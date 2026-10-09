//! Device settings: a single `settings.json` in the app config folder.
//!
//! The backend stores the raw text only; parsing, validation and migrations
//! happen in the frontend. [`SettingsWatcher`] reports edits made outside the
//! app (another editor, a dotfiles sync) so the frontend can reload them; the
//! app's own writes are recognized by their content hash and not reported.
//!
//! Writes are compare-and-swap ([`SettingsDir::write`]): the app only
//! replaces the version of the file it last read or wrote, so an outside
//! edit is never silently overwritten.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use notify::{RecursiveMode, Watcher};

use crate::error::{AppError, AppResult};
use crate::fs_ops;

pub const SETTINGS_FILE: &str = "settings.json";
/// Event emitted to the main window when the settings file changed outside
/// the app. It has no payload: the frontend reads the file again.
pub const CHANGED_EVENT: &str = "settings://changed";
/// Quiet time after the last file event before the file is checked.
pub const DEBOUNCE: Duration = Duration::from_millis(200);
/// Longest wait for quiet time while events keep coming.
pub const MAX_DELAY: Duration = Duration::from_secs(2);
/// Message of the `Conflict` returned by [`SettingsDir::write`].
pub const CONFLICT_MESSAGE: &str =
    "settings.json changed since it was last read; read it again and retry";

/// The version of the settings file the app last read or wrote, which is
/// the only one a write may replace.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Known {
    /// Nothing read or written yet.
    Unknown,
    /// The file did not exist.
    Missing,
    /// The file held contents with this hash.
    Hash(String),
}

#[derive(Debug)]
struct Seen {
    /// For compare-and-swap: what the frontend last received or wrote.
    known: Known,
    /// For the watcher: hash of the file as last written or reported by
    /// the app; `None` when it did not exist or could not be read.
    reported: Option<String>,
}

/// Folder holding `settings.json`, managed as app state, and the versions
/// of the file the app has seen. The app resolves the folder from the OS
/// app config folder at startup; tests point it at a temp folder.
#[derive(Clone)]
pub struct SettingsDir {
    path: PathBuf,
    /// Held while the app reads or writes the file, so the watcher and
    /// concurrent commands never see a write half recorded.
    seen: Arc<Mutex<Seen>>,
}

fn guard<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl SettingsDir {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            seen: Arc::new(Mutex::new(Seen {
                known: Known::Unknown,
                reported: None,
            })),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Returns the raw settings text (`None` if the file does not exist
    /// yet) and records what was returned as the version a later
    /// [`SettingsDir::write`] may replace. A file that is not valid UTF-8 is
    /// recorded too, so the app can replace it.
    pub fn read(&self) -> AppResult<Option<String>> {
        let mut seen = guard(&self.seen);
        match read_bytes(&self.path)? {
            None => {
                seen.known = Known::Missing;
                Ok(None)
            }
            Some(bytes) => {
                seen.known = Known::Hash(fs_ops::content_hash(&bytes));
                fs_ops::decode_utf8(bytes, SETTINGS_FILE).map(Some)
            }
        }
    }

    /// Replaces the settings with `contents` if the file is still the
    /// version the app last read or wrote (compare-and-swap), and
    /// remembers the contents so the watcher does not report this write.
    ///
    /// Fails with `Conflict` ([`CONFLICT_MESSAGE`]), writing nothing, when:
    /// - the file changed (or was created or deleted) since the app last
    ///   read or wrote it;
    /// - nothing was read or written yet and the file exists.
    ///
    /// A file that is still missing when the app last saw it missing is
    /// created.
    pub fn write(&self, contents: &str) -> AppResult<()> {
        let mut seen = guard(&self.seen);
        let current = match read_bytes(&self.path) {
            Ok(None) => Known::Missing,
            Ok(Some(bytes)) => Known::Hash(fs_ops::content_hash(&bytes)),
            // A folder that cannot be read is reported by the write below.
            Err(AppError::NotADirectory(_)) => Known::Missing,
            Err(err) => return Err(err),
        };
        let allowed = match &seen.known {
            Known::Unknown => current == Known::Missing,
            known => *known == current,
        };
        if !allowed {
            return Err(AppError::Conflict(CONFLICT_MESSAGE.into()));
        }
        write_settings(&self.path, contents)?;
        let hash = fs_ops::content_hash(contents.as_bytes());
        seen.reported = Some(hash.clone());
        seen.known = Known::Hash(hash);
        Ok(())
    }

    /// Hash of the file on disk now; `None` if it cannot be read.
    fn current_hash(&self) -> Option<String> {
        fs::read(self.path.join(SETTINGS_FILE))
            .ok()
            .map(|bytes| fs_ops::content_hash(&bytes))
    }

    /// Records the file as reported.
    fn remember_current(&self) {
        let current = self.current_hash();
        guard(&self.seen).reported = current;
    }

    /// Whether the file differs from what the app last reported; if so,
    /// the new state becomes the reported one, so each change is reported
    /// once. Does not change what a write may replace: the frontend reads
    /// the file again after the report.
    fn take_change(&self) -> bool {
        let mut seen = guard(&self.seen);
        let current = self.current_hash();
        if seen.reported == current {
            false
        } else {
            seen.reported = current;
            true
        }
    }
}

/// The settings bytes, or `None` if the file does not exist.
fn read_bytes(config_dir: &Path) -> AppResult<Option<Vec<u8>>> {
    match fs_ops::read_bytes(&config_dir.join(SETTINGS_FILE), SETTINGS_FILE) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(AppError::NotFound(_)) => Ok(None),
        Err(err) => Err(err),
    }
}

