//! Workspace file operations: listing notes, reading and atomic writes.
//!
//! Everything here is synchronous and free of Tauri types; the command layer
//! runs it on a blocking thread.

use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};
use crate::paths;

/// A Markdown file in the workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileEntry {
    /// Path relative to the workspace root, `/`-separated.
    pub path: String,
    /// Size in bytes.
    pub size: u64,
    /// Last modification time in milliseconds since the Unix epoch.
    pub modified: u64,
}

/// Contents of a workspace file and the hash of its bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileContents {
    pub contents: String,
    /// Lowercase hex SHA-256 of the file bytes, see [`content_hash`].
    pub hash: String,
}

/// The entry of a file that was just written and the hash of what was
/// written. Serialized flat: `{ path, size, modified, hash }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WrittenFile {
    #[serde(flatten)]
    pub entry: FileEntry,
    pub hash: String,
}

/// Precondition checked by [`write_file`] right before the new contents
/// replace the target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteCondition {
    /// Write whatever is on disk.
    Unconditional,
    /// Only create the file: fail with `Conflict` if it already exists.
    CreateOnly,
    /// Only replace the file if it exists and its bytes hash to this value
    /// (as returned by [`content_hash`]); otherwise fail with `Conflict`.
    Matches(String),
}

/// Lowercase hex SHA-256 of `bytes`.
pub fn content_hash(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest.iter() {
        out.push(char::from(HEX[usize::from(byte >> 4)]));
        out.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    out
}

/// Prefix of the temporary files created by [`atomic_write`]. It starts with
/// a dot so listings and the watcher skip them.
pub const TEMP_PREFIX: &str = ".kaido-";

/// Folder holding the workspace configuration. It is pruned from listings,
/// but the watcher reports changes to [`CONFIG_FILE`] inside it.
pub const CONFIG_DIR: &str = ".kaido";
/// The only file outside the Markdown set that the watcher reports.
pub const CONFIG_FILE: &str = ".kaido/config.json";

/// Whether a file or directory name is skipped entirely when walking the
/// workspace: hidden entries (`.git`, `.kaido`, temp files) and `node_modules`.
pub fn is_pruned_name(name: &str) -> bool {
    name.starts_with('.') || name == "node_modules"
}

/// Whether a relative path lies in a pruned location (hidden entries,
/// `node_modules`) or is one itself.
pub fn is_pruned_path(rel: &str) -> bool {
    rel.split('/').any(is_pruned_name)
}

/// Largest file `read_file` and `write_file` accept, in bytes.
pub const MAX_FILE_SIZE: u64 = 8 * 1024 * 1024;

/// Checks that `rel` is well formed and is a path the frontend may read or
/// write: a listable note (`*.md` outside pruned folders) or the workspace
/// config file. Everything else (`.git/config`, hooks, other files) is
/// refused with `InvalidPath`.
pub fn ensure_allowed(rel: &str) -> AppResult<()> {
    paths::validate_relative(rel)?;
    if rel == CONFIG_FILE || (is_markdown(rel) && !is_pruned_path(rel)) {
        Ok(())
    } else {
        Err(AppError::InvalidPath(format!(
            "{rel} is not a note or the workspace config file"
        )))
    }
}

/// Applies [`ensure_allowed`] to where `rel` really points after symlinks
/// were resolved, so a note that is a link to `.git/config` (or a folder
/// link into `.git`) is refused like the target itself would be.
fn ensure_resolved_allowed(root: &Path, resolved: &Path, rel: &str) -> AppResult<()> {
    let allowed = paths::to_relative(root, resolved).is_some_and(|r| ensure_allowed(&r).is_ok());
    if allowed {
        Ok(())
    } else {
        Err(AppError::InvalidPath(format!(
            "{rel} points to a file that is not a note or the workspace config file"
        )))
    }
}

fn too_large(label: &str) -> AppError {
    AppError::TooLarge(format!("{label} is larger than 8 MiB"))
}

/// Whether a file name has a `.md` extension, ignoring case.
pub fn is_markdown(name: &str) -> bool {
    Path::new(name)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}

fn modified_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

fn entry(rel: String, meta: &fs::Metadata) -> FileEntry {
    FileEntry {
        path: rel,
        size: meta.len(),
        modified: modified_ms(meta),
    }
}

/// Lists every Markdown file under `root` (canonical), sorted by path.
///
/// Hidden entries and `node_modules` are pruned, directory symlinks are not
/// followed, file symlinks are only listed when they resolve inside the
/// workspace, and names that are not valid UTF-8 are skipped. Subfolders that
/// cannot be read are skipped; failing to read the root is an error.
pub fn list_files(root: &Path) -> AppResult<Vec<FileEntry>> {
    let mut out = Vec::new();
    let top =
        fs::read_dir(root).map_err(|e| AppError::from_io(&e, "list", "the workspace folder"))?;
    walk(root, top, &mut out);
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

fn walk(root: &Path, entries: fs::ReadDir, out: &mut Vec<FileEntry>) {
    for dir_entry in entries.flatten() {
        let name = dir_entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if is_pruned_name(name) {
            continue;
        }
        let Ok(file_type) = dir_entry.file_type() else {
            continue;
        };
        let path = dir_entry.path();
        if file_type.is_dir() {
            if let Ok(sub) = fs::read_dir(&path) {
                walk(root, sub, out);
            }
        } else if is_markdown(name) {
            if let Some(found) = markdown_entry(root, &path, file_type.is_symlink()) {
                out.push(found);
            }
        }
    }
}

fn markdown_entry(root: &Path, path: &Path, is_symlink: bool) -> Option<FileEntry> {
    let rel = paths::to_relative(root, path)?;
    file_entry(root, path, rel, is_symlink)
}

/// Builds the entry of a regular file (or a symlink to one that stays inside
/// the workspace). Returns `None` for anything else.
/// When `resolve` is set (always for symlinks), the real location must be
/// inside the workspace and be a note or the config file itself.
fn file_entry(root: &Path, path: &Path, rel: String, resolve: bool) -> Option<FileEntry> {
    if resolve {
        let target = dunce::canonicalize(path).ok()?;
        ensure_resolved_allowed(root, &target, &rel).ok()?;
    }
    // `metadata` follows symlinks: a link to a folder is not a file.
    let meta = fs::metadata(path).ok()?;
    meta.is_file().then(|| entry(rel, &meta))
}

/// Fresh entry for a workspace-relative path, or `None` if it no longer
/// exists as a file (under the same rules as [`list_files`] for symlinks).
pub fn stat_entry(root: &Path, rel: &str) -> Option<FileEntry> {
    let path = root.join(paths::validate_relative(rel).ok()?);
    // Few paths go through here, so always resolve: this also covers files
    // reached through a folder symlink.
    file_entry(root, &path, rel.to_owned(), true)
}

/// Reads a workspace file as UTF-8 text, along with the hash of its bytes.
pub fn read_file(root: &Path, rel: &str) -> AppResult<FileContents> {
    ensure_allowed(rel)?;
    let path = paths::resolve_existing(root, rel)?;
    ensure_resolved_allowed(root, &path, rel)?;
    if path.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "{rel} is a folder, not a file"
        )));
    }
    let bytes = read_bytes(&path, rel)?;
    let hash = content_hash(&bytes);
    let contents = decode_utf8(bytes, rel)?;
    Ok(FileContents { contents, hash })
}

