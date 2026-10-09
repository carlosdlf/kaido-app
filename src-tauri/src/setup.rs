//! Workspace setup: the files a new workspace starts with, and the
//! `.gitattributes` and `.gitignore` lines an existing folder needs.
//!
//! Everything here is idempotent and conservative: files are created only
//! when missing, existing files only get lines appended (keeping their line
//! endings), and nothing is ever rewritten or deleted.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::fs_ops;
use crate::git::{Git, GitOptions, Mode};
use crate::paths;
use crate::sync::{self, SyncControl};

/// Git attributes file, at the workspace root.
pub const GITATTRIBUTES: &str = ".gitattributes";
/// Git ignore file, at the workspace root.
pub const GITIGNORE: &str = ".gitignore";
/// The inbox task list created for a new workspace.
pub const INBOX_TASKS: &str = "inbox/tasks.md";
/// Contents of a new `.kaido/config.json`.
pub const CONFIG_CONTENTS: &str = "{ \"version\": 1, \"ignore\": [] }\n";
/// Line added to `.gitattributes` so task lists merge by keeping both sides.
/// A pattern without `/` matches `tasks.md` in every folder.
pub const UNION_LINE: &str = "tasks.md merge=union";
/// Lines added to `.gitignore`: the app's temporary files and the trash
/// folders some systems create at a mount root.
pub const IGNORE_LINES: &[&str] = &[".kaido-*.tmp", ".Trash-*"];
/// Message of the first commit of a new workspace.
pub const INITIAL_COMMIT_MESSAGE: &str = "Set up Kaido workspace";
/// Files an operating system may put in any folder; a folder holding only
/// these still counts as empty.
const OS_CLUTTER: &[&str] = &[".DS_Store", "Thumbs.db", "desktop.ini"];

/// Files touched by a setup, workspace-relative and `/`-separated.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct SetupResult {
    pub created: Vec<String>,
    pub updated: Vec<String>,
}

impl SetupResult {
    fn record(&mut self, rel: &str, outcome: Outcome) {
        match outcome {
            Outcome::Created => self.created.push(rel.to_owned()),
            Outcome::Updated => self.updated.push(rel.to_owned()),
            Outcome::Unchanged => {}
        }
    }
}

/// Which setup files still need lines, for `workspace_setup_status`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct SetupStatus {
    pub missing: Vec<String>,
}

/// What happened to git while creating a workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitSetup {
    /// A new repository was created in the folder.
    Initialized,
    /// The folder is already inside a repository, which is used as is.
    ExistingRepo,
    /// Git is not installed; the workspace works without sync.
    GitMissing,
    /// Git is installed but setting up the repository failed (see
    /// `gitError`). The workspace files were still created.
    Failed,
}

/// Result of `scaffold_workspace`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaffoldResult {
    /// Canonical absolute path of the workspace folder.
    pub root: String,
    pub created: Vec<String>,
    pub updated: Vec<String>,
    pub git: GitSetup,
    /// Hash of the initial commit; `null` when none was made (no
    /// identity, no new repository, or a failure).
    pub commit: Option<String>,
    /// Sanitized reason when `git` is `failed` or the initial commit failed.
    pub git_error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Created,
    Updated,
    Unchanged,
}

// ---------------------------------------------------------------------------
// Line analysis

/// Patterns that make an attribute apply to every `tasks.md`.
const TASKS_PATTERNS: &[&str] = &[
    "tasks.md",
    "**/tasks.md",
    "*.md",
    "**/*.md",
    "*",
    "**",
    "**/*",
];

/// Whether `.gitattributes` text sets `merge=union` for every `tasks.md`.
/// Used when git cannot answer (see [`union_merge_active`]).
///
/// Lines are read in order and the last one that sets or unsets the `merge`
/// attribute for a matching pattern (including `*` and `**`) wins, as in
/// git: `-merge`, `!merge`, `merge`, `merge=<other>` and `binary` all turn
/// it off again.
pub fn has_union_merge(text: &str) -> bool {
    let mut union = false;
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(pattern) = parts.next() else {
            continue;
        };
        if pattern.starts_with('#') || !TASKS_PATTERNS.contains(&pattern) {
            continue;
        }
        for attr in parts {
            if attr == "merge=union" {
                union = true;
            } else if matches!(attr, "-merge" | "!merge" | "merge" | "binary")
                || attr.starts_with("merge=")
            {
                union = false;
            }
        }
    }
    union
}

/// Paths asked about with `git check-attr`: a task list at the workspace
/// root and one in a project.
const CHECKED_TASK_LISTS: &[&str] = &["tasks.md", "x/tasks.md"];

/// Whether git resolves `merge=union` for task lists in the workspace at
/// `root`, taking every attributes file into account. `None` when git cannot
/// answer (not installed, not a repository, any failure). Only reads.
pub fn git_union_merge(options: &GitOptions, root: &Path) -> Option<bool> {
    let mut args = vec!["check-attr", "merge", "--"];
    args.extend_from_slice(CHECKED_TASK_LISTS);
    let out = Git::new(options, root).run(Mode::Read, args).ok()?;
    if !out.success {
        return None;
    }
    parse_check_attr(&out.text(), CHECKED_TASK_LISTS.len())
}

