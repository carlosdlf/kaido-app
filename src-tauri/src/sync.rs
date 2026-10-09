//! Git sync for the open workspace: repository status, commits, and
//! fetch / rebase / push with conflict resolution.
//!
//! The workspace may be the root of a repository or any folder inside one.
//! Everything that changes the repository is limited to the workspace folder
//! with a pathspec, and the app's temporary files and trash folders are never
//! committed. Repositories in an unexpected state (an operation in progress,
//! a detached HEAD, unmerged files…) are reported and left alone.
//!
//! # Rebases
//!
//! A sync integrates upstream commits with `git rebase @{upstream}`. Before
//! starting it writes a marker file (`<git dir>/kaido-rebase`) recording the
//! rebase. The marker is only informational: it lets the status explain that
//! the app started a rebase that is still in progress.
//!
//! A rebase is aborted only by the sync that started it, right after one of
//! its own steps failed, and only if [`safe_to_abort`] holds: every change in
//! the working tree is one the rebase made. A rebase interrupted by an app
//! exit or a crash, or that cannot be undone safely, is left in place and
//! sync stays paused until the user finishes it with git. The app never
//! aborts a rebase in a later run.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::fs_ops;
use crate::git::{self, Git, GitOptions, Mode, Output};
use crate::paths;
use crate::state::TreeLock;

/// Pathspec of the workspace folder (git runs with `-C <workspace root>`),
/// without the app's temporary files and trash folders.
pub const WORKSPACE_PATHSPEC: &[&str] = &[
    "--",
    ".",
    ":(exclude,glob)**/.kaido-*.tmp",
    ":(exclude,glob)**/.Trash-*/**",
];

/// Config keys read for the status, as a `git config --get-regexp` pattern.
const CONFIG_KEYS: &str = r"^(user\.name|user\.email|core\.sshcommand|remote\.pushdefault|remote\..+\.url|branch\..+\.(remote|merge|pushremote))$";

/// Config overrides for the rebase run by a sync: never stash, never move
/// other branches, never squash `fixup!` commits.
const REBASE_CONFIG: &[&str] = &[
    "-c",
    "rebase.autoStash=false",
    "-c",
    "rebase.updateRefs=false",
    "-c",
    "rebase.autoSquash=false",
];

/// Name of the marker file, in the git folder, of a rebase started by the app.
pub const REBASE_MARKER: &str = "kaido-rebase";

/// An `index.lock` younger than this is assumed to belong to a git command
/// that is still running.
pub const INDEX_LOCK_AGE: Duration = Duration::from_secs(5);

/// Explanation of a rebase the app started and left in progress.
pub const APP_REBASE_MESSAGE: &str = "Kaido started this rebase while syncing and could not finish it. \
     Resolve the conflicts and run `git rebase --continue`, or run `git rebase --abort` to undo \
     Kaido's sync";

/// Conflict copy names tried for one file (`name`, `name 2`, … `name 99`).
pub const MAX_CONFLICT_COPY_NAMES: u32 = 99;
/// Longest file name, in bytes, on common file systems.
pub const FILE_NAME_LIMIT_BYTES: usize = 255;
/// Upper bound on rebase steps (conflict resolutions and skips) in one sync.
const MAX_REBASE_STEPS: usize = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnavailableReason {
    GitMissing,
    NotARepo,
}

impl UnavailableReason {
    pub fn as_str(self) -> &'static str {
        match self {
            UnavailableReason::GitMissing => "git-missing",
            UnavailableReason::NotARepo => "not-a-repo",
        }
    }
}

/// Why sync is paused. The first five also stop commits; the others only
/// stop pulling and pushing. `PullConflict` is never a status: it is only
/// the reason of a sync error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PausedReason {
    OperationInProgress,
    IndexLocked,
    UnmergedFiles,
    DetachedHead,
    NoIdentity,
    UpstreamMismatch,
    UpstreamGone,
    LocalMerges,
    OutsideCommits,
    OutsideChanges,
    PullConflict,
}

impl PausedReason {
    pub fn as_str(self) -> &'static str {
        match self {
            PausedReason::OperationInProgress => "operation-in-progress",
            PausedReason::IndexLocked => "index-locked",
            PausedReason::UnmergedFiles => "unmerged-files",
            PausedReason::DetachedHead => "detached-head",
            PausedReason::NoIdentity => "no-identity",
            PausedReason::UpstreamMismatch => "upstream-mismatch",
            PausedReason::UpstreamGone => "upstream-gone",
            PausedReason::LocalMerges => "local-merges",
            PausedReason::PullConflict => "pull-conflict",
            PausedReason::OutsideCommits => "outside-commits",
            PausedReason::OutsideChanges => "outside-changes",
        }
    }

    /// Whether commits are refused too.
    pub fn blocks_commit(self) -> bool {
        matches!(
            self,
            PausedReason::OperationInProgress
                | PausedReason::IndexLocked
                | PausedReason::UnmergedFiles
                | PausedReason::DetachedHead
                | PausedReason::NoIdentity
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Operation {
    Rebase,
    Merge,
    CherryPick,
    Revert,
    Bisect,
}

/// Repository details shared by the `ready` and `paused` states.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused_reason: Option<PausedReason>,
    /// Extra explanation of the paused state, when there is one (a rebase
    /// the app started and could not finish).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<Operation>,
    /// `None` when HEAD is detached.
    pub branch: Option<String>,
    /// Short name of the upstream branch, e.g. `origin/main`.
    pub upstream: Option<String>,
    /// Whether any remote is configured.
    pub remote: bool,
    pub ahead: u64,
    pub behind: u64,
    /// Workspace-relative paths with uncommitted changes, sorted.
    pub changed: Vec<String>,
    pub git_version: String,
}

/// Result of `git_status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum GitStatus {
    Unavailable { reason: UnavailableReason },
    Ready(RepoStatus),
    Paused(RepoStatus),
}

/// Result of `git_commit`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommitResult {
    /// Hash of the new commit, `None` if there was nothing to commit.
    pub commit: Option<String>,
    /// Workspace-relative paths in the commit, sorted.
    pub paths: Vec<String>,
}

/// A conflict resolved by keeping both versions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConflictCopy {
    /// The note, now holding the upstream version.
    pub path: String,
    /// The new file holding this device's version.
    pub copy: String,
}

/// Result of `git_sync`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct SyncResult {
    /// Commits integrated from the upstream branch.
    pub pulled: u64,
    /// Commits pushed.
    pub pushed: u64,
    /// Workspace-relative paths changed by the pull, sorted.
    pub changed: Vec<String>,
    pub conflicts: Vec<ConflictCopy>,
    /// The upstream branch has new commits, but the workspace has
    /// uncommitted changes, so nothing was pulled or pushed. Commit, then
    /// sync again.
    pub deferred: bool,
}

// ---------------------------------------------------------------------------
// Stopping on exit

fn guard<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // The guarded values stay consistent even if a holder panicked.
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Test hook run at every safe point; returning `true` stops the operation.
#[cfg(test)]
pub type CheckHook = Box<dyn FnMut() -> bool + Send>;