/// Reads a file of at most [`MAX_FILE_SIZE`] bytes and decodes it as UTF-8,
/// reporting errors with `label`.
pub fn read_text(path: &Path, label: &str) -> AppResult<String> {
    decode_utf8(read_bytes(path, label)?, label)
}

fn decode_utf8(bytes: Vec<u8>, label: &str) -> AppResult<String> {
    String::from_utf8(bytes)
        .map_err(|_| AppError::InvalidUtf8(format!("{label} is not valid UTF-8 text")))
}

/// Reads a file of at most [`MAX_FILE_SIZE`] bytes, reporting errors with
/// `label`.
fn read_bytes(path: &Path, label: &str) -> AppResult<Vec<u8>> {
    let io_err = |e: io::Error| AppError::from_io(&e, "read", label);
    let file = fs::File::open(path).map_err(io_err)?;
    if file.metadata().map_err(io_err)?.len() > MAX_FILE_SIZE {
        return Err(too_large(label));
    }
    // The size is checked again while reading in case the file grew.
    let mut bytes = Vec::new();
    file.take(MAX_FILE_SIZE + 1)
        .read_to_end(&mut bytes)
        .map_err(io_err)?;
    if bytes.len() as u64 > MAX_FILE_SIZE {
        return Err(too_large(label));
    }
    Ok(bytes)
}

/// Atomically writes a workspace file, creating missing parent folders inside
/// the workspace, and returns its new entry with the hash of `contents`.
///
/// Existing read-only files are never replaced. `condition` is checked after
/// every other validation, right before the new contents are published.
///
/// [`WriteCondition::CreateOnly`] is race-free where the file system supports
/// hard links: the temporary file is linked to the target name, which fails
/// if anything already exists there. Elsewhere it falls back to a check
/// followed by a rename. For that fallback and for
/// [`WriteCondition::Matches`], a change made by another process between the
/// check and the rename is not detected; the window is a few system calls
/// wide.
pub fn write_file(
    root: &Path,
    rel: &str,
    contents: &str,
    condition: &WriteCondition,
) -> AppResult<WrittenFile> {
    ensure_allowed(rel)?;
    if contents.len() as u64 > MAX_FILE_SIZE {
        return Err(too_large(rel));
    }
    let target = paths::resolve_for_write(root, rel)?;
    ensure_resolved_allowed(root, &target, rel)?;
    if fs::metadata(&target).is_ok_and(|m| m.permissions().readonly()) {
        return Err(AppError::PermissionDenied(format!("{rel} is read-only")));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::from_io(&e, "create the folder for", rel))?;
    }
    write_atomically(
        &target,
        contents.as_bytes(),
        rel,
        Some(Guard { root, condition }),
    )?;
    let meta = fs::metadata(&target).map_err(|e| AppError::from_io(&e, "read", rel))?;
    Ok(WrittenFile {
        entry: entry(rel.to_owned(), &meta),
        hash: content_hash(contents.as_bytes()),
    })
}

/// Checks `condition` against the current bytes of `target`.
fn check_condition(target: &Path, condition: &WriteCondition, label: &str) -> AppResult<()> {
    match condition {
        WriteCondition::Unconditional => Ok(()),
        WriteCondition::CreateOnly => match fs::metadata(target) {
            Ok(_) => Err(AppError::Conflict(format!("{label} already exists"))),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(AppError::from_io(&e, "check", label)),
        },
        WriteCondition::Matches(expected) => match read_bytes(target, label) {
            Ok(bytes) if content_hash(&bytes) == *expected => Ok(()),
            // A file over the size limit never had its hash handed out.
            Ok(_) | Err(AppError::TooLarge(_)) => Err(AppError::Conflict(format!(
                "{label} was changed by another program"
            ))),
            Err(AppError::NotFound(_)) => Err(AppError::Conflict(format!(
                "{label} was removed by another program"
            ))),
            Err(e) => Err(e),
        },
    }
}

/// Checks run by [`write_atomically`] right before publishing the file.
#[derive(Clone, Copy)]
struct Guard<'a> {
    /// The target's folder must still resolve inside this workspace root.
    root: &'a Path,
    /// Precondition on the target's current state.
    condition: &'a WriteCondition,
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_path(target: &Path) -> AppResult<PathBuf> {
    let dir = target
        .parent()
        .ok_or_else(|| AppError::InvalidPath("cannot write to the file system root".into()))?;
    let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    Ok(dir.join(format!("{TEMP_PREFIX}{}-{n}.tmp", std::process::id())))
}

/// Replaces `target` with `bytes` so readers see either the old or the new
/// contents, never a partial file.
///
/// The data goes to a hidden temporary file in the same folder, which is
/// flushed to disk and then renamed over the target. On Unix the folder is
/// synced too (best effort) so the new entry survives a crash. The temporary
/// file is removed if anything fails. `label` names the file in errors.
pub fn atomic_write(target: &Path, bytes: &[u8], label: &str) -> AppResult<()> {
    write_atomically(target, bytes, label, None)
}

