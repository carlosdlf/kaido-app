//! Running the system `git` binary.
//!
//! Every call goes through [`Git::run`]: `git` from `PATH` with explicit
//! arguments (never a shell), `-C <workspace root>` and a fixed environment
//! that keeps it from prompting. Commands that only read, and network
//! commands, are killed (with their process group) when they time out.
//! Commands that write to the repository are never killed: after a long
//! timeout they are asked to stop (`SIGTERM`, which git handles by removing
//! its lock files) and waited for. Output that reaches the frontend goes
//! through [`sanitize`] first.
//!
//! The user's own git setup (identity, hooks, signing, credential helpers,
//! SSH agent and configuration) is used as is.

use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use crate::error::{AppError, AppResult};

/// Timeout of commands that only read the repository.
pub const LOCAL_TIMEOUT: Duration = Duration::from_secs(10);
/// Timeout of commands that talk to a remote (`fetch`, `push`).
pub const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);
/// After this long a command that writes to the repository is asked to stop
/// (`SIGTERM` on Unix; elsewhere it is waited for without a limit).
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(600);
/// An old `index.lock` is checked again after this long before it is
/// reported, so a git command of another tool that just finished is not.
pub const INDEX_LOCK_RECHECK: Duration = Duration::from_millis(1500);
/// How long to wait for output after a writing command exited, in case a
/// process it started still holds the pipes.
const WRITE_OUTPUT_GRACE: Duration = Duration::from_secs(5);
/// SSH command used when the user has not configured one, so SSH fails
/// instead of asking for a password or passphrase nobody can type.
pub const DEFAULT_SSH_COMMAND: &str = "ssh -o BatchMode=yes";
/// Longest message (in characters) built from git output.
pub const MAX_MESSAGE_CHARS: usize = 500;

/// How git is started. The app uses [`GitOptions::default`]; tests point it at
/// an isolated configuration, a missing binary or shorter timeouts.
#[derive(Debug, Clone)]
pub struct GitOptions {
    /// The program to run, looked up in `PATH`.
    pub program: OsString,
    /// Extra environment variables, applied after the fixed ones.
    pub env: Vec<(OsString, OsString)>,
    /// Inherited environment variables to remove.
    pub env_remove: Vec<OsString>,
    /// See [`LOCAL_TIMEOUT`].
    pub local_timeout: Duration,
    /// See [`NETWORK_TIMEOUT`].
    pub network_timeout: Duration,
    /// See [`WRITE_TIMEOUT`].
    pub write_timeout: Duration,
    /// See [`INDEX_LOCK_RECHECK`].
    pub index_lock_recheck: Duration,
}

impl Default for GitOptions {
    fn default() -> Self {
        Self {
            program: OsString::from("git"),
            env: Vec::new(),
            env_remove: Vec::new(),
            local_timeout: LOCAL_TIMEOUT,
            network_timeout: NETWORK_TIMEOUT,
            write_timeout: WRITE_TIMEOUT,
            index_lock_recheck: INDEX_LOCK_RECHECK,
        }
    }
}

/// What a git command does, which decides its timeout and environment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Only reads the repository: runs with `GIT_OPTIONAL_LOCKS=0` so it
    /// never takes locks a concurrent git command of the user might need.
    /// Killed after [`LOCAL_TIMEOUT`].
    Read,
    /// Changes the repository (`add`, `commit`, `rebase`…), possibly running
    /// hooks or signing. Never killed; see [`WRITE_TIMEOUT`].
    Write,
    /// Talks to a remote (`fetch`, `push`). Killed after
    /// [`NETWORK_TIMEOUT`] or when the app closes. Failures are classified as
    /// network or authentication errors when stderr says so.
    Network,
}

/// Result of a git process that ran to completion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Output {
    pub success: bool,
    pub stdout: Vec<u8>,
    /// Lossy UTF-8; only used for messages and pattern matching.
    pub stderr: String,
}

impl Output {
    /// Stdout as text, lossy and without the trailing newline.
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout)
            .trim_end_matches(['\n', '\r'])
            .to_owned()
    }
}

/// A git runner bound to one workspace folder.
#[derive(Debug, Clone)]
pub struct Git {
    options: GitOptions,
    root: PathBuf,
    /// Whether the user configured `core.sshCommand`; see [`Git::set_ssh_configured`].
    ssh_configured: bool,
    /// When set, a network command in flight is killed (the app is closing).
    stop: Option<Arc<AtomicBool>>,
}