/// Lets the app stop git operations when it exits. Cheap to clone; clones
/// share their state.
///
/// Once [`SyncControl::shutdown`] was called, new commits and syncs are
/// refused, network commands in flight are killed, and a running sync stops
/// at its next safe point. Nothing is ever aborted on exit: a rebase still in
/// progress keeps its marker and is dealt with on the next status.
#[derive(Clone, Default)]
pub struct SyncControl {
    stop: Arc<AtomicBool>,
    /// Number of operations running, signalled when it changes.
    running: Arc<(Mutex<usize>, Condvar)>,
    #[cfg(test)]
    pub on_check: Arc<Mutex<Option<CheckHook>>>,
}

/// Marks an operation as running until dropped.
pub struct Running {
    control: SyncControl,
}

impl Drop for Running {
    fn drop(&mut self) {
        let (count, changed) = &*self.control.running;
        let mut count = guard(count);
        *count = count.saturating_sub(1);
        changed.notify_all();
    }
}

/// What [`SyncControl::shutdown`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Shutdown {
    /// Every running operation finished within the wait.
    pub finished: bool,
}

impl SyncControl {
    pub fn is_stopping(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    /// Registers a running operation, or fails if the app is closing.
    pub fn start(&self) -> AppResult<Running> {
        let (count, _) = &*self.running;
        let mut count = guard(count);
        if self.is_stopping() {
            return Err(git::stopped());
        }
        *count += 1;
        Ok(Running {
            control: self.clone(),
        })
    }

    /// A safe point: fails if the operation must stop.
    fn check(&self) -> AppResult<()> {
        #[cfg(test)]
        if let Some(hook) = guard(&self.on_check).as_mut()
            && hook()
        {
            self.stop.store(true, Ordering::SeqCst);
        }
        if self.is_stopping() {
            Err(git::stopped())
        } else {
            Ok(())
        }
    }

    fn attach(&self, git: &mut Git) {
        git.set_stop(Arc::clone(&self.stop));
    }

    /// Stops git operations for app exit: refuses new ones, kills network
    /// commands and waits up to `wait` for running ones to reach a safe
    /// point. Never aborts anything. Safe to call more than once.
    pub fn shutdown(&self, wait: Duration) -> Shutdown {
        self.stop.store(true, Ordering::SeqCst);
        let deadline = Instant::now() + wait;
        let (count, changed) = &*self.running;
        let mut count = guard(count);
        while *count > 0 {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            count = changed
                .wait_timeout(count, left)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
        Shutdown {
            finished: *count == 0,
        }
    }
}

fn paused(reason: PausedReason) -> AppError {
    AppError::GitPaused(reason.as_str().into())
}

/// The error when a rebase started by the app could not be undone safely.
pub fn interrupted() -> AppError {
    AppError::GitPaused(format!(
        "{}: {APP_REBASE_MESSAGE}",
        PausedReason::OperationInProgress.as_str()
    ))
}

fn unexpected(command: &str) -> AppError {
    AppError::GitFailed(format!("unexpected output from git {command}"))
}

/// Whether a workspace-relative (or repository-relative) path is one of the
/// app's temporary files or inside a trash folder.
pub fn is_temp(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    (name.starts_with(fs_ops::TEMP_PREFIX) && name.ends_with(".tmp"))
        || path.split('/').any(|s| s.starts_with(".Trash-"))
}

// ---------------------------------------------------------------------------
// `git status --porcelain=v2 -z --branch`

/// The stages of an unmerged path: 1 = common ancestor, 2 = "ours", 3 =
/// "theirs". During a rebase "ours" is the upstream side and "theirs" the
/// local commit being replayed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stages {
    /// Mode of stages 1–3, `000000` when the stage is absent.
    pub modes: [String; 3],
    pub hashes: [String; 3],
}

impl Stages {
    /// Blob hash of stage `n` (2 or 3) if present.
    fn blob(&self, n: usize) -> Option<&str> {
        let i = n - 1;
        (self.modes[i] != "000000").then_some(self.hashes[i].as_str())
    }

    /// Whether every present stage is a regular file (no symlink, submodule).
    fn regular_files(&self) -> bool {
        self.modes
            .iter()
            .all(|m| matches!(m.as_str(), "000000" | "100644" | "100755"))
    }
}

/// One changed path, repository-relative.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusEntry {
    /// Index and working tree status (`.M`, `A.`, `UU`; `??` for untracked).
    pub xy: String,
    /// Blob in the index (ordinary and renamed entries).
    pub index_hash: Option<String>,
    pub path: String,
    /// Source of a rename or copy.
    pub orig: Option<String>,
    pub unmerged: Option<Stages>,
}