/// [`atomic_write`], optionally running the checks of `guard` right before
/// publishing: the target's folder must still resolve inside the workspace
/// (narrowing the window in which a folder swapped for a symlink could
/// redirect the write) and the write condition must hold. A create-only
/// write is published without ever replacing an existing target.
fn write_atomically(
    target: &Path,
    bytes: &[u8],
    label: &str,
    guard: Option<Guard<'_>>,
) -> AppResult<()> {
    let temp = temp_path(target)?;
    let io_err = |e: io::Error| AppError::from_io(&e, "write", label);
    let create_only = guard.is_some_and(|g| *g.condition == WriteCondition::CreateOnly);
    let result = write_temp(&temp, target, bytes)
        .map_err(io_err)
        .and_then(|()| match guard {
            Some(guard) => ensure_parent_inside(guard.root, target, label)
                .and_then(|()| check_condition(target, guard.condition, label)),
            None => Ok(()),
        })
        .and_then(|()| {
            #[cfg(test)]
            tests::run_before_publish_hook();
            if create_only {
                publish_new(&temp, target, label, |from, to| fs::hard_link(from, to))
            } else {
                fs::rename(&temp, target).map_err(io_err)
            }
        });
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    } else {
        sync_parent(target);
    }
    result
}

/// Publishes `temp` as `target` only if nothing exists at `target`, then
/// removes `temp`.
///
/// Linking is atomic and never replaces an existing entry, so a file created
/// by another process at any point before the link wins and the write fails
/// with `Conflict`. If the file system cannot create the link (some network
/// and FAT-style file systems), this falls back to checking for the target
/// and renaming, which leaves a small race window. On failure `temp` is left
/// for the caller to remove.
fn publish_new(
    temp: &Path,
    target: &Path,
    label: &str,
    link: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> AppResult<()> {
    match link(temp, target) {
        Ok(()) => {
            // The contents are published; a temp file that cannot be removed
            // here is cleaned up later by the stale temp sweep.
            let _ = fs::remove_file(temp);
            Ok(())
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            Err(AppError::Conflict(format!("{label} already exists")))
        }
        Err(_) => check_condition(target, &WriteCondition::CreateOnly, label).and_then(|()| {
            fs::rename(temp, target).map_err(|e| AppError::from_io(&e, "write", label))
        }),
    }
}

fn ensure_parent_inside(root: &Path, target: &Path, label: &str) -> AppResult<()> {
    let parent = target.parent().unwrap_or(target);
    let resolved =
        dunce::canonicalize(parent).map_err(|e| AppError::from_io(&e, "write", label))?;
    if resolved.starts_with(root) {
        Ok(())
    } else {
        Err(AppError::OutsideWorkspace(format!(
            "{label} points outside the workspace"
        )))
    }
}

fn write_temp(temp: &Path, target: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(temp)?;
    // Keep the permissions of the file being replaced.
    if let Ok(meta) = fs::metadata(target) {
        let _ = file.set_permissions(meta.permissions());
    }
    file.write_all(bytes)?;
    file.sync_all()
}

/// Whether `name` is a temp file of [`atomic_write`] left behind by another
/// process (typically one that crashed mid-write): `.kaido-<pid>-<n>.tmp`.
fn is_stale_temp(name: &str) -> bool {
    let Some(middle) = name
        .strip_prefix(TEMP_PREFIX)
        .and_then(|rest| rest.strip_suffix(".tmp"))
    else {
        return false;
    };
    let Some((pid, n)) = middle.split_once('-') else {
        return false;
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    digits(pid) && digits(n) && pid != std::process::id().to_string()
}

/// Temp files younger than this are left alone: another running instance
/// may still be about to rename them.
pub const STALE_TEMP_AGE: Duration = Duration::from_secs(10 * 60);

fn older_than(meta: &fs::Metadata, age: Duration) -> bool {
    meta.modified()
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|elapsed| elapsed >= age)
}

/// Removes stale temp files from every folder `write_file` can write to (the
/// listable folders and the config folder): temp files of other processes
/// last modified at least [`STALE_TEMP_AGE`] ago. Best effort; returns how
/// many files were removed.
pub fn sweep_temp_files(root: &Path) -> usize {
    sweep_temp_files_older_than(root, STALE_TEMP_AGE)
}

fn sweep_temp_files_older_than(root: &Path, age: Duration) -> usize {
    let config_dir = root.join(CONFIG_DIR);
    let mut removed = 0;
    let mut stack = vec![root.to_path_buf(), config_dir.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let descend = dir != config_dir;
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_file()
                && is_stale_temp(name)
                && entry.metadata().is_ok_and(|m| older_than(&m, age))
            {
                removed += usize::from(fs::remove_file(entry.path()).is_ok());
            } else if file_type.is_dir() && descend && !is_pruned_name(name) {
                stack.push(entry.path());
            }
        }
    }
    removed
}

#[cfg(unix)]
fn sync_parent(target: &Path) {
    if let Some(dir) = target.parent() {
        if let Ok(dir) = fs::File::open(dir) {
            let _ = dir.sync_all();
        }
    }
}

