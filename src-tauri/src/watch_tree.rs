//! Which folders the file watcher registers.
//!
//! On Linux (inotify) every watched folder costs a kernel watch, and the
//! per-user limit is easy to exhaust with `.git` or `node_modules`. There the
//! workspace is watched folder by folder, non-recursively, skipping pruned
//! folders entirely and following folders as they appear and disappear. On
//! macOS and Windows a single recursive watch on the root is cheap, so it is
//! used instead; pruned paths are filtered out when events are classified.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use notify::event::{CreateKind, RemoveKind};
use notify::{Event, EventKind, RecursiveMode, Watcher};

use crate::fs_ops::{CONFIG_DIR, is_pruned_name, is_pruned_path};
use crate::paths::to_relative;

/// Whether this platform watches folder by folder.
pub const SELECTIVE: bool = !cfg!(any(target_os = "macos", target_os = "windows"));

/// The operations the tree needs from a file watcher.
pub trait WatchBackend {
    fn watch_dir(&mut self, dir: &Path, mode: RecursiveMode) -> notify::Result<()>;
    fn unwatch_dir(&mut self, dir: &Path) -> notify::Result<()>;
}

impl<W: Watcher> WatchBackend for W {
    fn watch_dir(&mut self, dir: &Path, mode: RecursiveMode) -> notify::Result<()> {
        self.watch(dir, mode)
    }

    fn unwatch_dir(&mut self, dir: &Path) -> notify::Result<()> {
        self.unwatch(dir)
    }
}

/// Tracks the watched folders of one workspace.
pub struct WatchTree<B> {
    root: PathBuf,
    backend: B,
    selective: bool,
    watched: BTreeSet<PathBuf>,
    /// Set when the watcher is being dropped: an ongoing walk stops at the
    /// next folder and gives its watches back.
    cancel: Arc<AtomicBool>,
}

impl<B: WatchBackend> WatchTree<B> {
    /// Watches the workspace root (recursively when not selective). Fails
    /// if the root cannot be watched. In selective mode the subfolders are
    /// registered separately with [`Self::register_subfolders`], so opening a
    /// workspace does not wait for a walk of the whole tree.
    pub fn start(root: PathBuf, backend: B, selective: bool) -> notify::Result<Self> {
        let mut tree = Self {
            root,
            backend,
            selective,
            watched: BTreeSet::new(),
            cancel: Arc::new(AtomicBool::new(false)),
        };
        let mode = if selective {
            RecursiveMode::NonRecursive
        } else {
            RecursiveMode::Recursive
        };
        tree.backend.watch_dir(&tree.root, mode)?;
        tree.watched.insert(tree.root.clone());
        Ok(tree)
    }

    /// Flag that cancels this tree: once set, walks stop promptly, every
    /// watch is released and further events are ignored.
    pub fn cancel_handle(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancel)
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// Releases every watch, the root included.
    fn release_all(&mut self) {
        for path in std::mem::take(&mut self.watched) {
            let _ = self.backend.unwatch_dir(&path);
        }
    }

    /// Watches every folder below the root that should be watched. Returns
    /// `false` if some folder could not be registered.
    pub fn register_subfolders(&mut self) -> bool {
        if !self.selective {
            return true;
        }
        let root = self.root.clone();
        self.add_tree(&root)
    }

    /// Number of folders currently watched, the root included.
    pub fn watched_count(&self) -> usize {
        self.watched.len()
    }

    /// Folders currently watched, sorted.
    #[cfg(test)]
    pub fn watched(&self) -> impl Iterator<Item = &Path> {
        self.watched.iter().map(PathBuf::as_path)
    }

