//! Tests for `sync`. They run the real `git` binary in temporary folders,
//! isolated from the user's git configuration (see `git::test_env`), with a
//! bare repository as the remote.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use super::*;
use crate::git::test_env::{bare_options, git, options};

const STAMP: &str = "2026-10-08 1200";

fn ctl() -> SyncControl {
    SyncControl::default()
}

fn tree() -> TreeLock {
    TreeLock::new(())
}

struct Fixture {
    _dir: tempfile::TempDir,
    base: PathBuf,
}

impl Fixture {
    /// A bare `remote.git` with one commit (`inbox/a.md`, `data.json`).
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(dir.path()).unwrap();
        git(&base, &["init", "-q", "--bare", "-b", "main", "remote.git"]);
        let fx = Fixture { _dir: dir, base };
        let seed = fx.clone_as("seed");
        write(&seed, "inbox/a.md", "# A\n\nline\n");
        write(&seed, "data.json", "{}\n");
        commit_all(&seed, "seed");
        git(&seed, &["push", "-q", "origin", "HEAD:refs/heads/main"]);
        fx
    }

    fn remote(&self) -> PathBuf {
        self.base.join("remote.git")
    }

    fn clone_as(&self, name: &str) -> PathBuf {
        git(&self.base, &["clone", "-q", "remote.git", name]);
        self.base.join(name)
    }
}

fn write(dir: &Path, rel: &str, contents: &str) {
    let path = dir.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

fn read(dir: &Path, rel: &str) -> String {
    fs::read_to_string(dir.join(rel)).unwrap()
}

fn commit_all(dir: &Path, message: &str) {
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", message]);
}

/// Commits `rel` with `contents` in `dir` and pushes it.
fn push_change(dir: &Path, rel: &str, contents: &str) {
    git(dir, &["pull", "-q", "--rebase"]);
    write(dir, rel, contents);
    commit_all(dir, "other device");
    git(dir, &["push", "-q"]);
}

fn head(dir: &Path) -> String {
    git(dir, &["rev-parse", "HEAD"])
}

fn hook(dir: &Path, name: &str, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join(".git/hooks").join(name);
    fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
}

fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join(name);
    fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn repo_status(dir: &Path) -> RepoStatus {
    match status(&options(), dir).unwrap() {
        GitStatus::Ready(s) | GitStatus::Paused(s) => s,
        other => panic!("unexpected status {other:?}"),
    }
}

fn paused_reason(dir: &Path) -> Option<PausedReason> {
    repo_status(dir).paused_reason
}

fn clean(dir: &Path) -> bool {
    git(dir, &["status", "--porcelain"]).is_empty()
}

// ---------------------------------------------------------------------------
// Pure helpers

#[test]
fn parses_porcelain_v2() {
    let raw = b"# branch.oid 0123\0# branch.head main\0# branch.upstream origin/main\0\
# branch.ab +2 -3\0# stash 1\0\
1 .M N... 100644 100644 100644 aaa aaa notes/a b.md\0\
2 R. N... 100644 100644 100644 aaa aaa R100 notes/new.md\0notes/old.md\0\
u UU N... 100644 100644 100644 100644 h1 h2 h3 notes/c.md\0\
? notes/new dir/x.md\0! ignored.md\0";
    let status = parse_status(raw).unwrap();
    assert_eq!(status.branch.as_deref(), Some("main"));
    assert!(!status.initial);
    assert_eq!(status.upstream.as_deref(), Some("origin/main"));
    assert_eq!(status.ab, Some((2, 3)));
    let paths: Vec<_> = status.entries.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(
        paths,
        [
            "notes/a b.md",
            "notes/new.md",
            "notes/c.md",
            "notes/new dir/x.md"
        ]
    );
    assert_eq!(status.entries[1].orig.as_deref(), Some("notes/old.md"));
    assert_eq!(status.entries[2].xy, "UU");
    assert_eq!(status.entries[0].xy, ".M");
    assert_eq!(status.entries[3].xy, "??");
    let stages = status.entries[2].unmerged.as_ref().unwrap();
    assert_eq!(stages.blob(2), Some("h2"));
    assert_eq!(stages.blob(3), Some("h3"));
    assert!(stages.regular_files());

    let detached = parse_status(b"# branch.oid (initial)\0# branch.head (detached)\0").unwrap();
    assert_eq!(detached.branch, None);
    assert!(detached.initial);
    assert_eq!(detached.ab, None);
}

#[test]
fn rejects_malformed_status() {
    for bad in [
        &b"1 .M N... too short"[..],
        b"2 R. N... 100644 100644 100644 a a R100 new.md",
        b"u UU N... 1 2",
        b"# branch.ab +x -1",
        b"# branch.ab 1",
        b"# branch.ab +1 2",
        b"z what",
        b"nospace",
    ] {
        let err = parse_status(bad).unwrap_err();
        assert_eq!(err.kind(), "GitFailed", "{}", String::from_utf8_lossy(bad));
        assert_eq!(err.to_string(), "unexpected output from git status");
    }
}

#[test]
fn stage_modes() {
    let stages = |m: [&str; 3]| Stages {
        modes: m.map(String::from),
        hashes: ["a", "b", "c"].map(String::from),
    };
    let ud = stages(["100644", "100755", "000000"]);
    assert_eq!(ud.blob(2), Some("b"));
    assert_eq!(ud.blob(3), None);
    assert!(ud.regular_files());
    assert!(!stages(["100644", "120000", "100644"]).regular_files());
    assert!(!stages(["000000", "160000", "100644"]).regular_files());
}

#[test]
fn parses_config() {
    let raw = b"user.name\nMe\0user.email\n\0core.sshcommand\nssh -i k\0\
remote.origin.url\nx\0branch.feat.x.remote\norigin\0branch.feat.x.merge\nrefs/heads/feat.x\0\
branch.odd\nvalue\0other.key\n1\0novalue\0";
    let config = parse_config(raw);
    assert!(config.user_name);
    assert!(!config.user_email);
    assert!(config.ssh_command);
    assert!(config.remote);
    assert_eq!(config.branch_remotes, [("feat.x".into(), "origin".into())]);
    assert_eq!(
        config.branch_merges,
        [("feat.x".into(), "refs/heads/feat.x".into())]
    );
    assert_eq!(parse_config(b""), ConfigValues::default());
}

#[test]
fn temp_files_and_trash_are_ignored() {
    assert!(is_temp(".kaido-12-3.tmp"));
    assert!(is_temp("inbox/.kaido-12-3.tmp"));
    assert!(is_temp(".Trash-1000/files/a.md"));
    assert!(is_temp("notes/.Trash-1000/info/a.md.trashinfo"));
    assert!(!is_temp("inbox/a.md"));
    assert!(!is_temp(".kaido/config.json"));
    assert!(!is_temp("inbox/.kaido-notes.md"));
}

#[test]
fn conflict_copy_names_match_the_editor() {
    assert_eq!(
        conflict_copy_path("inbox/idea.md", STAMP, 1),
        "inbox/idea (conflict 2026-10-08 1200).md"
    );
    assert_eq!(
        conflict_copy_path("a/b/Deploy.MD", STAMP, 2),
        "a/b/Deploy (conflict 2026-10-08 1200) 2.MD"
    );
    assert_eq!(
        conflict_copy_path("root.md", STAMP, 3),
        "root (conflict 2026-10-08 1200) 3.md"
    );
    assert_eq!(
        conflict_copy_path("notes/plain", STAMP, 1),
        "notes/plain (conflict 2026-10-08 1200).md"
    );
    // The stem is cut between characters so the name fits in 255 bytes.
    let stem = "é".repeat(150);
    let copy = conflict_copy_path(&format!("p/{stem}.md"), STAMP, 12);
    let name = copy.strip_prefix("p/").unwrap();
    assert!(name.len() <= FILE_NAME_LIMIT_BYTES, "{}", name.len());
    assert!(name.len() >= FILE_NAME_LIMIT_BYTES - 1);
    assert!(name.ends_with(" (conflict 2026-10-08 1200) 12.md"));
    assert!(name.starts_with("éé"));
    // An odd byte budget falls inside a two-byte character.
    let copy = conflict_copy_path(&format!("{stem}.md"), STAMP, 1);
    assert_eq!(copy.len(), FILE_NAME_LIMIT_BYTES - 1);
    assert!(copy.ends_with("é (conflict 2026-10-08 1200).md"));
    let time = chrono::TimeZone::with_ymd_and_hms(&chrono::Local, 2026, 3, 4, 5, 6, 7).unwrap();
    assert_eq!(conflict_stamp(time), "2026-03-04 0506");
}

#[test]
fn recognizes_rejected_pushes() {
    assert!(push_rejected(
        " ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs"
    ));
    assert!(push_rejected(
        "hint: Updates were rejected because the tip..."
    ));
    assert!(!push_rejected(
        " ! [remote rejected] main -> main (pre-receive hook declined)"
    ));
    assert!(!push_rejected("fatal: Authentication failed"));
}

#[test]
fn serializes_the_ipc_shapes() {
    let unavailable = GitStatus::Unavailable {
        reason: UnavailableReason::GitMissing,
    };
    assert_eq!(
        serde_json::to_value(unavailable).unwrap(),
        serde_json::json!({ "state": "unavailable", "reason": "git-missing" })
    );
    let repo = RepoStatus {
        paused_reason: Some(PausedReason::OperationInProgress),
        paused_message: Some(APP_REBASE_MESSAGE.into()),
        operation: Some(Operation::CherryPick),
        branch: None,
        upstream: Some("origin/main".into()),
        remote: true,
        ahead: 1,
        behind: 2,
        changed: vec!["a.md".into()],
        git_version: "2.43.0".into(),
    };
    assert_eq!(
        serde_json::to_value(GitStatus::Paused(repo.clone())).unwrap(),
        serde_json::json!({
            "state": "paused",
            "pausedReason": "operation-in-progress",
            "pausedMessage": APP_REBASE_MESSAGE,
            "operation": "cherry-pick",
            "branch": null,
            "upstream": "origin/main",
            "remote": true,
            "ahead": 1,
            "behind": 2,
            "changed": ["a.md"],
            "gitVersion": "2.43.0"
        })
    );
    let ready = RepoStatus {
        paused_reason: None,
        paused_message: None,
        operation: None,
        ..repo
    };
    let json = serde_json::to_value(GitStatus::Ready(ready)).unwrap();
    assert_eq!(json["state"], "ready");
    assert!(json.get("pausedReason").is_none());
    assert!(json.get("pausedMessage").is_none());
    assert!(json.get("operation").is_none());
    for (reason, text) in [
        (PausedReason::DetachedHead, "detached-head"),
        (PausedReason::UnmergedFiles, "unmerged-files"),
        (PausedReason::OutsideChanges, "outside-changes"),
        (PausedReason::NoIdentity, "no-identity"),
        (PausedReason::IndexLocked, "index-locked"),
        (PausedReason::UpstreamMismatch, "upstream-mismatch"),
        (PausedReason::UpstreamGone, "upstream-gone"),
        (PausedReason::OutsideCommits, "outside-commits"),
        (PausedReason::OperationInProgress, "operation-in-progress"),
        (PausedReason::LocalMerges, "local-merges"),
        (PausedReason::PullConflict, "pull-conflict"),
    ] {
        assert_eq!(reason.as_str(), text);
        assert_eq!(serde_json::to_value(reason).unwrap(), text);
        let blocks = matches!(
            text,
            "operation-in-progress"
                | "index-locked"
                | "unmerged-files"
                | "detached-head"
                | "no-identity"
        );
        assert_eq!(reason.blocks_commit(), blocks, "{text}");
    }
    assert_eq!(UnavailableReason::NotARepo.as_str(), "not-a-repo");
    let result = SyncResult {
        pulled: 1,
        pushed: 2,
        changed: vec!["a.md".into()],
        conflicts: vec![ConflictCopy {
            path: "a.md".into(),
            copy: "a (conflict 2026-10-08 1200).md".into(),
        }],
        deferred: false,
    };
    assert_eq!(
        serde_json::to_value(result).unwrap(),
        serde_json::json!({
            "pulled": 1, "pushed": 2, "changed": ["a.md"],
            "conflicts": [{ "path": "a.md", "copy": "a (conflict 2026-10-08 1200).md" }],
            "deferred": false
        })
    );
    let commit = CommitResult {
        commit: None,
        paths: vec![],
    };
    assert_eq!(
        serde_json::to_value(commit).unwrap(),
        serde_json::json!({ "commit": null, "paths": [] })
    );
}

// ---------------------------------------------------------------------------
// Status

#[test]
fn unavailable_states() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        status(&options(), dir.path()).unwrap(),
        GitStatus::Unavailable {
            reason: UnavailableReason::NotARepo
        }
    );
    let mut missing = options();
    missing.program = dir.path().join("no-git").into_os_string();
    assert_eq!(
        status(&missing, dir.path()).unwrap(),
        GitStatus::Unavailable {
            reason: UnavailableReason::GitMissing
        }
    );
    assert_eq!(
        commit(&options(), dir.path(), "m", &ctl()).unwrap_err(),
        AppError::GitUnavailable("not-a-repo".into())
    );
    assert_eq!(
        sync_at(&missing, dir.path(), STAMP, &ctl(), &tree()).unwrap_err(),
        AppError::GitUnavailable("git-missing".into())
    );
}