impl StatusEntry {
    /// Whether the working tree differs from the index here (untracked
    /// files included), i.e. a change nothing has staged.
    fn worktree_changed(&self) -> bool {
        self.unmerged.is_none() && self.xy.chars().nth(1).is_none_or(|y| y != '.')
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RawStatus {
    /// `None` when detached.
    pub branch: Option<String>,
    /// The branch has no commit yet.
    pub initial: bool,
    pub upstream: Option<String>,
    /// `(ahead, behind)`; missing when there is no upstream or it is gone.
    pub ab: Option<(u64, u64)>,
    pub entries: Vec<StatusEntry>,
}

fn fields(record: &str, n: usize) -> AppResult<Vec<&str>> {
    let parts: Vec<&str> = record.splitn(n, ' ').collect();
    if parts.len() == n {
        Ok(parts)
    } else {
        Err(unexpected("status"))
    }
}

/// Parses `git status --porcelain=v2 -z --branch` output.
pub fn parse_status(bytes: &[u8]) -> AppResult<RawStatus> {
    let text = String::from_utf8_lossy(bytes);
    let mut records = text.split('\0').filter(|r| !r.is_empty());
    let mut status = RawStatus::default();
    let mut detached = false;
    let entry = |xy: &str, path: &str| StatusEntry {
        xy: xy.to_owned(),
        index_hash: None,
        path: path.to_owned(),
        orig: None,
        unmerged: None,
    };
    while let Some(record) = records.next() {
        let (kind, rest) = record.split_once(' ').ok_or_else(|| unexpected("status"))?;
        match kind {
            "#" => {
                let (key, value) = rest.split_once(' ').unwrap_or((rest, ""));
                match key {
                    "branch.oid" => status.initial = value == "(initial)",
                    "branch.head" if value == "(detached)" => detached = true,
                    "branch.head" => status.branch = Some(value.to_owned()),
                    "branch.upstream" => status.upstream = Some(value.to_owned()),
                    "branch.ab" => {
                        let (a, b) = value.split_once(' ').ok_or_else(|| unexpected("status"))?;
                        let count = |s: &str, sign: char| {
                            s.strip_prefix(sign)
                                .and_then(|n| n.parse::<u64>().ok())
                                .ok_or_else(|| unexpected("status"))
                        };
                        status.ab = Some((count(a, '+')?, count(b, '-')?));
                    }
                    _ => {}
                }
            }
            "1" => {
                let f = fields(record, 9)?;
                status.entries.push(StatusEntry {
                    index_hash: Some(f[7].to_owned()),
                    ..entry(f[1], f[8])
                });
            }
            "2" => {
                let f = fields(record, 10)?;
                let orig = records.next().ok_or_else(|| unexpected("status"))?;
                status.entries.push(StatusEntry {
                    orig: Some(orig.to_owned()),
                    index_hash: Some(f[7].to_owned()),
                    ..entry(f[1], f[9])
                });
            }
            "u" => {
                let f = fields(record, 11)?;
                status.entries.push(StatusEntry {
                    unmerged: Some(Stages {
                        modes: [f[3].to_owned(), f[4].to_owned(), f[5].to_owned()],
                        hashes: [f[7].to_owned(), f[8].to_owned(), f[9].to_owned()],
                    }),
                    ..entry(f[1], f[10])
                });
            }
            "?" => status.entries.push(entry("??", rest)),
            "!" => {}
            _ => return Err(unexpected("status")),
        }
    }
    if detached {
        status.branch = None;
    }
    Ok(status)
}

// ---------------------------------------------------------------------------
// Repository inspection

/// Values read from `git config`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConfigValues {
    pub user_name: bool,
    pub user_email: bool,
    pub ssh_command: bool,
    pub remote: bool,
    /// `remote.pushDefault`.
    pub push_default: Option<String>,
    /// `(branch, remote)` pairs from `branch.<name>.remote`.
    pub branch_remotes: Vec<(String, String)>,
    /// `(branch, ref)` pairs from `branch.<name>.merge`.
    pub branch_merges: Vec<(String, String)>,
    /// `(branch, remote)` pairs from `branch.<name>.pushRemote`.
    pub branch_push_remotes: Vec<(String, String)>,
}

impl ConfigValues {
    fn branch_value(pairs: &[(String, String)], branch: &str) -> Option<String> {
        pairs
            .iter()
            .rev()
            .find(|(b, _)| b == branch)
            .map(|(_, v)| v.clone())
    }
}

/// Parses `git config -z --get-regexp` output for [`CONFIG_KEYS`].
pub fn parse_config(bytes: &[u8]) -> ConfigValues {
    let text = String::from_utf8_lossy(bytes);
    let mut values = ConfigValues::default();
    for record in text.split('\0').filter(|r| !r.is_empty()) {
        let (key, value) = record.split_once('\n').unwrap_or((record, ""));
        let set = !value.trim().is_empty();
        match key {
            "user.name" => values.user_name |= set,
            "user.email" => values.user_email |= set,
            "core.sshcommand" => values.ssh_command |= set,
            "remote.pushdefault" => values.push_default = Some(value.to_owned()),
            _ if key.starts_with("remote.") && key.ends_with(".url") => values.remote = true,
            _ => {
                let Some(rest) = key.strip_prefix("branch.") else {
                    continue;
                };
                let pair = |branch: &str| (branch.to_owned(), value.to_owned());
                if let Some(branch) = rest.strip_suffix(".remote") {
                    values.branch_remotes.push(pair(branch));
                } else if let Some(branch) = rest.strip_suffix(".merge") {
                    values.branch_merges.push(pair(branch));
                } else if let Some(branch) = rest.strip_suffix(".pushremote") {
                    values.branch_push_remotes.push(pair(branch));
                }
            }
        }
    }
    values
}

/// Files whose presence means an operation is in progress, as paths
/// relative to the git folder, in the order they are checked.
const OPERATION_MARKERS: &[(&str, Operation)] = &[
    ("rebase-merge", Operation::Rebase),
    ("rebase-apply", Operation::Rebase),
    ("MERGE_HEAD", Operation::Merge),
    ("CHERRY_PICK_HEAD", Operation::CherryPick),
    ("REVERT_HEAD", Operation::Revert),
    ("BISECT_LOG", Operation::Bisect),
];

/// Where the current branch pulls from and pushes to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushTarget {
    pub remote: String,
    pub branch: String,
}

/// The state of the current branch's upstream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Upstream {
    /// No upstream: commits stay local.
    None,
    /// Not a branch of the same name on the remote it pushes to.
    Mismatch,
    /// Configured, but the remote branch is not known (deleted or never
    /// pushed).
    Gone(PushTarget),
    Valid(PushTarget),
}

/// A git-path name is usable as a command argument and refname part.
fn plain_name(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('-') && name != "."
}

/// A repository and its current state, read in one go.
#[derive(Debug)]
pub struct Repo {
    pub git: Git,
    pub version: String,
    /// The repository's top folder.
    pub toplevel: PathBuf,
    /// The workspace folder relative to the repository root, `/`-separated
    /// with a trailing `/`, or empty when the workspace is the root.
    pub prefix: String,
    /// Absolute paths of [`OPERATION_MARKERS`].
    markers: Vec<(PathBuf, Operation)>,
    /// `<git dir>/index.lock`.
    index_lock: PathBuf,
    /// `<git dir>/kaido-rebase`.
    rebase_marker: PathBuf,
    /// See [`GitOptions::index_lock_recheck`].
    index_lock_recheck: Duration,
    pub config: ConfigValues,
    pub status: RawStatus,
}

/// Opens the repository of the workspace at `root` and reads its state.
/// Returns the reason when git or the repository is unavailable.
pub fn inspect(options: &GitOptions, root: &Path) -> AppResult<Result<Repo, UnavailableReason>> {
    let mut git = Git::new(options, root);
    let version = match git.run(Mode::Read, ["version"]) {
        Ok(out) if out.success => out.text(),
        Ok(out) => return Err(git.failure(Mode::Read, "version", &out)),
        Err(AppError::GitUnavailable(_)) => return Ok(Err(UnavailableReason::GitMissing)),
        Err(e) => return Err(e),
    };
    let version = version
        .strip_prefix("git version ")
        .unwrap_or(&version)
        .to_owned();

    let mut args = vec!["rev-parse", "--show-toplevel", "--show-prefix"];
    for (marker, _) in OPERATION_MARKERS {
        args.extend(["--git-path", marker]);
    }
    args.extend(["--git-path", "index.lock", "--git-path", REBASE_MARKER]);
    let out = git.run(Mode::Read, &args)?;
    if !out.success {
        if out.stderr.to_lowercase().contains("not a git repository") {
            return Ok(Err(UnavailableReason::NotARepo));
        }
        return Err(git.failure(Mode::Read, "rev-parse", &out));
    }
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let lines: Vec<&str> = text
        .strip_suffix('\n')
        .unwrap_or(&text)
        .split('\n')
        .collect();
    let n = OPERATION_MARKERS.len();
    if lines.len() != 4 + n {
        return Err(unexpected("rev-parse"));
    }
    let toplevel = PathBuf::from(lines[0]);
    let prefix = lines[1].to_owned();
    let markers = lines[2..2 + n]
        .iter()
        .zip(OPERATION_MARKERS)
        .map(|(path, (_, op))| (root.join(path), *op))
        .collect();
    let index_lock = root.join(lines[2 + n]);
    let rebase_marker = root.join(lines[3 + n]);

    let out = git.run(Mode::Read, ["config", "-z", "--get-regexp", CONFIG_KEYS])?;
    // Exit code 1 means no key matched.
    if !out.success && !out.stderr.trim().is_empty() {
        return Err(git.failure(Mode::Read, "config", &out));
    }
    let config = parse_config(&out.stdout);
    git.set_ssh_configured(config.ssh_command);

    let out = git.ok(
        Mode::Read,
        "status",
        [
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
        ],
    )?;
    let status = parse_status(&out.stdout)?;
    Ok(Ok(Repo {
        git,
        version,
        toplevel,
        prefix,
        markers,
        index_lock,
        rebase_marker,
        index_lock_recheck: options.index_lock_recheck,
        config,
        status,
    }))
}

