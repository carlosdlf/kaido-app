//! Workspace file watcher.
//!
//! Raw `notify` events are reduced to relative Markdown paths (or a request to
//! rescan), coalesced until the file system has been quiet for
//! [`DEBOUNCE`], and then handed to an emitter as one [`ChangeBatch`].

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use notify::event::{CreateKind, ModifyKind, RemoveKind};
use notify::{Event, EventKind, RecommendedWatcher};
use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::fs_ops::{self, CONFIG_DIR, CONFIG_FILE, FileEntry, is_markdown, is_pruned_path};
use crate::paths::to_relative;
use crate::watch_tree::{self, WatchTree};

/// Quiet period after the last event before a batch is emitted.
pub const DEBOUNCE: Duration = Duration::from_millis(200);
/// Upper bound on how long a continuous stream of events can delay a batch.
pub const MAX_DELAY: Duration = Duration::from_secs(2);

/// Payload of the `workspace://changed` event.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ChangeBatch {
    /// Changed, created or removed Markdown files (and the workspace config
    /// file), sorted and deduplicated.
    pub paths: Vec<String>,
    /// Fresh entries for the `paths` that still exist as files when the batch
    /// is emitted. Paths without an entry were removed.
    pub entries: Vec<FileEntry>,
    /// The listing may be stale in ways `paths` cannot describe.
    pub rescan: bool,
}

/// The relevant part of a single file system event.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Classified {
    pub paths: Vec<String>,
    pub rescan: bool,
}

/// Whether an event on a path that is not a Markdown file may still affect
/// the listing, e.g. a folder that was renamed or removed.
fn may_affect_listing(kind: &EventKind) -> bool {
    match kind {
        EventKind::Create(CreateKind::File) | EventKind::Remove(RemoveKind::File) => false,
        EventKind::Create(_) | EventKind::Remove(_) => true,
        EventKind::Modify(ModifyKind::Name(_)) => true,
        EventKind::Modify(_) | EventKind::Access(_) => false,
        EventKind::Any | EventKind::Other => true,
    }
}

/// How to report an event on a path named like a note: `(report the path,
/// request a rescan)`. A folder named `x.md` is a folder, not a note; when
/// the path is gone and the event does not say what it was, both are done.
fn markdown_change(kind: &EventKind, path: &Path) -> (bool, bool) {
    if matches!(
        kind,
        EventKind::Create(CreateKind::Folder) | EventKind::Remove(RemoveKind::Folder)
    ) {
        return (false, true);
    }
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => (false, true),
        Ok(_) => (true, false),
        Err(_) => {
            let ambiguous = matches!(
                kind,
                EventKind::Remove(RemoveKind::Any | RemoveKind::Other)
                    | EventKind::Modify(ModifyKind::Name(_))
                    | EventKind::Any
                    | EventKind::Other
            );
            (true, ambiguous)
        }
    }
}

/// Reduces one watcher result to the Markdown paths it touches. `root` must
/// be the canonical workspace root the watcher was started on.
pub fn classify(root: &Path, result: &notify::Result<Event>) -> Classified {
    let event = match result {
        Ok(event) => event,
        Err(_) => {
            return Classified {
                paths: Vec::new(),
                rescan: true,
            };
        }
    };
    let mut out = Classified {
        paths: Vec::new(),
        rescan: event.need_rescan(),
    };
    if matches!(event.kind, EventKind::Access(_)) {
        return out;
    }
    for path in &event.paths {
        if path == root {
            out.rescan = true;
            continue;
        }
        let Some(rel) = to_relative(root, path) else {
            continue;
        };
        if rel == CONFIG_FILE {
            out.paths.push(rel);
            continue;
        }
        if rel == CONFIG_DIR {
            // The config folder appeared, vanished or moved: its file may
            // have changed without an event of its own.
            if may_affect_listing(&event.kind) {
                out.paths.push(CONFIG_FILE.to_owned());
            }
            continue;
        }
        if is_pruned_path(&rel) {
            continue;
        }
        if is_markdown(&rel) {
            let (report, rescan) = markdown_change(&event.kind, path);
            if report {
                out.paths.push(rel);
            }
            out.rescan |= rescan;
        } else if may_affect_listing(&event.kind) {
            out.rescan = true;
        }
    }
    out
}