#[test]
fn git_failures_while_inspecting_are_reported() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    // A broken config file makes `git config` (and most commands) fail.
    fs::write(a.join(".git/config"), "[core\nbroken").unwrap();
    let err = status(&options(), &a).unwrap_err();
    assert_eq!(err.kind(), "GitFailed", "{err}");

    // A program that answers `version` but nothing else.
    let fake = script(
        &fx.base,
        "fake-git",
        "[ \"$3\" = version ] && echo 'git version 9' && exit 0\nexit 3",
    );
    let mut opts = options();
    opts.program = fake.into_os_string();
    let err = status(&opts, &fx.base).unwrap_err();
    assert_eq!(err.kind(), "GitFailed");
    let fake = script(&fx.base, "fake-git2", "exit 2");
    opts.program = fake.into_os_string();
    assert_eq!(status(&opts, &fx.base).unwrap_err().kind(), "GitFailed");
    // Unexpected rev-parse output.
    let fake = script(&fx.base, "fake-git3", "echo 'git version 9'");
    opts.program = fake.into_os_string();
    assert_eq!(
        status(&opts, &fx.base).unwrap_err().to_string(),
        "unexpected output from git rev-parse"
    );
}

#[test]
fn ready_status_lists_changes_and_counts() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let b = fx.clone_as("b");
    let version = git(&a, &["version"]);

    let s = repo_status(&a);
    assert_eq!(
        serde_json::to_value(status(&options(), &a).unwrap()).unwrap(),
        serde_json::json!({
            "state": "ready",
            "branch": "main",
            "upstream": "origin/main",
            "remote": true,
            "ahead": 0,
            "behind": 0,
            "changed": [],
            "gitVersion": version.strip_prefix("git version ").unwrap()
        })
    );
    assert_eq!(s.paused_reason, None);

    write(&a, "inbox/new.md", "x");
    write(&a, "inbox/a.md", "changed");
    write(&a, "p/deep/n.md", "x");
    write(&a, "inbox/.kaido-1-2.tmp", "x");
    write(&a, ".Trash-1000/files/old.md", "x");
    fs::remove_file(a.join("data.json")).unwrap();
    let s = repo_status(&a);
    assert_eq!(
        s.changed,
        ["data.json", "inbox/a.md", "inbox/new.md", "p/deep/n.md"]
    );

    commit_all(&a, "local");
    push_change(&b, "inbox/b.md", "b");
    assert_eq!((repo_status(&a).ahead, repo_status(&a).behind), (1, 0));
    git(&a, &["fetch", "-q"]);
    let s = repo_status(&a);
    assert_eq!((s.ahead, s.behind), (1, 1));
    // Renames are reported with both paths.
    git(&a, &["mv", "inbox/new.md", "inbox/renamed.md"]);
    assert!(repo_status(&a).changed.contains(&"inbox/new.md".to_owned()));
    assert!(
        repo_status(&a)
            .changed
            .contains(&"inbox/renamed.md".to_owned())
    );
}

#[test]
fn local_only_repository() {
    let dir = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(dir.path()).unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    let s = repo_status(&root);
    assert_eq!(s.branch.as_deref(), Some("main"));
    assert_eq!(s.upstream, None);
    assert!(!s.remote);
    assert_eq!((s.ahead, s.behind), (0, 0));
    assert_eq!(s.paused_reason, None);
    write(&root, "inbox/a.md", "x");
    let done = commit(&options(), &root, "Add inbox/a.md", &ctl()).unwrap();
    assert_eq!(done.paths, ["inbox/a.md"]);
    assert_eq!(done.commit.unwrap(), head(&root));
    let err = sync_at(&options(), &root, STAMP, &ctl(), &tree()).unwrap_err();
    assert_eq!(
        err,
        AppError::GitFailed("the current branch has no upstream branch".into())
    );
    git(&root, &["remote", "add", "origin", "/nowhere"]);
    assert!(repo_status(&root).remote);
}

#[test]
fn detached_head_pauses() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    git(&a, &["checkout", "-q", "--detach"]);
    let s = repo_status(&a);
    assert_eq!(s.branch, None);
    assert_eq!(s.paused_reason, Some(PausedReason::DetachedHead));
    assert!(matches!(
        status(&options(), &a).unwrap(),
        GitStatus::Paused(_)
    ));
    write(&a, "inbox/x.md", "x");
    assert_eq!(
        commit(&options(), &a, "m", &ctl()).unwrap_err(),
        AppError::GitPaused("detached-head".into())
    );
    assert_eq!(
        sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap_err(),
        AppError::GitPaused("detached-head".into())
    );
}

/// Makes `a` and the remote disagree on `inbox/a.md`.
fn diverge(fx: &Fixture, a: &Path) {
    let b = fx.clone_as("b");
    push_change(&b, "inbox/a.md", "theirs\n");
    write(a, "inbox/a.md", "ours\n");
    commit_all(a, "ours");
    git(a, &["fetch", "-q"]);
}

#[test]
fn operations_in_progress_pause() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    diverge(&fx, &a);

    let check = |op: Operation| {
        let s = repo_status(&a);
        assert_eq!(s.paused_reason, Some(PausedReason::OperationInProgress));
        assert_eq!(s.operation, Some(op));
        assert_eq!(
            commit(&options(), &a, "m", &ctl()).unwrap_err(),
            AppError::GitPaused("operation-in-progress".into())
        );
        assert_eq!(
            sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap_err(),
            AppError::GitPaused("operation-in-progress".into())
        );
    };
    let fails = |args: &[&str]| {
        let out = Git::new(&options(), &a).run(Mode::Write, args).unwrap();
        assert!(!out.success, "{args:?} should conflict");
    };

    fails(&["rebase", "@{upstream}"]);
    check(Operation::Rebase);
    git(&a, &["rebase", "--abort"]);

    fails(&["merge", "@{upstream}"]);
    check(Operation::Merge);
    git(&a, &["merge", "--abort"]);

    fails(&["cherry-pick", "@{upstream}"]);
    check(Operation::CherryPick);
    git(&a, &["cherry-pick", "--abort"]);

    let upstream = git(&a, &["rev-parse", "@{upstream}"]);
    fs::write(a.join(".git/REVERT_HEAD"), upstream).unwrap();
    check(Operation::Revert);
    fs::remove_file(a.join(".git/REVERT_HEAD")).unwrap();

    git(&a, &["bisect", "start"]);
    check(Operation::Bisect);
    git(&a, &["bisect", "reset"]);

    assert_eq!(paused_reason(&a), None);
    assert!(clean(&a));
}

#[test]
fn unmerged_files_without_an_operation_pause() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    write(&a, "inbox/a.md", "stashed\n");
    git(&a, &["stash", "-q"]);
    write(&a, "inbox/a.md", "committed\n");
    commit_all(&a, "c");
    let out = Git::new(&options(), &a)
        .run(Mode::Write, ["stash", "pop"])
        .unwrap();
    assert!(!out.success);
    let s = repo_status(&a);
    assert_eq!(s.operation, None);
    assert_eq!(s.paused_reason, Some(PausedReason::UnmergedFiles));
    assert_eq!(
        commit(&options(), &a, "m", &ctl()).unwrap_err(),
        AppError::GitPaused("unmerged-files".into())
    );
}

