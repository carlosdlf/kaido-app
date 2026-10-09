//! The currently open workspace, shared by all commands.
//!
//! # Workspace operation locks
//!
//! Each repository has two async locks (see [`OpLock`]); waiting commands do
//! not hold a thread, and the UI keeps working meanwhile.
//! - `git` serializes `git_commit` and `git_sync`.
//! - `tree` protects the working tree: `write_file`, `rename_file` and
//!   `delete_file` hold it shared, and a sync holds it exclusively only while
//!   it rebases (and resolves conflicts). File writes never wait for `git
//!   add` or `git commit`: the commit is limited to a pathspec and tolerates
//!   atomic writes landing meanwhile; the next commit picks them up.
//!
//! There is one pair per repository, not per open: the key is the
//! repository's git common folder (shared by its worktrees), or the
//! workspace folder itself outside a repository. Reopening the same folder,
//! or another folder of the same repository, while an operation still runs
//! gives the same locks, so two operations on one repository never overlap.
//!
//! The locks cannot deadlock: they are only taken by commands after every
//! `std` mutex here has been released, always in the order `git` then
//! `tree`, never twice by one command, and neither the watcher, `git_status`
//! nor `open_workspace` take them.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use crate::error::{AppError, AppResult};
use crate::paths;
use crate::watcher::{ChangeBatch, WorkspaceWatcher};

/// Guards the working tree against changes while git rewrites it.
pub type TreeLock = tauri::async_runtime::RwLock<()>;

/// The operation locks of one repository (see the module documentation).
#[derive(Default)]
pub struct OpLock {
    /// Serializes git operations (`git_commit`, `git_sync`).
    pub git: Arc<tauri::async_runtime::Mutex<()>>,
    /// File commands hold it shared; a sync holds it exclusively while it
    /// rebases.
    pub tree: Arc<TreeLock>,
}

/// The open workspace as seen by a command at one point in time.
#[derive(Clone)]
pub struct Workspace {
    /// Canonical root.
    pub root: PathBuf,
    /// Increases with every successful open.
    pub generation: u64,
    /// The folder's operation lock.
    pub lock: Arc<OpLock>,
}

struct OpenWorkspace {
    handle: Workspace,
    _watcher: WorkspaceWatcher,
}

#[derive(Default)]
pub struct AppState {
    workspace: Mutex<Option<OpenWorkspace>>,
    /// Held for the whole of an open, so opens never interleave.
    opening: Mutex<()>,
    /// Ticket of the most recently issued open.
    latest_open: AtomicU64,
    /// Generation of the most recent successful open.
    generation: AtomicU64,
    /// Operation locks by canonical folder, kept while anyone holds them.
    locks: Mutex<HashMap<PathBuf, Weak<OpLock>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // Guarded values are replaced wholesale, so a panic while holding a lock
    // cannot leave them half-updated.
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl AppState {
    fn lock(&self) -> MutexGuard<'_, Option<OpenWorkspace>> {
        lock(&self.workspace)
    }

    /// Canonical root of the open workspace.
    pub fn root(&self) -> AppResult<PathBuf> {
        self.current().map(|ws| ws.root)
    }

    /// The open workspace.
    pub fn current(&self) -> AppResult<Workspace> {
        self.lock()
            .as_ref()
            .map(|ws| ws.handle.clone())
            .ok_or(AppError::NoWorkspace)
    }

    /// Whether `workspace` is still the open one: no other open succeeded
    /// since it was returned by [`AppState::current`].
    pub fn is_current(&self, workspace: &Workspace) -> bool {
        self.lock()
            .as_ref()
            .is_some_and(|ws| ws.handle.generation == workspace.generation)
    }

    /// The operation lock of the folder `root`, shared by everyone using it.
    fn lock_for(&self, root: &Path) -> Arc<OpLock> {
        let mut locks = lock(&self.locks);
        locks.retain(|_, weak| weak.strong_count() > 0);
        if let Some(existing) = locks.get(root).and_then(Weak::upgrade) {
            return existing;
        }
        let created = Arc::new(OpLock::default());
        locks.insert(root.to_path_buf(), Arc::downgrade(&created));
        created
    }