/// [`inspect`], with an unavailable repository as a `GitUnavailable` error.
fn open(options: &GitOptions, root: &Path) -> AppResult<Repo> {
    inspect(options, root)?.map_err(|reason| AppError::GitUnavailable(reason.as_str().into()))
}

/// Paths in NUL-separated git output.
fn nul_split(bytes: &[u8]) -> impl Iterator<Item = String> + '_ {
    bytes
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .map(|p| String::from_utf8_lossy(p).into_owned())
}

impl Repo {
    /// The workspace-relative form of a repository-relative path, or `None`
    /// if it is outside the workspace.
    pub fn to_workspace(&self, repo_path: &str) -> Option<String> {
        let rel = repo_path.strip_prefix(self.prefix.as_str())?;
        (!rel.is_empty()).then(|| rel.to_owned())
    }

    /// The operation in progress, if any.
    pub fn operation(&self) -> Option<Operation> {
        self.markers
            .iter()
            .find(|(path, _)| path.exists())
            .map(|(_, op)| *op)
    }

    fn rebase_dir(&self) -> Option<&Path> {
        self.markers
            .iter()
            .find(|(path, op)| *op == Operation::Rebase && path.exists())
            .map(|(path, _)| path.as_path())
    }

    fn rebase_in_progress(&self) -> bool {
        self.rebase_dir().is_some()
    }

    /// `(orig-head, onto)` of the rebase in progress.
    fn rebase_state(&self) -> Option<(String, String)> {
        let dir = self.rebase_dir()?;
        let read = |name: &str| {
            fs::read_to_string(dir.join(name))
                .ok()
                .map(|s| s.trim().to_owned())
        };
        Some((read("orig-head")?, read("onto")?))
    }

    /// Whether the rebase in progress is one the app started (its marker
    /// matches). Only used to explain the paused state; the app never acts on
    /// it later.
    pub fn app_rebase(&self) -> bool {
        let Some((orig_head, onto)) = self.rebase_state() else {
            return false;
        };
        fs::read_to_string(&self.rebase_marker)
            .ok()
            .and_then(|text| RebaseMarker::parse(&text))
            .is_some_and(|m| m.orig_head == orig_head && m.onto == onto)
    }

    /// Removes the marker of a rebase that is no longer in progress. Only
    /// called while holding the git lock, so no sync is about to start one.
    fn forget_finished_rebase(&self) {
        if !self.rebase_in_progress() {
            let _ = fs::remove_file(&self.rebase_marker);
        }
    }

    /// Whether commits can be made: `user.name` and `user.email` are set in
    /// the git configuration or in the environment.
    pub fn has_identity(&self) -> bool {
        let env = |key| self.git.env_var(key).is_some();
        let name = self.config.user_name || (env("GIT_AUTHOR_NAME") && env("GIT_COMMITTER_NAME"));
        let email = self.config.user_email
            || (env("GIT_AUTHOR_EMAIL") && env("GIT_COMMITTER_EMAIL"))
            || env("EMAIL");
        name && email
    }

    /// Workspace-relative changed paths (sorted) and whether anything changed
    /// outside the workspace. Temporary files are ignored.
    fn split_changes(&self) -> (Vec<String>, bool) {
        let mut inside = BTreeSet::new();
        let mut outside = false;
        for entry in &self.status.entries {
            for path in std::iter::once(&entry.path).chain(entry.orig.as_ref()) {
                if is_temp(path) {
                    continue;
                }
                match self.to_workspace(path) {
                    Some(rel) => {
                        inside.insert(rel);
                    }
                    None => outside = true,
                }
            }
        }
        (inside.into_iter().collect(), outside)
    }

    fn has_unmerged(&self) -> bool {
        self.status.entries.iter().any(|e| e.unmerged.is_some())
    }

    /// Whether `index.lock` is held by something that is not about to
    /// release it: it must be at least [`INDEX_LOCK_AGE`] old and still
    /// there after [`GitOptions::index_lock_recheck`].
    fn index_locked(&self) -> bool {
        let old = fs::metadata(&self.index_lock)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age >= INDEX_LOCK_AGE);
        if !old {
            return false;
        }
        std::thread::sleep(self.index_lock_recheck);
        self.index_lock.exists()
    }

    /// The upstream branch, validated: it must be the branch of the same
    /// name on the remote the branch also pushes to (no local upstream, no
    /// separate push remote).
    pub fn upstream(&self) -> Upstream {
        if self.status.upstream.is_none() {
            return Upstream::None;
        }
        let Some(branch) = self.status.branch.as_deref() else {
            return Upstream::Mismatch;
        };
        let config = &self.config;
        let remote = ConfigValues::branch_value(&config.branch_remotes, branch);
        let merge = ConfigValues::branch_value(&config.branch_merges, branch);
        let (Some(remote), Some(merge)) = (remote, merge) else {
            return Upstream::Mismatch;
        };
        let push_remote = ConfigValues::branch_value(&config.branch_push_remotes, branch)
            .or_else(|| config.push_default.clone())
            .unwrap_or_else(|| remote.clone());
        let valid = plain_name(&remote)
            && plain_name(branch)
            && merge == format!("refs/heads/{branch}")
            && push_remote == remote;
        if !valid {
            return Upstream::Mismatch;
        }
        let target = PushTarget {
            remote,
            branch: branch.to_owned(),
        };
        if self.status.ab.is_some() {
            Upstream::Valid(target)
        } else {
            Upstream::Gone(target)
        }
    }

    fn ahead(&self) -> u64 {
        self.status.ab.map_or(0, |(ahead, _)| ahead)
    }

    /// Whether local commits not on the upstream include merges: a rebase
    /// would flatten them, which can drop or rewrite their changes.
    fn local_merges(&self) -> AppResult<bool> {
        if self.ahead() == 0 {
            return Ok(false);
        }
        let merges = self.count(&["rev-list", "--merges", "--count", "@{upstream}..HEAD"])?;
        Ok(merges > 0)
    }

    /// Whether local commits not on the upstream branch change files outside
    /// the workspace (they would be pushed with the notes).
    fn outside_commits(&self) -> AppResult<bool> {
        if self.prefix.is_empty() || self.ahead() == 0 {
            return Ok(false);
        }
        let out = self.git.ok(
            Mode::Read,
            "log",
            [
                "log",
                "--format=",
                "--name-only",
                "-z",
                "--no-renames",
                "@{upstream}..HEAD",
                "--",
            ],
        )?;
        Ok(nul_split(&out.stdout).any(|p| self.to_workspace(&p).is_none()))
    }

    /// Why sync is paused, most important reason first.
    pub fn paused_reason(&self) -> AppResult<Option<PausedReason>> {
        let reason = if self.operation().is_some() {
            PausedReason::OperationInProgress
        } else if self.index_locked() {
            PausedReason::IndexLocked
        } else if self.has_unmerged() {
            PausedReason::UnmergedFiles
        } else if self.status.branch.is_none() {
            PausedReason::DetachedHead
        } else if !self.has_identity() {
            PausedReason::NoIdentity
        } else if self.upstream() == Upstream::Mismatch {
            PausedReason::UpstreamMismatch
        } else if matches!(self.upstream(), Upstream::Gone(_)) {
            PausedReason::UpstreamGone
        } else if self.local_merges()? {
            PausedReason::LocalMerges
        } else if self.outside_commits()? {
            PausedReason::OutsideCommits
        } else if self.split_changes().1 {
            PausedReason::OutsideChanges
        } else {
            return Ok(None);
        };
        Ok(Some(reason))
    }

    /// Extra explanation of a paused state, if any.
    fn paused_message(&self, reason: PausedReason) -> Option<String> {
        (reason == PausedReason::OperationInProgress && self.app_rebase())
            .then(|| APP_REBASE_MESSAGE.to_owned())
    }

    /// The `GitPaused` error for `reason`.
    fn paused_error(&self, reason: PausedReason) -> AppError {
        match self.paused_message(reason) {
            Some(message) => AppError::GitPaused(format!("{}: {message}", reason.as_str())),
            None => paused(reason),
        }
    }

    fn count(&self, args: &[&str]) -> AppResult<u64> {
        let out = self.git.ok(Mode::Read, "rev-list", args)?;
        out.text()
            .trim()
            .parse()
            .map_err(|_| unexpected("rev-list"))
    }

    pub fn summary(&self) -> AppResult<GitStatus> {
        let (changed, _) = self.split_changes();
        let (ahead, behind) = self.status.ab.unwrap_or((0, 0));
        let paused_reason = self.paused_reason()?;
        let status = RepoStatus {
            paused_reason,
            paused_message: paused_reason.and_then(|r| self.paused_message(r)),
            operation: self.operation(),
            branch: self.status.branch.clone(),
            upstream: self.status.upstream.clone(),
            remote: self.config.remote,
            ahead,
            behind,
            changed,
            git_version: self.version.clone(),
        };
        Ok(if paused_reason.is_some() {
            GitStatus::Paused(status)
        } else {
            GitStatus::Ready(status)
        })
    }

    fn rev_parse(&self, rev: &str) -> AppResult<String> {
        Ok(self
            .git
            .ok(Mode::Read, "rev-parse", ["rev-parse", "--verify", rev])?
            .text())
    }

    /// The blob at `path` in `rev`, `None` if it has none.
    fn blob_at(&self, rev: &str, path: &str) -> AppResult<Option<String>> {
        let spec = format!("{rev}:{path}");
        let out = self
            .git
            .run(Mode::Read, ["rev-parse", "-q", "--verify", &spec])?;
        Ok(out.success.then(|| out.text()))
    }
}