/// Atomically replaces the settings file, creating the config folder first.
pub fn write_settings(config_dir: &Path, contents: &str) -> AppResult<()> {
    fs::create_dir_all(config_dir)
        .map_err(|e: io::Error| AppError::from_io(&e, "create", "the settings folder"))?;
    fs_ops::atomic_write(
        &config_dir.join(SETTINGS_FILE),
        contents.as_bytes(),
        SETTINGS_FILE,
    )
}

/// Whether a file event may concern the settings file.
fn concerns_settings(event: &notify::Result<notify::Event>) -> bool {
    match event {
        Ok(event) => {
            event.need_rescan()
                || event
                    .paths
                    .iter()
                    .any(|p| p.file_name().is_some_and(|n| n == SETTINGS_FILE))
        }
        Err(_) => true,
    }
}

/// Watches the settings folder (not the file, which atomic writes replace)
/// and calls `emit` from a background thread when the file changed outside
/// the app. Stops when dropped.
pub struct SettingsWatcher {
    _watcher: notify::RecommendedWatcher,
}

impl SettingsWatcher {
    /// Creates the settings folder if needed and starts watching it.
    pub fn start<F>(settings: &SettingsDir, emit: F) -> AppResult<Self>
    where
        F: Fn() + Send + 'static,
    {
        Self::start_with(settings, DEBOUNCE, MAX_DELAY, emit)
    }

    fn start_with<F>(
        settings: &SettingsDir,
        debounce: Duration,
        max_delay: Duration,
        emit: F,
    ) -> AppResult<Self>
    where
        F: Fn() + Send + 'static,
    {
        fs::create_dir_all(settings.path())
            .map_err(|e| AppError::from_io(&e, "create", "the settings folder"))?;
        settings.remember_current();
        let (tx, rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = tx.send(event);
        })
        .map_err(|e| AppError::Io(format!("could not watch the settings folder: {e}")))?;
        watcher
            .watch(settings.path(), RecursiveMode::NonRecursive)
            .map_err(|e| AppError::Io(format!("could not watch the settings folder: {e}")))?;
        let settings = settings.clone();
        thread::Builder::new()
            .name("settings-watcher".into())
            .spawn(move || run(&rx, &settings, debounce, max_delay, &emit))
            .map_err(|e| AppError::Io(format!("could not start the settings watcher: {e}")))?;
        Ok(Self { _watcher: watcher })
    }
}