/// The error of an operation stopped because the app is closing.
pub fn stopped() -> AppError {
    AppError::GitFailed("stopped because the app is closing".into())
}

impl Git {
    pub fn new(options: &GitOptions, root: &Path) -> Self {
        Self {
            options: options.clone(),
            root: root.to_path_buf(),
            ssh_configured: false,
            stop: None,
        }
    }

    /// The workspace folder git runs in.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Records whether the repository configuration sets `core.sshCommand`,
    /// in which case [`DEFAULT_SSH_COMMAND`] is not applied.
    pub fn set_ssh_configured(&mut self, configured: bool) {
        self.ssh_configured = configured;
    }

    /// Kills [`Mode::Network`] commands as soon as `stop` is set. Local
    /// commands always run to completion so the repository is never left
    /// half-written.
    pub fn set_stop(&mut self, stop: Arc<AtomicBool>) {
        self.stop = Some(stop);
    }

    fn stopping(&self, mode: Mode) -> bool {
        mode == Mode::Network
            && self
                .stop
                .as_ref()
                .is_some_and(|stop| stop.load(Ordering::SeqCst))
    }

    /// Value of an environment variable as git will see it.
    pub fn env_var(&self, key: &str) -> Option<OsString> {
        self.options
            .env
            .iter()
            .rev()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
            .or_else(|| {
                let removed = self.options.env_remove.iter().any(|k| k == key);
                if removed { None } else { std::env::var_os(key) }
            })
            .filter(|v| !v.is_empty())
    }

    /// Whether network commands get [`DEFAULT_SSH_COMMAND`]: only when
    /// neither `GIT_SSH_COMMAND`, `GIT_SSH` nor `core.sshCommand` is set.
    pub fn uses_default_ssh(&self) -> bool {
        !self.ssh_configured
            && self.env_var("GIT_SSH_COMMAND").is_none()
            && self.env_var("GIT_SSH").is_none()
    }

    fn timeout(&self, mode: Mode) -> Duration {
        match mode {
            Mode::Read => self.options.local_timeout,
            Mode::Write => self.options.write_timeout,
            Mode::Network => self.options.network_timeout,
        }
    }