/// Parses `git check-attr merge` output (`<path>: merge: <value>` per
/// path): whether all `expected` paths have the value `union`.
pub fn parse_check_attr(output: &str, expected: usize) -> Option<bool> {
    let values: Vec<&str> = output
        .lines()
        .filter_map(|line| line.rsplit_once(": merge: ").map(|(_, value)| value.trim()))
        .collect();
    (values.len() == expected).then(|| values.iter().all(|v| *v == "union"))
}

/// Whether task lists merge with `merge=union` in the workspace at `root`,
/// whose `.gitattributes` holds `text`: git decides when it can (see
/// [`git_union_merge`]), otherwise [`has_union_merge`] reads the text.
pub fn union_merge_active(options: &GitOptions, root: &Path, text: &str) -> bool {
    git_union_merge(options, root).unwrap_or_else(|| has_union_merge(text))
}

/// Whether the last line of `text` is [`UNION_LINE`]. Appending it again
/// could not change anything then.
fn ends_with_union_line(text: &str) -> bool {
    text.lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .is_some_and(|line| line.trim() == UNION_LINE)
}

/// The [`IGNORE_LINES`] that `.gitignore` text lacks. An entry also counts
/// when written as `**/<entry>`.
pub fn missing_ignore_lines(text: &str) -> Vec<&'static str> {
    IGNORE_LINES
        .iter()
        .copied()
        .filter(|entry| {
            !text.lines().any(|line| {
                let line = line.trim();
                line == *entry || line.strip_prefix("**/") == Some(entry)
            })
        })
        .collect()
}

/// The bytes to append to a file holding `existing` so it gains `lines`:
/// a line break first if the file does not end with one, then each line,
/// all with the file's line ending (`\r\n` if it already uses it).
pub fn appended_bytes(existing: &[u8], lines: &[&str]) -> Vec<u8> {
    let eol: &[u8] = if existing.windows(2).any(|w| w == b"\r\n") {
        b"\r\n"
    } else {
        b"\n"
    };
    let mut out = Vec::new();
    if !existing.is_empty() && !existing.ends_with(b"\n") {
        out.extend_from_slice(eol);
    }
    for line in lines {
        out.extend_from_slice(line.as_bytes());
        out.extend_from_slice(eol);
    }
    out
}

/// The lines the setup file `rel` (holding `text`) lacks in the workspace
/// at `root`.
///
/// `.gitattributes` lacks [`UNION_LINE`] when task lists do not merge with
/// `merge=union` (see [`union_merge_active`]), unless its last line already
/// is that line: then something git reads after it (such as
/// `.git/info/attributes`) turns it off, and appending it again would not
/// help.
fn missing_lines(options: &GitOptions, root: &Path, rel: &str, text: &str) -> Vec<&'static str> {
    if rel == GITIGNORE {
        return missing_ignore_lines(text);
    }
    if union_merge_active(options, root, text) || ends_with_union_line(text) {
        Vec::new()
    } else {
        vec![UNION_LINE]
    }
}

/// The setup files that may need lines.
const LINE_FILES: &[&str] = &[GITATTRIBUTES, GITIGNORE];

// ---------------------------------------------------------------------------
// File operations

/// Reads a setup file: `None` if it does not exist.
fn read_existing(root: &Path, rel: &str) -> AppResult<Option<(PathBuf, Vec<u8>)>> {
    let path = paths::resolve_for_write(root, rel)?;
    match fs::metadata(&path) {
        Ok(meta) if meta.len() > fs_ops::MAX_FILE_SIZE => {
            return Err(AppError::TooLarge(format!("{rel} is too large")));
        }
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(AppError::from_io(&e, "read", rel)),
    }
    match fs::read(&path) {
        Ok(bytes) => Ok(Some((path, bytes))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AppError::from_io(&e, "read", rel)),
    }
}

/// Appends the lines [`missing_lines`] reports to the file `rel`, creating
/// it if needed. Existing bytes are never rewritten.
fn ensure_lines(options: &GitOptions, root: &Path, rel: &str) -> AppResult<Outcome> {
    let existing = read_existing(root, rel)?;
    let (path, bytes) = match existing {
        Some((path, bytes)) => (path, Some(bytes)),
        None => (paths::resolve_for_write(root, rel)?, None),
    };
    let current = bytes.as_deref().unwrap_or_default();
    let lines = missing_lines(options, root, rel, &String::from_utf8_lossy(current));
    if lines.is_empty() {
        return Ok(Outcome::Unchanged);
    }
    let addition = appended_bytes(current, &lines);
    let mut options = OpenOptions::new();
    if bytes.is_some() {
        options.append(true);
    } else {
        // Never replace a file created meanwhile.
        options.write(true).create_new(true);
    }
    let mut file = options
        .open(&path)
        .map_err(|e| AppError::from_io(&e, "write", rel))?;
    file.write_all(&addition)
        .and_then(|()| file.sync_all())
        .map_err(|e| AppError::from_io(&e, "write", rel))?;
    Ok(if bytes.is_some() {
        Outcome::Updated
    } else {
        Outcome::Created
    })
}