/// Status of the workspace's repository, for `git_status`. Only reads; it
/// never changes the repository.
pub fn status(options: &GitOptions, root: &Path) -> AppResult<GitStatus> {
    match inspect(options, root)? {
        Ok(repo) => repo.summary(),
        Err(reason) => Ok(GitStatus::Unavailable { reason }),
    }
}

// ---------------------------------------------------------------------------
// The marker of a rebase started by the app

/// Contents of `<git dir>/kaido-rebase`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RebaseMarker {
    /// HEAD before the rebase (git's `orig-head`).
    pub orig_head: String,
    /// The upstream commit rebased onto (git's `onto`).
    pub onto: String,
}

impl RebaseMarker {
    pub fn to_text(&self) -> String {
        format!(
            "kaido-rebase 1\norig-head {}\nonto {}\n",
            self.orig_head, self.onto
        )
    }

    pub fn parse(text: &str) -> Option<Self> {
        let mut lines = text.lines();
        if lines.next()? != "kaido-rebase 1" {
            return None;
        }
        let mut field = |name: &str| {
            lines
                .next()?
                .strip_prefix(name)?
                .strip_prefix(' ')
                .map(str::to_owned)
        };
        Some(Self {
            orig_head: field("orig-head")?,
            onto: field("onto")?,
        })
    }

    fn write(&self, path: &Path) -> AppResult<()> {
        fs_ops::atomic_write(path, self.to_text().as_bytes(), "the rebase marker")
    }
}

fn remove_marker(repo: &Repo) {
    let _ = fs::remove_file(&repo.rebase_marker);
}

// ---------------------------------------------------------------------------
// Undoing the app's own rebase

/// What the app's rebase wrote to the working tree, or saw git write there,
/// by repository path: the hash of the contents (`None`: no file).
#[derive(Debug, Default)]
pub struct Ledger {
    files: BTreeMap<String, Option<String>>,
}