#[test]
fn missing_identity_pauses() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    write(&a, "inbox/x.md", "x");
    let anonymous = bare_options();
    let GitStatus::Paused(s) = status(&anonymous, &a).unwrap() else {
        panic!("expected paused");
    };
    assert_eq!(s.paused_reason, Some(PausedReason::NoIdentity));
    assert_eq!(
        commit(&anonymous, &a, "m", &ctl()).unwrap_err(),
        AppError::GitPaused("no-identity".into())
    );
    // Identity from the repository configuration.
    git(&a, &["config", "user.name", "Someone"]);
    git(&a, &["config", "user.email", "someone@example.com"]);
    assert!(matches!(
        status(&anonymous, &a).unwrap(),
        GitStatus::Ready(_)
    ));
    // Or the `EMAIL` variable for the address.
    git(&a, &["config", "--unset", "user.email"]);
    let mut with_email = bare_options();
    with_email
        .env
        .push(("EMAIL".into(), "e@example.com".into()));
    assert!(matches!(
        status(&with_email, &a).unwrap(),
        GitStatus::Ready(_)
    ));
    // A more important reason wins.
    git(&a, &["checkout", "-q", "--detach"]);
    assert_eq!(
        repo_status_with(&anonymous, &a).paused_reason,
        Some(PausedReason::DetachedHead)
    );
}

fn repo_status_with(opts: &GitOptions, dir: &Path) -> RepoStatus {
    match status(opts, dir).unwrap() {
        GitStatus::Ready(s) | GitStatus::Paused(s) => s,
        other => panic!("unexpected status {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Workspace inside a larger repository

#[test]
fn subfolder_workspace_is_isolated() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    write(&a, "notes/inbox/n.md", "n");
    write(&a, "src/main.rs", "fn main() {}");
    commit_all(&a, "layout");
    git(&a, &["push", "-q"]);
    let notes = a.join("notes");
    assert_eq!(paused_reason(&notes), None);

    // Staged and unstaged changes outside the workspace.
    write(&a, "src/main.rs", "fn main() { changed }");
    write(&a, "src/staged.rs", "staged");
    git(&a, &["add", "src/staged.rs"]);
    write(&notes, "inbox/n.md", "edited");
    write(&notes, "inbox/new.md", "new");
    write(&notes, "inbox/.kaido-9-9.tmp", "temp");
    write(&notes, ".Trash-1000/files/t.md", "trash");

    let s = repo_status(&notes);
    assert_eq!(s.paused_reason, Some(PausedReason::OutsideChanges));
    assert_eq!(s.changed, ["inbox/n.md", "inbox/new.md"]);

    // Commits still happen, limited to the workspace.
    let done = commit(&options(), &notes, "Update 2 notes in inbox", &ctl()).unwrap();
    assert_eq!(done.paths, ["inbox/n.md", "inbox/new.md"]);
    let files = git(&a, &["show", "--name-only", "--format=", "HEAD"]);
    assert_eq!(files, "notes/inbox/n.md\nnotes/inbox/new.md");
    assert_eq!(
        git(&a, &["log", "-1", "--format=%s"]),
        "Update 2 notes in inbox"
    );
    // The user's staged file is still staged, and nothing else moved.
    let porcelain = git(&a, &["status", "--porcelain", "-uall"]);
    assert!(porcelain.contains("A  src/staged.rs"), "{porcelain}");
    assert!(porcelain.contains(" M src/main.rs"), "{porcelain}");
    assert!(
        porcelain.contains("?? notes/inbox/.kaido-9-9.tmp"),
        "{porcelain}"
    );
    assert!(
        porcelain.contains("?? notes/.Trash-1000/files/t.md"),
        "{porcelain}"
    );

    // Pulling is paused while there are outside changes.
    assert_eq!(
        sync_at(&options(), &notes, STAMP, &ctl(), &tree()).unwrap_err(),
        AppError::GitPaused("outside-changes".into())
    );
}

// ---------------------------------------------------------------------------
// Commit

#[test]
fn commits_workspace_changes() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let empty = commit(&options(), &a, "nothing", &ctl()).unwrap();
    assert_eq!(
        empty,
        CommitResult {
            commit: None,
            paths: vec![]
        }
    );
    write(&a, "inbox/a.md", "edited");
    write(&a, "p/b.md", "b");
    write(&a, "p/.kaido-1-1.tmp", "temp");
    write(&a, "p/[odd] *name?.md", "glob characters");
    fs::remove_file(a.join("data.json")).unwrap();
    let done = commit(&options(), &a, "Update 4 files in 2 projects", &ctl()).unwrap();
    assert_eq!(
        done.paths,
        ["data.json", "inbox/a.md", "p/[odd] *name?.md", "p/b.md"]
    );
    assert_eq!(done.commit.as_deref(), Some(head(&a).as_str()));
    assert_eq!(
        git(&a, &["status", "--porcelain", "-uall"]),
        "?? p/.kaido-1-1.tmp"
    );
    // Only temp files left: nothing to commit.
    assert_eq!(
        commit(&options(), &a, "again", &ctl()).unwrap().commit,
        None
    );
    // The message is passed as is, never through a shell.
    write(&a, "inbox/a.md", "again");
    let message = "--amend $(touch pwned) `id`; \"quoted\"";
    commit(&options(), &a, message, &ctl()).unwrap();
    assert_eq!(git(&a, &["log", "-1", "--format=%s"]), message);
    assert!(!a.join("pwned").exists());
}

#[test]
fn commit_errors() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    write(&a, "inbox/a.md", "edited");
    assert_eq!(
        commit(&options(), &a, "  \n", &ctl()).unwrap_err(),
        AppError::GitFailed("the commit message is empty".into())
    );
    let outside = fx.base.join("lint.log");
    hook(
        &a,
        "pre-commit",
        &format!(
            "echo \"lint failed, see {}\" >&2\nexit 1",
            outside.display()
        ),
    );
    let err = commit(&options(), &a, "m", &ctl()).unwrap_err();
    assert_eq!(err.kind(), "GitFailed");
    assert_eq!(
        err.to_string(),
        "git commit failed: lint failed, see <path>"
    );
    // A passing hook runs too.
    hook(&a, "pre-commit", &format!("touch '{}'", outside.display()));
    assert!(
        commit(&options(), &a, "m", &ctl())
            .unwrap()
            .commit
            .is_some()
    );
    assert!(outside.exists());
}

// ---------------------------------------------------------------------------
// Sync

#[test]
fn sync_pulls_and_pushes() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let b = fx.clone_as("b");

    // Nothing to do.
    assert_eq!(
        sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap(),
        SyncResult::default()
    );

    // Fast-forward pull.
    push_change(&b, "inbox/from-b.md", "b");
    let result = sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap();
    assert_eq!(
        result,
        SyncResult {
            pulled: 1,
            pushed: 0,
            changed: vec!["inbox/from-b.md".into()],
            conflicts: vec![],
            deferred: false,
        }
    );
    assert_eq!(read(&a, "inbox/from-b.md"), "b");

    // Push only.
    write(&a, "inbox/from-a.md", "a");
    commit(&options(), &a, "Add inbox/from-a.md", &ctl()).unwrap();
    let result = sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap();
    assert_eq!((result.pulled, result.pushed), (0, 1));
    assert_eq!(git(&fx.remote(), &["rev-parse", "main"]), head(&a));

    // Both: rebase onto the upstream, then push. History stays linear.
    push_change(&b, "inbox/b2.md", "b2");
    write(&a, "inbox/a2.md", "a2");
    commit(&options(), &a, "Add inbox/a2.md", &ctl()).unwrap();
    let result = sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap();
    assert_eq!((result.pulled, result.pushed), (1, 1));
    assert_eq!(result.changed, ["inbox/b2.md"]);
    assert_eq!(git(&a, &["rev-list", "--merges", "--count", "HEAD"]), "0");
    assert_eq!(git(&fx.remote(), &["rev-parse", "main"]), head(&a));
    assert_eq!(paused_reason(&a), None);
    let s = repo_status(&a);
    assert_eq!((s.ahead, s.behind), (0, 0));
}

#[test]
fn sync_waits_for_uncommitted_changes_before_pulling() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let b = fx.clone_as("b");
    push_change(&b, "inbox/a.md", "theirs");
    write(&a, "inbox/typing.md", "not committed yet");
    let before = head(&a);
    let result = sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap();
    assert_eq!(
        result,
        SyncResult {
            deferred: true,
            ..SyncResult::default()
        }
    );
    assert_eq!(head(&a), before);
    assert_eq!(repo_status(&a).behind, 1);
    assert_eq!(read(&a, "inbox/typing.md"), "not committed yet");
}

#[test]
fn sync_keeps_both_versions_of_a_note() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let b = fx.clone_as("b");
    // A copy name that is already taken: the next one is used.
    write(&a, "inbox/a (conflict 2026-10-08 1200).md", "older copy");
    commit_all(&a, "older copy");
    git(&a, &["push", "-q"]);
    push_change(&b, "inbox/a.md", "# A\n\nfrom b\n");
    write(&a, "inbox/a.md", "# A\n\nfrom a\n");
    commit(&options(), &a, "Update inbox/a.md", &ctl()).unwrap();

    let result = sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap();
    let copy = "inbox/a (conflict 2026-10-08 1200) 2.md";
    assert_eq!(
        result.conflicts,
        [ConflictCopy {
            path: "inbox/a.md".into(),
            copy: copy.into()
        }]
    );
    assert_eq!((result.pulled, result.pushed), (1, 1));
    assert_eq!(
        result.changed,
        ["inbox/a (conflict 2026-10-08 1200) 2.md", "inbox/a.md"]
    );
    assert_eq!(read(&a, "inbox/a.md"), "# A\n\nfrom b\n");
    assert_eq!(read(&a, copy), "# A\n\nfrom a\n");
    assert_eq!(
        read(&a, "inbox/a (conflict 2026-10-08 1200).md"),
        "older copy"
    );
    assert!(clean(&a));
    assert_eq!(paused_reason(&a), None);
    // The other device gets both files.
    sync_at(&options(), &b, STAMP, &ctl(), &tree()).unwrap();
    assert_eq!(read(&b, copy), "# A\n\nfrom a\n");
    assert_eq!(read(&b, "inbox/a.md"), "# A\n\nfrom b\n");
}

