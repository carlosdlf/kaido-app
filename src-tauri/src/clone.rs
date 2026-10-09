//! Onboarding git commands: detecting git and cloning a repository into a
//! new folder.
//!
//! A clone always goes into a folder this module creates, so cancelling it
//! (killing git) and removing the partial folder can never touch the user's
//! files.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::git::{Git, GitOptions, Mode};
use crate::paths;

/// Longest folder name accepted, in bytes.
pub const MAX_NAME_BYTES: usize = 255;
/// Longest repository URL accepted, in bytes.
pub const MAX_URL_BYTES: usize = 4096;

/// Result of `git_version`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitVersion {
    pub available: bool,
    /// For example `2.43.0`; `null` when git is not available.
    pub version: Option<String>,
}

/// Whether git can be run, and its version.
pub fn git_version(options: &GitOptions) -> GitVersion {
    let git = Git::new(options, &std::env::temp_dir());
    match git.run(Mode::Read, ["version"]) {
        Ok(out) if out.success => {
            let text = out.text();
            let version = text.strip_prefix("git version ").unwrap_or(&text).trim();
            GitVersion {
                available: true,
                version: Some(version.to_owned()),
            }
        }
        _ => GitVersion {
            available: false,
            version: None,
        },
    }
}

/// Clones in progress, so they can be cancelled. Managed as app state.
#[derive(Clone, Default)]
pub struct CloneControl {
    running: Arc<Running>,
}

#[derive(Default)]
struct Running {
    /// The cancel flag of each clone in progress.
    flags: Mutex<Vec<Arc<AtomicBool>>>,
    /// Notified whenever a clone finishes (after its cleanup).
    finished: Condvar,
}

/// Registration of one running clone; removed when dropped, which happens
/// only after a failed clone's folder was removed.
struct Ticket {
    control: CloneControl,
    cancel: Arc<AtomicBool>,
}