/// Hash of the working tree file at `repo_path` (`None` when missing). A
/// file that cannot be read gets a value no recorded hash equals.
fn worktree_hash(repo: &Repo, repo_path: &str) -> Option<String> {
    match fs::read(repo.toplevel.join(repo_path)) {
        Ok(bytes) => Some(fs_ops::content_hash(&bytes)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(_) => Some("unreadable".into()),
    }
}

/// Recorded for a file changed after the git command that should have
/// written it returned: someone else's edit. Never equals a real hash.
const EDITED: &str = "edited after git wrote it";

impl Ledger {
    /// Records the current contents of `repo_path`, written by the app.
    fn record(&mut self, repo: &Repo, repo_path: &str) {
        let hash = worktree_hash(repo, repo_path);
        self.files.insert(repo_path.to_owned(), hash);
    }

    /// Records what git wrote at `repo_path` in a step whose command
    /// returned at `step_end`. A file modified after that is someone else's
    /// edit and is recorded as such, so it never counts as the rebase's own.
    fn record_from_git(&mut self, repo: &Repo, repo_path: &str, step_end: SystemTime) {
        let modified = fs::symlink_metadata(repo.toplevel.join(repo_path))
            .and_then(|m| m.modified())
            .ok();
        if modified.is_some_and(|m| m > step_end) {
            self.files
                .insert(repo_path.to_owned(), Some(EDITED.to_owned()));
        } else {
            self.record(repo, repo_path);
        }
    }

    /// Whether `repo_path` still has the recorded contents.
    fn unchanged(&self, repo: &Repo, repo_path: &str) -> bool {
        self.files.get(repo_path) == Some(&worktree_hash(repo, repo_path))
    }
}

/// Whether `git rebase --abort` (or `--skip`) of the app's own rebase can
/// run without losing anything someone else did. Every change in the
/// working tree must be one the rebase made:
/// - a file in the `ledger` must still have the recorded contents;
/// - any other unmerged file, unstaged change or new untracked file (the
///   app's temp files aside) is someone else's;
/// - any other staged change must be exactly what the commit being replayed
///   (`REBASE_HEAD`) has at that path.
pub fn safe_to_abort(repo: &Repo, ledger: &Ledger) -> AppResult<bool> {
    for entry in repo.status.entries.iter().filter(|e| !is_temp(&e.path)) {
        if ledger.files.contains_key(&entry.path) {
            if !ledger.unchanged(repo, &entry.path) {
                return Ok(false);
            }
            continue;
        }
        if entry.unmerged.is_some() || entry.worktree_changed() {
            return Ok(false);
        }
        if !staged_by_rebase(repo, entry)? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Whether a staged change is exactly what the commit being replayed
/// (`REBASE_HEAD`) has at that path, i.e. git staged it for the rebase.
fn staged_by_rebase(repo: &Repo, entry: &StatusEntry) -> AppResult<bool> {
    if repo.rev_parse("REBASE_HEAD").is_err() {
        return Ok(false);
    }
    let expected = repo.blob_at("REBASE_HEAD", &entry.path)?;
    let matches = if entry.xy.starts_with('D') {
        expected.is_none()
    } else {
        expected.is_some() && expected == entry.index_hash
    };
    let moved_away = match &entry.orig {
        Some(orig) => repo.blob_at("REBASE_HEAD", orig)?.is_none(),
        None => true,
    };
    Ok(matches && moved_away)
}

/// Whether everything staged is either a file the app wrote (unchanged
/// since) or what git staged for the commit being replayed. Checked before
/// `git rebase --continue`, so nothing else ends up in the commit.
fn index_is_rebase_only(repo: &Repo, ledger: &Ledger) -> AppResult<bool> {
    for entry in repo.status.entries.iter().filter(|e| !is_temp(&e.path)) {
        let staged = entry.unmerged.is_some() || !entry.xy.starts_with(['.', '?']);
        if !staged {
            continue;
        }
        let ok = if ledger.files.contains_key(&entry.path) {
            ledger.unchanged(repo, &entry.path)
        } else {
            entry.unmerged.is_none() && staged_by_rebase(repo, entry)?
        };
        if !ok {
            return Ok(false);
        }
    }
    Ok(true)
}

/// For every failure of a rebase the app started, right in the sync that
/// started it: abort it if [`safe_to_abort`] holds and return `err`;
/// otherwise leave it (with its marker) and return [`interrupted`].
fn settle(options: &GitOptions, root: &Path, ledger: &Ledger, err: AppError) -> AppError {
    let Ok(repo) = open(options, root) else {
        return interrupted();
    };
    if !repo.rebase_in_progress() {
        remove_marker(&repo);
        return err;
    }
    if !safe_to_abort(&repo, ledger).unwrap_or(false) {
        return interrupted();
    }
    match repo.git.run(Mode::Write, ["rebase", "--abort"]) {
        Ok(out) if out.success && !repo.rebase_in_progress() => {
            remove_marker(&repo);
            err
        }
        _ => interrupted(),
    }
}

// ---------------------------------------------------------------------------
// Commit

fn nul_list(out: &Output) -> Vec<String> {
    nul_split(&out.stdout).filter(|p| !is_temp(p)).collect()
}

/// Stages every change in the workspace and commits it (and nothing else)
/// with `message`. Hooks run normally. File writes may land meanwhile: the
/// next commit picks them up.
pub fn commit(
    options: &GitOptions,
    root: &Path,
    message: &str,
    control: &SyncControl,
) -> AppResult<CommitResult> {
    let _running = control.start()?;
    let repo = open(options, root)?;
    repo.forget_finished_rebase();
    if let Some(reason) = repo.paused_reason()?
        && reason.blocks_commit()
    {
        return Err(repo.paused_error(reason));
    }
    if message.trim().is_empty() {
        return Err(AppError::GitFailed("the commit message is empty".into()));
    }
    let git = &repo.git;
    git.ok(
        Mode::Write,
        "add",
        ["add", "-A"].iter().chain(WORKSPACE_PATHSPEC),
    )?;
    let staged = git.ok(
        Mode::Read,
        "diff",
        [
            "diff",
            "--cached",
            "--name-only",
            "-z",
            "--relative",
            "--no-renames",
        ]
        .iter()
        .chain(WORKSPACE_PATHSPEC),
    )?;
    let mut paths = nul_list(&staged);
    if paths.is_empty() {
        return Ok(CommitResult {
            commit: None,
            paths,
        });
    }
    paths.sort();
    git.ok(
        Mode::Write,
        "commit",
        ["commit", "--quiet", "-m", message]
            .iter()
            .chain(WORKSPACE_PATHSPEC),
    )?;
    Ok(CommitResult {
        commit: Some(repo.rev_parse("HEAD")?),
        paths,
    })
}

// ---------------------------------------------------------------------------
// Conflict copies

/// Local time as `YYYY-MM-DD HHmm`, the stamp used in conflict copy names.
pub fn conflict_stamp(time: chrono::DateTime<chrono::Local>) -> String {
    time.format("%Y-%m-%d %H%M").to_string()
}

/// The longest start of `text` that fits in `max` UTF-8 bytes.
fn truncate_utf8(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Where the other version of `path` is kept after a conflict:
/// `<dir>/<stem> (conflict YYYY-MM-DD HHmm).md`, then `… 2.md`, `… 3.md`.
/// The `.md` extension keeps its case; a stem too long for the suffix to fit
/// in [`FILE_NAME_LIMIT_BYTES`] is shortened. Same names as the editor uses
/// for its own conflicts.
pub fn conflict_copy_path(path: &str, stamp: &str, attempt: u32) -> String {
    let (folder, name) = match path.rfind('/') {
        Some(i) => path.split_at(i + 1),
        None => ("", path),
    };
    let (stem, extension) = if fs_ops::is_markdown(name) && name.len() >= 3 {
        name.split_at(name.len() - 3)
    } else {
        (name, ".md")
    };
    let counter = if attempt > 1 {
        format!(" {attempt}")
    } else {
        String::new()
    };
    let suffix = format!(" (conflict {stamp}){counter}{extension}");
    let room = FILE_NAME_LIMIT_BYTES.saturating_sub(suffix.len());
    format!("{folder}{}{suffix}", truncate_utf8(stem, room))
}

/// Writes `bytes` to a new conflict copy of `rel` that does not replace any
/// existing file, and returns its workspace-relative path.
fn write_conflict_copy(root: &Path, rel: &str, bytes: &[u8], stamp: &str) -> AppResult<String> {
    for attempt in 1..=MAX_CONFLICT_COPY_NAMES {
        let copy = conflict_copy_path(rel, stamp, attempt);
        let target = paths::resolve_for_write(root, &copy)?;
        let mut file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(AppError::from_io(&e, "create", &copy)),
        };
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|e| AppError::from_io(&e, "write", &copy))?;
        return Ok(copy);
    }
    Err(AppError::GitFailed(format!(
        "no free name for a conflict copy of {rel}"
    )))
}

/// Replaces the working tree file `rel` with `bytes`.
fn write_version(root: &Path, rel: &str, bytes: &[u8]) -> AppResult<()> {
    let target = paths::resolve_for_write(root, rel)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::from_io(&e, "create the folder for", rel))?;
    }
    fs_ops::atomic_write(&target, bytes, rel)
}

// ---------------------------------------------------------------------------
// Sync

/// An unmerged path during a rebase.
struct Unmerged {
    /// Workspace-relative path, `None` outside the workspace.
    rel: Option<String>,
    repo_path: String,
    stages: Stages,
}

impl Unmerged {
    /// Only notes inside the workspace, stored as regular files, are
    /// resolved automatically.
    fn resolvable(&self) -> bool {
        self.rel
            .as_deref()
            .is_some_and(|rel| fs_ops::ensure_note(rel).is_ok())
            && self.stages.regular_files()
    }