#[test]
fn sync_resolves_modify_delete_by_keeping_the_modified_note() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let b = fx.clone_as("b");
    write(&a, "p/upstream-edits.md", "base");
    write(&a, "p/local-edits.md", "base");
    commit_all(&a, "two notes");
    git(&a, &["push", "-q"]);

    git(&b, &["pull", "-q", "--rebase"]);
    write(&b, "p/upstream-edits.md", "edited on b");
    fs::remove_file(b.join("p/local-edits.md")).unwrap();
    commit_all(&b, "b");
    git(&b, &["push", "-q"]);

    fs::remove_file(a.join("p/upstream-edits.md")).unwrap();
    write(&a, "p/local-edits.md", "edited on a");
    commit(&options(), &a, "a", &ctl()).unwrap();

    let result = sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap();
    assert!(result.conflicts.is_empty());
    assert_eq!(read(&a, "p/upstream-edits.md"), "edited on b");
    assert_eq!(read(&a, "p/local-edits.md"), "edited on a");
    assert!(clean(&a));
    assert_eq!(git(&fx.remote(), &["rev-parse", "main"]), head(&a));
}

#[test]
fn sync_drops_a_local_commit_that_only_deleted_an_edited_note() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let b = fx.clone_as("b");
    push_change(&b, "inbox/a.md", "edited on b");
    fs::remove_file(a.join("inbox/a.md")).unwrap();
    commit(&options(), &a, "Delete inbox/a.md", &ctl()).unwrap();
    let result = sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap();
    assert_eq!(read(&a, "inbox/a.md"), "edited on b");
    assert_eq!(result.pulled, 1);
    assert_eq!(result.pushed, 0);
    assert_eq!(head(&a), git(&fx.remote(), &["rev-parse", "main"]));
}

#[test]
fn sync_aborts_on_conflicts_it_must_not_resolve() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let b = fx.clone_as("b");
    push_change(&b, "data.json", "{\"b\":1}\n");
    write(&a, "data.json", "{\"a\":1}\n");
    commit_all(&a, "a");
    let before = head(&a);
    let err = sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap_err();
    assert_eq!(err, AppError::GitPaused("pull-conflict: data.json".into()));
    // The rebase was aborted: the repository is exactly as before.
    assert_eq!(head(&a), before);
    assert!(clean(&a));
    assert_eq!(repo_status(&a).operation, None);
    assert_eq!(read(&a, "data.json"), "{\"a\":1}\n");

    // A note conflict next to a non-note one is not resolved either.
    git(&a, &["reset", "-q", "--hard", "@{upstream}"]);
    push_change(&b, ".kaido/config.json", "{\"v\":1}");
    push_change(&b, "inbox/a.md", "b");
    write(&a, ".kaido/config.json", "{\"v\":2}");
    write(&a, "inbox/a.md", "a");
    commit_all(&a, "a");
    let err = sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap_err();
    assert_eq!(
        err,
        AppError::GitPaused("pull-conflict: .kaido/config.json".into())
    );
    assert!(clean(&a));
    assert_eq!(read(&a, "inbox/a.md"), "a");
}

#[test]
fn outside_commits_pause_sync_but_not_commits() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let b = fx.clone_as("b");
    let notes = a.join("notes");
    write(&notes, "n.md", "n");
    commit(&options(), &notes, "Add n.md", &ctl()).unwrap();
    assert_eq!(paused_reason(&notes), None);
    // The user commits code outside the workspace on the same branch.
    write(&a, "src/lib.rs", "code");
    commit_all(&a, "code");
    assert_eq!(paused_reason(&notes), Some(PausedReason::OutsideCommits));
    push_change(&b, "src/lib.rs", "other code");
    let before = head(&a);
    let err = sync_at(&options(), &notes, STAMP, &ctl(), &tree()).unwrap_err();
    assert_eq!(err, AppError::GitPaused("outside-commits".into()));
    assert_eq!(head(&a), before);
    assert_eq!(read(&a, "src/lib.rs"), "code");
    // Notes can still be committed.
    write(&notes, "n.md", "edited");
    assert!(
        commit(&options(), &notes, "Update n.md", &ctl())
            .unwrap()
            .commit
            .is_some()
    );
    // At the repository root every path is inside the workspace.
    assert_eq!(paused_reason(&a), None);
}

#[test]
fn union_merge_combines_task_lists() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let b = fx.clone_as("b");
    write(&a, ".gitattributes", "tasks.md merge=union\n");
    write(&a, "inbox/tasks.md", "- [ ] one\n");
    commit_all(&a, "tasks");
    git(&a, &["push", "-q"]);
    push_change(&b, "inbox/tasks.md", "- [ ] one\n- [ ] from b\n");
    write(&a, "inbox/tasks.md", "- [ ] one\n- [ ] from a\n");
    commit(&options(), &a, "Update tasks in inbox", &ctl()).unwrap();
    let result = sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap();
    assert!(result.conflicts.is_empty());
    let tasks = read(&a, "inbox/tasks.md");
    assert!(
        tasks.contains("from a") && tasks.contains("from b"),
        "{tasks}"
    );
}

#[test]
fn rebase_that_cannot_start_is_reported() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let b = fx.clone_as("b");
    push_change(&b, "inbox/a.md", "b");
    write(&a, "inbox/x.md", "x");
    commit_all(&a, "a");
    // A pre-rebase hook refuses.
    hook(&a, "pre-rebase", "echo 'not now' >&2\nexit 1");
    let err = sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap_err();
    assert_eq!(err.kind(), "GitFailed");
    assert!(err.to_string().contains("not now"), "{err}");
    assert_eq!(repo_status(&a).operation, None);
}

#[test]
fn failures_while_continuing_abort_the_rebase() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let b = fx.clone_as("b");
    push_change(&b, "inbox/a.md", "b");
    write(&a, "inbox/a.md", "a");
    commit_all(&a, "a");
    let before = head(&a);
    // The commit made by `rebase --continue` cannot be signed.
    let gpg = script(&fx.base, "fake-gpg", "echo 'no key' >&2\nexit 2");
    git(&a, &["config", "commit.gpgSign", "true"]);
    git(&a, &["config", "gpg.program", gpg.to_str().unwrap()]);
    let err = sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap_err();
    assert_eq!(err.kind(), "GitFailed", "{err}");
    assert_eq!(repo_status(&a).operation, None);
    assert_eq!(head(&a), before);
    assert!(clean(&a));
}

#[test]
fn rejected_push_is_retried_once() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let b = fx.clone_as("b");
    let marker = fx.base.join("raced");
    // Someone pushes right after our rebase, once.
    let race = format!(
        "unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX\n\
         [ -e '{m}' ] && exit 0\ntouch '{m}'\n\
         cd '{b}' && git pull -q --rebase && echo race >> race.md && git add -A && \
         git commit -q -m race && git push -q",
        m = marker.display(),
        b = b.display()
    );
    hook(&a, "post-rewrite", &race);
    push_change(&b, "inbox/b.md", "b");
    write(&a, "inbox/a2.md", "a");
    commit(&options(), &a, "Add inbox/a2.md", &ctl()).unwrap();
    let result = sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap();
    assert!(marker.exists());
    assert_eq!((result.pulled, result.pushed), (2, 1));
    assert_eq!(result.changed, ["inbox/b.md", "race.md"]);
    assert_eq!(git(&fx.remote(), &["rev-parse", "main"]), head(&a));

    // Someone pushes after every rebase: give up after the retry.
    let always = race.replace(&format!("[ -e '{}' ] && exit 0\n", marker.display()), "");
    hook(&a, "post-rewrite", &always);
    push_change(&b, "inbox/b3.md", "b");
    write(&a, "inbox/a3.md", "a");
    commit(&options(), &a, "Add inbox/a3.md", &ctl()).unwrap();
    let err = sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap_err();
    assert_eq!(
        err,
        AppError::GitFailed("git push was rejected twice: the remote keeps changing".into())
    );
}

#[test]
fn push_failures_are_classified() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    write(&a, "inbox/x.md", "x");
    commit(&options(), &a, "x", &ctl()).unwrap();
    hook(
        &a,
        "pre-push",
        &format!("echo 'blocked by {}' >&2\nexit 1", fx.base.display()),
    );
    let err = sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap_err();
    assert_eq!(err.kind(), "GitFailed");
    assert!(err.to_string().starts_with("git push failed: "), "{err}");
    assert!(
        !err.to_string().contains(fx.base.to_str().unwrap()),
        "{err}"
    );
}

// ---------------------------------------------------------------------------
// Network, authentication and timeouts

/// Points `a`'s origin at an SSH URL served by a fake `ssh` script.
fn fake_ssh(fx: &Fixture, a: &Path, body: &str) -> GitOptions {
    git(
        a,
        &[
            "remote",
            "set-url",
            "origin",
            "ssh://git@example.invalid/notes.git",
        ],
    );
    let ssh = script(&fx.base, "fake-ssh", body);
    let mut opts = options();
    opts.env
        .push(("GIT_SSH_COMMAND".into(), ssh.into_os_string()));
    opts
}

#[test]
fn authentication_failures() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let opts = fake_ssh(
        &fx,
        &a,
        "echo 'git@example.invalid: Permission denied (publickey).' >&2\nexit 255",
    );
    let err = sync_at(&opts, &a, STAMP, &ctl(), &tree()).unwrap_err();
    assert_eq!(err.kind(), "GitAuth", "{err}");
    assert!(err.to_string().starts_with("git fetch failed: "), "{err}");
}