    /// Updates the watched folders after an event. Returns `false` if a
    /// folder that should be watched could not be registered, so the caller
    /// can ask the frontend for a rescan.
    pub fn on_event(&mut self, result: &notify::Result<Event>) -> bool {
        if !self.selective || self.cancelled() {
            return true;
        }
        let event = match result {
            Ok(event) if !event.need_rescan() => event,
            // Events may have been lost: reconcile with the disk.
            _ => return self.resync(),
        };
        if !may_change_folders(&event.kind) {
            return true;
        }
        let mut complete = true;
        for path in &event.paths {
            let Some(rel) = to_relative(&self.root, path) else {
                continue;
            };
            if rel == CONFIG_DIR {
                if is_real_dir(path) {
                    complete &= self.watch_single(path);
                } else {
                    self.remove_tree(path);
                }
                continue;
            }
            if is_pruned_path(&rel) {
                continue;
            }
            if is_real_dir(path) {
                complete &= self.add_tree(path);
            } else {
                self.remove_tree(path);
            }
        }
        complete
    }

    /// Watches one folder without its subfolders.
    fn watch_single(&mut self, dir: &Path) -> bool {
        if self.watched.contains(dir) {
            return true;
        }
        if self
            .backend
            .watch_dir(dir, RecursiveMode::NonRecursive)
            .is_err()
        {
            return false;
        }
        self.watched.insert(dir.to_path_buf());
        true
    }

    /// Watches `dir` and every non-pruned folder below it that is not watched
    /// yet, plus the workspace config folder (without its subfolders). Folder
    /// symlinks are not followed.
    fn add_tree(&mut self, dir: &Path) -> bool {
        let mut complete = true;
        let mut stack = vec![dir.to_path_buf()];
        while let Some(current) = stack.pop() {
            if self.cancelled() {
                self.release_all();
                return false;
            }
            if !self.watched.contains(&current) {
                if self
                    .backend
                    .watch_dir(&current, RecursiveMode::NonRecursive)
                    .is_err()
                {
                    complete = false;
                    continue;
                }
                self.watched.insert(current.clone());
            }
            let Ok(entries) = fs::read_dir(&current) else {
                complete = false;
                continue;
            };
            for entry in entries.flatten() {
                let name = entry.file_name();
                let Some(name) = name.to_str() else { continue };
                let is_dir = entry.file_type().is_ok_and(|t| t.is_dir());
                if name == CONFIG_DIR && is_dir && current == self.root {
                    complete &= self.watch_single(&entry.path());
                    continue;
                }
                if is_pruned_name(name) {
                    continue;
                }
                if is_dir {
                    stack.push(entry.path());
                }
            }
        }
        complete
    }

    /// Stops watching `dir` and everything below it.
    fn remove_tree(&mut self, dir: &Path) {
        let gone: Vec<PathBuf> = self
            .watched
            .iter()
            .filter(|w| w.starts_with(dir) && *w != &self.root)
            .cloned()
            .collect();
        for path in gone {
            // The kernel drops watches of deleted folders on its own, so a
            // failure here only means there was nothing left to remove.
            let _ = self.backend.unwatch_dir(&path);
            self.watched.remove(&path);
        }
    }

    /// Drops watches of folders that no longer exist and adds missing ones.
    fn resync(&mut self) -> bool {
        let stale: Vec<PathBuf> = self
            .watched
            .iter()
            .filter(|w| !is_real_dir(w))
            .cloned()
            .collect();
        for path in stale {
            self.remove_tree(&path);
        }
        let root = self.root.clone();
        self.add_tree(&root)
    }
}

fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_dir())
}