    /// Opens the folder at `path` (absolute), replacing the current workspace
    /// and its watcher. Returns the canonical root. Blocks on disk access, so
    /// call it off the UI thread.
    ///
    /// Opens run one at a time and the most recently issued one wins: a call
    /// that is still waiting when a newer one is issued gives up without
    /// touching the open workspace. Once this returns, the previous
    /// workspace's watcher has stopped and will not emit again.
    #[cfg(test)]
    pub fn open<F>(&self, path: &str, emit: F) -> AppResult<PathBuf>
    where
        F: Fn(ChangeBatch) + Send + 'static,
    {
        self.open_keyed(path, Path::to_path_buf, emit)
    }

    /// [`AppState::open`], with the operation lock keyed by `key(root)`
    /// (see the module documentation).
    pub fn open_keyed<K, F>(&self, path: &str, key: K, emit: F) -> AppResult<PathBuf>
    where
        K: FnOnce(&Path) -> PathBuf,
        F: Fn(ChangeBatch) + Send + 'static,
    {
        let ticket = self.latest_open.fetch_add(1, Ordering::SeqCst) + 1;
        let _opening = lock(&self.opening);
        if self.latest_open.load(Ordering::SeqCst) != ticket {
            return Err(AppError::Superseded);
        }
        let root = paths::canonical_root(path)?;
        let watcher = WorkspaceWatcher::start(root.clone(), emit)?;
        let handle = Workspace {
            root: root.clone(),
            generation: self.generation.fetch_add(1, Ordering::SeqCst) + 1,
            lock: self.lock_for(&key(&root)),
        };
        let previous = self.lock().replace(OpenWorkspace {
            handle,
            _watcher: watcher,
        });
        // Stop the previous watcher outside the lock.
        drop(previous);
        Ok(root)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    #[test]
    fn no_workspace_until_opened() {
        let state = AppState::default();
        assert_eq!(state.root(), Err(AppError::NoWorkspace));
    }

    #[test]
    fn failed_open_keeps_the_previous_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::default();
        let root = state.open(dir.path().to_str().unwrap(), |_| {}).unwrap();
        assert_eq!(root, dunce::canonicalize(dir.path()).unwrap());
        assert_eq!(state.root().unwrap(), root);

        let missing = dir.path().join("missing");
        assert_eq!(
            state
                .open(missing.to_str().unwrap(), |_| {})
                .unwrap_err()
                .kind(),
            "NotFound"
        );
        assert_eq!(
            state.open("relative", |_| {}).unwrap_err().kind(),
            "InvalidPath"
        );
        assert_eq!(state.root().unwrap(), root);
    }

    #[test]
    fn reopening_replaces_the_watcher() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let state = AppState::default();
        let first_events = Arc::new(AtomicUsize::new(0));
        let second_events = Arc::new(AtomicUsize::new(0));

        let counter = Arc::clone(&first_events);
        state
            .open(first.path().to_str().unwrap(), move |_| {
                counter.fetch_add(1, Ordering::SeqCst);
            })
            .unwrap();
        let counter = Arc::clone(&second_events);
        let root = state
            .open(second.path().to_str().unwrap(), move |_| {
                counter.fetch_add(1, Ordering::SeqCst);
            })
            .unwrap();
        assert_eq!(state.root().unwrap(), root);

        std::fs::write(first.path().join("a.md"), "x").unwrap();
        std::fs::write(second.path().join("b.md"), "x").unwrap();
        let start = Instant::now();
        while second_events.load(Ordering::SeqCst) == 0 && start.elapsed() < Duration::from_secs(5)
        {
            std::thread::sleep(Duration::from_millis(20));
        }
        std::thread::sleep(Duration::from_millis(300));
        assert!(second_events.load(Ordering::SeqCst) >= 1);
        assert_eq!(first_events.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn the_last_issued_open_wins() {
        let older = tempfile::tempdir().unwrap();
        let newer = tempfile::tempdir().unwrap();
        let current = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::default());
        let current_root = state
            .open(current.path().to_str().unwrap(), |_| {})
            .unwrap();

        // Hold the open lock so both calls queue up, in a known order.
        let held = state.opening.lock().unwrap();
        let spawn_open = |dir: &tempfile::TempDir| {
            let state = Arc::clone(&state);
            let path = dir.path().to_str().unwrap().to_owned();
            std::thread::spawn(move || state.open(&path, |_| {}))
        };
        let wait_ticket = |n: u64| {
            let start = Instant::now();
            while state.latest_open.load(Ordering::SeqCst) < n {
                assert!(start.elapsed() < Duration::from_secs(5));
                std::thread::sleep(Duration::from_millis(5));
            }
        };
        let first = spawn_open(&older);
        wait_ticket(2);
        let second = spawn_open(&newer);
        wait_ticket(3);
        assert_eq!(state.root().unwrap(), current_root);
        drop(held);

        let first = first.join().unwrap();
        let second = second.join().unwrap();
        let superseded = first.unwrap_err();
        assert_eq!(superseded, AppError::Superseded);
        assert_eq!(superseded.kind(), "Superseded");
        let newer_root = second.unwrap();
        assert_eq!(newer_root, dunce::canonicalize(newer.path()).unwrap());
        assert_eq!(state.root().unwrap(), newer_root);
    }