impl Ticket {
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        let running = &self.control.running;
        lock(&running.flags).retain(|flag| !Arc::ptr_eq(flag, &self.cancel));
        running.finished.notify_all();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl CloneControl {
    fn start(&self) -> Ticket {
        let cancel = Arc::new(AtomicBool::new(false));
        lock(&self.running.flags).push(Arc::clone(&cancel));
        Ticket {
            control: self.clone(),
            cancel,
        }
    }

    /// Cancels every clone in progress. Returns whether there was one.
    ///
    /// Each clone's thread notices within a few milliseconds, kills git with
    /// every process it started (see `git::ProcessTree`), removes the new
    /// folder and fails with `Cancelled`. A clone that has not started git
    /// yet never starts it.
    pub fn cancel_all(&self) -> bool {
        let flags = lock(&self.running.flags);
        for flag in flags.iter() {
            flag.store(true, Ordering::SeqCst);
        }
        !flags.is_empty()
    }

    /// Cancels every clone in progress (see [`CloneControl::cancel_all`])
    /// and waits up to `timeout` until each one has killed git and removed
    /// its folder. Used when the app exits, so no clone outlives it.
    /// Returns whether all of them finished in time.
    pub fn cancel_all_and_wait(&self, timeout: Duration) -> bool {
        self.cancel_all();
        let deadline = Instant::now() + timeout;
        let mut flags = lock(&self.running.flags);
        while !flags.is_empty() {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            flags = self
                .running
                .finished
                .wait_timeout(flags, left)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
        true
    }
}

/// Why `name` cannot be a folder name, if it cannot. `windows` adds the
/// Windows rules (reserved characters and device names, trailing dots and
/// spaces).
pub fn name_problem(name: &str, windows: bool) -> Option<&'static str> {
    if name.trim().is_empty() {
        return Some("the folder name is empty");
    }
    if name == "." || name == ".." {
        return Some("the folder name cannot be '.' or '..'");
    }
    if name.len() > MAX_NAME_BYTES {
        return Some("the folder name is too long");
    }
    if name.contains('/') || name.contains('\\') {
        return Some("the folder name cannot contain slashes");
    }
    if name.chars().any(char::is_control) {
        return Some("the folder name cannot contain control characters");
    }
    if windows {
        if name.contains(['<', '>', ':', '"', '|', '?', '*']) {
            return Some("the folder name cannot contain < > : \" | ? *");
        }
        if name.ends_with(['.', ' ']) {
            return Some("the folder name cannot end with a dot or a space");
        }
        let stem = name.split('.').next().unwrap_or(name).trim_end();
        let upper = stem.to_ascii_uppercase();
        let device = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ((upper.starts_with("COM") || upper.starts_with("LPT"))
                && upper.len() == 4
                && upper.as_bytes()[3].is_ascii_digit()
                && upper.as_bytes()[3] != b'0');
        if device {
            return Some("the folder name is reserved by Windows");
        }
    }
    None
}

/// Checks a folder name for this operating system.
pub fn validate_name(name: &str) -> AppResult<()> {
    match name_problem(name, cfg!(windows)) {
        Some(problem) => Err(AppError::InvalidPath(problem.into())),
        None => Ok(()),
    }
}

/// Checks a repository URL (or path) and returns it without surrounding
/// whitespace. Error messages never repeat the URL, which may hold a token.
pub fn validate_url(url: &str) -> AppResult<&str> {
    let url = url.trim();
    let invalid = |why: &str| {
        Err(AppError::InvalidPath(format!(
            "invalid repository URL: {why}"
        )))
    };
    if url.is_empty() {
        return invalid("it is empty");
    }
    if url.len() > MAX_URL_BYTES {
        return invalid("it is too long");
    }
    if url.chars().any(char::is_control) {
        return invalid("it contains control characters");
    }
    if url.starts_with('-') {
        return invalid("it cannot start with '-'");
    }
    Ok(url)
}

fn destination_parent(parent: &str) -> AppResult<PathBuf> {
    if parent.is_empty() || parent.contains('\0') || !Path::new(parent).is_absolute() {
        return Err(AppError::InvalidPath(
            "the destination folder must be an absolute path".into(),
        ));
    }
    let canonical = dunce::canonicalize(parent)
        .map_err(|e| AppError::from_io(&e, "open", "the destination folder"))?;
    if !canonical.is_dir() {
        return Err(AppError::NotADirectory(
            "the destination is not a folder".into(),
        ));
    }
    Ok(canonical)
}

/// Variables that would let a clone use transports the app disables:
/// `GIT_ALLOW_PROTOCOL` overrides `protocol.<name>.allow`.
pub const CLONE_STRIPPED_ENV: &[&str] = &["GIT_ALLOW_PROTOCOL", "GIT_PROTOCOL_FROM_USER"];

fn cancelled() -> AppError {
    AppError::Cancelled("the clone was cancelled".into())
}

/// Clones `url` into the new folder `parent/name` and returns its canonical
/// path.
///
/// The folder is created first and must not exist, nor be inside the open
/// `workspace` or contain it. Git runs with the network environment (no
/// prompts, batch SSH unless the user configured an SSH command), with the
/// `ext::` transport disabled and `GIT_ALLOW_PROTOCOL` removed, and is
/// killed with every process it started after
/// [`GitOptions::clone_timeout`] or when [`CloneControl::cancel_all`] is
/// called. On any failure the new folder is removed.
///
/// Errors: `InvalidPath` (URL, name, parent, or a destination overlapping
/// the open workspace), `NotFound` / `NotADirectory` (parent), `Conflict`
/// (destination exists), `Cancelled`, `GitUnavailable` (`git-missing`),
/// `GitAuth`, `GitNetwork` (also timeouts) and `GitFailed`, with sanitized
/// messages.
pub fn clone(
    options: &GitOptions,
    control: &CloneControl,
    workspace: Option<&Path>,
    url: &str,
    parent: &str,
    name: &str,
) -> AppResult<PathBuf> {
    let url = validate_url(url)?;
    validate_name(name)?;
    let parent = destination_parent(parent)?;
    let dest = parent.join(name);
    paths::refuse_workspace_overlap(&dest, workspace)?;
    // Registered before anything is created, so a cancel that arrives
    // while the folder is being set up is not lost.
    let ticket = control.start();
    if ticket.cancelled() {
        return Err(cancelled());
    }
    fs::create_dir(&dest).map_err(|e| match e.kind() {
        io::ErrorKind::AlreadyExists => {
            AppError::Conflict(format!("{name} already exists in the destination folder"))
        }
        _ => AppError::from_io(&e, "create", name),
    })?;
    let result = run_clone(options, &ticket, url, &parent, name, &dest);
    if result.is_err() {
        let _ = fs::remove_dir_all(&dest);
    }
    let was_cancelled = ticket.cancelled();
    // Only now, with the folder gone, does the clone count as finished.
    drop(ticket);
    match result {
        Err(_) if was_cancelled => Err(cancelled()),
        Err(err) => Err(err),
        Ok(()) => dunce::canonicalize(&dest).map_err(|e| AppError::from_io(&e, "open", name)),
    }
}

/// Whether the user configured `core.sshCommand` for clones: in the system
/// or global configuration, never in a repository around `dest` (git does
/// not look above `parent`).
fn ssh_command_configured(options: &GitOptions, parent: &Path, dest: &Path) -> AppResult<bool> {
    let mut probe_options = options.clone();
    probe_options
        .env
        .push(("GIT_CEILING_DIRECTORIES".into(), parent.as_os_str().into()));
    let probe =
        Git::new(&probe_options, dest).run(Mode::Read, ["config", "--get", "core.sshCommand"])?;
    Ok(probe.success && !probe.text().trim().is_empty())
}

fn run_clone(
    options: &GitOptions,
    ticket: &Ticket,
    url: &str,
    parent: &Path,
    name: &str,
    dest: &Path,
) -> AppResult<()> {
    let ssh_configured = ssh_command_configured(options, parent, dest)?;
    let mut clone_options = options.clone();
    clone_options.network_timeout = options.clone_timeout;
    clone_options
        .env
        .retain(|(key, _)| !CLONE_STRIPPED_ENV.iter().any(|k| key == k));
    clone_options
        .env_remove
        .extend(CLONE_STRIPPED_ENV.iter().map(Into::into));
    let mut git = Git::new(&clone_options, parent);
    git.set_ssh_configured(ssh_configured);
    git.set_stop(Arc::clone(&ticket.cancel));
    if ticket.cancelled() {
        return Err(cancelled());
    }
    let out = git.run(
        Mode::Network,
        [
            "-c",
            "protocol.ext.allow=never",
            "clone",
            "--quiet",
            "--",
            url,
            name,
        ],
    )?;
    if out.success {
        Ok(())
    } else {
        Err(git.failure(Mode::Network, "clone", &out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_env::{git, options};
    use std::time::{Duration, Instant};

    #[test]
    fn reports_the_git_version() {
        let version = git_version(&options());
        assert!(version.available);
        let text = version.version.unwrap();
        assert!(text.chars().next().unwrap().is_ascii_digit(), "{text}");
        let mut missing = options();
        missing.program = "kaido-no-such-git".into();
        assert_eq!(
            git_version(&missing),
            GitVersion {
                available: false,
                version: None
            }
        );
        assert_eq!(
            serde_json::to_value(git_version(&missing)).unwrap(),
            serde_json::json!({ "available": false, "version": null })
        );
    }

    #[test]
    fn folder_names() {
        for ok in ["notes", "my notes", ".notes", "notes.v2", "über", "CONSOLE"] {
            assert_eq!(name_problem(ok, true), None, "{ok}");
            assert_eq!(name_problem(ok, false), None, "{ok}");
        }
        for bad in ["", "  ", ".", "..", "a/b", "a\\b", "a\nb", "a\0b"] {
            assert!(name_problem(bad, false).is_some(), "{bad:?}");
            assert!(name_problem(bad, true).is_some(), "{bad:?}");
        }
        assert!(name_problem(&"x".repeat(256), false).is_some());
        assert_eq!(name_problem(&"x".repeat(255), false), None);
        for windows_only in [
            "a:b", "a?", "a*", "a|b", "<a>", "a\"", "notes.", "notes ", "CON", "con.md", "Nul",
            "COM1", "lpt9.txt", "aux .x",
        ] {
            assert_eq!(name_problem(windows_only, false), None, "{windows_only}");
            assert!(name_problem(windows_only, true).is_some(), "{windows_only}");
        }
        for fine in ["COM0", "COM10", "LPT", "COMA"] {
            assert_eq!(name_problem(fine, true), None, "{fine}");
        }
        assert_eq!(validate_name("ok"), Ok(()));
        assert_eq!(validate_name("..").unwrap_err().kind(), "InvalidPath");
    }

    #[test]
    fn urls() {
        assert_eq!(
            validate_url("  git@github.com:me/notes.git\n").unwrap(),
            "git@github.com:me/notes.git"
        );
        for bad in ["", "   ", "--upload-pack=x", "a\u{7}b", "https://h/a\nb"] {
            let err = validate_url(bad).unwrap_err();
            assert_eq!(err.kind(), "InvalidPath", "{bad:?}");
        }
        assert!(validate_url(&"x".repeat(MAX_URL_BYTES + 1)).is_err());
        let err = validate_url("-https://user:secret@h/x").unwrap_err();
        assert!(!err.to_string().contains("secret"));
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        base: PathBuf,
        remote: PathBuf,
        dest: PathBuf,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(dir.path()).unwrap();
        git(&base, &["init", "-q", "--bare", "-b", "main", "remote.git"]);
        git(&base, &["clone", "-q", "remote.git", "seed"]);
        fs::create_dir(base.join("seed/inbox")).unwrap();
        fs::write(base.join("seed/inbox/tasks.md"), "- [ ] a\n").unwrap();
        git(&base.join("seed"), &["add", "-A"]);
        git(&base.join("seed"), &["commit", "-q", "-m", "seed"]);
        git(&base.join("seed"), &["push", "-q", "origin", "HEAD:main"]);
        let dest = base.join("dest");
        fs::create_dir(&dest).unwrap();
        Fixture {
            remote: base.join("remote.git"),
            dest,
            base,
            _dir: dir,
        }
    }

    fn s(path: &Path) -> &str {
        path.to_str().unwrap()
    }

    #[test]
    fn clones_a_repository_into_a_new_folder() {
        let fx = fixture();
        let control = CloneControl::default();
        let root = clone(
            &options(),
            &control,
            None,
            s(&fx.remote),
            s(&fx.dest),
            "notes",
        )
        .unwrap();
        assert_eq!(root, fx.dest.join("notes"));
        assert_eq!(
            fs::read_to_string(root.join("inbox/tasks.md")).unwrap(),
            "- [ ] a\n"
        );
        assert_eq!(
            git(&root, &["rev-parse", "--abbrev-ref", "@{upstream}"]),
            "origin/main"
        );
        assert!(lock(&control.running.flags).is_empty());
        assert!(!control.cancel_all());
    }

    #[test]
    fn refuses_an_existing_destination() {
        let fx = fixture();
        fs::create_dir(fx.dest.join("taken")).unwrap();
        fs::write(fx.dest.join("taken/keep.md"), "mine").unwrap();
        let err = clone(
            &options(),
            &CloneControl::default(),
            None,
            s(&fx.remote),
            s(&fx.dest),
            "taken",
        )
        .unwrap_err();
        assert_eq!(err.kind(), "Conflict");
        assert_eq!(
            err.to_string(),
            "taken already exists in the destination folder"
        );
        assert_eq!(
            fs::read_to_string(fx.dest.join("taken/keep.md")).unwrap(),
            "mine"
        );
        // An empty folder counts too: it is the user's, not ours.
        fs::create_dir(fx.dest.join("empty")).unwrap();
        let err = clone(
            &options(),
            &CloneControl::default(),
            None,
            s(&fx.remote),
            s(&fx.dest),
            "empty",
        )
        .unwrap_err();
        assert_eq!(err.kind(), "Conflict");
        assert!(fx.dest.join("empty").is_dir());
    }

    #[test]
    fn validates_arguments_before_running_git() {
        let fx = fixture();
        let control = CloneControl::default();
        let run = |url: &str, parent: &str, name: &str| {
            clone(&options(), &control, None, url, parent, name)
                .unwrap_err()
                .kind()
        };
        assert_eq!(run("", s(&fx.dest), "x"), "InvalidPath");
        assert_eq!(run(s(&fx.remote), s(&fx.dest), "a/b"), "InvalidPath");
        assert_eq!(run(s(&fx.remote), "relative", "x"), "InvalidPath");
        assert_eq!(run(s(&fx.remote), "", "x"), "InvalidPath");
        assert_eq!(
            run(s(&fx.remote), s(&fx.base.join("missing")), "x"),
            "NotFound"
        );
        assert_eq!(
            run(s(&fx.remote), s(&fx.base.join("seed/inbox/tasks.md")), "x"),
            "NotADirectory"
        );
        assert_eq!(fs::read_dir(&fx.dest).unwrap().count(), 0);
    }

    #[test]
    fn failures_are_classified_and_clean_up() {
        let fx = fixture();
        let control = CloneControl::default();
        let attempt =
            |url: &str| clone(&options(), &control, None, url, s(&fx.dest), "notes").unwrap_err();

        let missing = attempt(s(&fx.base.join("no-such-repo")));
        assert_eq!(missing.kind(), "GitFailed", "{missing}");
        assert!(missing.to_string().starts_with("git clone failed"));
        assert!(!missing.to_string().contains(s(&fx.base)), "{missing}");

        let unreachable = attempt("https://user:s3cret@localhost:1/notes.git");
        assert_eq!(unreachable.kind(), "GitNetwork", "{unreachable}");
        assert!(!unreachable.to_string().contains("s3cret"), "{unreachable}");

        // `ext::` would run a command; it is always refused.
        let marker = fx.base.join("ran");
        let ext = attempt(&format!("ext::sh -c touch% {}", s(&marker)));
        assert_eq!(ext.kind(), "GitFailed", "{ext}");
        assert!(!marker.exists());

        assert!(!fx.dest.join("notes").exists());
        assert_eq!(fs::read_dir(&fx.dest).unwrap().count(), 0);
    }

    #[test]
    fn missing_git_is_unavailable_and_cleans_up() {
        let fx = fixture();
        let mut opts = options();
        opts.program = fx.base.join("no-git").into_os_string();
        let err = clone(
            &opts,
            &CloneControl::default(),
            None,
            s(&fx.remote),
            s(&fx.dest),
            "notes",
        )
        .unwrap_err();
        assert_eq!(err, AppError::GitUnavailable("git-missing".into()));
        assert!(!fx.dest.join("notes").exists());
    }

    #[cfg(unix)]
    fn slow_git(fx: &Fixture) -> GitOptions {
        use std::os::unix::fs::PermissionsExt;
        // Writes into the destination like a clone in progress, starts a
        // helper process (like `git-remote-https`) that records its pid next
        // to the destination, then hangs (only for `clone`; the config probe
        // answers at once).
        let script = fx.base.join("slow-git.sh");
        fs::write(
            &script,
            "#!/bin/sh\nfor a in \"$@\"; do last=\"$a\"; done\n\
             case \"$*\" in *clone*) mkdir -p \"$2/$last/.git\"; \
             sleep 30 & echo $! > \"$2/../helper.pid\"; \
             touch \"$2/$last/.git/partial\"; exec sleep 30;; esac\nexit 1\n",
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let mut opts = options();
        opts.program = script.into_os_string();
        opts
    }

    #[cfg(unix)]
    #[test]
    fn a_cancelled_clone_is_killed_and_removed() {
        let fx = fixture();
        let opts = slow_git(&fx);
        let control = CloneControl::default();
        let worker = {
            let control = control.clone();
            let dest = fx.dest.clone();
            std::thread::spawn(move || {
                clone(&opts, &control, None, "https://h/x.git", s(&dest), "notes")
            })
        };
        let partial = fx.dest.join("notes/.git/partial");
        let start = Instant::now();
        while !partial.exists() {
            assert!(start.elapsed() < Duration::from_secs(10));
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(control.cancel_all());
        let err = worker.join().unwrap().unwrap_err();
        assert_eq!(err, AppError::Cancelled("the clone was cancelled".into()));
        assert!(start.elapsed() < Duration::from_secs(10));
        assert!(!fx.dest.join("notes").exists());
        assert!(lock(&control.running.flags).is_empty());
        assert_helper_ended(&fx);
    }

    /// Whether process `pid` has ended (or is a zombie waiting to be reaped
    /// by its new parent).
    #[cfg(unix)]
    fn ended(pid: libc::pid_t) -> bool {
        // SAFETY: signal 0 only checks that the process exists.
        if unsafe { libc::kill(pid, 0) } != 0 {
            return true;
        }
        fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
            stat.rsplit_once(") ")
                .is_some_and(|(_, rest)| rest.starts_with('Z'))
        })
    }

    /// The helper started by [`slow_git`] was killed with git.
    #[cfg(unix)]
    fn assert_helper_ended(fx: &Fixture) {
        let pid: libc::pid_t = fs::read_to_string(fx.base.join("helper.pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let start = Instant::now();
        while !ended(pid) {
            assert!(
                start.elapsed() < Duration::from_secs(5),
                "the helper process {pid} is still running"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(unix)]
    fn start_slow_clone(
        fx: &Fixture,
        control: &CloneControl,
    ) -> std::thread::JoinHandle<AppResult<PathBuf>> {
        let opts = slow_git(fx);
        let control = control.clone();
        let dest = fx.dest.clone();
        let worker = std::thread::spawn(move || {
            clone(&opts, &control, None, "https://h/x.git", s(&dest), "notes")
        });
        let partial = fx.dest.join("notes/.git/partial");
        let start = Instant::now();
        while !partial.exists() {
            assert!(start.elapsed() < Duration::from_secs(10));
            std::thread::sleep(Duration::from_millis(10));
        }
        worker
    }

    #[cfg(unix)]
    #[test]
    fn exit_kills_clones_and_waits_for_their_cleanup() {
        let fx = fixture();
        let control = CloneControl::default();
        let worker = start_slow_clone(&fx, &control);
        let start = Instant::now();
        assert!(control.cancel_all_and_wait(Duration::from_secs(2)));
        assert!(start.elapsed() < Duration::from_secs(2));
        // Without joining the worker: by the time the wait returns, git and
        // its helpers are gone and so is the folder.
        assert!(!fx.dest.join("notes").exists());
        assert!(lock(&control.running.flags).is_empty());
        assert_helper_ended(&fx);
        assert_eq!(worker.join().unwrap().unwrap_err().kind(), "Cancelled");
    }

    #[test]
    fn waiting_for_clones_is_bounded() {
        let control = CloneControl::default();
        assert!(control.cancel_all_and_wait(Duration::from_secs(5)));
        let ticket = control.start();
        let start = Instant::now();
        assert!(!control.cancel_all_and_wait(Duration::from_millis(100)));
        assert!(start.elapsed() >= Duration::from_millis(100));
        assert!(ticket.cancelled());
        // Finishing wakes a waiter up early.
        let waiter = {
            let control = control.clone();
            std::thread::spawn(move || control.cancel_all_and_wait(Duration::from_secs(10)))
        };
        std::thread::sleep(Duration::from_millis(50));
        drop(ticket);
        assert!(waiter.join().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn a_clone_cancelled_before_git_starts_never_starts_it() {
        use std::os::unix::fs::PermissionsExt;
        let fx = fixture();
        // The configuration probe is slow; the clone itself leaves a mark.
        let script = fx.base.join("probe-git.sh");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\ncase \"$*\" in *clone*) touch '{ran}'; exit 1;; esac\n\
                 touch '{probing}'; sleep 1; exit 1\n",
                ran = s(&fx.base.join("clone-ran")),
                probing = s(&fx.base.join("probing")),
            ),
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let mut opts = options();
        opts.program = script.into_os_string();
        let control = CloneControl::default();
        let worker = {
            let control = control.clone();
            let dest = fx.dest.clone();
            std::thread::spawn(move || {
                clone(&opts, &control, None, "https://h/x.git", s(&dest), "notes")
            })
        };
        let start = Instant::now();
        while !fx.base.join("probing").exists() {
            assert!(start.elapsed() < Duration::from_secs(10));
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(control.cancel_all());
        let err = worker.join().unwrap().unwrap_err();
        assert_eq!(err.kind(), "Cancelled");
        assert!(!fx.base.join("clone-ran").exists());
        assert!(!fx.dest.join("notes").exists());
    }

    #[test]
    fn a_stopped_network_command_is_not_started() {
        let fx = fixture();
        let stop = Arc::new(AtomicBool::new(true));
        let mut git = Git::new(&options(), &fx.base);
        git.set_stop(Arc::clone(&stop));
        assert_eq!(
            git.run(Mode::Network, ["ls-remote", s(&fx.remote)])
                .unwrap_err(),
            crate::git::stopped()
        );
        // Local commands still run.
        assert!(git.run(Mode::Read, ["version"]).unwrap().success);
    }

    #[test]
    fn the_ssh_command_probe_ignores_repositories_around_the_destination() {
        let fx = fixture();
        // The destination's parent is a repository with its own SSH command.
        git(&fx.dest, &["init", "-q"]);
        git(&fx.dest, &["config", "core.sshCommand", "ssh -i repo-key"]);
        let new = fx.dest.join("notes");
        fs::create_dir(&new).unwrap();
        assert!(!ssh_command_configured(&options(), &fx.dest, &new).unwrap());
        // The user's global configuration counts.
        let global = fx.base.join("global.gitconfig");
        fs::write(&global, "[core]\n\tsshCommand = ssh -i my-key\n").unwrap();
        let mut opts = options();
        opts.env
            .push(("GIT_CONFIG_GLOBAL".into(), global.into_os_string()));
        assert!(ssh_command_configured(&opts, &fx.dest, &new).unwrap());
    }

    #[test]
    fn allowed_protocols_from_the_environment_are_ignored() {
        let fx = fixture();
        let mut opts = options();
        opts.env
            .push(("GIT_ALLOW_PROTOCOL".into(), "ext:file".into()));
        opts.env.push(("GIT_PROTOCOL_FROM_USER".into(), "1".into()));
        let marker = fx.base.join("ran");
        let err = clone(
            &opts,
            &CloneControl::default(),
            None,
            &format!("ext::sh -c touch% {}", s(&marker)),
            s(&fx.dest),
            "notes",
        )
        .unwrap_err();
        assert_eq!(err.kind(), "GitFailed", "{err}");
        assert!(!marker.exists());
        assert!(!fx.dest.join("notes").exists());
    }

    #[test]
    fn clones_must_not_overlap_the_open_workspace() {
        let fx = fixture();
        let control = CloneControl::default();
        let workspace = fx.dest.join("open");
        fs::create_dir(&workspace).unwrap();
        let err = clone(
            &options(),
            &control,
            Some(&workspace),
            s(&fx.remote),
            s(&workspace),
            "notes",
        )
        .unwrap_err();
        assert_eq!(err.kind(), "InvalidPath");
        assert!(
            err.to_string().contains("inside the open workspace"),
            "{err}"
        );
        assert!(!workspace.join("notes").exists());
        // A destination holding the workspace (it exists, so it would also
        // be refused as taken) is reported as overlapping first.
        let err = clone(
            &options(),
            &control,
            Some(&workspace),
            s(&fx.remote),
            s(&fx.base),
            "dest",
        )
        .unwrap_err();
        assert_eq!(err.kind(), "InvalidPath");
        assert!(
            err.to_string().contains("contains the open workspace"),
            "{err}"
        );
        // Next to the workspace is fine.
        let root = clone(
            &options(),
            &control,
            Some(&workspace),
            s(&fx.remote),
            s(&fx.dest),
            "notes",
        )
        .unwrap();
        assert_eq!(root, fx.dest.join("notes"));
    }

    #[cfg(unix)]
    #[test]
    fn a_clone_that_takes_too_long_is_a_network_error() {
        let fx = fixture();
        let mut opts = slow_git(&fx);
        opts.clone_timeout = Duration::from_millis(300);
        // The network timeout of other commands does not apply.
        opts.network_timeout = Duration::from_secs(60);
        let err = clone(
            &opts,
            &CloneControl::default(),
            None,
            "https://h/x.git",
            s(&fx.dest),
            "notes",
        )
        .unwrap_err();
        assert_eq!(err.kind(), "GitNetwork");
        assert!(!fx.dest.join("notes").exists());
    }
}