#[test]
fn network_failures() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let opts = fake_ssh(
        &fx,
        &a,
        "echo 'ssh: Could not resolve hostname example.invalid: Name or service not known' >&2\nexit 255",
    );
    assert_eq!(
        sync_at(&opts, &a, STAMP, &ctl(), &tree())
            .unwrap_err()
            .kind(),
        "GitNetwork"
    );

    // A real connection refused, with credentials in the URL.
    git(
        &a,
        &[
            "remote",
            "set-url",
            "origin",
            "https://me:s3cret@127.0.0.1:1/notes.git",
        ],
    );
    let err = sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap_err();
    assert_eq!(err.kind(), "GitNetwork", "{err}");
    assert!(!err.to_string().contains("s3cret"), "{err}");

    // A remote on a missing drive.
    let gone = fx.base.join("unmounted/notes.git");
    git(&a, &["remote", "set-url", "origin", gone.to_str().unwrap()]);
    let err = sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap_err();
    assert_eq!(err.kind(), "GitNetwork", "{err}");
    assert!(
        !err.to_string().contains(fx.base.to_str().unwrap()),
        "{err}"
    );
}

#[test]
fn network_timeouts() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let mut opts = fake_ssh(&fx, &a, "sleep 10");
    opts.network_timeout = Duration::from_millis(300);
    let start = std::time::Instant::now();
    let err = sync_at(&opts, &a, STAMP, &ctl(), &tree()).unwrap_err();
    assert_eq!(err.kind(), "GitNetwork");
    assert!(err.to_string().contains("timed out"), "{err}");
    assert!(start.elapsed() < Duration::from_secs(5));
}

#[test]
fn ssh_is_batch_mode_unless_configured() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let repo = open(&options(), &a).unwrap();
    assert!(repo.git.uses_default_ssh());
    git(&a, &["config", "core.sshCommand", "ssh -i ~/.ssh/notes"]);
    let repo = open(&options(), &a).unwrap();
    assert!(!repo.git.uses_default_ssh());
}

// ---------------------------------------------------------------------------
// Conflict copy writing

#[test]
fn conflict_copies_never_replace_files() {
    let dir = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(dir.path()).unwrap();
    for attempt in 1..=MAX_CONFLICT_COPY_NAMES {
        write(
            &root,
            &conflict_copy_path("p/n.md", STAMP, attempt),
            "taken",
        );
    }
    let err = write_conflict_copy(&root, "p/n.md", b"x", STAMP).unwrap_err();
    assert_eq!(
        err,
        AppError::GitFailed("no free name for a conflict copy of p/n.md".into())
    );
    let copy = write_conflict_copy(&root, "q/n.md", b"mine", STAMP);
    // The folder does not exist.
    assert_eq!(copy.unwrap_err().kind(), "NotFound");
    write_version(&root, "q/deep/n.md", b"v").unwrap();
    assert_eq!(read(&root, "q/deep/n.md"), "v");
    assert_eq!(
        write_conflict_copy(&root, "q/deep/n.md", b"mine", STAMP).unwrap(),
        "q/deep/n (conflict 2026-10-08 1200).md"
    );
}

// ---------------------------------------------------------------------------
// Writing commands are never killed

#[test]
fn a_slow_commit_is_stopped_cleanly() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    hook(&a, "pre-commit", "sleep 5");
    write(&a, "inbox/a.md", "edited");
    let mut opts = options();
    opts.write_timeout = Duration::from_millis(300);
    let start = std::time::Instant::now();
    let err = commit(&opts, &a, "m", &ctl()).unwrap_err();
    assert_eq!(err.kind(), "GitFailed");
    assert!(err.to_string().contains("was stopped"), "{err}");
    assert!(start.elapsed() < Duration::from_secs(4));
    // Git cleaned up after itself; nothing was lost or committed.
    assert!(!a.join(".git/index.lock").exists());
    assert_eq!(read(&a, "inbox/a.md"), "edited");
    assert_eq!(repo_status(&a).changed, ["inbox/a.md"]);
    assert_eq!(repo_status(&a).paused_reason, None);
}

/// A `reference-transaction` hook that sleeps once, the first time a ref
/// changes during a rebase.
fn slow_rebase_hook(dir: &Path, seconds: u32) {
    let flag = dir.join(".git/slowed");
    hook(
        dir,
        "reference-transaction",
        &format!(
            "[ -d \"$(git rev-parse --git-path rebase-merge)\" ] || exit 0\n\
             [ -e '{f}' ] && exit 0\ntouch '{f}'\nsleep {seconds}",
            f = flag.display()
        ),
    );
}

#[test]
fn a_rebase_stopped_for_taking_too_long_loses_nothing() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    diverge(&fx, &a);
    let before = head(&a);
    slow_rebase_hook(&a, 5);
    let mut opts = options();
    opts.write_timeout = Duration::from_millis(500);
    let err = sync_at(&opts, &a, STAMP, &ctl(), &tree()).unwrap_err();
    assert!(!a.join(".git/index.lock").exists());
    // Interrupted before git recorded what it was replaying, the rebase
    // cannot be proven safe to undo: it is left for the user, explained.
    assert_eq!(err, interrupted());
    let s = repo_status(&a);
    assert_eq!(s.operation, Some(Operation::Rebase));
    assert_eq!(s.paused_message.as_deref(), Some(APP_REBASE_MESSAGE));
    // The local commit is still reachable for the user.
    let marker =
        RebaseMarker::parse(&fs::read_to_string(a.join(".git").join(REBASE_MARKER)).unwrap())
            .unwrap();
    assert_eq!(marker.orig_head, before);
    git(&a, &["rebase", "--abort"]);
    assert_eq!(head(&a), before);
    assert_eq!(read(&a, "inbox/a.md"), "ours\n");
}

// ---------------------------------------------------------------------------
// Never abort over someone else's changes

/// Leaves `a` in the middle of a conflicting rebase started by the user:
/// the replayed commit changes `inbox/a.md` (conflict) and adds
/// `inbox/added.md` (staged by git).
fn stuck_rebase(fx: &Fixture) -> PathBuf {
    let a = fx.clone_as("a");
    let b = fx.clone_as("b");
    push_change(&b, "inbox/a.md", "theirs\n");
    write(&a, "inbox/a.md", "ours\n");
    write(&a, "inbox/added.md", "added\n");
    commit_all(&a, "ours");
    git(&a, &["fetch", "-q"]);
    let out = Git::new(&options(), &a)
        .run(Mode::Write, ["rebase", "@{upstream}"])
        .unwrap();
    assert!(!out.success);
    assert_eq!(repo_status(&a).operation, Some(Operation::Rebase));
    a
}

#[test]
fn safe_to_abort_only_when_the_rebase_made_every_change() {
    let fx = Fixture::new();
    let a = stuck_rebase(&fx);
    let repo = || open(&options(), &a).unwrap();
    let check = |ledger: &Ledger| safe_to_abort(&repo(), ledger).unwrap();

    // Conflicted files the app never saw are not its own.
    let mut ledger = Ledger::default();
    assert!(!check(&ledger));
    ledger.record(&repo(), "inbox/a.md");
    // The staged `added.md` is what the replayed commit has.
    assert!(check(&ledger));
    write(&a, "inbox/.kaido-1-1.tmp", "temp");
    assert!(check(&ledger));

    // Someone edits the conflicted file.
    let original = read(&a, "inbox/a.md");
    write(&a, "inbox/a.md", "edited by hand");
    assert!(!check(&ledger));
    write(&a, "inbox/a.md", &original);
    assert!(check(&ledger));

    write(&a, "inbox/new.md", "untracked");
    assert!(!check(&ledger));
    fs::remove_file(a.join("inbox/new.md")).unwrap();
    write(&a, "data.json", "edited outside");
    assert!(!check(&ledger));
    // Staging it does not make it the rebase's change.
    git(&a, &["add", "data.json"]);
    assert!(!check(&ledger));
    git(&a, &["reset", "-q", "--", "data.json"]);
    git(&a, &["checkout", "--", "data.json"]);
    assert!(check(&ledger));
    // A staged deletion the replayed commit does not have.
    git(&a, &["rm", "-q", "--cached", "data.json"]);
    assert!(!check(&ledger));
    git(&a, &["reset", "-q", "--", "data.json"]);
    // Staged content that differs from the replayed commit.
    write(&a, "inbox/added.md", "changed and staged");
    git(&a, &["add", "inbox/added.md"]);
    assert!(!check(&ledger));
}

#[test]
fn staged_renames_must_match_the_replayed_commit() {
    let fx = Fixture::new();
    let a = stuck_rebase(&fx);
    let mut ledger = Ledger::default();
    ledger.record(&open(&options(), &a).unwrap(), "inbox/a.md");
    git(&a, &["mv", "data.json", "moved.json"]);
    assert!(!safe_to_abort(&open(&options(), &a).unwrap(), &ledger).unwrap());
    git(&a, &["mv", "moved.json", "data.json"]);
    // Outside a rebase there is no replayed commit to compare with.
    git(&a, &["rebase", "--abort"]);
    git(&a, &["rm", "-q", "--cached", "data.json"]);
    assert!(!safe_to_abort(&open(&options(), &a).unwrap(), &Ledger::default()).unwrap());
}

/// Two local commits, each conflicting with the upstream.
fn two_conflicting_commits(fx: &Fixture) -> PathBuf {
    let a = fx.clone_as("a");
    let b = fx.clone_as("b");
    write(&a, "p/one.md", "base");
    write(&a, "p/two.md", "base");
    commit_all(&a, "base");
    git(&a, &["push", "-q"]);
    git(&b, &["pull", "-q", "--rebase"]);
    write(&b, "p/one.md", "b1");
    write(&b, "p/two.md", "b2");
    commit_all(&b, "b");
    git(&b, &["push", "-q"]);
    write(&a, "p/one.md", "a1");
    commit_all(&a, "a1");
    write(&a, "p/two.md", "a2");
    commit_all(&a, "a2");
    a
}

/// Runs `edit` at the `n`-th safe point of a sync.
fn at_check(control: &SyncControl, n: usize, edit: impl FnOnce() + Send + 'static) {
    let mut checks = 0;
    let mut edit = Some(edit);
    *guard(&control.on_check) = Some(Box::new(move || {
        checks += 1;
        if checks == n
            && let Some(edit) = edit.take()
        {
            edit();
        }
        false
    }));
}