    #[test]
    fn concurrent_opens_leave_one_consistent_workspace() {
        let dirs: Vec<_> = (0..8).map(|_| tempfile::tempdir().unwrap()).collect();
        let state = Arc::new(AppState::default());
        let handles: Vec<_> = dirs
            .iter()
            .map(|dir| {
                let state = Arc::clone(&state);
                let path = dir.path().to_str().unwrap().to_owned();
                std::thread::spawn(move || state.open(&path, |_| {}))
            })
            .collect();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let opened: Vec<PathBuf> = results.into_iter().filter_map(Result::ok).collect();
        assert!(!opened.is_empty());
        // Every call either opened its folder or was superseded, and the
        // open workspace is one of those that succeeded.
        assert!(opened.contains(&state.root().unwrap()));
    }

    #[test]
    fn workspaces_share_one_lock_per_folder() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let state = AppState::default();
        state.open(first.path().to_str().unwrap(), |_| {}).unwrap();
        let a = state.current().unwrap();
        assert!(state.is_current(&a));

        state.open(second.path().to_str().unwrap(), |_| {}).unwrap();
        let b = state.current().unwrap();
        assert!(!state.is_current(&a));
        assert!(state.is_current(&b));
        assert!(b.generation > a.generation);
        assert!(!Arc::ptr_eq(&a.lock, &b.lock));

        // Back to the first folder while `a` is still held: same lock.
        state.open(first.path().to_str().unwrap(), |_| {}).unwrap();
        let again = state.current().unwrap();
        assert!(Arc::ptr_eq(&a.lock, &again.lock));
        assert!(!state.is_current(&a));
        assert_eq!(again.root, a.root);

        // Locks nobody holds are dropped from the registry.
        drop((a, b, again));
        state.open(second.path().to_str().unwrap(), |_| {}).unwrap();
        let live = lock(&state.locks)
            .values()
            .filter(|weak| weak.strong_count() > 0)
            .count();
        assert_eq!(live, 1);
        assert!(lock(&state.locks).len() <= 2);
    }

    #[test]
    fn folders_with_the_same_key_share_the_lock() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let state = AppState::default();
        let same = |_: &Path| PathBuf::from("/repo/.git");
        state
            .open_keyed(first.path().to_str().unwrap(), same, |_| {})
            .unwrap();
        let a = state.current().unwrap();
        state
            .open_keyed(second.path().to_str().unwrap(), same, |_| {})
            .unwrap();
        let b = state.current().unwrap();
        assert_ne!(a.root, b.root);
        assert!(Arc::ptr_eq(&a.lock, &b.lock));
    }

    #[test]
    fn closed_state_is_never_current() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::default();
        state.open(dir.path().to_str().unwrap(), |_| {}).unwrap();
        let ws = state.current().unwrap();
        let other = AppState::default();
        assert!(!other.is_current(&ws));
    }

    #[test]
    fn poisoned_lock_is_recovered() {
        let state = Arc::new(AppState::default());
        let clone = Arc::clone(&state);
        let _ = std::thread::spawn(move || {
            let _guard = clone.workspace.lock().unwrap();
            panic!("poison the lock");
        })
        .join();
        assert_eq!(state.root(), Err(AppError::NoWorkspace));
    }
}