    fn command<I, S>(&self, mode: Mode, args: I) -> Command
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut cmd = Command::new(&self.options.program);
        cmd.arg("-C")
            .arg(&self.root)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .env("LANGUAGE", "C")
            // Nothing may open an editor: rebase --continue reuses messages.
            .env("GIT_EDITOR", "true")
            .env("GIT_SEQUENCE_EDITOR", "true")
            .env("GIT_MERGE_AUTOEDIT", "no");
        // Inherited variables that would point git at another repository or
        // inject configuration.
        for key in STRIPPED_ENV {
            cmd.env_remove(key);
        }
        for (key, _) in std::env::vars_os() {
            if is_config_env(&key) {
                cmd.env_remove(key);
            }
        }
        if mode == Mode::Read {
            cmd.env("GIT_OPTIONAL_LOCKS", "0");
        }
        for key in &self.options.env_remove {
            cmd.env_remove(key);
        }
        for (key, value) in &self.options.env {
            cmd.env(key, value);
        }
        if mode == Mode::Network && self.uses_default_ssh() {
            cmd.env("GIT_SSH_COMMAND", DEFAULT_SSH_COMMAND);
        }
        detach(&mut cmd);
        cmd
    }

    /// Runs git with `args` and waits for it.
    ///
    /// A non-zero exit is not an error here (see [`Output::success`]). Errors:
    /// - `GitUnavailable("git-missing")` if git cannot be found;
    /// - `GitNetwork` if a [`Mode::Read`] or [`Mode::Network`] command timed
    ///   out (it is killed with its children);
    /// - `GitFailed` if a [`Mode::Write`] command timed out (it was asked to
    ///   stop and has exited), if a network command was stopped because the
    ///   app is closing, or if git could not be started or watched.
    pub fn run<I, S>(&self, mode: Mode, args: I) -> AppResult<Output>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut cmd = self.command(mode, args);
        let mut child = spawn(&mut cmd).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AppError::GitUnavailable("git-missing".into())
            } else {
                AppError::GitFailed(format!("could not run git: {e}"))
            }
        })?;
        let timeout = self.timeout(mode);
        let deadline = Instant::now() + timeout;
        let stdout = child.stdout.take().map(read_all);
        let stderr = child.stderr.take().map(read_all);
        let timed_out =
            || AppError::GitNetwork(format!("git timed out after {} s", timeout.as_secs()));

        let mut poll = Duration::from_millis(1);
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {}
                Err(e) => {
                    kill(&mut child);
                    return Err(AppError::GitFailed(format!("could not wait for git: {e}")));
                }
            }
            if self.stopping(mode) {
                kill(&mut child);
                return Err(stopped());
            }
            if Instant::now() >= deadline {
                if mode == Mode::Write {
                    terminate(&mut child);
                    return Err(AppError::GitFailed(format!(
                        "git took longer than {} s and was stopped",
                        timeout.as_secs()
                    )));
                }
                kill(&mut child);
                return Err(timed_out());
            }
            std::thread::sleep(poll);
            poll = (poll * 2).min(Duration::from_millis(20));
        };
        // A child of git (a hook, ssh) may still hold the pipes open.
        let grace = if mode == Mode::Write {
            WRITE_OUTPUT_GRACE
        } else {
            deadline.saturating_duration_since(Instant::now())
        };
        let wait_until = Instant::now() + grace;
        let collect = |rx: Option<mpsc::Receiver<Vec<u8>>>| -> Option<Vec<u8>> {
            match rx {
                Some(rx) => rx
                    .recv_timeout(wait_until.saturating_duration_since(Instant::now()))
                    .ok(),
                None => Some(Vec::new()),
            }
        };
        let (stdout, stderr) = match (collect(stdout), collect(stderr)) {
            (Some(stdout), Some(stderr)) => (stdout, stderr),
            // A writing command has finished its work: keep its exit status
            // and leave the stray process alone.
            (stdout, stderr) if mode == Mode::Write => {
                (stdout.unwrap_or_default(), stderr.unwrap_or_default())
            }
            _ => {
                kill(&mut child);
                return Err(timed_out());
            }
        };
        Ok(Output {
            success: status.success(),
            stdout,
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        })
    }

    /// Runs git and fails unless it exits successfully, classifying the
    /// failure with [`Git::failure`].
    pub fn ok<I, S>(&self, mode: Mode, action: &str, args: I) -> AppResult<Output>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let out = self.run(mode, args)?;
        if out.success {
            Ok(out)
        } else {
            Err(self.failure(mode, action, &out))
        }
    }

    /// The error for a failed git command (see [`classify`]).
    pub fn failure(&self, mode: Mode, action: &str, out: &Output) -> AppError {
        classify(mode, action, &out.stderr, &self.root)
    }

    /// [`sanitize`] for this workspace.
    pub fn sanitize(&self, text: &str) -> String {
        sanitize(text, &self.root)
    }
}

/// Starts `cmd`, retrying briefly if the program file is momentarily busy
/// (`ETXTBSY`: another process still had it open for writing when it was
/// started, e.g. a script that was just written).
#[cfg(unix)]
fn spawn(cmd: &mut Command) -> std::io::Result<Child> {
    let mut attempts = 0;
    loop {
        match cmd.spawn() {
            Err(e) if e.raw_os_error() == Some(libc::ETXTBSY) && attempts < 50 => {
                attempts += 1;
                std::thread::sleep(Duration::from_millis(10));
            }
            other => return other,
        }
    }
}

#[cfg(not(unix))]
fn spawn(cmd: &mut Command) -> std::io::Result<Child> {
    cmd.spawn()
}

fn read_all<R: Read + Send + 'static>(mut reader: R) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = reader.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    rx
}

/// Starts git in its own process group (Unix) so a timeout can stop the
/// helpers it started too (`ssh`, credential helpers, hooks), and without a
/// console window (Windows).
#[cfg(unix)]
fn detach(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
}

#[cfg(windows)]
fn detach(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(any(unix, windows)))]
fn detach(_cmd: &mut Command) {}

/// Variables removed from git's environment: they would point it at another
/// repository or object store, or inject configuration.
const STRIPPED_ENV: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_PREFIX",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
];

/// `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`.
fn is_config_env(key: &OsStr) -> bool {
    key.to_str()
        .is_some_and(|k| k.starts_with("GIT_CONFIG_KEY_") || k.starts_with("GIT_CONFIG_VALUE_"))
}

/// Asks a writing command (and the hooks it started) to stop, then waits for
/// it to exit. Git removes its lock files when it receives `SIGTERM`. Never
/// kills: on platforms without `SIGTERM` it only waits.
fn terminate(child: &mut Child) {
    #[cfg(unix)]
    if let Ok(pid) = libc::pid_t::try_from(child.id()) {
        // SAFETY: `kill` has no memory-safety preconditions. The group id is
        // the pid of our own child, which has not been reaped yet.
        unsafe {
            libc::kill(-pid, libc::SIGTERM);
        }
    }
    let _ = child.wait();
}