#[test]
fn an_external_edit_during_a_multi_step_rebase_survives() {
    let fx = Fixture::new();
    let a = two_conflicting_commits(&fx);
    let control = ctl();
    let (edited, lock) = (a.join("data.json"), a.join(".git/index.lock"));
    // Second conflict step: someone edits a file, then the step fails.
    at_check(&control, 4, move || {
        fs::write(&edited, "edited in another editor").unwrap();
        fs::write(&lock, "").unwrap();
    });
    let err = sync_at(&options(), &a, STAMP, &control, &tree()).unwrap_err();
    assert_eq!(err, interrupted());
    assert!(
        err.to_string()
            .starts_with("operation-in-progress: Kaido started this rebase")
    );
    assert_eq!(read(&a, "data.json"), "edited in another editor");
    assert_eq!(repo_status(&a).operation, Some(Operation::Rebase));
    assert!(a.join(".git").join(REBASE_MARKER).exists());

    // Nothing ever undoes it later, not even once the edit is gone.
    fs::remove_file(a.join(".git/index.lock")).unwrap();
    git(&a, &["checkout", "--", "data.json"]);
    for _ in 0..2 {
        let GitStatus::Paused(s) = status(&options(), &a).unwrap() else {
            panic!("expected paused")
        };
        assert_eq!(s.paused_reason, Some(PausedReason::OperationInProgress));
        assert_eq!(s.paused_message.as_deref(), Some(APP_REBASE_MESSAGE));
    }
    assert_eq!(
        sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap_err(),
        interrupted()
    );
    write(&a, "inbox/x.md", "x");
    assert_eq!(
        commit(&options(), &a, "m", &ctl()).unwrap_err(),
        interrupted()
    );
    assert_eq!(repo_status(&a).operation, Some(Operation::Rebase));
    assert!(a.join(".git").join(REBASE_MARKER).exists());

    // The user undoes it; the marker goes with the next commit.
    git(&a, &["rebase", "--abort"]);
    assert_eq!(read(&a, "p/one.md"), "a1");
    assert_eq!(read(&a, "p/two.md"), "a2");
    commit(&options(), &a, "Add inbox/x.md", &ctl()).unwrap();
    assert!(!a.join(".git").join(REBASE_MARKER).exists());
}

#[test]
fn an_edit_to_a_conflicted_note_is_never_overwritten() {
    let fx = Fixture::new();
    let a = two_conflicting_commits(&fx);
    let control = ctl();
    let note = a.join("p/one.md");
    // First conflict step: someone edits the file git just wrote.
    at_check(&control, 3, move || {
        fs::write(&note, "fixed by hand").unwrap();
    });
    let err = sync_at(&options(), &a, STAMP, &control, &tree()).unwrap_err();
    assert_eq!(err, interrupted());
    assert_eq!(read(&a, "p/one.md"), "fixed by hand");
    assert_eq!(repo_status(&a).operation, Some(Operation::Rebase));
    // No conflict copy was written.
    let files = fs::read_dir(a.join("p")).unwrap().count();
    assert_eq!(files, 2);
}

#[test]
fn a_failed_step_that_cannot_be_undone_keeps_its_copies() {
    let fx = Fixture::new();
    let a = two_conflicting_commits(&fx);
    let before = head(&a);
    let control = ctl();
    let lock = a.join(".git/index.lock");
    // Second step: `git add` fails, and the lock blocks the abort too.
    at_check(&control, 4, move || fs::write(&lock, "").unwrap());
    let err = sync_at(&options(), &a, STAMP, &control, &tree()).unwrap_err();
    assert_eq!(err, interrupted());
    assert_eq!(repo_status(&a).operation, Some(Operation::Rebase));
    // Both versions of the second note are still in the working tree.
    let copy = "p/two (conflict 2026-10-08 1200).md";
    assert_eq!(read(&a, copy), "a2");
    fs::remove_file(a.join(".git/index.lock")).unwrap();
    git(&a, &["rebase", "--abort"]);
    assert_eq!(head(&a), before);
}

// ---------------------------------------------------------------------------
// Exit and the rebase marker

#[test]
fn nothing_starts_after_shutdown() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let control = ctl();
    assert_eq!(
        control.shutdown(Duration::ZERO),
        Shutdown { finished: true }
    );
    assert!(control.is_stopping());
    assert_eq!(
        sync_at(&options(), &a, STAMP, &control, &tree()).unwrap_err(),
        git::stopped()
    );
    write(&a, "inbox/x.md", "x");
    assert_eq!(
        commit(&options(), &a, "m", &control).unwrap_err(),
        git::stopped()
    );
    assert!(control.clone().is_stopping());
    assert!(control.shutdown(Duration::ZERO).finished);
}

#[test]
fn shutdown_kills_a_network_command_in_flight() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let mut opts = fake_ssh(&fx, &a, "sleep 10");
    opts.network_timeout = Duration::from_secs(60);
    let control = ctl();
    let stopper = {
        let control = control.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            control.shutdown(Duration::from_secs(5))
        })
    };
    let start = std::time::Instant::now();
    assert_eq!(
        sync_at(&opts, &a, STAMP, &control, &tree()).unwrap_err(),
        git::stopped()
    );
    assert!(start.elapsed() < Duration::from_secs(5));
    assert!(stopper.join().unwrap().finished);
}

#[test]
fn shutdown_waits_for_running_operations_a_bounded_time() {
    let control = ctl();
    let running = control.start().unwrap();
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        drop(running);
    });
    let start = std::time::Instant::now();
    assert!(control.shutdown(Duration::from_secs(5)).finished);
    assert!(start.elapsed() >= Duration::from_millis(150));
    release.join().unwrap();

    let control = ctl();
    let _stuck = control.start().unwrap();
    let start = std::time::Instant::now();
    assert!(!control.shutdown(Duration::from_millis(100)).finished);
    assert!(start.elapsed() < Duration::from_secs(2));
}

#[test]
fn a_rebase_interrupted_by_exit_is_left_for_the_user() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    diverge(&fx, &a);
    let before = head(&a);
    slow_rebase_hook(&a, 1);
    let control = ctl();
    let syncer = {
        let (control, a) = (control.clone(), a.clone());
        std::thread::spawn(move || sync_at(&options(), &a, STAMP, &control, &tree()))
    };
    let flag = a.join(".git/slowed");
    let start = std::time::Instant::now();
    while !flag.exists() {
        assert!(start.elapsed() < Duration::from_secs(10));
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(!control.shutdown(Duration::from_millis(50)).finished);
    assert_eq!(syncer.join().unwrap().unwrap_err(), git::stopped());

    // As after a restart: the rebase is reported, never undone, with the
    // user's edit made meanwhile intact.
    write(&a, "data.json", "edited after the crash");
    for _ in 0..2 {
        let GitStatus::Paused(s) = status(&options(), &a).unwrap() else {
            panic!("expected paused")
        };
        assert_eq!(s.operation, Some(Operation::Rebase));
        assert_eq!(s.paused_message.as_deref(), Some(APP_REBASE_MESSAGE));
    }
    assert_eq!(
        sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap_err(),
        interrupted()
    );
    assert_eq!(read(&a, "data.json"), "edited after the crash");
    let marker = fs::read_to_string(a.join(".git").join(REBASE_MARKER)).unwrap();
    assert_eq!(RebaseMarker::parse(&marker).unwrap().orig_head, before);
}

#[test]
fn the_users_rebase_is_reported_without_the_apps_message() {
    let fx = Fixture::new();
    let a = stuck_rebase(&fx);
    let GitStatus::Paused(s) = status(&options(), &a).unwrap() else {
        panic!("expected paused")
    };
    assert_eq!(s.paused_message, None);
    assert_eq!(
        sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap_err(),
        AppError::GitPaused("operation-in-progress".into())
    );
    // A marker of another rebase does not make it the app's, and is kept
    // while a rebase is in progress.
    let marker_path = a.join(".git").join(REBASE_MARKER);
    let other = RebaseMarker {
        orig_head: "0".repeat(40),
        onto: "1".repeat(40),
    };
    fs::write(&marker_path, other.to_text()).unwrap();
    let GitStatus::Paused(s) = status(&options(), &a).unwrap() else {
        panic!("expected paused")
    };
    assert_eq!(s.paused_message, None);
    write(&a, "inbox/x.md", "x");
    let _ = commit(&options(), &a, "m", &ctl());
    assert!(marker_path.exists());
    assert_eq!(repo_status(&a).operation, Some(Operation::Rebase));
    // Unreadable markers are ignored too.
    fs::write(&marker_path, "garbage").unwrap();
    assert!(!open(&options(), &a).unwrap().app_rebase());
}

#[test]
fn a_marker_without_a_rebase_is_removed_by_the_next_git_operation() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let marker_path = a.join(".git").join(REBASE_MARKER);
    fs::write(&marker_path, "kaido-rebase 1\norig-head x\nonto y\n").unwrap();
    // The status only reads.
    assert!(matches!(
        status(&options(), &a).unwrap(),
        GitStatus::Ready(_)
    ));
    assert!(marker_path.exists());
    sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap();
    assert!(!marker_path.exists());
}

#[test]
fn rebase_markers_round_trip() {
    let marker = RebaseMarker {
        orig_head: "abc".into(),
        onto: "def".into(),
    };
    assert_eq!(RebaseMarker::parse(&marker.to_text()), Some(marker));
    for bad in [
        "",
        "other 1\norig-head a\nonto b\n",
        "kaido-rebase 1\nonto b\n",
        "kaido-rebase 1\norig-head a\n",
        "kaido-rebase 1\norig-heada\nonto b\n",
    ] {
        assert_eq!(RebaseMarker::parse(bad), None, "{bad}");
    }
}

#[test]
fn stopping_during_conflict_resolution_leaves_the_rebase() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    diverge(&fx, &a);
    let control = ctl();
    let mut checks = 0;
    // Safe points: attempt start, after fetch, first conflict step.
    *guard(&control.on_check) = Some(Box::new(move || {
        checks += 1;
        checks == 3
    }));
    assert_eq!(
        sync_at(&options(), &a, STAMP, &control, &tree()).unwrap_err(),
        git::stopped()
    );
    assert_eq!(repo_status(&a).operation, Some(Operation::Rebase));
    assert!(a.join(".git").join(REBASE_MARKER).exists());
    assert_eq!(
        sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap_err(),
        interrupted()
    );
}

// ---------------------------------------------------------------------------
// Working tree lock