    fn label(&self) -> &str {
        self.rel.as_deref().unwrap_or(&self.repo_path)
    }
}

/// The contents of a blob as they would be checked out at `repo_path`, with
/// the same filters (line endings, smudge filters) as a normal checkout.
fn blob(git: &Git, hash: &str, repo_path: &str) -> AppResult<Vec<u8>> {
    let path = format!("--path={repo_path}");
    Ok(git
        .ok(
            Mode::Read,
            "cat-file",
            ["cat-file", "--filters", path.as_str(), hash],
        )?
        .stdout)
}

/// Resolves one unmerged note: the upstream version stays at its path and,
/// when both sides changed it, this device's version goes to a conflict copy.
/// When one side deleted it, the modified version is kept. Every file written
/// is recorded in `ledger`.
fn resolve(
    repo: &Repo,
    u: &Unmerged,
    rel: &str,
    stamp: &str,
    ledger: &mut Ledger,
) -> AppResult<Option<ConflictCopy>> {
    let git = &repo.git;
    let root = git.root();
    let read = |hash| blob(git, hash, &u.repo_path);
    match (u.stages.blob(2), u.stages.blob(3)) {
        (Some(upstream), Some(local)) => {
            write_version(root, rel, &read(upstream)?)?;
            ledger.record(repo, &u.repo_path);
            let copy = write_conflict_copy(root, rel, &read(local)?, stamp)?;
            ledger.record(repo, &format!("{}{copy}", repo.prefix));
            Ok(Some(ConflictCopy {
                path: rel.to_owned(),
                copy,
            }))
        }
        (Some(kept), None) | (None, Some(kept)) => {
            write_version(root, rel, &read(kept)?)?;
            ledger.record(repo, &u.repo_path);
            Ok(None)
        }
        (None, None) => Ok(None),
    }
}

/// Literal pathspecs (no glob characters) for workspace-relative paths.
fn literal_pathspecs<'a>(paths: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    paths
        .into_iter()
        .map(|p| format!(":(literal){p}"))
        .collect()
}

/// Rebases the current branch onto its upstream (`git rebase @{upstream}`),
/// resolving note conflicts. Call it holding the working tree lock.
///
/// A marker records the rebase before it starts. Any failure goes through
/// [`settle`] right away. A stop requested by app exit leaves the rebase and
/// its marker in place; the app never undoes it later.
fn rebase(
    options: &GitOptions,
    repo: &Repo,
    stamp: &str,
    control: &SyncControl,
) -> AppResult<Vec<ConflictCopy>> {
    let git = &repo.git;
    let root = git.root();
    let mut ledger = Ledger::default();
    RebaseMarker {
        orig_head: repo.rev_parse("HEAD")?,
        onto: repo.rev_parse("@{upstream}")?,
    }
    .write(&repo.rebase_marker)?;
    let args: Vec<&str> = REBASE_CONFIG
        .iter()
        .copied()
        .chain(["rebase", "@{upstream}"])
        .collect();
    let out = match git.run(Mode::Write, &args) {
        Ok(out) => out,
        Err(err) => return Err(settle(options, root, &ledger, err)),
    };
    let step_end = SystemTime::now();
    if out.success {
        remove_marker(repo);
        return Ok(Vec::new());
    }
    if !repo.rebase_in_progress() {
        // The rebase did not start (a hook refused, files in the way).
        remove_marker(repo);
        return Err(git.failure(Mode::Write, "rebase", &out));
    }
    let mut conflicts = Vec::new();
    let step = Step {
        last: out,
        end: step_end,
    };
    match resolve_rebase(
        options,
        repo,
        stamp,
        step,
        &mut conflicts,
        &mut ledger,
        control,
    ) {
        Ok(()) => {
            remove_marker(repo);
            Ok(conflicts)
        }
        Err(err) if control.is_stopping() => Err(err),
        Err(err) => Err(settle(options, root, &ledger, err)),
    }
}

/// The result of the last git command of a rebase and when it returned.
struct Step {
    last: Output,
    end: SystemTime,
}

/// Runs a rebase command (`--continue`, `--skip`) as the next step.
fn run_step(git: &Git, arg: &str) -> AppResult<Step> {
    let last = git.run(Mode::Write, ["rebase", arg])?;
    Ok(Step {
        last,
        end: SystemTime::now(),
    })
}

/// Puts the conflict markers back in `paths` (still unmerged in the index)
/// after a step failed half-way, so the working tree shows both versions
/// again instead of the upstream one the app had written.
fn restore_markers(git: &Git, paths: &[&Unmerged], ledger: &mut Ledger, repo: &Repo) {
    for u in paths {
        let spec = format!(":(top,literal){}", u.repo_path);
        let restored = git
            .run(Mode::Write, ["checkout", "--merge", "--", &spec])
            .is_ok_and(|out| out.success);
        if restored {
            ledger.record(repo, &u.repo_path);
        }
    }
}

fn resolve_rebase(
    options: &GitOptions,
    repo: &Repo,
    stamp: &str,
    mut step: Step,
    conflicts: &mut Vec<ConflictCopy>,
    ledger: &mut Ledger,
    control: &SyncControl,
) -> AppResult<()> {
    let git = &repo.git;
    let mut skipped = false;
    for _ in 0..MAX_REBASE_STEPS {
        if !repo.rebase_in_progress() {
            return Ok(());
        }
        let current = open(options, git.root())?;
        let unmerged: Vec<Unmerged> = current
            .status
            .entries
            .iter()
            .filter_map(|e| {
                e.unmerged.as_ref().map(|stages| Unmerged {
                    rel: current.to_workspace(&e.path),
                    repo_path: e.path.clone(),
                    stages: stages.clone(),
                })
            })
            .collect();
        // What git wrote for this step is the rebase's own.
        for u in &unmerged {
            ledger.record_from_git(&current, &u.repo_path, step.end);
        }
        control.check()?;
        if unmerged.is_empty() {
            // Nothing to resolve: the replayed commit became empty (older
            // git stops there) or the step failed for another reason.
            let quiet = git.run(Mode::Read, ["diff", "--cached", "--quiet"])?;
            if quiet.success && !skipped {
                if !safe_to_abort(&current, ledger)? {
                    return Err(interrupted());
                }
                step = run_step(git, "--skip")?;
                skipped = true;
                continue;
            }
            return Err(git.failure(Mode::Write, "rebase", &step.last));
        }
        skipped = false;
        let blocked: Vec<&str> = unmerged
            .iter()
            .filter(|u| !u.resolvable())
            .map(Unmerged::label)
            .collect();
        if !blocked.is_empty() {
            let list = git.sanitize(&blocked.join(", "));
            return Err(AppError::GitPaused(format!(
                "{}: {list}",
                PausedReason::PullConflict.as_str()
            )));
        }
        // All or nothing: if any conflicted file changed since git wrote it,
        // nothing is written.
        if !unmerged
            .iter()
            .all(|u| ledger.unchanged(&current, &u.repo_path))
        {
            return Err(interrupted());
        }
        let mut touched = Vec::new();
        let mut written: Vec<&Unmerged> = Vec::new();
        let staged = (|| {
            for u in &unmerged {
                let rel = u.rel.as_deref().unwrap_or_default();
                touched.push(rel.to_owned());
                written.push(u);
                if let Some(conflict) = resolve(repo, u, rel, stamp, ledger)? {
                    touched.push(conflict.copy.clone());
                    conflicts.push(conflict);
                }
            }
            let specs = literal_pathspecs(touched.iter().map(String::as_str));
            let mut add = vec!["add", "-A", "--"];
            add.extend(specs.iter().map(String::as_str));
            git.ok(Mode::Write, "add", &add).map(drop)
        })();
        if let Err(err) = staged {
            // Conflict copies stay (an extra file loses nothing); the files
            // the app overwrote get their conflict markers back.
            let both: Vec<&Unmerged> = written
                .into_iter()
                .filter(|u| u.stages.blob(2).is_some() && u.stages.blob(3).is_some())
                .collect();
            restore_markers(git, &both, ledger, repo);
            return Err(err);
        }
        // Nothing but the rebase's own changes goes into the commit.
        if !index_is_rebase_only(&open(options, git.root())?, ledger)? {
            return Err(interrupted());
        }
        step = run_step(git, "--continue")?;
    }
    Err(AppError::GitFailed("the rebase did not finish".into()))
}