/// Fills `entries` by checking each path of the batch on disk.
pub fn stat_entries(root: &Path, mut batch: ChangeBatch) -> ChangeBatch {
    batch.entries = batch
        .paths
        .iter()
        .filter_map(|rel| fs_ops::stat_entry(root, rel))
        .collect();
    batch
}

/// Accumulates classified events and decides when a batch is due.
#[derive(Debug, Default)]
pub struct Debouncer {
    paths: BTreeSet<String>,
    rescan: bool,
    first: Option<Instant>,
    last: Option<Instant>,
}

impl Debouncer {
    pub fn push(&mut self, change: Classified, now: Instant) {
        if change.paths.is_empty() && !change.rescan {
            return;
        }
        self.paths.extend(change.paths);
        self.rescan |= change.rescan;
        self.first.get_or_insert(now);
        self.last = Some(now);
    }

    /// When the pending batch should be emitted, if there is one.
    pub fn deadline(&self, debounce: Duration, max_delay: Duration) -> Option<Instant> {
        let (first, last) = (self.first?, self.last?);
        Some((last + debounce).min(first + max_delay))
    }

    /// Takes the pending batch if its deadline has passed.
    pub fn take_due(
        &mut self,
        now: Instant,
        debounce: Duration,
        max_delay: Duration,
    ) -> Option<ChangeBatch> {
        if self.deadline(debounce, max_delay)? > now {
            return None;
        }
        let batch = ChangeBatch {
            paths: std::mem::take(&mut self.paths).into_iter().collect(),
            entries: Vec::new(),
            rescan: self.rescan,
        };
        *self = Self::default();
        Some(batch)
    }
}

enum Message {
    Event(notify::Result<Event>),
    Stop,
}

type SharedTree = Arc<Mutex<WatchTree<RecommendedWatcher>>>;