#[test]
fn file_writes_wait_only_while_rebasing() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    diverge(&fx, &a);
    let lock = std::sync::Arc::new(tree());
    let control = ctl();
    let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
    let (l, s) = (std::sync::Arc::clone(&lock), std::sync::Arc::clone(&seen));
    *guard(&control.on_check) = Some(Box::new(move || {
        guard(&s).push(l.try_read().is_ok());
        false
    }));
    let result = sync_at(&options(), &a, STAMP, &control, &lock).unwrap();
    assert_eq!(result.conflicts.len(), 1);
    // Free before and after fetching, held during conflict resolution, free
    // again before pushing.
    assert_eq!(*guard(&seen), [true, true, false, true]);
    assert!(lock.try_write().is_ok());
}

// ---------------------------------------------------------------------------
// Index lock

#[test]
fn only_an_old_index_lock_that_stays_pauses() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let lock = a.join(".git/index.lock");
    let mut opts = options();
    opts.index_lock_recheck = Duration::from_millis(300);
    let reason = |opts: &GitOptions| match status(opts, &a).unwrap() {
        GitStatus::Ready(s) | GitStatus::Paused(s) => s.paused_reason,
        other => panic!("{other:?}"),
    };
    // A fresh lock belongs to a command that is still running.
    fs::write(&lock, "").unwrap();
    assert_eq!(reason(&opts), None);
    // An old one that is released during the re-check.
    crate::test_support::backdate(&lock, 60);
    let remover = {
        let lock = lock.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            fs::remove_file(&lock).unwrap();
        })
    };
    assert_eq!(reason(&opts), None);
    remover.join().unwrap();
    // An old one that stays.
    fs::write(&lock, "").unwrap();
    crate::test_support::backdate(&lock, 60);
    assert_eq!(reason(&opts), Some(PausedReason::IndexLocked));
    write(&a, "inbox/x.md", "x");
    assert_eq!(
        commit(&opts, &a, "m", &ctl()).unwrap_err(),
        AppError::GitPaused("index-locked".into())
    );
    assert_eq!(
        sync_at(&opts, &a, STAMP, &ctl(), &tree()).unwrap_err(),
        AppError::GitPaused("index-locked".into())
    );
    fs::remove_file(&lock).unwrap();
    assert_eq!(reason(&opts), None);
}

// ---------------------------------------------------------------------------
// Upstream validation

#[test]
fn upstream_with_another_name_or_a_local_upstream_is_a_mismatch() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    git(
        &a,
        &["checkout", "-q", "-b", "notes", "--track", "origin/main"],
    );
    assert_eq!(paused_reason(&a), Some(PausedReason::UpstreamMismatch));
    write(&a, "inbox/x.md", "x");
    assert!(
        commit(&options(), &a, "m", &ctl())
            .unwrap()
            .commit
            .is_some()
    );
    assert_eq!(
        sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap_err(),
        AppError::GitPaused("upstream-mismatch".into())
    );

    git(&a, &["checkout", "-q", "-b", "work"]);
    git(&a, &["branch", "-q", "-u", "main"]);
    assert_eq!(repo_status(&a).upstream.as_deref(), Some("main"));
    assert_eq!(paused_reason(&a), Some(PausedReason::UpstreamMismatch));
}

#[test]
fn a_separate_push_remote_is_a_mismatch() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let remote = fx.remote();
    git(&a, &["remote", "add", "fork", remote.to_str().unwrap()]);
    git(&a, &["config", "branch.main.pushRemote", "fork"]);
    assert_eq!(paused_reason(&a), Some(PausedReason::UpstreamMismatch));
    git(&a, &["config", "branch.main.pushRemote", "origin"]);
    assert_eq!(paused_reason(&a), None);
    git(&a, &["config", "--unset", "branch.main.pushRemote"]);
    git(&a, &["config", "remote.pushDefault", "fork"]);
    assert_eq!(paused_reason(&a), Some(PausedReason::UpstreamMismatch));
    // pushRemote wins over pushDefault.
    git(&a, &["config", "branch.main.pushRemote", "origin"]);
    assert_eq!(paused_reason(&a), None);
}

#[test]
fn incomplete_branch_config_is_a_mismatch() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let mut repo = open(&options(), &a).unwrap();
    assert!(matches!(repo.upstream(), Upstream::Valid(_)));
    repo.config.branch_merges.clear();
    assert_eq!(repo.upstream(), Upstream::Mismatch);
    let mut repo = open(&options(), &a).unwrap();
    repo.config.branch_remotes = vec![("main".into(), "-x".into())];
    assert_eq!(repo.upstream(), Upstream::Mismatch);
    repo.status.branch = None;
    assert_eq!(repo.upstream(), Upstream::Mismatch);
    assert!(plain_name("origin"));
    for bad in ["", ".", "-x", "--upload-pack=x"] {
        assert!(!plain_name(bad), "{bad}");
    }
}

#[test]
fn a_deleted_or_never_pushed_upstream_is_gone() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let b = fx.clone_as("b");
    git(&a, &["checkout", "-q", "-b", "topic"]);
    write(&a, "inbox/t.md", "t");
    commit_all(&a, "t");
    git(&a, &["push", "-q", "-u", "origin", "topic"]);
    assert_eq!(paused_reason(&a), None);
    // Deleted on the remote (a merged pull request): the stale local
    // tracking branch is not trusted, and is forgotten.
    git(&b, &["push", "-q", "origin", "--delete", "topic"]);
    write(&a, "inbox/t.md", "t2");
    commit(&options(), &a, "m", &ctl()).unwrap();
    assert_eq!(paused_reason(&a), None);
    assert_eq!(
        sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap_err(),
        AppError::GitPaused("upstream-gone".into())
    );
    assert_eq!(git(&fx.remote(), &["branch", "--list", "topic"]), "");
    assert_eq!(paused_reason(&a), Some(PausedReason::UpstreamGone));
    // Sync still tries when asked, in case the branch is back.
    git(&a, &["push", "-q", "origin", "topic"]);
    assert_eq!(paused_reason(&a), None);

    // A clone of an empty repository: pushed once by hand first.
    let dir = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(dir.path()).unwrap();
    git(&base, &["init", "-q", "--bare", "-b", "main", "empty.git"]);
    git(&base, &["clone", "-q", "empty.git", "e"]);
    let e = base.join("e");
    assert_eq!(paused_reason(&e), Some(PausedReason::UpstreamGone));
    write(&e, "inbox/first.md", "x");
    assert!(
        commit(&options(), &e, "first", &ctl())
            .unwrap()
            .commit
            .is_some()
    );
    assert_eq!(
        sync_at(&options(), &e, STAMP, &ctl(), &tree()).unwrap_err(),
        AppError::GitPaused("upstream-gone".into())
    );
    git(&e, &["push", "-q", "origin", "main"]);
    assert_eq!(paused_reason(&e), None);
    assert_eq!(
        sync_at(&options(), &e, STAMP, &ctl(), &tree()).unwrap(),
        SyncResult::default()
    );
}

#[test]
fn pushes_go_to_the_branch_of_the_same_name() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    git(&a, &["checkout", "-q", "-b", "notes"]);
    git(&a, &["push", "-q", "-u", "origin", "notes"]);
    write(&a, "inbox/n.md", "n");
    commit(&options(), &a, "m", &ctl()).unwrap();
    // Push settings that would push other branches are not used.
    git(&a, &["config", "push.default", "matching"]);
    let main_before = git(&fx.remote(), &["rev-parse", "main"]);
    assert_eq!(
        sync_at(&options(), &a, STAMP, &ctl(), &tree())
            .unwrap()
            .pushed,
        1
    );
    assert_eq!(git(&fx.remote(), &["rev-parse", "notes"]), head(&a));
    assert_eq!(git(&fx.remote(), &["rev-parse", "main"]), main_before);
}

// ---------------------------------------------------------------------------
// Local history

#[test]
fn local_merges_pause_sync_and_nothing_is_flattened() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let b = fx.clone_as("b");
    git(&a, &["checkout", "-q", "-b", "side"]);
    write(&a, "inbox/side.md", "side");
    commit_all(&a, "side");
    git(&a, &["checkout", "-q", "main"]);
    write(&a, "inbox/main.md", "main");
    commit_all(&a, "main");
    git(&a, &["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    push_change(&b, "inbox/b.md", "b");
    let before = head(&a);
    assert_eq!(paused_reason(&a), Some(PausedReason::LocalMerges));
    assert_eq!(
        sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap_err(),
        AppError::GitPaused("local-merges".into())
    );
    assert_eq!(head(&a), before);
    assert_eq!(git(&a, &["rev-list", "--merges", "--count", "HEAD"]), "1");
    assert_eq!(read(&a, "inbox/side.md"), "side");
    // Commits still happen.
    write(&a, "inbox/x.md", "x");
    assert!(
        commit(&options(), &a, "m", &ctl())
            .unwrap()
            .commit
            .is_some()
    );
}

#[test]
fn a_force_pushed_upstream_never_drops_local_notes() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let b = fx.clone_as("b");
    // `a` pushes x.md; the other device rewrites history without it.
    write(&a, "inbox/x.md", "keep me");
    commit(&options(), &a, "Add inbox/x.md", &ctl()).unwrap();
    sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap();
    git(&b, &["fetch", "-q"]);
    git(&b, &["reset", "-q", "--hard", "origin/main~1"]);
    write(&b, "inbox/b.md", "b");
    commit_all(&b, "rewritten");
    git(&b, &["push", "-q", "--force"]);
    write(&a, "inbox/later.md", "later");
    commit(&options(), &a, "Add inbox/later.md", &ctl()).unwrap();
    git(&a, &["fetch", "-q"]);

    let result = sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap();
    assert_eq!(read(&a, "inbox/x.md"), "keep me");
    assert_eq!(read(&a, "inbox/later.md"), "later");
    assert_eq!(read(&a, "inbox/b.md"), "b");
    assert_eq!(result.pushed, 2);
    let remote_files = git(&fx.remote(), &["ls-tree", "-r", "--name-only", "main"]);
    assert!(remote_files.contains("inbox/x.md"), "{remote_files}");
}