/// The watcher loop: waits for a relevant event, then for `debounce` of
/// quiet (at most `max_delay`), then reports a change if the contents
/// differ from what the app knows. Ends when the watcher is dropped.
fn run<F: Fn()>(
    rx: &mpsc::Receiver<notify::Result<notify::Event>>,
    settings: &SettingsDir,
    debounce: Duration,
    max_delay: Duration,
    emit: &F,
) {
    while let Ok(first) = rx.recv() {
        let mut relevant = concerns_settings(&first);
        let deadline = Instant::now() + max_delay;
        loop {
            let wait = debounce.min(deadline.saturating_duration_since(Instant::now()));
            match rx.recv_timeout(wait) {
                Ok(event) => relevant |= concerns_settings(&event),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        if relevant && settings.take_change() {
            emit();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn read_settings(config_dir: &Path) -> AppResult<Option<String>> {
        SettingsDir::new(config_dir.to_path_buf()).read()
    }

    #[test]
    fn missing_settings_read_as_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_settings(dir.path()).unwrap(), None);
        assert_eq!(
            read_settings(&dir.path().join("not-created")).unwrap(),
            None
        );
    }

    #[test]
    fn round_trips_and_creates_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("nested").join("config");
        write_settings(&config, r#"{"version":1}"#).unwrap();
        assert_eq!(
            read_settings(&config).unwrap().as_deref(),
            Some(r#"{"version":1}"#)
        );
        write_settings(&config, r#"{"version":2}"#).unwrap();
        assert_eq!(
            read_settings(&config).unwrap().as_deref(),
            Some(r#"{"version":2}"#)
        );
        let names: Vec<_> = fs::read_dir(&config)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, [SETTINGS_FILE]);
    }

    #[test]
    fn invalid_utf8_settings_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(SETTINGS_FILE), [0xc3, 0x28]).unwrap();
        assert_eq!(read_settings(dir.path()).unwrap_err().kind(), "InvalidUtf8");
    }

    #[test]
    fn config_folder_blocked_by_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("blocker");
        fs::write(&blocker, "x").unwrap();
        let err = write_settings(&blocker.join("config"), "{}").unwrap_err();
        assert!(matches!(err.kind(), "NotADirectory" | "Io"), "{err:?}");
        assert!(!err.to_string().contains(dir.path().to_str().unwrap()));
        let settings = SettingsDir::new(blocker.join("config"));
        assert!(settings.write("{}").is_err());
        assert_eq!(guard(&settings.seen).known, Known::Unknown);
        assert_eq!(guard(&settings.seen).reported, None);
        assert!(SettingsWatcher::start(&settings, || {}).is_err());
    }

    #[test]
    fn changes_are_taken_once_and_own_writes_are_known() {
        let dir = tempfile::tempdir().unwrap();
        let settings = SettingsDir::new(dir.path().to_path_buf());
        assert!(!settings.take_change());
        settings.write("{}").unwrap();
        assert!(!settings.take_change());
        fs::write(dir.path().join(SETTINGS_FILE), "{\"a\":1}").unwrap();
        assert!(settings.take_change());
        assert!(!settings.take_change());
        fs::remove_file(dir.path().join(SETTINGS_FILE)).unwrap();
        assert!(settings.take_change());
        assert!(!settings.take_change());
    }

    fn conflict(result: AppResult<()>) {
        assert_eq!(
            result.unwrap_err(),
            AppError::Conflict(CONFLICT_MESSAGE.into())
        );
    }

    #[test]
    fn writes_only_replace_the_version_last_read_or_written() {
        let dir = tempfile::tempdir().unwrap();
        let settings = SettingsDir::new(dir.path().to_path_buf());
        let file = dir.path().join(SETTINGS_FILE);
        let on_disk = || fs::read_to_string(&file).unwrap();

        // Read as missing: creating it is fine.
        assert_eq!(settings.read().unwrap(), None);
        settings.write("{\"a\":1}").unwrap();
        // The app's own write is the known version: writing again is fine.
        settings.write("{\"a\":2}").unwrap();
        assert_eq!(on_disk(), "{\"a\":2}");

        // Edited outside the app: the stale write is refused and changes
        // nothing.
        fs::write(&file, "{\"outside\":true}").unwrap();
        conflict(settings.write("{\"a\":3}"));
        assert_eq!(on_disk(), "{\"outside\":true}");
        // The watcher noticing the edit does not make the write allowed.
        assert!(settings.take_change());
        conflict(settings.write("{\"a\":3}"));
        // After reading it again, the write goes through.
        assert_eq!(
            settings.read().unwrap().as_deref(),
            Some("{\"outside\":true}")
        );
        settings.write("{\"a\":3}").unwrap();
        assert_eq!(on_disk(), "{\"a\":3}");
        assert!(!settings.take_change());

        // Deleted outside the app: refused until read again.
        fs::remove_file(&file).unwrap();
        conflict(settings.write("{\"a\":4}"));
        assert!(!file.exists());
        assert_eq!(settings.read().unwrap(), None);
        // Created outside the app after it was read as missing: refused.
        fs::write(&file, "{}").unwrap();
        conflict(settings.write("{\"a\":4}"));
        assert_eq!(on_disk(), "{}");
    }

    #[test]
    fn a_first_write_needs_a_read_unless_the_file_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(SETTINGS_FILE);
        // Nothing known and no file: allowed.
        let fresh = SettingsDir::new(dir.path().to_path_buf());
        fresh.write("{\"a\":1}").unwrap();

        // Nothing known and the file exists: refused.
        let other = SettingsDir::new(dir.path().to_path_buf());
        conflict(other.write("{\"b\":1}"));
        assert_eq!(fs::read_to_string(&file).unwrap(), "{\"a\":1}");
        // Equal to what the last read returned: allowed.
        assert_eq!(other.read().unwrap().as_deref(), Some("{\"a\":1}"));
        other.write("{\"b\":1}").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "{\"b\":1}");
        // The first handle's known version is now stale.
        conflict(fresh.write("{\"a\":2}"));
    }

    #[test]
    fn invalid_settings_can_be_replaced_after_reading_them() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(SETTINGS_FILE);
        fs::write(&file, [0xc3, 0x28]).unwrap();
        let settings = SettingsDir::new(dir.path().to_path_buf());
        conflict(settings.write("{}"));
        assert_eq!(settings.read().unwrap_err().kind(), "InvalidUtf8");
        settings.write("{}").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "{}");
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_settings_are_not_overwritten() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(SETTINGS_FILE);
        fs::write(&file, "{}").unwrap();
        let settings = SettingsDir::new(dir.path().to_path_buf());
        settings.read().unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read(&file).is_ok() {
            // Running with privileges that ignore permissions.
            return;
        }
        let err = settings.write("{\"a\":1}").unwrap_err();
        assert_eq!(err.kind(), "PermissionDenied");
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "{}");
    }

    #[test]
    fn event_filter() {
        let event = |path: &str| {
            Ok(notify::Event::new(notify::EventKind::Any).add_path(PathBuf::from(path)))
        };
        assert!(concerns_settings(&event("/c/settings.json")));
        assert!(!concerns_settings(&event("/c/.kaido-1-2.tmp")));
        assert!(!concerns_settings(&event("/c/settings.json.bak")));
        let rescan =
            notify::Event::new(notify::EventKind::Other).set_flag(notify::event::Flag::Rescan);
        assert!(concerns_settings(&Ok(rescan)));
        assert!(concerns_settings(&Err(notify::Error::generic("x"))));
    }

    struct Watched {
        _dir: tempfile::TempDir,
        settings: SettingsDir,
        count: Arc<AtomicUsize>,
        _watcher: SettingsWatcher,
    }

    fn watched(debounce: Duration) -> Watched {
        let dir = tempfile::tempdir().unwrap();
        let settings = SettingsDir::new(dir.path().join("config"));
        let count = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&count);
        let watcher = SettingsWatcher::start_with(&settings, debounce, MAX_DELAY, move || {
            counter.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
        Watched {
            _dir: dir,
            settings,
            count,
            _watcher: watcher,
        }
    }

    fn wait_for_count(count: &AtomicUsize, expected: usize) {
        let start = Instant::now();
        while count.load(Ordering::SeqCst) < expected && start.elapsed() < Duration::from_secs(5) {
            thread::sleep(Duration::from_millis(10));
        }
        // Give a late duplicate the chance to show up.
        thread::sleep(Duration::from_millis(400));
        assert_eq!(count.load(Ordering::SeqCst), expected);
    }

    #[test]
    fn outside_edits_are_reported_once_after_quiet_time() {
        let w = watched(DEBOUNCE);
        let file = w.settings.path().join(SETTINGS_FILE);
        // Several quick writes, as an editor saving twice, give one event.
        for n in 0..5 {
            fs::write(&file, format!("{{\"n\":{n}}}")).unwrap();
            thread::sleep(Duration::from_millis(20));
        }
        wait_for_count(&w.count, 1);
        // Atomic replacement by another tool.
        let temp = w.settings.path().join("settings.json.new");
        fs::write(&temp, "{\"n\":9}").unwrap();
        fs::rename(&temp, &file).unwrap();
        wait_for_count(&w.count, 2);
        // Touching the file without changing it reports nothing.
        fs::write(&file, "{\"n\":9}").unwrap();
        wait_for_count(&w.count, 2);
        // Other files in the folder are ignored.
        fs::write(w.settings.path().join("other.json"), "x").unwrap();
        wait_for_count(&w.count, 2);
    }

    #[test]
    fn the_apps_own_writes_are_not_reported() {
        let w = watched(Duration::from_millis(100));
        w.settings.write("{\"version\":1}").unwrap();
        w.settings
            .write("{\"version\":1,\"autoSync\":false}")
            .unwrap();
        wait_for_count(&w.count, 0);
        fs::write(w.settings.path().join(SETTINGS_FILE), "{}").unwrap();
        wait_for_count(&w.count, 1);
        assert_eq!(w.settings.read().unwrap().as_deref(), Some("{}"));
        w.settings.write("{\"version\":1}").unwrap();
        wait_for_count(&w.count, 1);
    }

    #[test]
    fn existing_settings_are_not_reported_at_start() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(SETTINGS_FILE), "{}").unwrap();
        let settings = SettingsDir::new(dir.path().to_path_buf());
        let _watcher = SettingsWatcher::start(&settings, || {}).unwrap();
        assert!(!settings.take_change());
    }
}