/// Creates `rel` with `contents` (and its folder) unless it exists.
fn create_if_missing(root: &Path, rel: &str, contents: &str) -> AppResult<Outcome> {
    let rel_path = paths::validate_relative(rel)?;
    if let Some(parent) = rel_path.parent().filter(|p| !p.as_os_str().is_empty()) {
        let parent_rel = parent.to_string_lossy().replace('\\', "/");
        // Resolving first keeps a folder link from pointing the write
        // outside the workspace.
        let dir = if fs::symlink_metadata(root.join(parent)).is_ok() {
            paths::resolve_existing(root, &parent_rel)?
        } else {
            paths::resolve_for_write(root, &parent_rel)?
        };
        fs::create_dir_all(&dir).map_err(|e| AppError::from_io(&e, "create", &parent_rel))?;
    }
    let path = paths::resolve_for_write(root, rel)?;
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            file.write_all(contents.as_bytes())
                .and_then(|()| file.sync_all())
                .map_err(|e| AppError::from_io(&e, "write", rel))?;
            Ok(Outcome::Created)
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(Outcome::Unchanged),
        Err(e) => Err(AppError::from_io(&e, "create", rel)),
    }
}

/// Adds the `.gitattributes` union line and the `.gitignore` entries the
/// workspace at `root` (canonical) lacks.
pub fn ensure_workspace_files(options: &GitOptions, root: &Path) -> AppResult<SetupResult> {
    let mut result = SetupResult::default();
    for rel in LINE_FILES {
        let outcome = ensure_lines(options, root, rel)?;
        result.record(rel, outcome);
    }
    Ok(result)
}

/// Which of `.gitattributes` and `.gitignore` lack lines. Only reads.
pub fn setup_status(options: &GitOptions, root: &Path) -> AppResult<SetupStatus> {
    let mut missing = Vec::new();
    for rel in LINE_FILES {
        let text = read_existing(root, rel)?
            .map(|(_, bytes)| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_default();
        if !missing_lines(options, root, rel, &text).is_empty() {
            missing.push((*rel).to_owned());
        }
    }
    Ok(SetupStatus { missing })
}

/// Writes every scaffold file missing from the workspace at `root`.
pub fn scaffold_files(options: &GitOptions, root: &Path) -> AppResult<SetupResult> {
    let mut result = SetupResult::default();
    for (rel, contents) in [(INBOX_TASKS, ""), (fs_ops::CONFIG_FILE, CONFIG_CONTENTS)] {
        let outcome = create_if_missing(root, rel, contents)?;
        result.record(rel, outcome);
    }
    let lines = ensure_workspace_files(options, root)?;
    result.created.extend(lines.created);
    result.updated.extend(lines.updated);
    Ok(result)
}

// ---------------------------------------------------------------------------
// Creating a workspace

/// Checks the folder chosen for a new workspace and creates it if missing.
/// An existing folder must be empty (apart from [`OS_CLUTTER`]); a missing
/// one is created inside an existing parent. Returns the canonical path.
pub fn prepare_new_folder(path: &str) -> AppResult<PathBuf> {
    if path.is_empty() || path.contains('\0') {
        return Err(AppError::InvalidPath("the folder path is not valid".into()));
    }
    let folder = Path::new(path);
    if !folder.is_absolute() {
        return Err(AppError::InvalidPath(
            "the folder path must be absolute".into(),
        ));
    }
    match fs::metadata(folder) {
        Ok(meta) if !meta.is_dir() => {
            return Err(AppError::NotADirectory(
                "the chosen path is a file, not a folder".into(),
            ));
        }
        Ok(_) => {
            let entries =
                fs::read_dir(folder).map_err(|e| AppError::from_io(&e, "read", "the folder"))?;
            for entry in entries {
                let entry = entry.map_err(|e| AppError::from_io(&e, "read", "the folder"))?;
                let name = entry.file_name();
                if !OS_CLUTTER.iter().any(|c| name == *c) {
                    return Err(AppError::NotEmpty(
                        "the folder is not empty; choose an empty folder or open it instead".into(),
                    ));
                }
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            fs::create_dir(folder).map_err(|e| match e.kind() {
                io::ErrorKind::NotFound => {
                    AppError::NotFound("the parent folder was not found".into())
                }
                _ => AppError::from_io(&e, "create", "the folder"),
            })?;
        }
        Err(e) => return Err(AppError::from_io(&e, "open", "the folder")),
    }
    paths::canonical_root(path)
}

/// The canonical form of `path` before it is created: canonical itself if
/// it exists, else its canonical parent joined with its name. `None` when
/// neither can be resolved ([`prepare_new_folder`] reports why).
fn canonical_destination(path: &str) -> Option<PathBuf> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return None;
    }
    if let Ok(canonical) = dunce::canonicalize(path) {
        return Some(canonical);
    }
    let parent = dunce::canonicalize(path.parent()?).ok()?;
    Some(parent.join(path.file_name()?))
}