#[test]
fn a_rewritten_upstream_commit_keeps_both_versions() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let b = fx.clone_as("b");
    push_change(&b, "inbox/a.md", "v2\n");
    git(&a, &["pull", "-q", "--rebase"]);
    // The other device rewrites the commit `a` already has.
    write(&b, "inbox/a.md", "v2 amended\n");
    git(&b, &["commit", "-q", "--amend", "-am", "amended"]);
    git(&b, &["push", "-q", "--force"]);
    write(&a, "inbox/mine.md", "mine");
    commit(&options(), &a, "Add inbox/mine.md", &ctl()).unwrap();
    let result = sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap();
    assert_eq!(read(&a, "inbox/a.md"), "v2 amended\n");
    assert_eq!(result.conflicts.len(), 1);
    assert_eq!(read(&a, &result.conflicts[0].copy), "v2\n");
    assert_eq!(read(&a, "inbox/mine.md"), "mine");
}

// ---------------------------------------------------------------------------
// Lock key

#[test]
fn worktrees_of_one_repository_share_the_lock_key() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    git(&a, &["worktree", "add", "-q", "-b", "other", "../wt"]);
    let wt = fx.base.join("wt");
    let key = lock_key(&options(), &a.join("inbox")).unwrap();
    assert_eq!(key, dunce::canonicalize(a.join(".git")).unwrap());
    assert_eq!(lock_key(&options(), &wt).unwrap(), key);
    let plain = tempfile::tempdir().unwrap();
    assert_eq!(lock_key(&options(), plain.path()), None);
    let mut missing = options();
    missing.program = fx.base.join("no-git").into_os_string();
    assert_eq!(lock_key(&missing, &a), None);
}

// ---------------------------------------------------------------------------
// Conflict contents

#[test]
fn conflict_copies_get_checkout_filters() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let b = fx.clone_as("b");
    write(&a, ".gitattributes", "*.md text eol=crlf\n");
    commit_all(&a, "crlf");
    git(&a, &["push", "-q"]);
    git(&b, &["pull", "-q", "--rebase"]);
    write(&b, "inbox/a.md", "theirs\r\nline\r\n");
    commit_all(&b, "b");
    git(&b, &["push", "-q"]);
    write(&a, "inbox/a.md", "ours\r\nline\r\n");
    commit(&options(), &a, "a", &ctl()).unwrap();
    let result = sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap();
    let copy = &result.conflicts[0].copy;
    assert_eq!(read(&a, copy), "ours\r\nline\r\n");
    assert_eq!(read(&a, "inbox/a.md"), "theirs\r\nline\r\n");
    assert!(clean(&a));
    let stored = git(&a, &["show", &format!("HEAD:{copy}")]);
    assert_eq!(stored, "ours\nline");
}

#[test]
fn rename_conflicts_keep_every_version() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let b = fx.clone_as("b");
    write(&a, "p/r.md", "rename me\nline 2\nline 3\n");
    write(&a, "p/d.md", "delete or rename\nline 2\nline 3\n");
    commit_all(&a, "base");
    git(&a, &["push", "-q"]);
    git(&b, &["pull", "-q", "--rebase"]);
    git(&b, &["mv", "p/r.md", "p/upstream-name.md"]);
    git(&b, &["mv", "p/d.md", "p/d-renamed.md"]);
    commit_all(&b, "b");
    git(&b, &["push", "-q"]);
    git(&a, &["mv", "p/r.md", "p/local-name.md"]);
    git(&a, &["rm", "-q", "p/d.md"]);
    commit(&options(), &a, "a", &ctl()).unwrap();

    let result = sync_at(&options(), &a, STAMP, &ctl(), &tree()).unwrap();
    assert_eq!(result.pulled, 1);
    assert_eq!(
        read(&a, "p/upstream-name.md"),
        "rename me\nline 2\nline 3\n"
    );
    assert_eq!(read(&a, "p/local-name.md"), "rename me\nline 2\nline 3\n");
    assert_eq!(
        read(&a, "p/d-renamed.md"),
        "delete or rename\nline 2\nline 3\n"
    );
    assert!(!a.join("p/r.md").exists());
    assert!(clean(&a));
    assert_eq!(repo_status(&a).operation, None);
    assert_eq!(git(&fx.remote(), &["rev-parse", "main"]), head(&a));
}

// ---------------------------------------------------------------------------
// Half-resolved steps

/// One local commit changing `p/one.md` and `q/two.md`, both conflicting.
fn one_commit_two_conflicts(fx: &Fixture) -> PathBuf {
    let a = fx.clone_as("a");
    let b = fx.clone_as("b");
    write(&a, "p/one.md", "base one\n");
    write(&a, "q/two.md", "base two\n");
    commit_all(&a, "base");
    git(&a, &["push", "-q"]);
    git(&b, &["pull", "-q", "--rebase"]);
    write(&b, "p/one.md", "upstream one\n");
    write(&b, "q/two.md", "upstream two\n");
    commit_all(&b, "b");
    git(&b, &["push", "-q"]);
    write(&a, "p/one.md", "local one\n");
    write(&a, "q/two.md", "local two\n");
    commit_all(&a, "local");
    a
}

fn conflict_copies(dir: &Path) -> Vec<String> {
    let mut found = Vec::new();
    for folder in ["p", "q"] {
        for entry in fs::read_dir(dir.join(folder)).unwrap() {
            let name = entry.unwrap().file_name().to_string_lossy().into_owned();
            if name.contains("(conflict") {
                found.push(format!("{folder}/{name}"));
            }
        }
    }
    found
}

#[test]
fn an_edit_to_one_conflicted_note_stops_the_whole_step_before_writing() {
    let fx = Fixture::new();
    let a = one_commit_two_conflicts(&fx);
    let control = ctl();
    let two = a.join("q/two.md");
    at_check(&control, 3, move || {
        fs::write(&two, "fixed by hand\n").unwrap()
    });
    let err = sync_at(&options(), &a, STAMP, &control, &tree()).unwrap_err();
    assert_eq!(err, interrupted());
    assert_eq!(read(&a, "q/two.md"), "fixed by hand\n");
    // Nothing was written: the other note still shows both versions.
    let one = read(&a, "p/one.md");
    assert!(one.contains("<<<<<<<") && one.contains("local one") && one.contains("upstream one"));
    assert!(conflict_copies(&a).is_empty());
    assert_eq!(repo_status(&a).operation, Some(Operation::Rebase));
}

#[test]
fn a_step_failing_half_way_puts_the_conflict_markers_back() {
    use std::os::unix::fs::PermissionsExt;
    if crate::test_support::skip_if_privileged(
        "a_step_failing_half_way_puts_the_conflict_markers_back",
    ) {
        return;
    }
    let fx = Fixture::new();
    let a = one_commit_two_conflicts(&fx);
    let control = ctl();
    let (q, user_file) = (a.join("q"), a.join("todo.txt"));
    // `p/one.md` is resolved, then writing `q/two.md` fails; a file of the
    // user's makes undoing the rebase unsafe.
    at_check(&control, 3, move || {
        fs::set_permissions(&q, fs::Permissions::from_mode(0o555)).unwrap();
        fs::write(&user_file, "mine").unwrap();
    });
    let err = sync_at(&options(), &a, STAMP, &control, &tree()).unwrap_err();
    fs::set_permissions(a.join("q"), fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(err, interrupted());
    assert_eq!(repo_status(&a).operation, Some(Operation::Rebase));
    // Both versions are in the working tree: markers and the copy.
    let one = read(&a, "p/one.md");
    assert!(
        one.contains("<<<<<<<") && one.contains("local one") && one.contains("upstream one"),
        "{one}"
    );
    assert_eq!(conflict_copies(&a), ["p/one (conflict 2026-10-08 1200).md"]);
    assert_eq!(
        read(&a, "p/one (conflict 2026-10-08 1200).md"),
        "local one\n"
    );
    assert_eq!(read(&a, "todo.txt"), "mine");
    // The user cannot continue without resolving first.
    let out = Git::new(&options(), &a)
        .run(Mode::Write, ["rebase", "--continue"])
        .unwrap();
    assert!(!out.success);
    let unmerged = git(&a, &["diff", "--name-only", "--diff-filter=U"]);
    assert!(unmerged.contains("p/one.md"), "{unmerged}");
}

#[test]
fn nothing_staged_by_someone_else_is_committed_or_pushed() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let b = fx.clone_as("b");
    write(&a, "notes/n.md", "base");
    commit_all(&a, "base");
    git(&a, &["push", "-q"]);
    git(&b, &["pull", "-q", "--rebase"]);
    write(&b, "notes/n.md", "upstream");
    commit_all(&b, "b");
    git(&b, &["push", "-q"]);
    let notes = a.join("notes");
    write(&notes, "n.md", "local");
    commit(&options(), &notes, "Update n.md", &ctl()).unwrap();
    let remote_before = git(&fx.remote(), &["rev-parse", "main"]);

    let control = ctl();
    let repo = a.clone();
    // During conflict resolution, someone stages a file outside the notes.
    at_check(&control, 3, move || {
        fs::create_dir_all(repo.join("src")).unwrap();
        fs::write(repo.join("src/x.rs"), "code").unwrap();
        git(&repo, &["add", "src/x.rs"]);
    });
    let err = sync_at(&options(), &notes, STAMP, &control, &tree()).unwrap_err();
    assert_eq!(err, interrupted());
    assert_eq!(git(&fx.remote(), &["rev-parse", "main"]), remote_before);
    assert!(git(&a, &["diff", "--cached", "--name-only"]).contains("src/x.rs"));
    assert_eq!(repo_status(&a).operation, Some(Operation::Rebase));
}

#[test]
fn files_changed_after_git_wrote_them_are_never_the_rebases() {
    let fx = Fixture::new();
    let a = fx.clone_as("a");
    let repo = open(&options(), &a).unwrap();
    let mut ledger = Ledger::default();
    let now = SystemTime::now();
    ledger.record_from_git(&repo, "inbox/a.md", now - Duration::from_secs(60));
    assert_eq!(
        ledger.files.get("inbox/a.md"),
        Some(&Some(EDITED.to_owned()))
    );
    assert!(!ledger.unchanged(&repo, "inbox/a.md"));
    ledger.record_from_git(&repo, "inbox/a.md", now + Duration::from_secs(60));
    assert!(ledger.unchanged(&repo, "inbox/a.md"));
    // A missing file is recorded as missing.
    ledger.record_from_git(&repo, "inbox/none.md", now);
    assert!(ledger.unchanged(&repo, "inbox/none.md"));
}