/// Kills a reading or network command with its process group.
fn kill(child: &mut Child) {
    #[cfg(unix)]
    if let Ok(pid) = libc::pid_t::try_from(child.id()) {
        // SAFETY: `kill` has no memory-safety preconditions. The group id is
        // the pid of our own child, which has not been reaped yet (we only
        // reap it below), so the group cannot belong to anyone else.
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Stderr fragments (lowercase) that mean the remote refused our
/// credentials. Checked before [`NETWORK_PATTERNS`].
pub const AUTH_PATTERNS: &[&str] = &[
    "permission denied",
    "authentication failed",
    "could not read username",
    "could not read password",
    "terminal prompts disabled",
    "invalid username or password",
    "invalid credentials",
    "bad credentials",
    "access denied",
    "host key verification failed",
    "returned error: 401",
    "returned error: 403",
    "repository not found",
];

/// Stderr fragments (lowercase) that mean the remote could not be reached.
pub const NETWORK_PATTERNS: &[&str] = &[
    "could not resolve host",
    "name or service not known",
    "temporary failure in name resolution",
    "nodename nor servname",
    "no address associated",
    "network is unreachable",
    "no route to host",
    "connection refused",
    "connection timed out",
    "operation timed out",
    "timed out",
    "connection reset",
    "connection closed",
    "failed to connect",
    "couldn't connect",
    "could not connect",
    "unable to access",
    "remote end hung up",
    "early eof",
    "does not appear to be a git repository",
    "could not read from remote repository",
];

/// Turns the stderr of a failed git command into an error.
///
/// For [`Mode::Network`] commands, stderr is matched (case-insensitively)
/// against [`AUTH_PATTERNS`] (`GitAuth`) and then [`NETWORK_PATTERNS`]
/// (`GitNetwork`). Everything else is `GitFailed`. The message is
/// `git <action> failed: <sanitized stderr>`.
pub fn classify(mode: Mode, action: &str, stderr: &str, root: &Path) -> AppError {
    let detail = sanitize(stderr, root);
    let message = if detail.is_empty() {
        format!("git {action} failed")
    } else {
        format!("git {action} failed: {detail}")
    };
    let message = truncate(&message);
    if mode == Mode::Network {
        let lower = stderr.to_lowercase();
        if AUTH_PATTERNS.iter().any(|p| lower.contains(p)) {
            return AppError::GitAuth(message);
        }
        if NETWORK_PATTERNS.iter().any(|p| lower.contains(p)) {
            return AppError::GitNetwork(message);
        }
    }
    AppError::GitFailed(message)
}

/// Makes git output safe to show:
/// - `hint:` lines are dropped and blank lines removed;
/// - credentials in URLs (`https://user:token@host`) are removed and
///   `file://` URLs are replaced by `<path>`;
/// - the workspace root is removed from paths inside it (they become
///   workspace-relative) and every other absolute path becomes `<path>`;
/// - the result is cut to [`MAX_MESSAGE_CHARS`] characters.
pub fn sanitize(text: &str, root: &Path) -> String {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("hint:"))
        .collect();
    let text = strip_url_credentials(&lines.join("\n"));
    let text = relativize(&text, root);
    truncate(&scrub_absolute_paths(&text))
}

fn truncate(text: &str) -> String {
    if text.chars().count() <= MAX_MESSAGE_CHARS {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(MAX_MESSAGE_CHARS - 1).collect();
    out.push('…');
    out
}

fn is_token_end(c: char) -> bool {
    c.is_whitespace() || matches!(c, '\'' | '"' | '`' | ')' | ']' | '>' | ',' | ';')
}

fn strip_url_credentials(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find("://") {
        let scheme_start = rest[..pos]
            .rfind(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')))
            .map_or(0, |i| i + 1);
        let scheme = &rest[scheme_start..pos];
        let after = &rest[pos + 3..];
        let url_end = after.find(is_token_end).unwrap_or(after.len());
        if scheme.eq_ignore_ascii_case("file") {
            out.push_str(&rest[..scheme_start]);
            out.push_str("<path>");
            rest = &after[url_end..];
            continue;
        }
        let authority_end = after[..url_end].find('/').unwrap_or(url_end);
        out.push_str(&rest[..pos + 3]);
        let host_start = after[..authority_end].rfind('@').map_or(0, |at| at + 1);
        out.push_str(&strip_secret_params(&after[host_start..url_end]));
        rest = &after[url_end..];
    }
    out.push_str(rest);
    out
}

/// Query parameters (lowercase names) removed from URLs.
const SECRET_PARAMS: &[&str] = &["access_token", "token", "password", "private_token"];

/// Removes [`SECRET_PARAMS`] from the query of a URL without its scheme.
fn strip_secret_params(url: &str) -> String {
    let Some((base, query)) = url.split_once('?') else {
        return url.to_owned();
    };
    let kept: Vec<&str> = query
        .split('&')
        .filter(|param| {
            let name = param.split('=').next().unwrap_or(param);
            !SECRET_PARAMS.contains(&name.to_ascii_lowercase().as_str())
        })
        .collect();
    if kept.is_empty() {
        base.to_owned()
    } else {
        format!("{base}?{}", kept.join("&"))
    }
}

/// Removes the workspace root from paths inside it. Both separators are
/// tried: git prints `/` on every platform.
fn relativize(text: &str, root: &Path) -> String {
    let native = root.to_string_lossy().into_owned();
    if native.is_empty() || native == "/" {
        return text.to_owned();
    }
    let mut forms = vec![native.clone()];
    let slashed = native.replace('\\', "/");
    if slashed != native {
        forms.push(slashed);
    }
    let mut text = text.to_owned();
    for form in forms {
        for sep in ['/', '\\'] {
            text = text.replace(&format!("{form}{sep}"), "");
        }
        text = replace_whole(&text, &form, "the workspace");
    }
    text
}

/// Replaces `needle` where it is not followed by a path character.
fn replace_whole(text: &str, needle: &str, with: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find(needle) {
        let after = &rest[pos + needle.len()..];
        out.push_str(&rest[..pos]);
        if after
            .chars()
            .next()
            .is_none_or(|c| is_token_end(c) || c == ':')
        {
            out.push_str(with);
        } else {
            out.push_str(needle);
        }
        rest = after;
    }
    out.push_str(rest);
    out
}

/// Replaces absolute paths (`/a/b`, `C:\a`, `C:/a`) that start a token.
fn scrub_absolute_paths(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let starts_token = i == 0
            || chars[i - 1].is_whitespace()
            || matches!(chars[i - 1], '\'' | '"' | '`' | '(' | '[' | '<' | '=');
        let unix = chars[i] == '/' && chars.get(i + 1).is_some_and(|c| !is_token_end(*c));
        let windows = chars[i].is_ascii_alphabetic()
            && chars.get(i + 1) == Some(&':')
            && chars.get(i + 2).is_some_and(|c| matches!(c, '\\' | '/'));
        if starts_token && (unix || windows) {
            out.push_str("<path>");
            while i < chars.len() && !is_token_end(chars[i]) {
                i += 1;
            }
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

#[cfg(test)]
pub mod test_env {
    //! Git isolated from the user's configuration, for tests.

    use super::*;

    /// Options that ignore the global and system git configuration and give
    /// commits a fixed identity.
    pub fn options() -> GitOptions {
        let mut options = bare_options();
        options.env.extend(
            [
                ("GIT_AUTHOR_NAME", "Test"),
                ("GIT_AUTHOR_EMAIL", "test@example.com"),
                ("GIT_COMMITTER_NAME", "Test"),
                ("GIT_COMMITTER_EMAIL", "test@example.com"),
            ]
            .map(|(k, v)| (OsString::from(k), OsString::from(v))),
        );
        options
    }

    /// Like [`options`] but without an identity.
    pub fn bare_options() -> GitOptions {
        GitOptions {
            env: [
                ("GIT_CONFIG_GLOBAL", "/dev/null"),
                ("GIT_CONFIG_NOSYSTEM", "1"),
            ]
            .map(|(k, v)| (OsString::from(k), OsString::from(v)))
            .to_vec(),
            env_remove: [
                "GIT_AUTHOR_NAME",
                "GIT_AUTHOR_EMAIL",
                "GIT_COMMITTER_NAME",
                "GIT_COMMITTER_EMAIL",
                "EMAIL",
                "GIT_SSH_COMMAND",
                "GIT_SSH",
            ]
            .map(OsString::from)
            .to_vec(),
            ..GitOptions::default()
        }
    }

    /// Runs git in `dir` with [`options`] and panics on failure.
    pub fn git(dir: &Path, args: &[&str]) -> String {
        let out = Git::new(&options(), dir).run(Mode::Write, args).unwrap();
        assert!(out.success, "git {args:?} failed: {}", out.stderr);
        out.text()
    }
}

#[cfg(test)]
mod tests {
    use super::test_env::{git, options};
    use super::*;

    fn root() -> PathBuf {
        PathBuf::from("/home/me/notes")
    }

    #[test]
    fn runs_git_with_a_controlled_environment() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q", "-b", "main"]);
        let runner = Git::new(&options(), dir.path());
        assert_eq!(runner.root(), dir.path());
        let out = runner.run(Mode::Read, ["var", "GIT_EDITOR"]).unwrap();
        assert!(out.success);
        assert_eq!(out.text(), "true");
        let out = runner
            .run(Mode::Read, ["rev-parse", "--show-toplevel"])
            .unwrap();
        assert_eq!(
            dunce::canonicalize(out.text()).unwrap(),
            dunce::canonicalize(dir.path()).unwrap()
        );
        let failed = runner
            .run(Mode::Read, ["rev-parse", "--verify", "nope"])
            .unwrap();
        assert!(!failed.success);
        let err = runner
            .ok(Mode::Read, "rev-parse", ["rev-parse", "--verify", "nope"])
            .unwrap_err();
        assert_eq!(err.kind(), "GitFailed");
        assert!(err.to_string().starts_with("git rev-parse failed"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn network_commands_get_the_batch_ssh_command_unless_configured() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("env.sh");
        std::fs::write(&script, "#!/bin/sh\nprintf '%s|%s|%s' \"$GIT_SSH_COMMAND\" \"$GIT_OPTIONAL_LOCKS\" \"$GIT_TERMINAL_PROMPT\"\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut opts = options();
        opts.program = script.into_os_string();
        let mut runner = Git::new(&opts, dir.path());
        assert!(runner.uses_default_ssh());
        assert_eq!(
            runner.run(Mode::Network, ["fetch"]).unwrap().text(),
            "ssh -o BatchMode=yes||0"
        );
        assert_eq!(runner.run(Mode::Read, ["status"]).unwrap().text(), "|0|0");
        assert_eq!(runner.run(Mode::Write, ["add"]).unwrap().text(), "||0");

        runner.set_ssh_configured(true);
        assert!(!runner.uses_default_ssh());
        assert_eq!(runner.run(Mode::Network, ["fetch"]).unwrap().text(), "||0");

        let mut opts = opts.clone();
        opts.env.push(("GIT_SSH_COMMAND".into(), "my-ssh".into()));
        let runner = Git::new(&opts, dir.path());
        assert!(!runner.uses_default_ssh());
        assert_eq!(runner.env_var("GIT_SSH_COMMAND").unwrap(), "my-ssh");
        assert_eq!(
            runner.run(Mode::Network, ["fetch"]).unwrap().text(),
            "my-ssh||0"
        );
    }

    #[test]
    fn missing_git_is_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let mut opts = options();
        opts.program = dir.path().join("no-such-git").into_os_string();
        let err = Git::new(&opts, dir.path())
            .run(Mode::Read, ["version"])
            .unwrap_err();
        assert_eq!(err, AppError::GitUnavailable("git-missing".into()));
    }

    #[test]
    fn unstartable_program_is_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        let mut opts = options();
        // A folder exists but cannot be executed.
        opts.program = dir.path().as_os_str().to_owned();
        let err = Git::new(&opts, dir.path())
            .run(Mode::Read, ["version"])
            .unwrap_err();
        assert_eq!(err.kind(), "GitFailed");
        assert!(err.to_string().starts_with("could not run git"));
    }

    #[cfg(unix)]
    #[test]
    fn timeouts_kill_the_process_group() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("survived");
        let script = dir.path().join("slow.sh");
        // The background child keeps the pipes open and would write the
        // marker if it were not killed with its parent.
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\n(sleep 1; touch '{}') &\nsleep 5\n",
                marker.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut opts = options();
        opts.program = script.into_os_string();
        opts.local_timeout = Duration::from_millis(200);
        opts.network_timeout = Duration::from_millis(300);
        let runner = Git::new(&opts, dir.path());
        let start = Instant::now();
        let err = runner.run(Mode::Read, ["status"]).unwrap_err();
        assert_eq!(err.kind(), "GitNetwork");
        assert_eq!(err.to_string(), "git timed out after 0 s");
        let err = runner.run(Mode::Network, ["fetch"]).unwrap_err();
        assert_eq!(err.kind(), "GitNetwork");
        assert!(start.elapsed() < Duration::from_secs(3));
        std::thread::sleep(Duration::from_millis(1300));
        assert!(
            !marker.exists(),
            "a child of the timed out process survived"
        );
    }

    #[cfg(unix)]
    #[test]
    fn stop_kills_network_commands_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("slow.sh");
        std::fs::write(&script, "#!/bin/sh\nsleep 0.3\necho done\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut opts = options();
        opts.program = script.into_os_string();
        let mut runner = Git::new(&opts, dir.path());
        let stop = Arc::new(AtomicBool::new(true));
        runner.set_stop(Arc::clone(&stop));
        let start = Instant::now();
        assert_eq!(runner.run(Mode::Network, ["fetch"]).unwrap_err(), stopped());
        assert!(start.elapsed() < Duration::from_millis(250));
        // Local commands finish even while stopping.
        assert_eq!(runner.run(Mode::Write, ["rebase"]).unwrap().text(), "done");
        stop.store(false, Ordering::SeqCst);
        assert_eq!(runner.run(Mode::Network, ["fetch"]).unwrap().text(), "done");
    }

    #[cfg(unix)]
    #[test]
    fn a_child_holding_the_pipes_after_exit_times_out() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("leak.sh");
        std::fs::write(&script, "#!/bin/sh\nsleep 5 &\nexit 0\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut opts = options();
        opts.program = script.into_os_string();
        opts.local_timeout = Duration::from_millis(300);
        let err = Git::new(&opts, dir.path())
            .run(Mode::Read, ["x"])
            .unwrap_err();
        assert_eq!(err.kind(), "GitNetwork");
    }

    #[cfg(unix)]
    #[test]
    fn a_writing_command_that_exited_is_never_killed_for_its_children() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("leak.sh");
        // A hook left in the background keeps the pipes open for a moment.
        std::fs::write(&script, "#!/bin/sh\necho done\nsleep 1 &\nexit 0\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut opts = options();
        opts.program = script.into_os_string();
        opts.write_timeout = Duration::from_millis(100);
        let out = Git::new(&opts, dir.path()).run(Mode::Write, ["x"]).unwrap();
        assert!(out.success);
        assert_eq!(out.text(), "done");
    }

    #[cfg(unix)]
    #[test]
    fn slow_writing_commands_are_asked_to_stop_not_killed() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let cleaned = dir.path().join("cleaned-up");
        let script = dir.path().join("slow-write.sh");
        // Like git, the script cleans up when it receives SIGTERM; SIGKILL
        // would not let it.
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\ntrap 'touch \"{}\"; exit 143' TERM\nsleep 5 &\nwait $!\n",
                cleaned.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut opts = options();
        opts.program = script.into_os_string();
        opts.write_timeout = Duration::from_millis(300);
        let start = Instant::now();
        let err = Git::new(&opts, dir.path())
            .run(Mode::Write, ["commit"])
            .unwrap_err();
        assert_eq!(err.kind(), "GitFailed");
        assert!(err.to_string().contains("was stopped"), "{err}");
        assert!(start.elapsed() < Duration::from_secs(4));
        assert!(cleaned.exists(), "the command did not get to clean up");
    }

    #[test]
    fn strips_injected_configuration_from_the_environment() {
        assert!(is_config_env(OsStr::new("GIT_CONFIG_KEY_0")));
        assert!(is_config_env(OsStr::new("GIT_CONFIG_VALUE_12")));
        assert!(!is_config_env(OsStr::new("GIT_CONFIG_GLOBAL")));
        let dir = tempfile::tempdir().unwrap();
        let cmd = Git::new(&options(), dir.path()).command(Mode::Read, ["status"]);
        let removed: Vec<_> = cmd
            .get_envs()
            .filter(|(_, v)| v.is_none())
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect();
        for key in STRIPPED_ENV {
            assert!(removed.iter().any(|k| k == key), "{key} is not removed");
        }
    }

    #[test]
    fn classifies_network_and_auth_failures() {
        let classify = |mode, stderr: &str| classify(mode, "fetch", stderr, &root());
        let cases = [
            (
                "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
                "GitAuth",
            ),
            (
                "fatal: Authentication failed for 'https://github.com/a/b.git/'",
                "GitAuth",
            ),
            (
                "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
                "GitAuth",
            ),
            (
                "Host key verification failed.\nfatal: Could not read from remote repository.",
                "GitAuth",
            ),
            (
                "fatal: unable to access 'https://x/': The requested URL returned error: 403",
                "GitAuth",
            ),
            (
                "ERROR: Repository not found.\nfatal: Could not read from remote repository.",
                "GitAuth",
            ),
            (
                "ssh: Could not resolve hostname github.com: Temporary failure in name resolution",
                "GitNetwork",
            ),
            (
                "fatal: unable to access 'https://localhost:1/x.git/': Failed to connect to localhost port 1: Couldn't connect to server",
                "GitNetwork",
            ),
            (
                "ssh: connect to host x port 22: Connection timed out",
                "GitNetwork",
            ),
            (
                "ssh: connect to host x port 22: Network is unreachable",
                "GitNetwork",
            ),
            (
                "fatal: '/mnt/usb/notes.git' does not appear to be a git repository\nfatal: Could not read from remote repository.",
                "GitNetwork",
            ),
            ("fatal: the remote end hung up unexpectedly", "GitNetwork"),
            ("error: something else went wrong", "GitFailed"),
            ("", "GitFailed"),
        ];
        for (stderr, kind) in cases {
            assert_eq!(classify(Mode::Network, stderr).kind(), kind, "{stderr}");
        }
        // Local commands are never auth or network errors.
        let local = classify(
            Mode::Write,
            "error: unable to create '.git/index.lock': Permission denied",
        );
        assert_eq!(local.kind(), "GitFailed");
        assert_eq!(classify(Mode::Read, "").to_string(), "git fetch failed");
    }

    #[test]
    fn sanitizes_credentials_paths_hints_and_length() {
        let r = root();
        assert_eq!(
            sanitize(
                "fatal: unable to access 'https://user:s3cret@github.com/a/b.git/': 401",
                &r
            ),
            "fatal: unable to access 'https://github.com/a/b.git/': 401"
        );
        assert_eq!(
            sanitize(
                "remote: https://tok@host and http://h/x and ssh://git@h:22/r",
                &r
            ),
            "remote: https://host and http://h/x and ssh://h:22/r"
        );
        assert_eq!(
            sanitize("fatal: 'file:///home/me/remote.git' is bad", &r),
            "fatal: '<path>' is bad"
        );
        assert_eq!(
            sanitize("error: could not write /home/me/notes/inbox/a.md", &r),
            "error: could not write inbox/a.md"
        );
        assert_eq!(
            sanitize("fatal: cannot use /home/me/notes: odd", &r),
            "fatal: cannot use the workspace: odd"
        );
        assert_eq!(
            sanitize(
                "fatal: '/home/me/notes-old/x' and /etc/passwd and (C:\\Users\\me) C:/x",
                &r
            ),
            "fatal: '<path>' and <path> and (<path>) <path>"
        );
        assert_eq!(
            sanitize("hint: do this\n\n  error: a / b  \nhint: more", &r),
            "error: a / b"
        );
        assert_eq!(sanitize("see https://", &r), "see https://");
        assert_eq!(
            sanitize(
                "fatal: https://h/r.git?access_token=abc&x=1&Token=t&password=p ok",
                &r
            ),
            "fatal: https://h/r.git?x=1 ok"
        );
        assert_eq!(
            sanitize("at https://h/r?private_token=abc", &r),
            "at https://h/r"
        );
        assert_eq!(
            sanitize("at https://h/r?ref=main", &r),
            "at https://h/r?ref=main"
        );
        let long = "x".repeat(2 * MAX_MESSAGE_CHARS);
        let cut = sanitize(&long, &r);
        assert_eq!(cut.chars().count(), MAX_MESSAGE_CHARS);
        assert!(cut.ends_with('…'));
        let error = classify(Mode::Write, "commit", &long, &r).to_string();
        assert_eq!(error.chars().count(), MAX_MESSAGE_CHARS);
        // A root of `/` is not stripped from every path.
        assert_eq!(sanitize("at /etc/x", Path::new("/")), "at <path>");
        assert_eq!(
            Git::new(&options(), &r).sanitize("at /home/me/notes/a.md"),
            "at a.md"
        );
    }

    #[test]
    fn windows_style_roots_are_relativized() {
        let r = PathBuf::from("C:\\Users\\me\\notes");
        assert_eq!(
            sanitize(
                "error: C:/Users/me/notes/inbox/a.md and C:\\Users\\me\\notes\\b.md",
                &r
            ),
            "error: inbox/a.md and b.md"
        );
    }
}