fn to_string(path: &Path) -> AppResult<String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| AppError::InvalidPath("the folder path is not valid UTF-8".into()))
}

/// Creates a new workspace at `path` (see [`prepare_new_folder`]), writes
/// the scaffold, creates a git repository when git is installed and the
/// folder is not already in one, and makes the initial commit when a git
/// identity is configured. Git problems never undo the scaffold; they are
/// reported in the result.
pub fn scaffold_workspace(
    options: &GitOptions,
    control: &SyncControl,
    workspace: Option<&Path>,
    path: &str,
) -> AppResult<ScaffoldResult> {
    if let Some(dest) = canonical_destination(path) {
        paths::refuse_workspace_overlap(&dest, workspace)?;
    }
    let root = prepare_new_folder(path)?;
    let files = scaffold_files(options, &root)?;
    let mut result = ScaffoldResult {
        root: to_string(&root)?,
        created: files.created,
        updated: files.updated,
        git: GitSetup::Initialized,
        commit: None,
        git_error: None,
    };
    let git = Git::new(options, &root);
    match git.run(Mode::Read, ["rev-parse", "--is-inside-work-tree"]) {
        Err(AppError::GitUnavailable(_)) => {
            result.git = GitSetup::GitMissing;
            return Ok(result);
        }
        Err(err) => return Ok(failed(result, &err)),
        Ok(out) if out.success => {
            result.git = GitSetup::ExistingRepo;
            return Ok(result);
        }
        Ok(_) => {}
    }
    if let Err(err) = git.ok(Mode::Write, "init", ["init", "--quiet"]) {
        return Ok(failed(result, &err));
    }
    match initial_commit(options, control, &root) {
        Ok(commit) => result.commit = commit,
        Err(err) => result.git_error = Some(err.to_string()),
    }
    Ok(result)
}

fn failed(mut result: ScaffoldResult, err: &AppError) -> ScaffoldResult {
    result.git = GitSetup::Failed;
    result.git_error = Some(err.to_string());
    result
}