/// Whether `git push` failed because the remote has commits we do not have.
pub fn push_rejected(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("[rejected]") || lower.contains("updates were rejected")
}

/// Whether `git fetch <remote> <branch>` failed because the branch does not
/// exist on the remote.
fn missing_remote_ref(stderr: &str) -> bool {
    stderr.to_lowercase().contains("couldn't find remote ref")
}

/// Forgets the remote-tracking branch of an upstream that no longer exists
/// on the remote, like `git fetch --prune` would, so the status reports
/// `upstream-gone` from now on.
fn prune_upstream(repo: &Repo) -> AppResult<()> {
    let tracking = repo
        .git
        .ok(
            Mode::Read,
            "rev-parse",
            ["rev-parse", "--symbolic-full-name", "@{upstream}"],
        )?
        .text();
    if tracking.starts_with("refs/remotes/") {
        repo.git
            .ok(Mode::Write, "update-ref", ["update-ref", "-d", &tracking])?;
    }
    Ok(())
}

/// Fetches, rebases onto the upstream branch (keeping both versions of
/// conflicting notes) and pushes. A push rejected because someone pushed in
/// the meantime is retried once from the fetch.
///
/// `tree` is held exclusively only while rebasing, so file writes wait only
/// then. `control` stops the sync at a safe point when the app exits.
pub fn sync(
    options: &GitOptions,
    root: &Path,
    control: &SyncControl,
    tree: &TreeLock,
) -> AppResult<SyncResult> {
    sync_at(
        options,
        root,
        &conflict_stamp(chrono::Local::now()),
        control,
        tree,
    )
}

/// [`sync`] with the conflict copy stamp given.
pub fn sync_at(
    options: &GitOptions,
    root: &Path,
    stamp: &str,
    control: &SyncControl,
    tree: &TreeLock,
) -> AppResult<SyncResult> {
    let _running = control.start()?;
    let mut result = SyncResult::default();
    let mut changed = BTreeSet::new();
    for attempt in 0..2 {
        control.check()?;
        let mut repo = open(options, root)?;
        repo.forget_finished_rebase();
        control.attach(&mut repo.git);
        // These may change with the fetch, so they are checked after it.
        match repo.paused_reason()? {
            None
            | Some(
                PausedReason::UpstreamGone
                | PausedReason::OutsideCommits
                | PausedReason::LocalMerges,
            ) => {}
            Some(reason) => return Err(repo.paused_error(reason)),
        }
        let target = match repo.upstream() {
            Upstream::Valid(target) | Upstream::Gone(target) => target,
            Upstream::None | Upstream::Mismatch => {
                return Err(AppError::GitFailed(
                    "the current branch has no upstream branch".into(),
                ));
            }
        };
        let branch_ref = format!("refs/heads/{}", target.branch);
        let fetch = repo.git.run(
            Mode::Network,
            ["fetch", "--quiet", "--", &target.remote, &branch_ref],
        )?;
        if !fetch.success {
            if missing_remote_ref(&fetch.stderr) {
                if repo.status.ab.is_some() {
                    prune_upstream(&repo)?;
                }
                return Err(paused(PausedReason::UpstreamGone));
            }
            return Err(repo.git.failure(Mode::Network, "fetch", &fetch));
        }

        control.check()?;
        let mut repo = open(options, root)?;
        control.attach(&mut repo.git);
        if let Some(reason) = repo.paused_reason()? {
            return Err(repo.paused_error(reason));
        }
        let (mut ahead, behind) = repo.status.ab.unwrap_or((0, 0));
        if behind > 0 {
            // File writes wait from here until the rebase is over.
            let _tree = tree.blocking_write();
            let mut repo = open(options, root)?;
            control.attach(&mut repo.git);
            if !repo.split_changes().0.is_empty() {
                // Uncommitted changes would stop the rebase.
                result.deferred = true;
                break;
            }
            let before = repo.rev_parse("HEAD")?;
            result
                .conflicts
                .extend(rebase(options, &repo, stamp, control)?);
            result.pulled += behind;
            let diff = repo.git.ok(
                Mode::Read,
                "diff",
                [
                    "diff",
                    "--name-only",
                    "-z",
                    "--no-renames",
                    "--relative",
                    &before,
                    "HEAD",
                    "--",
                    ".",
                ],
            )?;
            changed.extend(nul_list(&diff));
            // Check again what the rebase produced before pushing it.
            let rebased = open(options, root)?;
            if let Some(reason) = rebased.paused_reason()? {
                return Err(rebased.paused_error(reason));
            }
            ahead = repo.count(&["rev-list", "--count", "@{upstream}..HEAD"])?;
        }
        if ahead == 0 {
            break;
        }
        control.check()?;
        let refspec = format!("HEAD:{branch_ref}");
        let out = repo.git.run(
            Mode::Network,
            ["push", "--quiet", "--", &target.remote, &refspec],
        )?;
        if out.success {
            result.pushed += ahead;
            break;
        }
        if !push_rejected(&out.stderr) {
            return Err(repo.git.failure(Mode::Network, "push", &out));
        }
        if attempt == 1 {
            return Err(AppError::GitFailed(
                "git push was rejected twice: the remote keeps changing".into(),
            ));
        }
    }
    result.changed = changed.into_iter().collect();
    Ok(result)
}

/// The folder that identifies the repository of `root` for locking: git's
/// common directory (shared by all worktrees), canonicalized. `None` when
/// `root` is not in a repository or git is unavailable.
pub fn lock_key(options: &GitOptions, root: &Path) -> Option<PathBuf> {
    let out = Git::new(options, root)
        .run(Mode::Read, ["rev-parse", "--git-common-dir"])
        .ok()?;
    if !out.success {
        return None;
    }
    dunce::canonicalize(root.join(out.text())).ok()
}

// The tests run real git with Unix hook scripts; git must be on PATH (it is
// on the CI runners).
#[cfg(all(test, unix))]
#[path = "sync_tests.rs"]
mod tests;