fn may_change_folders(kind: &EventKind) -> bool {
    match kind {
        EventKind::Create(CreateKind::File) | EventKind::Remove(RemoveKind::File) => false,
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Any | EventKind::Other => true,
        EventKind::Modify(notify::event::ModifyKind::Name(_)) => true,
        EventKind::Modify(_) | EventKind::Access(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{DataChange, Flag, ModifyKind, RenameMode};
    use tempfile::TempDir;

    #[derive(Default)]
    struct FakeBackend {
        fail_on: BTreeSet<PathBuf>,
        calls: Vec<(PathBuf, RecursiveMode)>,
        unwatched: Vec<PathBuf>,
        /// Sets the flag once this many folders have been watched.
        cancel_after: Option<(usize, Arc<AtomicBool>)>,
    }

    impl WatchBackend for FakeBackend {
        fn watch_dir(&mut self, dir: &Path, mode: RecursiveMode) -> notify::Result<()> {
            if self.fail_on.contains(dir) {
                return Err(notify::Error::new(notify::ErrorKind::MaxFilesWatch));
            }
            self.calls.push((dir.to_path_buf(), mode));
            if let Some((after, flag)) = &self.cancel_after {
                if self.calls.len() >= *after {
                    flag.store(true, Ordering::SeqCst);
                }
            }
            Ok(())
        }

        fn unwatch_dir(&mut self, dir: &Path) -> notify::Result<()> {
            self.unwatched.push(dir.to_path_buf());
            Ok(())
        }
    }

    fn workspace(dirs: &[&str]) -> (TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        for d in dirs {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        (dir, root)
    }

    fn start_all(
        root: PathBuf,
        backend: FakeBackend,
        selective: bool,
    ) -> (WatchTree<FakeBackend>, bool) {
        let mut tree = WatchTree::start(root, backend, selective).unwrap();
        let complete = tree.register_subfolders();
        (tree, complete)
    }

    fn rels(tree: &WatchTree<FakeBackend>) -> Vec<String> {
        tree.watched()
            .map(|p| to_relative(&tree.root, p).unwrap_or_default())
            .collect()
    }

    fn event(kind: EventKind, paths: &[PathBuf]) -> notify::Result<Event> {
        let mut event = Event::new(kind);
        for p in paths {
            event = event.add_path(p.clone());
        }
        Ok(event)
    }

    #[test]
    fn skips_pruned_folders_and_symlinks() {
        let (_dir, root) = workspace(&[
            "p/sub/deeper",
            "_archive/old",
            ".git/objects/ab",
            ".kaido",
            "node_modules/pkg/node_modules/inner",
            "p/node_modules/x",
            "p/.cache",
        ]);
        fs::write(root.join("p/a.md"), "x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("p"), root.join("link")).unwrap();

        let (tree, complete) = start_all(root.clone(), FakeBackend::default(), true);
        assert!(complete);
        assert_eq!(
            rels(&tree),
            [
                "",
                ".kaido",
                "_archive",
                "_archive/old",
                "p",
                "p/sub",
                "p/sub/deeper"
            ]
        );
        assert!(tree.backend.calls.iter().all(|(p, mode)| {
            *mode == RecursiveMode::NonRecursive
                && to_relative(&root, p)
                    .is_none_or(|rel| rel == CONFIG_DIR || !is_pruned_path(&rel))
        }));
        assert_eq!(tree.backend.calls.len(), 7);
    }

    #[test]
    fn recursive_mode_watches_only_the_root() {
        let (_dir, root) = workspace(&["p/sub"]);
        let (mut tree, complete) = start_all(root.clone(), FakeBackend::default(), false);
        assert!(complete);
        assert_eq!(
            tree.backend.calls,
            [(root.clone(), RecursiveMode::Recursive)]
        );
        let created = event(EventKind::Create(CreateKind::Folder), &[root.join("p/new")]);
        fs::create_dir(root.join("p/new")).unwrap();
        assert!(tree.on_event(&created));
        assert_eq!(tree.backend.calls.len(), 1);
    }

    #[test]
    fn root_watch_failure_is_an_error() {
        let (_dir, root) = workspace(&[]);
        for selective in [true, false] {
            let backend = FakeBackend {
                fail_on: [root.clone()].into(),
                ..Default::default()
            };
            assert!(WatchTree::start(root.clone(), backend, selective).is_err());
        }
    }

    #[test]
    fn subfolder_failures_are_reported_not_fatal() {
        let (_dir, root) = workspace(&["a", "b/c"]);
        let backend = FakeBackend {
            fail_on: [root.join("b")].into(),
            ..Default::default()
        };
        let (tree, complete) = start_all(root.clone(), backend, true);
        assert!(!complete);
        assert_eq!(rels(&tree), ["", "a"]);
    }

    #[test]
    fn follows_new_moved_and_removed_folders() {
        let (_dir, root) = workspace(&["p"]);
        let (mut tree, _) = start_all(root.clone(), FakeBackend::default(), true);

        fs::create_dir_all(root.join("p/new/inner")).unwrap();
        fs::create_dir_all(root.join("p/new/node_modules/x")).unwrap();
        let created = event(EventKind::Create(CreateKind::Folder), &[root.join("p/new")]);
        assert!(tree.on_event(&created));
        assert_eq!(rels(&tree), ["", "p", "p/new", "p/new/inner"]);

        fs::rename(root.join("p/new"), root.join("moved")).unwrap();
        let renamed = event(
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            &[root.join("p/new"), root.join("moved")],
        );
        assert!(tree.on_event(&renamed));
        assert_eq!(rels(&tree), ["", "moved", "moved/inner", "p"]);
        assert!(tree.backend.unwatched.contains(&root.join("p/new/inner")));

        fs::remove_dir_all(root.join("moved")).unwrap();
        let removed = event(EventKind::Remove(RemoveKind::Folder), &[root.join("moved")]);
        assert!(tree.on_event(&removed));
        assert_eq!(rels(&tree), ["", "p"]);
    }

    #[test]
    fn ignores_pruned_outside_and_file_events() {
        let (_dir, root) = workspace(&["p", ".git/refs", "node_modules/x"]);
        let (mut tree, _) = start_all(root.clone(), FakeBackend::default(), true);
        let before = tree.backend.calls.len();
        for (kind, path) in [
            (
                EventKind::Create(CreateKind::Folder),
                root.join(".git/refs"),
            ),
            (
                EventKind::Create(CreateKind::Folder),
                root.join("node_modules/x"),
            ),
            (
                EventKind::Create(CreateKind::Folder),
                PathBuf::from("/elsewhere"),
            ),
            (EventKind::Create(CreateKind::File), root.join("p")),
            (
                EventKind::Modify(ModifyKind::Data(DataChange::Any)),
                root.join("p"),
            ),
            (
                EventKind::Access(notify::event::AccessKind::Any),
                root.join("p"),
            ),
        ] {
            assert!(tree.on_event(&event(kind, &[path])));
        }
        // The root itself is never unwatched.
        assert!(tree.on_event(&event(
            EventKind::Remove(RemoveKind::Folder),
            std::slice::from_ref(&root)
        )));
        assert_eq!(tree.backend.calls.len(), before);
        assert_eq!(rels(&tree), ["", "p"]);
    }

    #[test]
    fn a_file_replacing_a_folder_drops_its_watch() {
        let (_dir, root) = workspace(&["p/sub"]);
        let (mut tree, _) = start_all(root.clone(), FakeBackend::default(), true);
        fs::remove_dir_all(root.join("p")).unwrap();
        fs::write(root.join("p"), "x").unwrap();
        assert!(tree.on_event(&event(EventKind::Any, &[root.join("p")])));
        assert_eq!(rels(&tree), [""]);
    }

    #[test]
    fn late_watch_failures_ask_for_a_rescan() {
        let (_dir, root) = workspace(&[]);
        let (mut tree, _) = start_all(root.clone(), FakeBackend::default(), true);
        tree.backend.fail_on.insert(root.join("new"));
        fs::create_dir(root.join("new")).unwrap();
        fs::create_dir(root.join("other")).unwrap();
        let created = event(
            EventKind::Create(CreateKind::Folder),
            &[root.join("new"), root.join("other")],
        );
        assert!(!tree.on_event(&created));
        assert_eq!(rels(&tree), ["", "other"]);
    }

    #[test]
    fn overflow_and_errors_resync_with_the_disk() {
        let (_dir, root) = workspace(&["gone/sub", "kept"]);
        let (mut tree, _) = start_all(root.clone(), FakeBackend::default(), true);
        fs::remove_dir_all(root.join("gone")).unwrap();
        fs::create_dir_all(root.join("kept/new")).unwrap();
        let overflow = Ok(Event::new(EventKind::Other).set_flag(Flag::Rescan));
        assert!(tree.on_event(&overflow));
        assert_eq!(rels(&tree), ["", "kept", "kept/new"]);

        fs::create_dir(root.join("later")).unwrap();
        assert!(tree.on_event(&Err(notify::Error::generic("lost"))));
        assert_eq!(rels(&tree), ["", "kept", "kept/new", "later"]);
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_folders_are_reported() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, root) = workspace(&["locked/inner"]);
        if crate::test_support::skip_if_privileged("unreadable_folders_are_reported") {
            return;
        }
        fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o000)).unwrap();
        let (tree, complete) = start_all(root.clone(), FakeBackend::default(), true);
        fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!complete);
        assert_eq!(rels(&tree), ["", "locked"]);
    }

    #[test]
    fn real_watchers_implement_the_backend() {
        let (_dir, root) = workspace(&["p"]);
        let mut watcher = notify::recommended_watcher(|_: notify::Result<Event>| {}).unwrap();
        watcher
            .watch_dir(&root.join("p"), RecursiveMode::NonRecursive)
            .unwrap();
        watcher.unwatch_dir(&root.join("p")).unwrap();
    }

    #[test]
    fn watches_the_config_folder_but_not_below_it() {
        let (_dir, root) = workspace(&[".kaido/cache/deep", "p/.kaido"]);
        let (mut tree, complete) = start_all(root.clone(), FakeBackend::default(), true);
        assert!(complete);
        assert_eq!(rels(&tree), ["", ".kaido", "p"]);

        fs::remove_dir_all(root.join(".kaido")).unwrap();
        let removed = event(
            EventKind::Remove(RemoveKind::Folder),
            &[root.join(".kaido")],
        );
        assert!(tree.on_event(&removed));
        assert_eq!(rels(&tree), ["", "p"]);

        fs::create_dir_all(root.join(".kaido/sub")).unwrap();
        let created = event(
            EventKind::Create(CreateKind::Folder),
            &[root.join(".kaido")],
        );
        assert!(tree.on_event(&created));
        assert!(tree.on_event(&created), "already watched");
        assert_eq!(rels(&tree), ["", ".kaido", "p"]);

        // Nested config-named folders and folders below it stay pruned.
        let nested = event(
            EventKind::Create(CreateKind::Folder),
            &[root.join(".kaido/sub"), root.join("p/.kaido")],
        );
        assert!(tree.on_event(&nested));
        assert_eq!(rels(&tree), ["", ".kaido", "p"]);
    }

    #[test]
    fn config_folder_watch_failures_ask_for_a_rescan() {
        let (_dir, root) = workspace(&[".kaido"]);
        let backend = FakeBackend {
            fail_on: [root.join(".kaido")].into(),
            ..Default::default()
        };
        let (mut tree, complete) = start_all(root.clone(), backend, true);
        assert!(!complete);
        let created = event(
            EventKind::Create(CreateKind::Folder),
            &[root.join(".kaido")],
        );
        assert!(!tree.on_event(&created));
        assert_eq!(rels(&tree), [""]);
    }

    #[test]
    fn cancelling_stops_the_walk_and_releases_watches() {
        let dirs: Vec<String> = (0..20).map(|i| format!("d{i}/sub")).collect();
        let refs: Vec<&str> = dirs.iter().map(String::as_str).collect();
        let (_dir, root) = workspace(&refs);
        let mut tree = WatchTree::start(root.clone(), FakeBackend::default(), true).unwrap();
        let cancel = tree.cancel_handle();
        tree.backend.cancel_after = Some((4, Arc::clone(&cancel)));

        assert!(!tree.register_subfolders());
        assert_eq!(
            tree.backend.calls.len(),
            4,
            "the walk stops at the next folder"
        );
        assert_eq!(rels(&tree), Vec::<String>::new());
        let mut released = tree.backend.unwatched.clone();
        released.sort();
        let mut watched: Vec<PathBuf> = tree.backend.calls.iter().map(|(p, _)| p.clone()).collect();
        watched.sort();
        assert_eq!(released, watched);

        // A cancelled tree ignores events.
        fs::create_dir(root.join("late")).unwrap();
        let created = event(EventKind::Create(CreateKind::Folder), &[root.join("late")]);
        assert!(tree.on_event(&created));
        assert_eq!(tree.backend.calls.len(), 4);
    }
}