/// Commits the scaffold if an identity is configured.
fn initial_commit(
    options: &GitOptions,
    control: &SyncControl,
    root: &Path,
) -> AppResult<Option<String>> {
    let repo = match sync::inspect(options, root)? {
        Ok(repo) => repo,
        Err(reason) => return Err(AppError::GitUnavailable(reason.as_str().into())),
    };
    if !repo.has_identity() {
        return Ok(None);
    }
    Ok(sync::commit(options, root, INITIAL_COMMIT_MESSAGE, control)?.commit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_env::{bare_options, git, options};

    fn tree(root: &Path) -> Vec<String> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for entry in fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                let rel = paths::to_relative(root, &path).unwrap();
                if rel == ".git" {
                    continue;
                }
                if path.is_dir() {
                    stack.push(path);
                } else {
                    out.push(rel);
                }
            }
        }
        out.sort();
        out
    }

    fn read(root: &Path, rel: &str) -> String {
        fs::read_to_string(root.join(rel)).unwrap()
    }

    #[test]
    fn union_merge_detection() {
        let yes = [
            "tasks.md merge=union",
            "**/tasks.md merge=union\n",
            "*.md   -text\tmerge=union\r\n",
            "# notes\n\n**/*.md merge=union",
            "tasks.md -merge\ntasks.md merge=union",
            "* -merge\ntasks.md merge=union",
            "* merge=union",
            "* text\ntasks.md merge=union",
        ];
        for text in yes {
            assert!(has_union_merge(text), "{text:?}");
        }
        let no = [
            "",
            "# tasks.md merge=union",
            "inbox/tasks.md merge=union",
            "/tasks.md merge=union",
            "tasks.md merge=ours",
            "tasks.md merge=union\ntasks.md -merge",
            "tasks.md merge=union\n*.md binary",
            "tasks.md merge=union\ntasks.md !merge",
            "tasks.md merge=union\n*.md merge",
            "tasks.md merge=union\n* -merge",
            "tasks.md merge=union\n* binary",
            "tasks.md merge=union\n** !merge",
            "tasks.md merge=union\n**/* merge=ours",
            "tasks.md text",
            "tasks.mdmerge=union",
        ];
        for text in no {
            assert!(!has_union_merge(text), "{text:?}");
        }
    }

    #[test]
    fn ignore_line_detection() {
        assert_eq!(missing_ignore_lines(""), IGNORE_LINES);
        assert_eq!(
            missing_ignore_lines("node_modules\n.kaido-*.tmp\n"),
            [".Trash-*"]
        );
        assert!(missing_ignore_lines("**/.kaido-*.tmp\r\n  .Trash-*  \r\n").is_empty());
        // Anchored or commented forms do not cover every folder.
        assert_eq!(
            missing_ignore_lines("/.kaido-*.tmp\n# .Trash-*\n"),
            IGNORE_LINES
        );
    }

    #[test]
    fn appended_bytes_keep_line_endings() {
        assert_eq!(appended_bytes(b"", &["a", "b"]), b"a\nb\n");
        assert_eq!(appended_bytes(b"x\n", &["a"]), b"a\n");
        assert_eq!(appended_bytes(b"x", &["a"]), b"\na\n");
        assert_eq!(appended_bytes(b"x\r\ny\r\n", &["a"]), b"a\r\n");
        assert_eq!(appended_bytes(b"x\r\ny", &["a", "b"]), b"\r\na\r\nb\r\n");
        assert!(appended_bytes(b"x", &[]).len() == 1);
    }

    #[test]
    fn ensure_creates_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        assert_eq!(
            setup_status(&options(), &root).unwrap().missing,
            [GITATTRIBUTES, GITIGNORE]
        );
        let result = ensure_workspace_files(&options(), &root).unwrap();
        assert_eq!(result.created, [GITATTRIBUTES, GITIGNORE]);
        assert!(result.updated.is_empty());
        assert_eq!(read(&root, GITATTRIBUTES), "tasks.md merge=union\n");
        assert_eq!(read(&root, GITIGNORE), ".kaido-*.tmp\n.Trash-*\n");
        assert!(setup_status(&options(), &root).unwrap().missing.is_empty());
        // Idempotent.
        assert_eq!(
            ensure_workspace_files(&options(), &root).unwrap(),
            SetupResult::default()
        );
        assert_eq!(read(&root, GITIGNORE), ".kaido-*.tmp\n.Trash-*\n");
    }

    #[test]
    fn ensure_appends_without_rewriting() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        fs::write(root.join(GITATTRIBUTES), "*.png binary\r\n*.md text").unwrap();
        fs::write(root.join(GITIGNORE), "target/\n.Trash-*\n").unwrap();
        let result = ensure_workspace_files(&options(), &root).unwrap();
        assert_eq!(result.updated, [GITATTRIBUTES, GITIGNORE]);
        assert!(result.created.is_empty());
        assert_eq!(
            read(&root, GITATTRIBUTES),
            "*.png binary\r\n*.md text\r\ntasks.md merge=union\r\n"
        );
        assert_eq!(read(&root, GITIGNORE), "target/\n.Trash-*\n.kaido-*.tmp\n");
        assert_eq!(
            ensure_workspace_files(&options(), &root).unwrap(),
            SetupResult::default()
        );
    }

    #[test]
    fn ensure_keeps_files_that_already_have_the_lines() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let attributes = "**/tasks.md   merge=union -text";
        let ignore = "**/.kaido-*.tmp\r\n.Trash-*";
        fs::write(root.join(GITATTRIBUTES), attributes).unwrap();
        fs::write(root.join(GITIGNORE), ignore).unwrap();
        assert!(setup_status(&options(), &root).unwrap().missing.is_empty());
        assert_eq!(
            ensure_workspace_files(&options(), &root).unwrap(),
            SetupResult::default()
        );
        assert_eq!(read(&root, GITATTRIBUTES), attributes);
        assert_eq!(read(&root, GITIGNORE), ignore);
    }

    #[test]
    fn status_reports_only_what_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        fs::write(root.join(GITATTRIBUTES), UNION_LINE).unwrap();
        assert_eq!(
            setup_status(&options(), &root).unwrap().missing,
            [GITIGNORE]
        );
        fs::write(root.join(GITIGNORE), ".kaido-*.tmp\n.Trash-*\n").unwrap();
        fs::write(
            root.join(GITATTRIBUTES),
            "tasks.md merge=union\n*.md -merge\n",
        )
        .unwrap();
        assert_eq!(
            setup_status(&options(), &root).unwrap().missing,
            [GITATTRIBUTES]
        );
    }

    #[test]
    fn setup_files_must_be_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        fs::create_dir(root.join(GITIGNORE)).unwrap();
        assert_eq!(
            setup_status(&options(), &root).unwrap_err().kind(),
            "InvalidPath"
        );
        assert_eq!(
            ensure_workspace_files(&options(), &root)
                .unwrap_err()
                .kind(),
            "InvalidPath"
        );
    }

    #[test]
    fn oversized_setup_files_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let file = fs::File::create(root.join(GITATTRIBUTES)).unwrap();
        file.set_len(fs_ops::MAX_FILE_SIZE + 1).unwrap();
        assert_eq!(
            setup_status(&options(), &root).unwrap_err().kind(),
            "TooLarge"
        );
    }

    #[cfg(unix)]
    #[test]
    fn links_out_of_the_workspace_are_refused() {
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("ignore"), "x\n").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        std::os::unix::fs::symlink(outside.path().join("ignore"), root.join(GITIGNORE)).unwrap();
        assert_eq!(
            ensure_workspace_files(&options(), &root)
                .unwrap_err()
                .kind(),
            "OutsideWorkspace"
        );
        assert_eq!(read(outside.path(), "ignore"), "x\n");

        let inbox = tempfile::tempdir().unwrap();
        let root2 = tempfile::tempdir().unwrap();
        let root2 = dunce::canonicalize(root2.path()).unwrap();
        std::os::unix::fs::symlink(inbox.path(), root2.join("inbox")).unwrap();
        assert_eq!(
            scaffold_files(&options(), &root2).unwrap_err().kind(),
            "OutsideWorkspace"
        );
        assert_eq!(fs::read_dir(inbox.path()).unwrap().count(), 0);
    }

    #[test]
    fn scaffold_files_are_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let result = scaffold_files(&options(), &root).unwrap();
        assert_eq!(
            result.created,
            [INBOX_TASKS, fs_ops::CONFIG_FILE, GITATTRIBUTES, GITIGNORE]
        );
        assert_eq!(read(&root, INBOX_TASKS), "");
        assert_eq!(read(&root, fs_ops::CONFIG_FILE), CONFIG_CONTENTS);
        let config: serde_json::Value = serde_json::from_str(CONFIG_CONTENTS).unwrap();
        assert_eq!(config, serde_json::json!({ "version": 1, "ignore": [] }));
        assert_eq!(
            scaffold_files(&options(), &root).unwrap(),
            SetupResult::default()
        );
    }

    #[test]
    fn scaffold_files_keep_what_exists() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        fs::create_dir_all(root.join("inbox")).unwrap();
        fs::write(root.join(INBOX_TASKS), "- [ ] keep\n").unwrap();
        fs::create_dir_all(root.join(".kaido")).unwrap();
        fs::write(root.join(fs_ops::CONFIG_FILE), "{\"version\":1}").unwrap();
        fs::write(root.join(GITIGNORE), "x").unwrap();
        let result = scaffold_files(&options(), &root).unwrap();
        assert_eq!(result.created, [GITATTRIBUTES]);
        assert_eq!(result.updated, [GITIGNORE]);
        assert_eq!(read(&root, INBOX_TASKS), "- [ ] keep\n");
        assert_eq!(read(&root, fs_ops::CONFIG_FILE), "{\"version\":1}");
        assert_eq!(read(&root, GITIGNORE), "x\n.kaido-*.tmp\n.Trash-*\n");
    }

    #[test]
    fn scaffold_files_report_blocked_folders() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        fs::write(root.join("inbox"), "a file").unwrap();
        let err = scaffold_files(&options(), &root).unwrap_err();
        assert!(matches!(err.kind(), "NotADirectory" | "Io"), "{err:?}");
        assert!(!err.to_string().contains(root.to_str().unwrap()));
    }

    #[test]
    fn new_folder_rules() {
        let dir = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(dir.path()).unwrap();
        let path = |p: &Path| p.to_str().unwrap().to_owned();
        assert_eq!(prepare_new_folder("").unwrap_err().kind(), "InvalidPath");
        assert_eq!(
            prepare_new_folder("a\0b").unwrap_err().kind(),
            "InvalidPath"
        );
        assert_eq!(
            prepare_new_folder("relative").unwrap_err().kind(),
            "InvalidPath"
        );

        // Missing: created.
        let fresh = base.join("fresh");
        assert_eq!(prepare_new_folder(&path(&fresh)).unwrap(), fresh);
        assert!(fresh.is_dir());
        // Empty, or holding only OS clutter: accepted.
        fs::write(fresh.join(".DS_Store"), "x").unwrap();
        assert_eq!(prepare_new_folder(&path(&fresh)).unwrap(), fresh);
        // Not empty: refused, untouched.
        fs::write(fresh.join("a.md"), "x").unwrap();
        let err = prepare_new_folder(&path(&fresh)).unwrap_err();
        assert_eq!(err.kind(), "NotEmpty");
        assert!(err.to_string().contains("not empty"));
        // A file.
        assert_eq!(
            prepare_new_folder(&path(&fresh.join("a.md")))
                .unwrap_err()
                .kind(),
            "NotADirectory"
        );
        // Missing parent.
        let err = prepare_new_folder(&path(&base.join("no/child"))).unwrap_err();
        assert_eq!(err.kind(), "NotFound");
        assert!(!base.join("no").exists());
    }

    fn scaffold(options: &GitOptions, path: &Path) -> ScaffoldResult {
        scaffold_workspace(
            options,
            &SyncControl::default(),
            None,
            path.to_str().unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn create_with_identity_inits_and_commits() {
        let dir = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(dir.path()).unwrap();
        let root = base.join("notes");
        let result = scaffold(&options(), &root);
        assert_eq!(result.root, root.to_str().unwrap());
        assert_eq!(result.git, GitSetup::Initialized);
        assert_eq!(result.git_error, None);
        assert_eq!(
            result.created,
            [INBOX_TASKS, fs_ops::CONFIG_FILE, GITATTRIBUTES, GITIGNORE]
        );
        let head = git(&root, &["rev-parse", "HEAD"]);
        assert_eq!(result.commit.as_deref(), Some(head.as_str()));
        assert_eq!(
            git(&root, &["log", "-1", "--format=%s"]),
            INITIAL_COMMIT_MESSAGE
        );
        let files = git(&root, &["ls-files"]);
        let mut files: Vec<&str> = files.lines().collect();
        files.sort_unstable();
        assert_eq!(
            files,
            [GITATTRIBUTES, GITIGNORE, fs_ops::CONFIG_FILE, INBOX_TASKS]
        );
        assert_eq!(git(&root, &["status", "--porcelain"]), "");
        // The union line is active.
        assert_eq!(
            git(&root, &["check-attr", "merge", "--", "p/tasks.md"]),
            "p/tasks.md: merge: union"
        );
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["git"], "initialized");
        assert!(json["gitError"].is_null());
        assert_eq!(tree(&root).len(), 4);
    }

    #[test]
    fn create_without_identity_leaves_the_files_uncommitted() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let result = scaffold(&bare_options(), &root);
        assert_eq!(result.git, GitSetup::Initialized);
        assert_eq!(result.commit, None);
        assert_eq!(result.git_error, None);
        assert!(root.join(".git").is_dir());
        let status = git(&root, &["status", "--porcelain", "--untracked-files=all"]);
        assert_eq!(status.lines().count(), 4, "{status}");
    }

    #[test]
    fn create_inside_a_repository_uses_it() {
        let dir = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(dir.path()).unwrap();
        git(&base, &["init", "-q", "-b", "main"]);
        let root = base.join("notes");
        let result = scaffold(&options(), &root);
        assert_eq!(result.git, GitSetup::ExistingRepo);
        assert_eq!(result.commit, None);
        assert!(!root.join(".git").exists());
        assert_eq!(
            serde_json::to_value(&result).unwrap()["git"],
            "existing-repo"
        );
    }

    #[test]
    fn create_without_git_still_scaffolds() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let mut opts = options();
        opts.program = root.join("no-git").into_os_string();
        let result = scaffold(&opts, &root);
        assert_eq!(result.git, GitSetup::GitMissing);
        assert_eq!(result.created.len(), 4);
        assert_eq!(serde_json::to_value(&result).unwrap()["git"], "git-missing");
    }

    #[cfg(unix)]
    #[test]
    fn git_failures_are_reported_not_fatal() {
        use std::os::unix::fs::PermissionsExt;
        let scripts = tempfile::tempdir().unwrap();
        let script = scripts.path().join("git.sh");
        // `rev-parse` says "not a repository"; `init` fails.
        fs::write(
            &script,
            "#!/bin/sh\necho 'fatal: init broke' >&2\nexit 128\n",
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let mut opts = options();
        opts.program = script.into_os_string();
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let result = scaffold(&opts, &root);
        assert_eq!(result.git, GitSetup::Failed);
        assert_eq!(
            result.git_error.as_deref(),
            Some("git init failed: fatal: init broke")
        );
        assert_eq!(result.created.len(), 4);

        // A git that cannot even be started.
        let mut opts = options();
        opts.program = scripts.path().as_os_str().to_owned();
        let other = tempfile::tempdir().unwrap();
        let result = scaffold(&opts, other.path());
        assert_eq!(result.git, GitSetup::Failed);
        assert!(result.git_error.unwrap().starts_with("could not run git"));
    }

    #[cfg(unix)]
    #[test]
    fn a_failing_initial_commit_is_reported() {
        use std::os::unix::fs::PermissionsExt;
        let templates = tempfile::tempdir().unwrap();
        let hooks = templates.path().join("hooks");
        fs::create_dir(&hooks).unwrap();
        let hook = hooks.join("pre-commit");
        fs::write(&hook, "#!/bin/sh\necho 'hook says no' >&2\nexit 1\n").unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        let mut opts = options();
        opts.env
            .push(("GIT_TEMPLATE_DIR".into(), templates.path().into()));
        let dir = tempfile::tempdir().unwrap();
        let result = scaffold(&opts, dir.path());
        assert_eq!(result.git, GitSetup::Initialized);
        assert_eq!(result.commit, None);
        let error = result.git_error.unwrap();
        assert!(error.contains("hook says no"), "{error}");
    }

    #[test]
    fn check_attr_output() {
        let both = "tasks.md: merge: union\nx/tasks.md: merge: union\n";
        assert_eq!(parse_check_attr(both, 2), Some(true));
        let one = "tasks.md: merge: union\nx/tasks.md: merge: unset";
        assert_eq!(parse_check_attr(one, 2), Some(false));
        assert_eq!(
            parse_check_attr("tasks.md: merge: unspecified", 1),
            Some(false)
        );
        assert_eq!(parse_check_attr("tasks.md: merge: union", 2), None);
        assert_eq!(parse_check_attr("", 2), None);
        assert_eq!(parse_check_attr("garbage", 1), None);
    }

    fn repo() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        fs::write(root.join(GITIGNORE), ".kaido-*.tmp\n.Trash-*\n").unwrap();
        (dir, root)
    }

    #[test]
    fn later_broad_patterns_turn_the_union_line_off() {
        for text in [
            "tasks.md merge=union\n* -merge\n",
            "tasks.md merge=union\n* binary\n",
        ] {
            // Decided by git in a repository.
            let (_dir, root) = repo();
            fs::write(root.join(GITATTRIBUTES), text).unwrap();
            assert_eq!(git_union_merge(&options(), &root), Some(false));
            assert_eq!(
                setup_status(&options(), &root).unwrap().missing,
                [GITATTRIBUTES]
            );
            let result = ensure_workspace_files(&options(), &root).unwrap();
            assert_eq!(result.updated, [GITATTRIBUTES]);
            assert_eq!(read(&root, GITATTRIBUTES), format!("{text}{UNION_LINE}\n"));
            assert_eq!(git_union_merge(&options(), &root), Some(true));
            assert!(setup_status(&options(), &root).unwrap().missing.is_empty());

            // Decided by the text without git.
            let dir = tempfile::tempdir().unwrap();
            let plain = dunce::canonicalize(dir.path()).unwrap();
            fs::write(plain.join(GITATTRIBUTES), text).unwrap();
            fs::write(plain.join(GITIGNORE), ".kaido-*.tmp\n.Trash-*\n").unwrap();
            let mut no_git = options();
            no_git.program = plain.join("no-git").into_os_string();
            assert_eq!(git_union_merge(&no_git, &plain), None);
            assert_eq!(
                setup_status(&no_git, &plain).unwrap().missing,
                [GITATTRIBUTES]
            );
        }
    }

    #[test]
    fn git_sees_patterns_the_text_check_does_not() {
        let (_dir, root) = repo();
        // Turned off for the root task list only: the text check cannot
        // tell, git can.
        let text = "tasks.md merge=union\n/tasks.md -merge\n";
        fs::write(root.join(GITATTRIBUTES), text).unwrap();
        assert!(has_union_merge(text));
        assert_eq!(
            setup_status(&options(), &root).unwrap().missing,
            [GITATTRIBUTES]
        );
        ensure_workspace_files(&options(), &root).unwrap();
        assert!(setup_status(&options(), &root).unwrap().missing.is_empty());
    }

    #[test]
    fn an_override_outside_the_file_is_not_fought() {
        let (_dir, root) = repo();
        fs::write(root.join(GITATTRIBUTES), "tasks.md merge=union\n").unwrap();
        fs::write(root.join(".git/info/attributes"), "* -merge\n").unwrap();
        assert_eq!(git_union_merge(&options(), &root), Some(false));
        // Appending the line again would change nothing.
        assert!(setup_status(&options(), &root).unwrap().missing.is_empty());
        assert_eq!(
            ensure_workspace_files(&options(), &root).unwrap(),
            SetupResult::default()
        );
        assert_eq!(read(&root, GITATTRIBUTES), "tasks.md merge=union\n");
    }

    #[test]
    fn new_workspaces_must_not_overlap_the_open_one() {
        let dir = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(dir.path()).unwrap();
        let open = base.join("open");
        fs::create_dir(&open).unwrap();
        fs::write(open.join("a.md"), "x").unwrap();
        let create = |path: &Path| {
            scaffold_workspace(
                &options(),
                &SyncControl::default(),
                Some(&open),
                path.to_str().unwrap(),
            )
        };
        let inside = create(&open.join("nested")).unwrap_err();
        assert_eq!(inside.kind(), "InvalidPath");
        assert!(inside.to_string().contains("inside the open workspace"));
        assert!(!open.join("nested").exists());
        let existing = open.join("empty");
        fs::create_dir(&existing).unwrap();
        assert_eq!(create(&existing).unwrap_err().kind(), "InvalidPath");
        assert_eq!(fs::read_dir(&existing).unwrap().count(), 0);
        let around = create(&base).unwrap_err();
        assert_eq!(around.kind(), "InvalidPath");
        assert!(around.to_string().contains("contains the open workspace"));
        // Next to it is fine.
        assert_eq!(
            create(&base.join("next")).unwrap().git,
            GitSetup::Initialized
        );
        // Paths that cannot be resolved are left to the usual checks.
        assert_eq!(canonical_destination("relative"), None);
        assert_eq!(
            create(&base.join("no/child")).unwrap_err().kind(),
            "NotFound"
        );
    }
}