#[cfg(not(unix))]
fn sync_parent(_target: &Path) {
    // Windows has no portable way to sync a directory entry.
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use tempfile::TempDir;

    type Hook = Box<dyn FnOnce()>;

    thread_local! {
        /// Runs once inside `write_atomically`, after the write condition was
        /// checked and right before the file is published.
        static BEFORE_PUBLISH: RefCell<Option<Hook>> = const { RefCell::new(None) };
    }

    pub(super) fn run_before_publish_hook() {
        if let Some(hook) = BEFORE_PUBLISH.with(|h| h.borrow_mut().take()) {
            hook();
        }
    }

    fn before_publish(hook: impl FnOnce() + 'static) {
        BEFORE_PUBLISH.with(|h| *h.borrow_mut() = Some(Box::new(hook)));
    }

    fn workspace() -> (TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        (dir, root)
    }

    fn put(root: &Path, rel: &str, contents: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    fn write(root: &Path, rel: &str, contents: &str) -> AppResult<FileEntry> {
        write_file(root, rel, contents, &WriteCondition::Unconditional).map(|w| w.entry)
    }

    fn read(root: &Path, rel: &str) -> AppResult<String> {
        read_file(root, rel).map(|f| f.contents)
    }

    fn listed(root: &Path) -> Vec<String> {
        list_files(root)
            .unwrap()
            .into_iter()
            .map(|e| e.path)
            .collect()
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|n| n.starts_with(TEMP_PREFIX))
            .collect()
    }

    #[test]
    fn markdown_extension_is_case_insensitive() {
        assert!(is_markdown("a.md"));
        assert!(is_markdown("a.MD"));
        assert!(is_markdown("a.Md"));
        assert!(!is_markdown("a.markdown"));
        assert!(!is_markdown("a.md.bak"));
        assert!(!is_markdown("md"));
        assert!(!is_markdown(".md"));
    }

    #[test]
    fn pruned_names() {
        assert!(is_pruned_name(".git"));
        assert!(is_pruned_name(".kaido"));
        assert!(is_pruned_name(".kaido-1-2.tmp"));
        assert!(is_pruned_name("node_modules"));
        assert!(!is_pruned_name("_archive"));
        assert!(!is_pruned_name("inbox"));
    }

    #[test]
    fn lists_markdown_recursively_sorted_and_pruned() {
        let (_dir, root) = workspace();
        put(&root, "inbox/tasks.md", "- [ ] a");
        put(&root, "zeta.md", "z");
        put(&root, "api/auth/LOGIN.MD", "x");
        put(&root, "api/notes.txt", "x");
        put(&root, "_archive/old/n.md", "x");
        put(&root, ".git/HEAD.md", "x");
        put(&root, ".kaido/config.md", "x");
        put(&root, "proj/.hidden.md", "x");
        put(&root, "proj/node_modules/pkg/readme.md", "x");
        put(&root, "node_modules/readme.md", "x");
        put(&root, "proj/.kaido-1-1.tmp", "x");
        assert_eq!(
            listed(&root),
            [
                "_archive/old/n.md",
                "api/auth/LOGIN.MD",
                "inbox/tasks.md",
                "zeta.md"
            ]
        );
    }

    #[test]
    fn entries_have_size_and_mtime() {
        let (_dir, root) = workspace();
        put(&root, "a.md", "hello");
        let entries = list_files(&root).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].size, 5);
        assert!(entries[0].modified > 1_600_000_000_000);
        let json = serde_json::to_value(&entries[0]).unwrap();
        assert_eq!(json["path"], "a.md");
        assert_eq!(json["size"], 5);
    }

    #[test]
    fn listing_a_missing_root_fails() {
        let (_dir, root) = workspace();
        assert_eq!(
            list_files(&root.join("gone")).unwrap_err().kind(),
            "NotFound"
        );
    }

    #[cfg(unix)]
    #[test]
    fn listing_skips_symlinked_dirs_and_outside_file_links() {
        use std::os::unix::fs::symlink;
        let (_dir, root) = workspace();
        let (_outside_dir, outside) = workspace();
        put(&outside, "secret.md", "s");
        put(&root, "real/a.md", "a");
        symlink(&outside, root.join("out")).unwrap();
        symlink(root.join("real"), root.join("alias")).unwrap();
        symlink(outside.join("secret.md"), root.join("secret.md")).unwrap();
        symlink(root.join("real/a.md"), root.join("inside-link.md")).unwrap();
        symlink(root.join("real"), root.join("dir-link.md")).unwrap();
        symlink(root.join("missing.md"), root.join("dangling.md")).unwrap();
        assert_eq!(listed(&root), ["inside-link.md", "real/a.md"]);
    }

    #[cfg(unix)]
    #[test]
    fn listing_skips_non_utf8_names() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        let (_dir, root) = workspace();
        put(&root, "ok.md", "x");
        if fs::write(root.join(OsStr::from_bytes(b"bad\xff.md")), "x").is_ok() {
            let _ = fs::create_dir(root.join(OsStr::from_bytes(b"dir\xff")));
            assert_eq!(listed(&root), ["ok.md"]);
        }
    }

    #[cfg(unix)]
    #[test]
    fn listing_skips_unreadable_subfolders() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, root) = workspace();
        put(&root, "ok.md", "x");
        put(&root, "locked/hidden.md", "x");
        if crate::test_support::skip_if_privileged("listing_skips_unreadable_subfolders") {
            return;
        }
        fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o000)).unwrap();
        let result = listed(&root);
        fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(result, ["ok.md"]);
    }

    #[test]
    fn reads_utf8_files() {
        let (_dir, root) = workspace();
        put(&root, "p/a.md", "# Título\n");
        assert_eq!(read(&root, "p/a.md").unwrap(), "# Título\n");
    }

    #[test]
    fn read_failures() {
        let (_dir, root) = workspace();
        fs::create_dir(root.join("p")).unwrap();
        fs::write(root.join("bin.md"), [0xff, 0xfe, 0x00]).unwrap();
        let err = |rel| read(&root, rel).unwrap_err();
        assert_eq!(err("missing.md").kind(), "NotFound");
        assert_eq!(err("p").kind(), "InvalidPath");
        assert_eq!(err("bin.md").kind(), "InvalidUtf8");
        assert_eq!(err("../x.md").kind(), "InvalidPath");
        assert_eq!(err("/etc/passwd").kind(), "InvalidPath");
        assert_eq!(err("a\0.md").kind(), "InvalidPath");
        // Messages never mention the absolute root.
        let message = err("missing.md").to_string();
        assert!(!message.contains(root.to_str().unwrap()), "{message}");
        assert!(message.contains("missing.md"));
    }

    #[cfg(unix)]
    #[test]
    fn reading_an_unreadable_file_is_permission_denied() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, root) = workspace();
        put(&root, "a.md", "x");
        if crate::test_support::skip_if_privileged("reading_an_unreadable_file") {
            return;
        }
        fs::set_permissions(root.join("a.md"), fs::Permissions::from_mode(0o000)).unwrap();
        let result = read(&root, "a.md");
        assert_eq!(result.unwrap_err().kind(), "PermissionDenied");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_rejected_for_read_and_write() {
        use std::os::unix::fs::symlink;
        let (_dir, root) = workspace();
        let (_outside_dir, outside) = workspace();
        put(&outside, "secret.md", "secret");
        symlink(outside.join("secret.md"), root.join("s.md")).unwrap();
        symlink(&outside, root.join("out")).unwrap();
        assert_eq!(read(&root, "s.md").unwrap_err().kind(), "OutsideWorkspace");
        assert_eq!(
            write(&root, "s.md", "x").unwrap_err().kind(),
            "OutsideWorkspace"
        );
        assert_eq!(
            write(&root, "out/new.md", "x").unwrap_err().kind(),
            "OutsideWorkspace"
        );
        assert_eq!(
            fs::read_to_string(outside.join("secret.md")).unwrap(),
            "secret"
        );
        assert!(!outside.join("new.md").exists());
    }

    #[test]
    fn writes_new_files_and_creates_folders() {
        let (_dir, root) = workspace();
        let written = write(&root, "proj/sub/new.md", "hello").unwrap();
        assert_eq!(written.path, "proj/sub/new.md");
        assert_eq!(written.size, 5);
        assert!(written.modified > 0);
        assert_eq!(
            fs::read_to_string(root.join("proj/sub/new.md")).unwrap(),
            "hello"
        );
        assert!(leftovers(&root.join("proj/sub")).is_empty());
    }

    #[test]
    fn overwrites_existing_files() {
        let (_dir, root) = workspace();
        put(&root, "a.md", "old contents that are longer");
        let written = write(&root, "a.md", "new").unwrap();
        assert_eq!(written.size, 3);
        assert_eq!(read(&root, "a.md").unwrap(), "new");
        assert!(leftovers(&root).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn overwriting_keeps_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, root) = workspace();
        put(&root, "a.md", "old");
        fs::set_permissions(root.join("a.md"), fs::Permissions::from_mode(0o600)).unwrap();
        write(&root, "a.md", "new").unwrap();
        let mode = fs::metadata(root.join("a.md"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn writing_through_an_inside_symlink_updates_the_target() {
        use std::os::unix::fs::symlink;
        let (_dir, root) = workspace();
        put(&root, "real/a.md", "old");
        symlink(root.join("real/a.md"), root.join("link.md")).unwrap();
        let written = write(&root, "link.md", "new").unwrap();
        assert_eq!(written.path, "link.md");
        assert_eq!(fs::read_to_string(root.join("real/a.md")).unwrap(), "new");
        assert!(
            fs::symlink_metadata(root.join("link.md"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[test]
    fn write_failures() {
        let (_dir, root) = workspace();
        put(&root, "file.md", "x");
        fs::create_dir(root.join("folder")).unwrap();
        let err = |rel| write(&root, rel, "x").unwrap_err().kind();
        assert_eq!(err("../escape.md"), "InvalidPath");
        assert_eq!(err("/abs.md"), "InvalidPath");
        assert_eq!(err(""), "InvalidPath");
        assert_eq!(err("folder"), "InvalidPath");
        assert_eq!(err("file.md/child.md"), "NotADirectory");
        assert!(!root.parent().unwrap().join("escape.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn writing_into_a_read_only_folder_is_permission_denied() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, root) = workspace();
        put(&root, "ro/a.md", "old");
        if crate::test_support::skip_if_privileged("writing_into_a_read_only_folder") {
            return;
        }
        fs::set_permissions(root.join("ro"), fs::Permissions::from_mode(0o500)).unwrap();
        let result = write(&root, "ro/a.md", "new");
        let nested = write(&root, "ro/sub/b.md", "new");
        fs::set_permissions(root.join("ro"), fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(result.unwrap_err().kind(), "PermissionDenied");
        assert_eq!(nested.unwrap_err().kind(), "PermissionDenied");
        assert_eq!(fs::read_to_string(root.join("ro/a.md")).unwrap(), "old");
        assert!(leftovers(&root.join("ro")).is_empty());
    }

    #[test]
    fn read_only_files_are_never_replaced() {
        let (_dir, root) = workspace();
        put(&root, "a.md", "old");
        let mut perms = fs::metadata(root.join("a.md")).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(root.join("a.md"), perms).unwrap();
        let err = write(&root, "a.md", "new").unwrap_err();
        assert_eq!(err.kind(), "PermissionDenied");
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "old");
        assert!(leftovers(&root).is_empty());
    }

    #[test]
    fn only_notes_and_the_config_file_are_accessible() {
        let (_dir, root) = workspace();
        put(&root, ".kaido/config.json", "{}");
        put(&root, ".git/config", "[core]");
        put(&root, "notes.txt", "x");
        for rel in [
            "a.md",
            "p/sub/B.MD",
            "_archive/p/n.md",
            ".kaido/config.json",
        ] {
            assert!(ensure_allowed(rel).is_ok(), "{rel}");
        }
        for rel in [
            ".git/config",
            ".git/hooks/pre-commit",
            ".git/x.md",
            ".kaido/other.json",
            ".kaido/notes.md",
            "p/.hidden.md",
            "node_modules/readme.md",
            "p/node_modules/x/readme.md",
            "notes.txt",
            "config.json",
            "p/.kaido/config.json",
            ".KAIDO/config.json",
        ] {
            assert_eq!(read(&root, rel).unwrap_err().kind(), "InvalidPath", "{rel}");
            assert_eq!(
                write(&root, rel, "x").unwrap_err().kind(),
                "InvalidPath",
                "{rel}"
            );
        }
        assert_eq!(
            fs::read_to_string(root.join(".git/config")).unwrap(),
            "[core]"
        );
        assert!(!root.join(".git/hooks").exists());
        assert_eq!(read(&root, ".kaido/config.json").unwrap(), "{}");
        write(&root, ".kaido/config.json", r#"{"version":1}"#).unwrap();
        assert_eq!(
            read(&root, ".kaido/config.json").unwrap(),
            r#"{"version":1}"#
        );
    }

    #[test]
    fn files_over_8_mib_are_too_large() {
        let (_dir, root) = workspace();
        let limit = usize::try_from(MAX_FILE_SIZE).unwrap();
        let at_limit = "a".repeat(limit);
        assert_eq!(
            write(&root, "big.md", &at_limit).unwrap().size,
            MAX_FILE_SIZE
        );
        assert_eq!(read(&root, "big.md").unwrap().len(), limit);

        let over = "a".repeat(limit + 1);
        let err = write(&root, "over.md", &over).unwrap_err();
        assert_eq!(err.kind(), "TooLarge");
        assert!(!root.join("over.md").exists());
        fs::write(root.join("over.md"), &over).unwrap();
        assert_eq!(read(&root, "over.md").unwrap_err().kind(), "TooLarge");
    }

    #[cfg(unix)]
    #[test]
    fn rename_is_refused_if_the_folder_moved_outside() {
        use std::os::unix::fs::symlink;
        let (_dir, root) = workspace();
        let (_outside_dir, outside) = workspace();
        // Simulates a folder replaced by a link after it was resolved.
        symlink(&outside, root.join("swapped")).unwrap();
        let target = root.join("swapped").join("a.md");
        let guard = Some(Guard {
            root: &root,
            condition: &WriteCondition::Unconditional,
        });
        let err = write_atomically(&target, b"x", "swapped/a.md", guard).unwrap_err();
        assert_eq!(err.kind(), "OutsideWorkspace");
        assert!(!outside.join("a.md").exists());
        assert!(leftovers(&outside).is_empty());
        // The same write inside the workspace goes through.
        fs::create_dir(root.join("real")).unwrap();
        write_atomically(&root.join("real/a.md"), b"x", "real/a.md", guard).unwrap();
        let gone = root.join("gone").join("a.md");
        let err = write_atomically(&gone, b"x", "gone/a.md", guard).unwrap_err();
        assert_eq!(err.kind(), "NotFound");
    }

    #[test]
    fn recognizes_stale_temp_names() {
        let own = std::process::id();
        let other = own.wrapping_add(1);
        assert!(is_stale_temp(&format!(".kaido-{other}-0.tmp")));
        assert!(is_stale_temp(".kaido-1-12.tmp") || own == 1);
        for name in [
            format!(".kaido-{own}-3.tmp"),
            ".kaido-1-2.tmp.md".into(),
            ".kaido-x-2.tmp".into(),
            ".kaido--2.tmp".into(),
            ".kaido-12.tmp".into(),
            ".kaido-1-.tmp".into(),
            ".kaido-tmp".into(),
            "kaido-1-2.tmp".into(),
            "a.md".into(),
        ] {
            assert!(!is_stale_temp(&name), "{name}");
        }
    }

    #[test]
    fn sweeps_stale_temp_files_only() {
        let (_dir, root) = workspace();
        let other = std::process::id().wrapping_add(1);
        let stale = format!(".kaido-{other}-7.tmp");
        let own = format!(".kaido-{}-7.tmp", std::process::id());
        for dir in ["", "p/sub", ".kaido"] {
            put(&root, format!("{dir}/{stale}").trim_start_matches('/'), "x");
        }
        put(&root, &format!("p/{own}"), "x");
        put(&root, &format!(".git/{stale}"), "x");
        put(&root, &format!(".kaido/cache/{stale}"), "x");
        put(&root, &format!("node_modules/{stale}"), "x");
        put(&root, "p/.kaido-notes.tmp", "x");
        put(&root, "p/a.md", "x");
        fs::create_dir(root.join(format!("p/.kaido-{other}-8.tmp"))).unwrap();
        // Recent temp files of another process may belong to a running
        // instance and are kept.
        let fresh = format!(".kaido-{other}-9.tmp");
        put(&root, &format!("p/{fresh}"), "x");
        let backdate = |rel: &str| crate::test_support::backdate(&root.join(rel), 3600);
        for rel in [
            stale.clone(),
            format!("p/sub/{stale}"),
            format!(".kaido/{stale}"),
            format!("p/{own}"),
            format!(".git/{stale}"),
            format!(".kaido/cache/{stale}"),
            format!("node_modules/{stale}"),
            "p/.kaido-notes.tmp".into(),
        ] {
            backdate(&rel);
        }

        assert_eq!(sweep_temp_files(&root), 3);
        for rel in [
            stale.clone(),
            format!("p/sub/{stale}"),
            format!(".kaido/{stale}"),
        ] {
            assert!(!root.join(&rel).exists(), "{rel}");
        }
        for rel in [
            format!("p/{own}"),
            format!(".git/{stale}"),
            format!(".kaido/cache/{stale}"),
            format!("node_modules/{stale}"),
            "p/.kaido-notes.tmp".into(),
            "p/a.md".into(),
            format!("p/.kaido-{other}-8.tmp"),
            format!("p/{fresh}"),
        ] {
            assert!(root.join(&rel).exists(), "{rel}");
        }
        // With a zero age the fresh one goes too.
        assert_eq!(sweep_temp_files_older_than(&root, Duration::ZERO), 1);
        assert!(!root.join(format!("p/{fresh}")).exists());
        assert_eq!(sweep_temp_files(&root.join("missing")), 0);
    }

    #[test]
    fn failed_rename_removes_the_temp_file() {
        let (_dir, root) = workspace();
        // Renaming a file over a non-empty folder fails on every platform.
        put(&root, "target/child.md", "x");
        let err = atomic_write(&root.join("target"), b"data", "target").unwrap_err();
        assert!(!err.to_string().contains(root.to_str().unwrap()));
        assert!(leftovers(&root).is_empty());
        assert!(root.join("target/child.md").exists());
    }

    #[test]
    fn atomic_write_rejects_the_filesystem_root() {
        let root = Path::new("/");
        assert_eq!(
            atomic_write(root, b"x", "root").unwrap_err().kind(),
            "InvalidPath"
        );
    }

    #[test]
    fn temp_names_are_hidden_and_unique() {
        let a = temp_path(Path::new("/w/a.md")).unwrap();
        let b = temp_path(Path::new("/w/a.md")).unwrap();
        assert_ne!(a, b);
        let name = a.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with(TEMP_PREFIX) && is_pruned_name(name) && !is_markdown(name));
    }

    #[test]
    fn stat_entry_reports_only_existing_files() {
        let (_dir, root) = workspace();
        put(&root, "p/a.md", "hello");
        put(&root, ".kaido/config.json", "{}");
        let a = stat_entry(&root, "p/a.md").unwrap();
        assert_eq!((a.path.as_str(), a.size), ("p/a.md", 5));
        assert!(a.modified > 0);
        assert_eq!(stat_entry(&root, ".kaido/config.json").unwrap().size, 2);
        assert_eq!(stat_entry(&root, "p/missing.md"), None);
        assert_eq!(stat_entry(&root, "p"), None);
        assert_eq!(stat_entry(&root, "../x.md"), None);
    }

    #[cfg(unix)]
    #[test]
    fn links_to_files_that_are_not_notes_are_refused() {
        use std::os::unix::fs::symlink;
        let (_dir, root) = workspace();
        put(&root, ".git/config", "[core]");
        put(&root, ".git/notes.md", "git");
        put(&root, ".kaido/other.json", "{}");
        put(&root, ".kaido/config.json", "{}");
        put(&root, "inbox/real.md", "real");
        put(&root, "inbox/data.txt", "data");
        symlink(root.join(".git/config"), root.join("inbox/git.md")).unwrap();
        symlink(root.join(".kaido/other.json"), root.join("inbox/other.md")).unwrap();
        symlink(root.join("inbox/data.txt"), root.join("inbox/data.md")).unwrap();
        symlink(root.join("inbox/real.md"), root.join("inbox/alias.md")).unwrap();
        symlink(
            root.join(".kaido/config.json"),
            root.join("inbox/config.md"),
        )
        .unwrap();
        symlink(root.join(".git"), root.join("gitdir")).unwrap();

        assert_eq!(
            listed(&root),
            ["inbox/alias.md", "inbox/config.md", "inbox/real.md"]
        );
        for rel in [
            "inbox/git.md",
            "inbox/other.md",
            "inbox/data.md",
            "gitdir/notes.md",
        ] {
            assert_eq!(read(&root, rel).unwrap_err().kind(), "InvalidPath", "{rel}");
            assert_eq!(
                write(&root, rel, "x").unwrap_err().kind(),
                "InvalidPath",
                "{rel}"
            );
            assert_eq!(stat_entry(&root, rel), None, "{rel}");
        }
        assert_eq!(
            fs::read_to_string(root.join(".git/config")).unwrap(),
            "[core]"
        );
        assert_eq!(
            fs::read_to_string(root.join(".kaido/other.json")).unwrap(),
            "{}"
        );
        assert_eq!(
            fs::read_to_string(root.join(".git/notes.md")).unwrap(),
            "git"
        );
        let err = write(&root, "gitdir/new.md", "x").unwrap_err();
        assert_eq!(err.kind(), "InvalidPath");
        assert!(!root.join(".git/new.md").exists());
        assert!(leftovers(&root.join(".git")).is_empty());

        // Links to notes (or the config file) keep working.
        assert_eq!(read(&root, "inbox/alias.md").unwrap(), "real");
        write(&root, "inbox/alias.md", "new").unwrap();
        assert_eq!(
            fs::read_to_string(root.join("inbox/real.md")).unwrap(),
            "new"
        );
        assert_eq!(stat_entry(&root, "inbox/alias.md").unwrap().size, 3);
        assert_eq!(read(&root, "inbox/config.md").unwrap(), "{}");
    }

    #[cfg(unix)]
    #[test]
    fn stat_entry_applies_the_symlink_rules() {
        use std::os::unix::fs::symlink;
        let (_dir, root) = workspace();
        let (_outside_dir, outside) = workspace();
        put(&outside, "secret.md", "s");
        put(&root, "real.md", "abc");
        symlink(outside.join("secret.md"), root.join("out.md")).unwrap();
        symlink(root.join("real.md"), root.join("in.md")).unwrap();
        assert_eq!(stat_entry(&root, "out.md"), None);
        assert_eq!(stat_entry(&root, "in.md").unwrap().size, 3);
    }

    #[test]
    fn content_hash_is_lowercase_hex_sha256() {
        assert_eq!(
            content_hash(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            content_hash(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn read_file_returns_the_hash_of_the_bytes() {
        let (_dir, root) = workspace();
        put(&root, "a.md", "abc");
        let read = read_file(&root, "a.md").unwrap();
        assert_eq!(read.contents, "abc");
        assert_eq!(read.hash, content_hash(b"abc"));
        let json = serde_json::to_value(&read).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "contents": "abc", "hash": content_hash(b"abc") })
        );
    }

    #[test]
    fn written_file_serializes_flat_with_its_hash() {
        let (_dir, root) = workspace();
        let written = write_file(&root, "a.md", "abc", &WriteCondition::Unconditional).unwrap();
        assert_eq!(written.hash, content_hash(b"abc"));
        let json = serde_json::to_value(&written).unwrap();
        assert_eq!(json["path"], "a.md");
        assert_eq!(json["size"], 3);
        assert!(json["modified"].as_u64().unwrap() > 0);
        assert_eq!(json["hash"], content_hash(b"abc"));
        assert_eq!(json.as_object().unwrap().len(), 4);
    }

    #[test]
    fn unconditional_writes_create_and_replace() {
        let (_dir, root) = workspace();
        let cond = WriteCondition::Unconditional;
        write_file(&root, "a.md", "one", &cond).unwrap();
        let written = write_file(&root, "a.md", "two", &cond).unwrap();
        assert_eq!(read(&root, "a.md").unwrap(), "two");
        assert_eq!(written.hash, read_file(&root, "a.md").unwrap().hash);
    }

    #[test]
    fn create_only_writes_new_files() {
        let (_dir, root) = workspace();
        let written = write_file(&root, "p/new.md", "hi", &WriteCondition::CreateOnly).unwrap();
        assert_eq!(written.entry.size, 2);
        assert_eq!(written.hash, content_hash(b"hi"));
        assert_eq!(read(&root, "p/new.md").unwrap(), "hi");
        assert!(leftovers(&root.join("p")).is_empty());
    }

    #[test]
    fn create_only_conflicts_when_the_target_appears_before_publishing() {
        let (_dir, root) = workspace();
        let target = root.join("a.md");
        before_publish(move || fs::write(target, "theirs").unwrap());
        let err = write_file(&root, "a.md", "mine", &WriteCondition::CreateOnly).unwrap_err();
        assert_eq!(err.kind(), "Conflict");
        assert_eq!(err.to_string(), "a.md already exists");
        assert_eq!(read(&root, "a.md").unwrap(), "theirs");
        assert!(leftovers(&root).is_empty());
    }

    #[test]
    fn unconditional_write_replaces_a_target_that_appears_before_publishing() {
        let (_dir, root) = workspace();
        let target = root.join("a.md");
        before_publish(move || fs::write(target, "theirs").unwrap());
        write(&root, "a.md", "mine").unwrap();
        assert_eq!(read(&root, "a.md").unwrap(), "mine");
        assert!(leftovers(&root).is_empty());
    }

    fn unsupported(_: &Path, _: &Path) -> io::Result<()> {
        Err(io::Error::from(io::ErrorKind::Unsupported))
    }

    #[test]
    fn create_only_falls_back_to_rename_without_hard_links() {
        let (_dir, root) = workspace();
        let target = root.join("a.md");
        let temp = temp_path(&target).unwrap();
        write_temp(&temp, &target, b"mine").unwrap();
        publish_new(&temp, &target, "a.md", unsupported).unwrap();
        assert_eq!(read(&root, "a.md").unwrap(), "mine");
        assert!(leftovers(&root).is_empty());
    }

    #[test]
    fn create_only_fallback_still_refuses_an_existing_target() {
        let (_dir, root) = workspace();
        put(&root, "a.md", "theirs");
        let target = root.join("a.md");
        let temp = temp_path(&target).unwrap();
        write_temp(&temp, &target, b"mine").unwrap();
        let err = publish_new(&temp, &target, "a.md", unsupported).unwrap_err();
        assert_eq!(err.kind(), "Conflict");
        assert_eq!(read(&root, "a.md").unwrap(), "theirs");
        // The caller removes the temp file on failure.
        assert!(temp.exists());
    }

    #[test]
    fn create_only_reports_a_failed_fallback_rename() {
        let (_dir, root) = workspace();
        let target = root.join("a.md");
        let temp = temp_path(&target).unwrap();
        // Nothing to rename: the fallback surfaces the I/O error.
        let err = publish_new(&temp, &target, "a.md", unsupported).unwrap_err();
        assert_eq!(err.kind(), "NotFound");
        assert!(!target.exists());
    }

    #[test]
    fn create_only_conflicts_with_an_existing_file() {
        let (_dir, root) = workspace();
        put(&root, "a.md", "theirs");
        let err = write_file(&root, "a.md", "mine", &WriteCondition::CreateOnly).unwrap_err();
        assert_eq!(err.kind(), "Conflict");
        assert_eq!(err.to_string(), "a.md already exists");
        assert_eq!(read(&root, "a.md").unwrap(), "theirs");
        assert!(leftovers(&root).is_empty());
    }

    #[test]
    fn matching_hash_replaces_the_file() {
        let (_dir, root) = workspace();
        put(&root, "a.md", "old");
        let base = read_file(&root, "a.md").unwrap().hash;
        let written =
            write_file(&root, "a.md", "new", &WriteCondition::Matches(base.clone())).unwrap();
        assert_eq!(read(&root, "a.md").unwrap(), "new");
        assert_eq!(written.hash, content_hash(b"new"));
        assert_ne!(written.hash, base);
        // The returned hash is the base for the next conditional write.
        write_file(
            &root,
            "a.md",
            "newer",
            &WriteCondition::Matches(written.hash),
        )
        .unwrap();
        assert_eq!(read(&root, "a.md").unwrap(), "newer");
    }

    #[test]
    fn different_hash_is_a_conflict() {
        let (_dir, root) = workspace();
        put(&root, "a.md", "old");
        let base = read_file(&root, "a.md").unwrap().hash;
        put(&root, "a.md", "changed elsewhere");
        let err = write_file(&root, "a.md", "mine", &WriteCondition::Matches(base)).unwrap_err();
        assert_eq!(err.kind(), "Conflict");
        assert_eq!(err.to_string(), "a.md was changed by another program");
        assert_eq!(read(&root, "a.md").unwrap(), "changed elsewhere");
        assert!(leftovers(&root).is_empty());
        // Hashes are compared exactly.
        let upper = content_hash(b"changed elsewhere").to_uppercase();
        let err = write_file(&root, "a.md", "mine", &WriteCondition::Matches(upper)).unwrap_err();
        assert_eq!(err.kind(), "Conflict");
    }

    #[test]
    fn expected_hash_on_a_missing_file_is_a_conflict() {
        let (_dir, root) = workspace();
        let cond = WriteCondition::Matches(content_hash(b"old"));
        let err = write_file(&root, "p/gone.md", "mine", &cond).unwrap_err();
        assert_eq!(err.kind(), "Conflict");
        assert_eq!(err.to_string(), "p/gone.md was removed by another program");
        assert!(!root.join("p/gone.md").exists());
        assert!(leftovers(&root.join("p")).is_empty());
    }

    #[test]
    fn expected_hash_on_a_file_over_the_limit_is_a_conflict() {
        let (_dir, root) = workspace();
        let limit = usize::try_from(MAX_FILE_SIZE).unwrap();
        let over = "a".repeat(limit + 1);
        fs::write(root.join("big.md"), &over).unwrap();
        let cond = WriteCondition::Matches(content_hash(over.as_bytes()));
        let err = write_file(&root, "big.md", "small", &cond).unwrap_err();
        assert_eq!(err.kind(), "Conflict");
        assert_eq!(
            fs::metadata(root.join("big.md")).unwrap().len(),
            MAX_FILE_SIZE + 1
        );
    }

    #[test]
    fn other_validation_runs_before_the_condition() {
        let (_dir, root) = workspace();
        put(&root, "ro.md", "old");
        let mut perms = fs::metadata(root.join("ro.md")).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(root.join("ro.md"), perms).unwrap();
        let wrong = WriteCondition::Matches("0".repeat(64));
        for cond in [WriteCondition::CreateOnly, wrong.clone()] {
            let err = |rel| write_file(&root, rel, "x", &cond).unwrap_err().kind();
            assert_eq!(err("ro.md"), "PermissionDenied");
            assert_eq!(err("../x.md"), "InvalidPath");
            assert_eq!(err("notes.txt"), "InvalidPath");
        }
        let limit = usize::try_from(MAX_FILE_SIZE).unwrap();
        let over = "a".repeat(limit + 1);
        let err = write_file(&root, "big.md", &over, &wrong).unwrap_err();
        assert_eq!(err.kind(), "TooLarge");
    }

    #[cfg(unix)]
    #[test]
    fn expected_hash_on_an_unreadable_file_reports_the_read_error() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, root) = workspace();
        put(&root, "a.md", "old");
        if crate::test_support::skip_if_privileged("expected_hash_on_an_unreadable_file") {
            return;
        }
        fs::set_permissions(root.join("a.md"), fs::Permissions::from_mode(0o200)).unwrap();
        let cond = WriteCondition::Matches(content_hash(b"old"));
        let result = write_file(&root, "a.md", "new", &cond);
        fs::set_permissions(root.join("a.md"), fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(result.unwrap_err().kind(), "PermissionDenied");
        assert_eq!(read(&root, "a.md").unwrap(), "old");
        assert!(leftovers(&root).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn conditions_apply_to_the_target_of_an_inside_symlink() {
        use std::os::unix::fs::symlink;
        let (_dir, root) = workspace();
        put(&root, "real.md", "old");
        symlink(root.join("real.md"), root.join("link.md")).unwrap();
        let err = write_file(&root, "link.md", "x", &WriteCondition::CreateOnly).unwrap_err();
        assert_eq!(err.kind(), "Conflict");
        assert!(leftovers(&root).is_empty());
        let cond = WriteCondition::Matches(content_hash(b"old"));
        write_file(&root, "link.md", "new", &cond).unwrap();
        assert_eq!(fs::read_to_string(root.join("real.md")).unwrap(), "new");
    }
}