/// A running watcher. Dropping it stops watching: once `drop` returns, the
/// emitter is never called again.
pub struct WorkspaceWatcher {
    control: mpsc::Sender<Message>,
    /// Set on drop. The worker holds this lock while it emits, so dropping
    /// waits for an emit in progress instead of racing with it.
    stopped: Arc<Mutex<bool>>,
    /// Cancels a subfolder walk still running on the worker thread.
    cancel: Arc<AtomicBool>,
    /// Shared with the worker thread so tests can inspect it.
    #[cfg(test)]
    tree: SharedTree,
    #[cfg(test)]
    registered: Arc<AtomicBool>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // Every critical section leaves the data consistent, so a panic in
    // another thread does not make it unusable.
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl WorkspaceWatcher {
    /// Starts watching `root` (canonical), calling `emit` from a background
    /// thread with each debounced batch.
    ///
    /// Returns once the root is watched; it fails only if that is not
    /// possible. Subfolders are registered on the background thread, after
    /// removing temp files left behind by crashed writes; a batch with
    /// `rescan: true` follows if anything may have been missed meanwhile.
    pub fn start<F>(root: PathBuf, emit: F) -> AppResult<Self>
    where
        F: Fn(ChangeBatch) + Send + 'static,
    {
        Self::start_with(root, DEBOUNCE, MAX_DELAY, emit)
    }

    fn start_with<F>(
        root: PathBuf,
        debounce: Duration,
        max_delay: Duration,
        emit: F,
    ) -> AppResult<Self>
    where
        F: Fn(ChangeBatch) + Send + 'static,
    {
        let (tx, rx) = mpsc::channel::<Message>();
        let events = tx.clone();
        let watcher = notify::recommended_watcher(move |res| {
            let _ = events.send(Message::Event(res));
        })
        .map_err(watch_error)?;
        let tree =
            WatchTree::start(root.clone(), watcher, watch_tree::SELECTIVE).map_err(watch_error)?;
        let cancel = tree.cancel_handle();
        let tree: SharedTree = Arc::new(Mutex::new(tree));
        let stopped = Arc::new(Mutex::new(false));
        let registered = Arc::new(AtomicBool::new(false));

        let worker = Worker {
            root,
            debounce,
            max_delay,
            tree: Arc::clone(&tree),
            stopped: Arc::clone(&stopped),
            registered: Arc::clone(&registered),
        };
        thread::Builder::new()
            .name("workspace-watcher".into())
            .spawn(move || worker.run(&rx, &emit))
            .map_err(|e| AppError::Io(format!("could not start the file watcher: {e}")))?;

        #[cfg(not(test))]
        let _ = (tree, registered);
        Ok(Self {
            control: tx,
            stopped,
            cancel,
            #[cfg(test)]
            tree,
            #[cfg(test)]
            registered,
        })
    }

    /// Folders currently registered with the operating system.
    #[cfg(test)]
    fn watched_dirs(&self) -> Vec<PathBuf> {
        lock(&self.tree).watched().map(Path::to_path_buf).collect()
    }

    /// Waits until the subfolders have been registered.
    #[cfg(test)]
    fn wait_registered(&self) {
        let start = Instant::now();
        while !self.registered.load(Ordering::SeqCst) {
            assert!(
                start.elapsed() < Duration::from_secs(5),
                "registration timed out"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for WorkspaceWatcher {
    fn drop(&mut self) {
        // Cancel first: the worker may be walking subfolders with the tree
        // locked, and must not keep registering watches for a dead workspace.
        self.cancel.store(true, Ordering::SeqCst);
        *lock(&self.stopped) = true;
        let _ = self.control.send(Message::Stop);
    }
}

struct Worker {
    root: PathBuf,
    debounce: Duration,
    max_delay: Duration,
    tree: SharedTree,
    stopped: Arc<Mutex<bool>>,
    registered: Arc<AtomicBool>,
}

impl Worker {
    fn run<F: Fn(ChangeBatch)>(self, rx: &mpsc::Receiver<Message>, emit: &F) {
        let mut debouncer = Debouncer::default();
        {
            let mut tree = lock(&self.tree);
            fs_ops::sweep_temp_files(&self.root);
            let complete = tree.register_subfolders();
            // Changes inside subfolders before their watch existed went
            // unnoticed, so ask for a rescan unless only the root is watched.
            let rescan = !complete || tree.watched_count() > 1;
            debouncer.push(
                Classified {
                    paths: Vec::new(),
                    rescan,
                },
                Instant::now(),
            );
        }
        self.registered.store(true, Ordering::SeqCst);

        loop {
            let received = match debouncer.deadline(self.debounce, self.max_delay) {
                None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
                Some(deadline) => {
                    rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                }
            };
            match received {
                Ok(Message::Event(result)) => {
                    let mut change = classify(&self.root, &result);
                    change.rescan |= !lock(&self.tree).on_event(&result);
                    debouncer.push(change, Instant::now());
                }
                Err(RecvTimeoutError::Timeout) => {}
                Ok(Message::Stop) | Err(RecvTimeoutError::Disconnected) => return,
            }
            if let Some(batch) = debouncer.take_due(Instant::now(), self.debounce, self.max_delay) {
                let stopped = lock(&self.stopped);
                if *stopped {
                    return;
                }
                emit(stat_entries(&self.root, batch));
            }
        }
    }
}

fn watch_error(err: notify::Error) -> AppError {
    match err.kind {
        notify::ErrorKind::Io(ref io) => AppError::from_io(io, "watch", "the workspace folder"),
        notify::ErrorKind::PathNotFound => {
            AppError::NotFound("the workspace folder was not found".into())
        }
        notify::ErrorKind::MaxFilesWatch => AppError::Io(
            "the workspace has too many folders to watch; raise the system watch limit".into(),
        ),
        _ => AppError::Io("could not watch the workspace folder".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{DataChange, Flag, RenameMode};
    use std::fs;

    fn root() -> PathBuf {
        PathBuf::from("/w")
    }

    fn ev(kind: EventKind, rels: &[&str]) -> notify::Result<Event> {
        let mut event = Event::new(kind);
        for rel in rels {
            event = event.add_path(root().join(rel));
        }
        Ok(event)
    }

    fn data() -> EventKind {
        EventKind::Modify(ModifyKind::Data(DataChange::Content))
    }

    fn classified(paths: &[&str], rescan: bool) -> Classified {
        Classified {
            paths: paths.iter().map(|p| p.to_string()).collect(),
            rescan,
        }
    }

    #[test]
    fn pruned_paths() {
        assert!(is_pruned_path(".git/index"));
        assert!(is_pruned_path("p/.hidden.md"));
        assert!(is_pruned_path("p/node_modules/x/readme.md"));
        assert!(is_pruned_path("p/.kaido-1-1.tmp"));
        assert!(!is_pruned_path("_archive/p/a.md"));
        assert!(!is_pruned_path("p/sub/a.md"));
    }

    #[test]
    fn reports_markdown_changes_case_insensitively() {
        let c = classify(&root(), &ev(data(), &["p/a.md", "p/B.MD"]));
        assert_eq!(c, classified(&["p/a.md", "p/B.MD"], false));
        let c = classify(&root(), &ev(EventKind::Create(CreateKind::File), &["n.md"]));
        assert_eq!(c, classified(&["n.md"], false));
        let c = classify(&root(), &ev(EventKind::Remove(RemoveKind::File), &["n.md"]));
        assert_eq!(c, classified(&["n.md"], false));
    }

    #[test]
    fn ignores_pruned_locations_temp_files_and_access() {
        for (kind, rel) in [
            (data(), ".git/index"),
            (EventKind::Remove(RemoveKind::Folder), ".git/refs"),
            (
                EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
                ".git/x.md",
            ),
            (data(), "node_modules/a/readme.md"),
            (EventKind::Create(CreateKind::File), "p/.kaido-12-3.tmp"),
            (data(), "p/.hidden.md"),
            (EventKind::Access(notify::event::AccessKind::Any), "p/a.md"),
            (data(), "p/image.png"),
            (EventKind::Create(CreateKind::File), "p/a.md~"),
            (EventKind::Remove(RemoveKind::File), "p/4913"),
        ] {
            assert_eq!(
                classify(&root(), &ev(kind, &[rel])),
                Classified::default(),
                "{rel}"
            );
        }
    }

    #[test]
    fn ignores_paths_outside_the_root() {
        let event = Ok(Event::new(data()).add_path(PathBuf::from("/elsewhere/a.md")));
        assert_eq!(classify(&root(), &event), Classified::default());
    }

    #[test]
    fn atomic_save_reports_only_the_target() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        fs::write(root.join("a.md"), "x").unwrap();
        let event = Ok(
            Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
                .add_path(root.join(".kaido-1-1.tmp"))
                .add_path(root.join("a.md")),
        );
        assert_eq!(classify(&root, &event), classified(&["a.md"], false));
    }

    #[test]
    fn folders_named_like_notes_are_folder_events() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        fs::create_dir(root.join("dir.md")).unwrap();
        fs::write(root.join("file.md"), "x").unwrap();
        let at = |kind, rel: &str| classify(&root, &Ok(Event::new(kind).add_path(root.join(rel))));

        // Existing folder: whatever the event says, it is a rescan.
        assert_eq!(at(data(), "dir.md"), classified(&[], true));
        assert_eq!(
            at(EventKind::Create(CreateKind::Any), "dir.md"),
            classified(&[], true)
        );
        // Folder kinds are trusted even when the folder is gone.
        assert_eq!(
            at(EventKind::Create(CreateKind::Folder), "gone.md"),
            classified(&[], true)
        );
        assert_eq!(
            at(EventKind::Remove(RemoveKind::Folder), "gone.md"),
            classified(&[], true)
        );
        // Existing files are plain changes.
        let renamed = EventKind::Modify(ModifyKind::Name(RenameMode::To));
        assert_eq!(at(renamed, "file.md"), classified(&["file.md"], false));
        // A gone path is reported; if the event cannot tell a file from a
        // folder, a rescan is requested as well.
        assert_eq!(
            at(EventKind::Remove(RemoveKind::File), "gone.md"),
            classified(&["gone.md"], false)
        );
        for kind in [
            EventKind::Remove(RemoveKind::Any),
            EventKind::Remove(RemoveKind::Other),
            EventKind::Modify(ModifyKind::Name(RenameMode::From)),
            EventKind::Any,
            EventKind::Other,
        ] {
            assert_eq!(
                at(kind, "gone.md"),
                classified(&["gone.md"], true),
                "{kind:?}"
            );
        }
    }

    #[test]
    fn folder_level_changes_request_a_rescan() {
        for kind in [
            EventKind::Create(CreateKind::Folder),
            EventKind::Remove(RemoveKind::Folder),
            EventKind::Remove(RemoveKind::Any),
            EventKind::Modify(ModifyKind::Name(RenameMode::From)),
            EventKind::Any,
            EventKind::Other,
        ] {
            assert_eq!(
                classify(&root(), &ev(kind, &["proj"])),
                classified(&[], true),
                "{kind:?}"
            );
        }
        let renamed = ev(
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            &["old", "new"],
        );
        assert!(classify(&root(), &renamed).rescan);
    }

    #[test]
    fn errors_overflow_and_root_events_request_a_rescan() {
        let error = Err(notify::Error::generic("boom"));
        assert_eq!(classify(&root(), &error), classified(&[], true));
        let overflow = Ok(Event::new(EventKind::Other).set_flag(Flag::Rescan));
        assert_eq!(classify(&root(), &overflow), classified(&[], true));
        let root_event = Ok(Event::new(EventKind::Remove(RemoveKind::Folder)).add_path(root()));
        assert_eq!(classify(&root(), &root_event), classified(&[], true));
    }

    #[test]
    fn debouncer_coalesces_until_quiet() {
        let d = Duration::from_millis(200);
        let max = Duration::from_secs(2);
        let t0 = Instant::now();
        let mut deb = Debouncer::default();
        assert_eq!(deb.deadline(d, max), None);
        assert_eq!(deb.take_due(t0, d, max), None);

        deb.push(Classified::default(), t0);
        assert_eq!(deb.deadline(d, max), None, "empty changes are ignored");

        deb.push(classified(&["b.md", "a.md"], false), t0);
        deb.push(
            classified(&["a.md"], false),
            t0 + Duration::from_millis(150),
        );
        assert_eq!(deb.deadline(d, max), Some(t0 + Duration::from_millis(350)));
        assert_eq!(deb.take_due(t0 + Duration::from_millis(300), d, max), None);

        let batch = deb
            .take_due(t0 + Duration::from_millis(350), d, max)
            .unwrap();
        assert_eq!(batch.paths, ["a.md", "b.md"]);
        assert!(!batch.rescan);
        assert_eq!(deb.deadline(d, max), None, "state resets after a batch");
    }

    #[test]
    fn debouncer_keeps_rescan_and_caps_the_delay() {
        let d = Duration::from_millis(200);
        let max = Duration::from_millis(500);
        let t0 = Instant::now();
        let mut deb = Debouncer::default();
        for i in 0..10u64 {
            let change = if i == 3 {
                classified(&[], true)
            } else {
                classified(&["a.md"], false)
            };
            deb.push(change, t0 + Duration::from_millis(i * 100));
        }
        assert_eq!(deb.deadline(d, max), Some(t0 + max));
        let batch = deb.take_due(t0 + max, d, max).unwrap();
        assert_eq!(
            batch,
            ChangeBatch {
                paths: vec!["a.md".into()],
                entries: Vec::new(),
                rescan: true
            }
        );
    }

    #[test]
    fn batch_serializes_for_the_frontend() {
        let json = serde_json::to_value(ChangeBatch {
            paths: vec!["a.md".into()],
            entries: vec![FileEntry {
                path: "a.md".into(),
                size: 3,
                modified: 7,
            }],
            rescan: false,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "paths": ["a.md"],
                "entries": [{ "path": "a.md", "size": 3, "modified": 7 }],
                "rescan": false
            })
        );
    }

    #[test]
    fn watch_errors_map_to_app_errors() {
        let io = notify::Error::io(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        assert_eq!(watch_error(io).kind(), "PermissionDenied");
        assert_eq!(
            watch_error(notify::Error::path_not_found()).kind(),
            "NotFound"
        );
        assert_eq!(
            watch_error(notify::Error::new(notify::ErrorKind::MaxFilesWatch)).kind(),
            "Io"
        );
        assert_eq!(watch_error(notify::Error::generic("x")).kind(), "Io");
    }

    #[test]
    fn starting_on_a_missing_folder_fails() {
        let dir = tempfile::tempdir().unwrap();
        let result = WorkspaceWatcher::start(dir.path().join("missing"), |_| {});
        assert_eq!(result.err().map(|e| e.kind()), Some("NotFound"));
    }

    type Batches = Arc<Mutex<Vec<ChangeBatch>>>;

    fn wait_for(batches: &Batches, pred: impl Fn(&[ChangeBatch]) -> bool) -> bool {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            if pred(&batches.lock().unwrap()) {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        false
    }

    fn all_paths(batches: &[ChangeBatch]) -> BTreeSet<String> {
        batches
            .iter()
            .flat_map(|b| b.paths.iter().cloned())
            .collect()
    }

    /// Starts a watcher, waits for its subfolders to be registered and for
    /// the initial batch to go out, then returns it with an empty batch log.
    fn start_settled(root: &Path, debounce_ms: u64) -> (WorkspaceWatcher, Batches) {
        let batches: Batches = Arc::default();
        let sink = Arc::clone(&batches);
        let debounce = Duration::from_millis(debounce_ms);
        let watcher =
            WorkspaceWatcher::start_with(root.to_path_buf(), debounce, MAX_DELAY, move |b| {
                sink.lock().unwrap().push(b)
            })
            .unwrap();
        watcher.wait_registered();
        thread::sleep(debounce + Duration::from_millis(150));
        batches.lock().unwrap().clear();
        (watcher, batches)
    }

    #[test]
    fn watches_a_real_folder_and_coalesces_writes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        fs::create_dir_all(root.join("p")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();

        let (watcher, batches) = start_settled(&root, 150);

        for i in 0..5 {
            fs::write(root.join("p/a.md"), format!("v{i}")).unwrap();
        }
        fs::write(root.join("p/b.MD"), "b").unwrap();
        fs::write(root.join("p/image.png"), "x").unwrap();
        fs::write(root.join(".git/index.md"), "x").unwrap();
        fs::write(root.join("node_modules/readme.md"), "x").unwrap();
        crate::fs_ops::write_file(&root, "p/c.md", "c").unwrap();

        let expected: BTreeSet<String> = ["p/a.md", "p/b.MD", "p/c.md"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert!(
            wait_for(&batches, |b| all_paths(b) == expected),
            "got {:?}",
            batches.lock().unwrap()
        );
        // Let any trailing events settle, then check nothing unexpected arrived.
        thread::sleep(Duration::from_millis(400));
        let got = batches.lock().unwrap().clone();
        assert_eq!(all_paths(&got), expected);
        for path in &expected {
            assert!(got.iter().any(|b| b.paths.contains(path)), "{path}");
        }

        // A folder removal asks for a rescan.
        batches.lock().unwrap().clear();
        fs::remove_dir_all(root.join("p")).unwrap();
        assert!(wait_for(&batches, |b| b.iter().any(|b| b.rescan)));

        // Nothing is emitted once the watcher is dropped.
        drop(watcher);
        thread::sleep(Duration::from_millis(50));
        let count = batches.lock().unwrap().len();
        fs::write(root.join("late.md"), "x").unwrap();
        thread::sleep(Duration::from_millis(400));
        assert_eq!(batches.lock().unwrap().len(), count);
    }

    #[test]
    fn never_watches_pruned_folders_and_follows_new_ones() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let deep = root.join("node_modules/a/node_modules/b/node_modules/c");
        fs::create_dir_all(&deep).unwrap();
        fs::create_dir_all(root.join(".git/objects/aa")).unwrap();
        fs::create_dir_all(root.join("p/node_modules/x")).unwrap();
        fs::create_dir_all(root.join("p/sub")).unwrap();

        let (watcher, batches) = start_settled(&root, 100);

        let watched = watcher.watched_dirs();
        if watch_tree::SELECTIVE {
            assert_eq!(watched, [root.clone(), root.join("p"), root.join("p/sub")]);
        } else {
            assert_eq!(watched, std::slice::from_ref(&root));
        }
        for path in &watched {
            let rel = to_relative(&root, path);
            assert!(
                rel.is_none_or(|rel| rel == CONFIG_DIR || !is_pruned_path(&rel)),
                "{path:?}"
            );
        }

        // A new folder triggers a rescan and is then watched.
        fs::create_dir_all(root.join("new/inner")).unwrap();
        assert!(wait_for(&batches, |b| b.iter().any(|b| b.rescan)));
        if watch_tree::SELECTIVE {
            assert!(watcher.watched_dirs().contains(&root.join("new")));
        }
        fs::write(root.join("new/inner/n.md"), "x").unwrap();
        assert!(
            wait_for(&batches, |b| all_paths(b).contains("new/inner/n.md")),
            "got {:?}",
            batches.lock().unwrap()
        );

        // A removed folder is no longer watched.
        fs::remove_dir_all(root.join("new")).unwrap();
        let start = Instant::now();
        while watcher.watched_dirs().contains(&root.join("new"))
            && start.elapsed() < Duration::from_secs(5)
        {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(!watcher.watched_dirs().contains(&root.join("new")));
        assert!(!watcher.watched_dirs().contains(&root.join("new/inner")));
    }

    #[test]
    fn reports_the_workspace_config_file_only() {
        let c = classify(&root(), &ev(data(), &[".kaido/config.json"]));
        assert_eq!(c, classified(&[".kaido/config.json"], false));
        for rel in [
            ".kaido/other.json",
            ".kaido/sub/config.json",
            ".kaido/.kaido-1-1.tmp",
            ".KAIDO/config.json",
            ".git/config.json",
            "p/.kaido/config.json",
        ] {
            assert_eq!(
                classify(&root(), &ev(data(), &[rel])),
                Classified::default(),
                "{rel}"
            );
        }
        let save = EventKind::Modify(ModifyKind::Name(RenameMode::Both));
        let c = classify(
            &root(),
            &ev(save, &[".kaido/.kaido-1-1.tmp", ".kaido/config.json"]),
        );
        assert_eq!(c, classified(&[".kaido/config.json"], false));
    }

    #[test]
    fn config_folder_events_report_the_config_file() {
        for kind in [
            EventKind::Create(CreateKind::Folder),
            EventKind::Remove(RemoveKind::Folder),
            EventKind::Modify(ModifyKind::Name(RenameMode::From)),
        ] {
            let c = classify(&root(), &ev(kind, &[".kaido"]));
            assert_eq!(c, classified(&[".kaido/config.json"], false), "{kind:?}");
        }
        let c = classify(&root(), &ev(data(), &[".kaido"]));
        assert_eq!(c, Classified::default());
    }

    #[test]
    fn stat_entries_lists_only_surviving_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        fs::create_dir_all(root.join(".kaido")).unwrap();
        fs::write(root.join("a.md"), "aaa").unwrap();
        fs::write(root.join(".kaido/config.json"), "{}").unwrap();
        fs::create_dir(root.join("dir.md")).unwrap();
        let batch = ChangeBatch {
            paths: vec![
                ".kaido/config.json".into(),
                "a.md".into(),
                "dir.md".into(),
                "gone.md".into(),
            ],
            entries: Vec::new(),
            rescan: false,
        };
        let batch = stat_entries(&root, batch);
        let found: Vec<(&str, u64)> = batch
            .entries
            .iter()
            .map(|e| (e.path.as_str(), e.size))
            .collect();
        assert_eq!(found, [(".kaido/config.json", 2), ("a.md", 3)]);
        assert_eq!(batch.paths.len(), 4);
    }

    #[test]
    fn watches_the_workspace_config_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        fs::create_dir_all(root.join("p")).unwrap();

        let (watcher, batches) = start_settled(&root, 100);

        // The config folder is created after the watcher started.
        fs::create_dir(root.join(".kaido")).unwrap();
        let start = Instant::now();
        while !watcher.watched_dirs().contains(&root.join(".kaido"))
            && start.elapsed() < Duration::from_secs(5)
        {
            thread::sleep(Duration::from_millis(20));
        }
        fs::create_dir(root.join(".kaido/cache")).unwrap();
        fs::write(root.join(".kaido/cache/index.json"), "x").unwrap();
        fs::write(root.join(".kaido/other.json"), "x").unwrap();
        crate::fs_ops::write_file(&root, ".kaido/config.json", r#"{"version":1}"#).unwrap();

        let has_entry = |b: &[ChangeBatch]| {
            b.iter().any(|b| {
                b.entries
                    .iter()
                    .any(|e| e.path == ".kaido/config.json" && e.size == 13)
            })
        };
        assert!(
            wait_for(&batches, has_entry),
            "got {:?}",
            batches.lock().unwrap()
        );
        thread::sleep(Duration::from_millis(300));
        let reported = all_paths(&batches.lock().unwrap());
        assert_eq!(
            reported.into_iter().collect::<Vec<_>>(),
            [".kaido/config.json"]
        );
        if watch_tree::SELECTIVE {
            assert!(!watcher.watched_dirs().contains(&root.join(".kaido/cache")));
        }

        // A removal is reported without an entry.
        batches.lock().unwrap().clear();
        fs::remove_file(root.join(".kaido/config.json")).unwrap();
        assert!(wait_for(&batches, |b| all_paths(b).contains(".kaido/config.json")));
        assert!(batches.lock().unwrap().iter().all(|b| b.entries.is_empty()));
    }

    #[test]
    fn drop_waits_for_an_emit_in_progress() {
        use std::sync::atomic::AtomicUsize;
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let started = Arc::new(AtomicUsize::new(0));
        let finished = Arc::new(AtomicUsize::new(0));
        let (s, f) = (Arc::clone(&started), Arc::clone(&finished));
        let watcher = WorkspaceWatcher::start_with(
            root.clone(),
            Duration::from_millis(50),
            MAX_DELAY,
            move |_| {
                s.fetch_add(1, Ordering::SeqCst);
                thread::sleep(Duration::from_millis(300));
                f.fetch_add(1, Ordering::SeqCst);
            },
        )
        .unwrap();
        watcher.wait_registered();

        fs::write(root.join("a.md"), "x").unwrap();
        let start = Instant::now();
        while started.load(Ordering::SeqCst) == 0 && start.elapsed() < Duration::from_secs(5) {
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(started.load(Ordering::SeqCst), 1);
        drop(watcher);
        // The drop returned only after the emit in progress completed.
        assert_eq!(finished.load(Ordering::SeqCst), 1);

        fs::write(root.join("b.md"), "x").unwrap();
        thread::sleep(Duration::from_millis(300));
        assert_eq!(started.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn startup_sweeps_temp_files_and_rescans_after_registering_subfolders() {
        let collect = |root: &Path| {
            let batches: Batches = Arc::default();
            let sink = Arc::clone(&batches);
            let watcher = WorkspaceWatcher::start_with(
                root.to_path_buf(),
                Duration::from_millis(50),
                MAX_DELAY,
                move |b| sink.lock().unwrap().push(b),
            )
            .unwrap();
            watcher.wait_registered();
            thread::sleep(Duration::from_millis(250));
            let guard = batches.lock().unwrap();
            guard.clone()
        };

        // Only the root: nothing can have been missed.
        let flat = tempfile::tempdir().unwrap();
        let flat_root = dunce::canonicalize(flat.path()).unwrap();
        fs::write(flat_root.join("a.md"), "x").unwrap();
        assert_eq!(collect(&flat_root), []);

        // Subfolders registered after `start` returned: one rescan.
        let nested = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(nested.path()).unwrap();
        fs::create_dir(root.join("p")).unwrap();
        let stale = format!(".kaido-{}-1.tmp", std::process::id().wrapping_add(1));
        fs::write(root.join("p").join(&stale), "x").unwrap();
        crate::test_support::backdate(&root.join("p").join(&stale), 3600);
        let got = collect(&root);
        if watch_tree::SELECTIVE {
            assert_eq!(
                got,
                [ChangeBatch {
                    paths: Vec::new(),
                    entries: Vec::new(),
                    rescan: true
                }]
            );
        }
        assert!(!root.join("p").join(&stale).exists());
    }
}
