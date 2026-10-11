//! Project folder operations: renaming, archiving and unarchiving a project
//! (all of them a folder rename) and moving a project to the trash.
//!
//! Like `fs_ops`, everything here is synchronous and free of Tauri types.
//!
//! Only project folders are accepted: a top-level folder (`a`) or an archived
//! project (`_archive/a`). Never the workspace root, `inbox`, `_archive`
//! itself, hidden folders or `node_modules`. A project folder that is itself
//! a link to a folder, or that is reached through one, is refused: renaming
//! or trashing a link could break it or act on what it points to, and the
//! listing does not follow folder links, so the app never shows such a
//! project anyway.

use std::fs;
use std::io;
use std::path::{Component, Path};

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::fs_ops::{self, FileEntry};
use crate::paths;

/// Folder holding archived projects.
pub const ARCHIVE_DIR: &str = "_archive";
/// The default project, which cannot be renamed, archived or deleted.
pub const INBOX_DIR: &str = "inbox";

/// Whether folder names that differ only in letter case count as the same
/// name when checking for conflicts, even on a case-sensitive volume: the
/// workspace may be cloned on a system where they would clash.
const IGNORE_CASE: bool = cfg!(any(target_os = "windows", target_os = "macos"));

/// Result of [`rename_folder`]: every listable Markdown file of the folder at
/// its new path, sorted by path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MovedFolder {
    pub entries: Vec<FileEntry>,
}

/// Checks that `rel` names a project folder: `name` or `_archive/name`,
/// where `name` is neither hidden nor `node_modules`, and a top-level `name`
/// is neither `inbox` nor `_archive` in any letter case.
pub fn ensure_project_folder(rel: &str) -> AppResult<()> {
    paths::validate_relative(rel)?;
    let not_project = || AppError::InvalidPath(format!("{rel} is not a project folder"));
    let name = match rel.split_once('/') {
        None => {
            let key = rel.to_lowercase();
            if key == INBOX_DIR {
                return Err(AppError::InvalidPath(
                    "the inbox cannot be renamed, archived or deleted".into(),
                ));
            }
            if key == ARCHIVE_DIR {
                return Err(not_project());
            }
            rel
        }
        Some((ARCHIVE_DIR, name)) if !name.contains('/') => name,
        Some(_) => return Err(not_project()),
    };
    if fs_ops::is_pruned_name(name) {
        return Err(not_project());
    }
    Ok(())
}

/// Moves the project folder `from` to `to` with a single rename, and returns
/// the listable Markdown files at their new paths.
///
/// Used to rename a project (`a` to `b`), archive it (`a` to `_archive/a`,
/// creating `_archive/` when missing) and unarchive it (`_archive/a` to `a`).
/// Both paths must be project folders (see [`ensure_project_folder`];
/// `InvalidPath` otherwise), so `to` is never inside `from`. A missing
/// `from` is `NotFound`.
///
/// An existing `to` is never replaced (`Conflict`), not even an empty folder,
/// except when it is `from` itself under a different letter case (`a` to
/// `A`), which is a plain rename. On Windows and macOS a folder whose name
/// only differs in letter case from `to` is a `Conflict` too. The rename is
/// race-free where the system can refuse to replace an existing entry
/// (Linux, macOS, Windows); elsewhere a check comes first.
///
/// Links inside the folder are moved as they are. If one is relative and
/// points out of the folder, and the move would make it point somewhere
/// else (archiving adds a folder level), the move is refused with
/// `InvalidPath`. Hidden folders and `node_modules` inside the project are
/// not checked, since the app never reads them.
///
/// A move to another drive or file system is refused with `Io`; nothing is
/// copied.
pub fn rename_folder(root: &Path, from: &str, to: &str) -> AppResult<MovedFolder> {
    rename_folder_with(root, from, to, IGNORE_CASE, rename_no_replace)
}

fn rename_folder_with(
    root: &Path,
    from: &str,
    to: &str,
    ignore_case: bool,
    rename: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> AppResult<MovedFolder> {
    ensure_project_folder(from)?;
    // A project folder is never inside another one, so `to` cannot be
    // inside `from`.
    ensure_project_folder(to)?;
    let from_path = fs_ops::real_folder(root, from, from, true)?;
    let (from_parent, from_name) = fs_ops::split_parent(from);
    let (to_parent, to_name) = fs_ops::split_parent(to);
    let (parent_path, missing) = fs_ops::folder_chain(root, to_parent, to, false)?;
    let to_path = parent_path.join(to_name);
    let same_parent = from_parent == to_parent;

    let mut case_only = false;
    if missing.is_empty() {
        match fs::symlink_metadata(&to_path) {
            Ok(to_meta) => {
                let from_meta = fs::symlink_metadata(&from_path)
                    .map_err(|e| AppError::from_io(&e, "open", from))?;
                case_only = same_parent
                    && fs_ops::is_case_variant(from_name, to_name)
                    && fs_ops::same_entry(&from_meta, &to_meta)
                    // On a case-sensitive file system both names really exist.
                    && !fs_ops::has_entry_named(&parent_path, to_name);
                if !case_only {
                    return Err(AppError::Conflict(format!("{to} already exists")));
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                let own_name = same_parent.then_some(from_name);
                if ignore_case && has_case_variant(&parent_path, to_name, own_name) {
                    return Err(AppError::Conflict(format!(
                        "{to} already exists with different letter case"
                    )));
                }
            }
            Err(e) => return Err(AppError::from_io(&e, "check", to)),
        }
    }
    // On a case-insensitive volume a link through the old name (`../a/x`)
    // still reaches the folder after a case-only rename (`a` to `A`).
    let fold_case = ignore_case && same_parent && fs_ops::is_case_variant(from_name, to_name);
    ensure_links_keep_pointing(&from_path, from, to, fold_case)?;

    let created = fs_ops::create_folders(&missing, to)?;
    let result = if case_only {
        fs::rename(&from_path, &to_path)
    } else {
        rename(&from_path, &to_path)
    };
    if let Err(err) = result {
        fs_ops::remove_empty_folders(&created);
        return Err(fs_ops::move_error(&err, "move", from, to));
    }
    fs_ops::sync_parent(&from_path);
    fs_ops::sync_parent(&to_path);
    Ok(MovedFolder {
        entries: list_folder(root, &to_path),
    })
}

/// Listable Markdown files below `dir`, by the rules of
/// [`fs_ops::list_files`], sorted by path. A folder that cannot be read
/// gives an empty list; the watcher reports the move anyway.
fn list_folder(root: &Path, dir: &Path) -> Vec<FileEntry> {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        fs_ops::walk(root, entries, &mut out);
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// Whether `dir` has an entry whose name equals `name` ignoring case, other
/// than `except`. A folder that cannot be read answers `true`, so nothing
/// that might clash is created.
fn has_case_variant(dir: &Path, name: &str, except: Option<&str>) -> bool {
    let key = name.to_lowercase();
    match fs::read_dir(dir) {
        Ok(entries) => entries.flatten().any(|entry| {
            let entry_name = entry.file_name();
            let entry_name = entry_name.to_string_lossy();
            entry_name.to_lowercase() == key && except != Some(entry_name.as_ref())
        }),
        Err(_) => true,
    }
}

/// Refuses the move of the folder at `from_path` (workspace-relative `from`)
/// to `to` if a relative link inside it would point somewhere else after the
/// move: a link into the folder must reach the same entry at its new place,
/// and a link out of it the same location as before. Absolute links are
/// unaffected. With `fold_case`, names are compared ignoring letter case.
fn ensure_links_keep_pointing(
    from_path: &Path,
    from: &str,
    to: &str,
    fold_case: bool,
) -> AppResult<()> {
    let fold = |parts: Vec<String>| -> Vec<String> {
        if fold_case {
            parts.into_iter().map(|p| p.to_lowercase()).collect()
        } else {
            parts
        }
    };
    let from_parts = fold(from.split('/').map(str::to_owned).collect());
    let to_parts = fold(to.split('/').map(str::to_owned).collect());
    let mut stack = vec![(from_path.to_path_buf(), Vec::<String>::new())];
    while let Some((dir, inner)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if fs_ops::is_pruned_name(name) {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let mut here = inner.clone();
            if file_type.is_symlink() {
                let Ok(target) = fs::read_link(entry.path()) else {
                    continue;
                };
                let before = resolve_lexically(&from_parts, &here, &target).map(fold);
                let after = resolve_lexically(&to_parts, &here, &target).map(fold);
                let moves_along = match (&before, &after) {
                    // Into the folder: must reach the same entry after it moved.
                    (Some(before), Some(after)) if before.starts_with(&from_parts) => {
                        after.starts_with(&to_parts)
                            && before[from_parts.len()..] == after[to_parts.len()..]
                    }
                    // Out of it: must reach the same place, not the moved folder.
                    (Some(before), Some(after)) => before == after && !after.starts_with(&to_parts),
                    _ => true,
                };
                if !moves_along {
                    here.push(name.to_owned());
                    let link = format!("{from}/{}", here.join("/"));
                    return Err(AppError::InvalidPath(format!(
                        "{link} is a relative link that would point somewhere else after the move"
                    )));
                }
            } else if file_type.is_dir() {
                here.push(name.to_owned());
                stack.push((entry.path(), here));
            }
        }
    }
    Ok(())
}

/// Where a relative link target lands, as workspace-relative parts, for a
/// link in the folder `folder/inner…`. `None` for absolute targets (they do
/// not depend on where the link is); a target that climbs above the
/// workspace root keeps the extra `..` parts, so it still differs between
/// two depths.
fn resolve_lexically(folder: &[String], inner: &[String], target: &Path) -> Option<Vec<String>> {
    if target.has_root() || target.is_absolute() {
        return None;
    }
    let mut parts: Vec<String> = folder.to_vec();
    parts.extend(inner.iter().cloned());
    let mut above = 0usize;
    for component in target.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            Component::ParentDir => {
                if parts.pop().is_none() {
                    above += 1;
                }
            }
            Component::CurDir => {}
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    let mut out = vec!["..".to_owned(); above];
    out.extend(parts);
    Some(out)
}

/// Renames `from` to `to`, failing with `AlreadyExists` instead of replacing
/// an existing entry, atomically where the system supports it.
fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    match native_rename_no_replace(from, to) {
        Some(result) => result,
        None => check_then_rename(from, to),
    }
}

/// Renames only if nothing exists at `to`. Another program creating `to`
/// between the check and the rename is not detected; on Unix an empty
/// folder created there in that window would be replaced.
fn check_then_rename(from: &Path, to: &Path) -> io::Result<()> {
    match fs::symlink_metadata(to) {
        Ok(_) => Err(io::Error::from(io::ErrorKind::AlreadyExists)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => fs::rename(from, to),
        Err(e) => Err(e),
    }
}

/// `renameat2(RENAME_NOREPLACE)`. `None` when the kernel or file system does
/// not support it.
#[cfg(target_os = "linux")]
fn native_rename_no_replace(from: &Path, to: &Path) -> Option<io::Result<()>> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let (Ok(from), Ok(to)) = (
        CString::new(from.as_os_str().as_bytes()),
        CString::new(to.as_os_str().as_bytes()),
    ) else {
        return Some(Err(io::Error::from(io::ErrorKind::InvalidInput)));
    };
    // SAFETY: both arguments are valid NUL-terminated strings that outlive
    // the call; the syscall does not keep them.
    let rc = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if rc == 0 {
        return Some(Ok(()));
    }
    let err = io::Error::last_os_error();
    match err.raw_os_error() {
        Some(libc::EINVAL | libc::ENOSYS | libc::EOPNOTSUPP) => None,
        _ => Some(Err(err)),
    }
}

/// `renamex_np(RENAME_EXCL)`. `None` when the file system does not support
/// it.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn native_rename_no_replace(from: &Path, to: &Path) -> Option<io::Result<()>> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let (Ok(from), Ok(to)) = (
        CString::new(from.as_os_str().as_bytes()),
        CString::new(to.as_os_str().as_bytes()),
    ) else {
        return Some(Err(io::Error::from(io::ErrorKind::InvalidInput)));
    };
    // SAFETY: both arguments are valid NUL-terminated strings that outlive
    // the call; the function does not keep them.
    let rc = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    if rc == 0 {
        return Some(Ok(()));
    }
    let err = io::Error::last_os_error();
    match err.raw_os_error() {
        Some(libc::ENOTSUP | libc::EINVAL) => None,
        _ => Some(Err(err)),
    }
}

/// `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING` (an existing target is
/// an error) and without `MOVEFILE_COPY_ALLOWED` (another volume is an
/// error instead of a copy). Paths are passed in extended-length form (see
/// [`extended_length`]), so folders deeper than 260 characters can move.
/// It never answers `None`: there is no check-then-rename fallback here.
#[cfg(windows)]
fn native_rename_no_replace(from: &Path, to: &Path) -> Option<io::Result<()>> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
    let wide = |path: &Path| -> Vec<u16> {
        let mut out = extended_length(&path.as_os_str().encode_wide().collect::<Vec<u16>>());
        out.push(0);
        out
    };
    let (from, to) = (wide(from), wide(to));
    // SAFETY: both arguments are valid NUL-terminated wide strings that
    // outlive the call; the function does not keep them.
    let ok = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) };
    Some(if ok != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    })
}

/// The extended-length form of a Windows path, given as UTF-16, which lifts
/// the 260-character limit of the file APIs:
///
/// - `C:\x` becomes `\\?\C:\x`;
/// - `\\server\share\x` becomes `\\?\UNC\server\share\x`;
/// - `/` is turned into `\` first, since extended-length paths are not
///   normalized by Windows.
///
/// Paths that already start with `\\?\` or `\\.\` are returned as they are.
/// Relative paths, drive-relative paths (`C:x`), rooted paths without a
/// drive (`\x`) and paths with `.` or `..` parts are only normalized for
/// `/`, since the prefix would change their meaning.
#[cfg(any(windows, test))]
fn extended_length(path: &[u16]) -> Vec<u16> {
    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().collect() };
    if path.starts_with(&wide(r"\\?\")) || path.starts_with(&wide(r"\\.\")) {
        return path.to_vec();
    }
    let backslash = u16::from(b'\\');
    let path: Vec<u16> = path
        .iter()
        .map(|&c| if c == u16::from(b'/') { backslash } else { c })
        .collect();
    if path
        .split(|&c| c == backslash)
        .any(|part| part == wide(".") || part == wide(".."))
    {
        return path;
    }
    let is_letter = |c: u16| u8::try_from(c).is_ok_and(|b| b.is_ascii_alphabetic());
    let (prefix, rest) = match path.as_slice() {
        [drive, colon, sep, ..]
            if is_letter(*drive) && *colon == u16::from(b':') && *sep == backslash =>
        {
            (wide(r"\\?\"), path.as_slice())
        }
        [a, b, c, rest @ ..] if *a == backslash && *b == backslash && *c != backslash => {
            let mut unc = wide(r"\\?\UNC\");
            unc.push(*c);
            (unc, rest)
        }
        _ => return path,
    };
    let mut out = prefix;
    out.extend_from_slice(rest);
    out
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "ios", windows)))]
fn native_rename_no_replace(_from: &Path, _to: &Path) -> Option<io::Result<()>> {
    None
}

/// Start of the `Io` message [`delete_folder`] returns when the system trash
/// cannot be used. The frontend matches on it, so it must not change.
pub const TRASH_UNAVAILABLE_PREFIX: &str = "The system trash is not available for this folder";

/// Moves the project folder `rel` to the OS trash (see
/// [`ensure_project_folder`] for which folders are accepted). There is no
/// hash precondition: the app asks the user first.
///
/// A project is never removed permanently. Unlike notes in
/// [`fs_ops::delete_file`], when the trash folders themselves cannot be used
/// (Linux and other freedesktop systems) the folder is kept and the result
/// is `Io` with a message starting with [`TRASH_UNAVAILABLE_PREFIX`]. Any
/// other trash failure is reported as well and the folder is left in place.
pub fn delete_folder(root: &Path, rel: &str) -> AppResult<()> {
    delete_folder_with(root, rel, fs_ops::move_to_os_trash)
}

fn delete_folder_with(
    root: &Path,
    rel: &str,
    move_to_trash: impl FnOnce(&Path) -> Result<(), trash::Error>,
) -> AppResult<()> {
    ensure_project_folder(rel)?;
    let path = fs_ops::real_folder(root, rel, rel, true)?;
    match move_to_trash(&path) {
        Ok(()) => Ok(()),
        Err(err) if fs_ops::trash_unavailable(&err, &path) => Err(AppError::Io(format!(
            "{TRASH_UNAVAILABLE_PREFIX}; {rel} was not deleted"
        ))),
        Err(err) => Err(fs_ops::trash_failure(&err, &path, rel)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::path::PathBuf;
    use tempfile::TempDir;

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

    fn listed(root: &Path) -> Vec<String> {
        fs_ops::list_files(root)
            .unwrap()
            .into_iter()
            .map(|e| e.path)
            .collect()
    }

    fn paths_of(moved: &MovedFolder) -> Vec<&str> {
        moved.entries.iter().map(|e| e.path.as_str()).collect()
    }

    fn rename(root: &Path, from: &str, to: &str) -> AppResult<MovedFolder> {
        rename_folder_with(root, from, to, false, rename_no_replace)
    }

    fn rename_kind(root: &Path, from: &str, to: &str) -> &'static str {
        rename(root, from, to).unwrap_err().kind()
    }

    #[test]
    fn project_folders() {
        for ok in [
            "a",
            "My project",
            "_archive/a",
            "_archive/inbox",
            "a.md",
            "_x",
        ] {
            assert_eq!(ensure_project_folder(ok), Ok(()), "{ok}");
        }
        for bad in [
            "",
            "/a",
            "../a",
            "a/",
            "a/b",
            "_archive/a/b",
            "_archive",
            "_ARCHIVE",
            "_archive/.hidden",
            "_archive/node_modules",
            ".git",
            ".kaido",
            ".hidden",
            "node_modules",
            "other/a",
            "inbox",
            "Inbox",
        ] {
            assert_eq!(
                ensure_project_folder(bad).unwrap_err().kind(),
                "InvalidPath",
                "{bad}"
            );
        }
        assert_eq!(
            ensure_project_folder("INBOX").unwrap_err().to_string(),
            "the inbox cannot be renamed, archived or deleted"
        );
        assert_eq!(
            ensure_project_folder("a/b").unwrap_err().to_string(),
            "a/b is not a project folder"
        );
    }

    #[test]
    fn renames_a_project_and_returns_its_notes() {
        let (_dir, root) = workspace();
        put(&root, "a/tasks.md", "- [ ] t");
        put(&root, "a/note.md", "body");
        put(&root, "a/sub/deep.MD", "x");
        put(&root, "a/image.png", "x");
        put(&root, "a/.hidden/h.md", "x");
        put(&root, "a/node_modules/m.md", "x");
        put(&root, "other/keep.md", "x");
        let moved = rename(&root, "a", "b").unwrap();
        assert_eq!(
            paths_of(&moved),
            ["b/note.md", "b/sub/deep.MD", "b/tasks.md"]
        );
        assert_eq!(moved.entries[0].size, 4);
        assert!(moved.entries[0].modified > 0);
        assert!(!root.join("a").exists());
        assert!(root.join("b/image.png").exists());
        assert!(root.join("b/.hidden/h.md").exists());
        assert_eq!(
            listed(&root),
            ["b/note.md", "b/sub/deep.MD", "b/tasks.md", "other/keep.md"]
        );
        let json = serde_json::to_value(&moved).unwrap();
        assert_eq!(json["entries"][0]["path"], "b/note.md");
        assert_eq!(json["entries"][0]["size"], 4);
        assert_eq!(json.as_object().unwrap().len(), 1);
    }

    #[test]
    fn archives_and_unarchives_a_project() {
        let (_dir, root) = workspace();
        put(&root, "a/n.md", "x");
        put(&root, "c/n.md", "x");
        let archived = rename(&root, "a", "_archive/a").unwrap();
        assert_eq!(paths_of(&archived), ["_archive/a/n.md"]);
        assert!(root.join("_archive").is_dir());
        // `_archive/` already exists the second time.
        rename(&root, "c", "_archive/c").unwrap();
        // An archived project can be renamed in place.
        rename(&root, "_archive/c", "_archive/d").unwrap();
        let back = rename(&root, "_archive/a", "a").unwrap();
        assert_eq!(paths_of(&back), ["a/n.md"]);
        assert_eq!(listed(&root), ["_archive/d/n.md", "a/n.md"]);
        assert!(root.join("_archive").is_dir());
        // An empty project folder moves too.
        fs::create_dir(root.join("empty")).unwrap();
        assert!(rename(&root, "empty", "full").unwrap().entries.is_empty());
    }

    #[test]
    fn never_replaces_an_existing_entry() {
        let (_dir, root) = workspace();
        put(&root, "a/n.md", "mine");
        put(&root, "full/n.md", "theirs");
        fs::create_dir(root.join("empty")).unwrap();
        put(&root, "file", "x");
        put(&root, "_archive/a/old.md", "x");
        for to in ["full", "empty", "file", "_archive/a", "a"] {
            let err = rename(&root, "a", to).unwrap_err();
            assert_eq!(err.kind(), "Conflict", "{to}");
            assert_eq!(err.to_string(), format!("{to} already exists"));
        }
        assert_eq!(fs::read_to_string(root.join("a/n.md")).unwrap(), "mine");
        assert!(root.join("empty").is_dir());
        assert_eq!(
            fs::read_to_string(root.join("full/n.md")).unwrap(),
            "theirs"
        );
    }

    #[test]
    fn the_atomic_rename_refuses_an_empty_folder_that_appeared() {
        // A plain rename would silently replace an empty folder.
        let (_dir, root) = workspace();
        put(&root, "a/n.md", "x");
        fs::create_dir(root.join("b")).unwrap();
        let err = rename_no_replace(&root.join("a"), &root.join("b")).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert!(root.join("a/n.md").exists());
        rename_no_replace(&root.join("a"), &root.join("c")).unwrap();
        assert!(root.join("c/n.md").exists());
    }

    #[test]
    fn check_then_rename_without_native_support() {
        let (_dir, root) = workspace();
        put(&root, "a/n.md", "x");
        fs::create_dir(root.join("b")).unwrap();
        let err = check_then_rename(&root.join("a"), &root.join("b")).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        check_then_rename(&root.join("a"), &root.join("c")).unwrap();
        assert!(root.join("c/n.md").exists());
        let err = check_then_rename(&root.join("c"), &root.join("file/x")).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn extended_length_paths() {
        let ext = |path: &str| -> String {
            let wide: Vec<u16> = path.encode_utf16().collect();
            String::from_utf16(&extended_length(&wide)).unwrap()
        };
        assert_eq!(ext(r"C:\Users\me\notes\a"), r"\\?\C:\Users\me\notes\a");
        assert_eq!(ext(r"d:\a"), r"\\?\d:\a");
        assert_eq!(ext("C:/Users/me/a"), r"\\?\C:\Users\me\a");
        assert_eq!(ext(r"\\server\share\a"), r"\\?\UNC\server\share\a");
        assert_eq!(ext("//server/share/a"), r"\\?\UNC\server\share\a");
        // Already extended or a device path: unchanged.
        assert_eq!(ext(r"\\?\C:\a"), r"\\?\C:\a");
        assert_eq!(ext(r"\\?\UNC\server\share"), r"\\?\UNC\server\share");
        assert_eq!(ext(r"\\.\C:\a"), r"\\.\C:\a");
        // Not absolute, or not safe to prefix: unchanged.
        for same in [
            r"a\b",
            r"C:a",
            r"\a",
            r"\\\a",
            r"C:\a\..\b",
            r"C:\.\a",
            "",
            "1:\\a",
        ] {
            assert_eq!(ext(same), same, "{same}");
        }
        assert_eq!(ext(r"C:\a\..b"), r"\\?\C:\a\..b");
        // A path over 260 characters keeps every character.
        let long = format!(r"C:\{}", "x".repeat(300));
        assert_eq!(ext(&long), format!(r"\\?\{long}"));
    }

    #[test]
    fn letter_case_conflicts() {
        let (_dir, root) = workspace();
        put(&root, "a/n.md", "x");
        put(&root, "B/n.md", "x");
        put(&root, "_archive/A/n.md", "x");
        let strict =
            |from: &str, to: &str| rename_folder_with(&root, from, to, true, rename_no_replace);
        let err = strict("a", "b").unwrap_err();
        assert_eq!(err.kind(), "Conflict");
        assert_eq!(
            err.to_string(),
            "b already exists with different letter case"
        );
        assert_eq!(strict("a", "_archive/a").unwrap_err().kind(), "Conflict");
        // Its own name is not a clash: a case-only rename.
        assert_eq!(paths_of(&strict("a", "A").unwrap()), ["A/n.md"]);
        // On a case-sensitive volume, without the extra check, both exist.
        rename(&root, "A", "b").unwrap();
        assert_eq!(listed(&root), ["B/n.md", "_archive/A/n.md", "b/n.md"]);
        assert!(has_case_variant(&root.join("missing"), "x", None));
        assert!(has_case_variant(&root, "b", Some("B")));
        assert!(!has_case_variant(&root, "c", None));
    }

    #[test]
    fn case_only_rename_on_a_case_sensitive_file_system() {
        let (_dir, root) = workspace();
        put(&root, "proj/n.md", "x");
        assert_eq!(
            paths_of(&rename(&root, "proj", "Proj").unwrap()),
            ["Proj/n.md"]
        );
        assert_eq!(rename_kind(&root, "Proj", "Proj"), "Conflict");
    }

    #[test]
    fn refuses_special_and_malformed_folders() {
        let (_dir, root) = workspace();
        for dir in [
            "inbox",
            "_archive/x",
            ".git",
            ".kaido",
            "node_modules",
            "a/b",
        ] {
            put(&root, &format!("{dir}/n.md"), "x");
        }
        for (from, to) in [
            ("inbox", "b"),
            ("a", "inbox"),
            ("_archive", "b"),
            ("a", "_archive"),
            (".git", "b"),
            (".kaido", "b"),
            ("a", ".b"),
            ("node_modules", "b"),
            ("a/b", "c"),
            ("a", "a/c"),
            ("a", "_archive/a/c"),
            ("a", ""),
            ("", "a"),
            ("../a", "b"),
            ("a", "/tmp/x"),
        ] {
            assert_eq!(
                rename_kind(&root, from, to),
                "InvalidPath",
                "{from} -> {to}"
            );
        }
        for dir in [
            "inbox",
            "_archive/x",
            ".git",
            ".kaido",
            "node_modules",
            "a/b",
        ] {
            assert!(root.join(dir).join("n.md").exists(), "{dir}");
        }
    }

    #[test]
    fn reports_missing_and_non_folder_sources() {
        let (_dir, root) = workspace();
        put(&root, "file", "x");
        put(&root, "_archive", "not a folder");
        let err = rename(&root, "gone", "b").unwrap_err();
        assert_eq!(err.kind(), "NotFound");
        assert_eq!(err.to_string(), "gone was not found");
        assert_eq!(rename_kind(&root, "_archive/gone", "b"), "NotADirectory");
        let err = rename(&root, "file", "b").unwrap_err();
        assert_eq!(err.kind(), "NotADirectory");
        assert_eq!(err.to_string(), "file is not a folder");
        fs::create_dir(root.join("a")).unwrap();
        let err = rename(&root, "a", "_archive/a").unwrap_err();
        assert_eq!(err.kind(), "NotADirectory");
        assert_eq!(err.to_string(), "a parent of _archive/a is not a folder");
        assert!(root.join("a").is_dir());
    }

    #[test]
    fn a_failed_move_removes_the_archive_folder_it_created() {
        let (_dir, root) = workspace();
        put(&root, "a/n.md", "x");
        let cross = |_: &Path, _: &Path| Err(io::Error::from(io::ErrorKind::CrossesDevices));
        let err = rename_folder_with(&root, "a", "_archive/a", false, cross).unwrap_err();
        assert_eq!(err.kind(), "Io");
        assert_eq!(
            err.to_string(),
            "could not move a to _archive/a: they are on different drives or file systems"
        );
        assert!(!root.join("_archive").exists());
        // Something created at `to` right before the rename wins.
        let race = |_: &Path, to: &Path| {
            fs::create_dir(to)?;
            Err(io::Error::from(io::ErrorKind::AlreadyExists))
        };
        let err = rename_folder_with(&root, "a", "_archive/a", false, race).unwrap_err();
        assert_eq!(err, AppError::Conflict("_archive/a already exists".into()));
        // Not empty any more, so it stays.
        assert!(root.join("_archive/a").is_dir());
        assert!(root.join("a/n.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn renaming_in_a_read_only_folder_is_permission_denied() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, root) = workspace();
        put(&root, "a/n.md", "x");
        if crate::test_support::skip_if_privileged("renaming_in_a_read_only_folder") {
            return;
        }
        fs::set_permissions(&root, fs::Permissions::from_mode(0o500)).unwrap();
        let renamed = rename(&root, "a", "b");
        let archived = rename(&root, "a", "_archive/a");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(renamed.unwrap_err().kind(), "PermissionDenied");
        assert_eq!(archived.unwrap_err().kind(), "PermissionDenied");
        assert_eq!(listed(&root), ["a/n.md"]);
    }

    #[cfg(unix)]
    #[test]
    fn checking_the_destination_reports_access_errors() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, root) = workspace();
        put(&root, "_archive/a/n.md", "x");
        put(&root, "b/n.md", "x");
        if crate::test_support::skip_if_privileged("checking_the_destination") {
            return;
        }
        // Listable but not searchable: its entries cannot be checked.
        fs::set_permissions(root.join("_archive"), fs::Permissions::from_mode(0o600)).unwrap();
        let result = rename(&root, "b", "_archive/b");
        fs::set_permissions(root.join("_archive"), fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(result.unwrap_err().kind(), "PermissionDenied");
        assert!(root.join("b/n.md").exists());
    }

    #[test]
    fn unreadable_folders_list_nothing() {
        let (_dir, root) = workspace();
        assert!(list_folder(&root, &root.join("missing")).is_empty());
    }

    #[test]
    fn resolves_relative_link_targets_lexically() {
        let parts = |s: &str| -> Vec<String> { s.split('/').map(str::to_owned).collect() };
        let inner = |s: &[&str]| -> Vec<String> { s.iter().map(|p| (*p).to_owned()).collect() };
        let resolve = |folder: &str, within: &[&str], target: &str| {
            resolve_lexically(&parts(folder), &inner(within), Path::new(target))
                .map(|p| p.join("/"))
        };
        assert_eq!(resolve("a", &[], "x.md").as_deref(), Some("a/x.md"));
        assert_eq!(resolve("a", &["s"], "../x.md").as_deref(), Some("a/x.md"));
        assert_eq!(resolve("a", &[], "./../b/x.md").as_deref(), Some("b/x.md"));
        assert_eq!(resolve("a", &[], "../../x.md").as_deref(), Some("../x.md"));
        assert_eq!(
            resolve("_archive/a", &[], "../../../x.md").as_deref(),
            Some("../x.md")
        );
        assert_eq!(resolve("a", &[], "/etc/x.md"), None);
    }

    #[cfg(unix)]
    mod links {
        use super::*;
        use std::os::unix::fs::symlink;

        #[test]
        fn refuses_linked_project_folders() {
            let (_dir, root) = workspace();
            let (_outside_dir, outside) = workspace();
            put(&outside, "n.md", "x");
            put(&root, "real/n.md", "x");
            symlink(&outside, root.join("out")).unwrap();
            symlink(root.join("real"), root.join("alias")).unwrap();
            let err = rename(&root, "out", "b").unwrap_err();
            assert_eq!(err.kind(), "InvalidPath");
            assert_eq!(
                err.to_string(),
                "out is a link to a folder, which the app does not follow"
            );
            assert_eq!(rename_kind(&root, "alias", "b"), "InvalidPath");
            assert_eq!(rename_kind(&root, "alias", "_archive/alias"), "InvalidPath");
            assert!(
                fs::symlink_metadata(root.join("out"))
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
            assert!(outside.join("n.md").exists());
            assert!(!root.join("_archive").exists());
        }

        #[test]
        fn refuses_a_linked_archive_folder() {
            let (_dir, root) = workspace();
            let (_outside_dir, outside) = workspace();
            put(&root, "a/n.md", "x");
            put(&outside, "b/n.md", "x");
            symlink(&outside, root.join("_archive")).unwrap();
            let err = rename(&root, "a", "_archive/a").unwrap_err();
            assert_eq!(err.kind(), "InvalidPath");
            assert_eq!(
                err.to_string(),
                "_archive/a is inside a linked folder, which the app does not follow"
            );
            assert_eq!(rename_kind(&root, "_archive/b", "b"), "InvalidPath");
            assert!(root.join("a/n.md").exists());
            assert!(!outside.join("a").exists());
            assert!(outside.join("b/n.md").exists());
        }

        #[test]
        fn links_inside_move_with_the_folder() {
            let (_dir, root) = workspace();
            let (_outside_dir, outside) = workspace();
            put(&outside, "secret.md", "s");
            put(&root, "a/real.md", "r");
            put(&root, "a/sub/x.md", "x");
            symlink("real.md", root.join("a/inside.md")).unwrap();
            symlink("../real.md", root.join("a/sub/up.md")).unwrap();
            symlink(outside.join("secret.md"), root.join("a/absolute.md")).unwrap();
            symlink("../a/real.md", root.join("a/via-name.md")).unwrap();
            let moved = rename(&root, "a", "_archive/a").unwrap();
            // Links outside the workspace are moved, never listed or followed.
            assert_eq!(
                paths_of(&moved),
                [
                    "_archive/a/inside.md",
                    "_archive/a/real.md",
                    "_archive/a/sub/up.md",
                    "_archive/a/sub/x.md",
                    "_archive/a/via-name.md",
                ]
            );
            for link in ["inside.md", "sub/up.md", "absolute.md", "via-name.md"] {
                let path = root.join("_archive/a").join(link);
                assert!(
                    fs::symlink_metadata(&path)
                        .unwrap()
                        .file_type()
                        .is_symlink()
                );
            }
            assert_eq!(
                fs::read_to_string(root.join("_archive/a/sub/up.md")).unwrap(),
                "r"
            );
            assert_eq!(fs::read_to_string(outside.join("secret.md")).unwrap(), "s");
        }

        #[test]
        fn refuses_moves_that_change_where_a_relative_link_points() {
            let (_dir, root) = workspace();
            put(&root, "a/n.md", "x");
            put(&root, "b/target.md", "t");
            symlink("../b/target.md", root.join("a/sibling.md")).unwrap();
            let err = rename(&root, "a", "_archive/a").unwrap_err();
            assert_eq!(err.kind(), "InvalidPath");
            assert_eq!(
                err.to_string(),
                "a/sibling.md is a relative link that would point somewhere else after the move"
            );
            assert!(root.join("a/n.md").exists());
            assert!(!root.join("_archive").exists());
            // At the same depth it keeps pointing to the same place.
            let moved = rename(&root, "a", "c").unwrap();
            assert_eq!(paths_of(&moved), ["c/n.md", "c/sibling.md"]);
            // Folder links are checked too, also in subfolders.
            fs::remove_file(root.join("c/sibling.md")).unwrap();
            fs::create_dir(root.join("c/sub")).unwrap();
            symlink("../../b", root.join("c/sub/dir")).unwrap();
            let err = rename(&root, "c", "_archive/c").unwrap_err();
            assert_eq!(
                err.to_string(),
                "c/sub/dir is a relative link that would point somewhere else after the move"
            );
            // A dangling link that would reach the moved folder: refused.
            symlink("../e/n.md", root.join("c/later.md")).unwrap();
            assert_eq!(rename_kind(&root, "c", "e"), "InvalidPath");
            fs::remove_file(root.join("c/later.md")).unwrap();
            // A link to its own old name breaks: refused as well.
            fs::remove_file(root.join("c/sub/dir")).unwrap();
            symlink("../c/n.md", root.join("c/self.md")).unwrap();
            assert_eq!(rename_kind(&root, "c", "d"), "InvalidPath");
        }

        #[test]
        fn case_only_rename_keeps_links_through_the_old_name_when_case_is_ignored() {
            // Regression: on Windows and macOS a link like `../a/x.md` was
            // treated as broken by renaming `a` to `A`.
            let (_dir, root) = workspace();
            put(&root, "a/x.md", "x");
            put(&root, "b/t.md", "t");
            symlink("../a/x.md", root.join("a/self.md")).unwrap();
            symlink("../b/t.md", root.join("a/sibling.md")).unwrap();
            let insensitive =
                |from: &str, to: &str| rename_folder_with(&root, from, to, true, rename_no_replace);
            // Case-sensitive: the link to the old name would break.
            assert_eq!(rename_kind(&root, "a", "A"), "InvalidPath");
            // Only the case-only rename of the same folder folds case.
            assert_eq!(insensitive("a", "c").unwrap_err().kind(), "InvalidPath");
            assert_eq!(
                insensitive("a", "_archive/A").unwrap_err().kind(),
                "InvalidPath"
            );
            // The test volume is case-sensitive, so `A/self.md` now dangles and
            // is not listed; on a case-insensitive one it reaches `A/x.md`.
            assert_eq!(
                paths_of(&insensitive("a", "A").unwrap()),
                ["A/sibling.md", "A/x.md"]
            );
            assert!(
                fs::symlink_metadata(root.join("A/self.md"))
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
            // Back to the old name, folding case again.
            assert_eq!(
                paths_of(&insensitive("A", "a").unwrap()),
                ["a/self.md", "a/sibling.md", "a/x.md"]
            );
        }

        #[test]
        fn links_in_hidden_folders_are_not_checked() {
            let (_dir, root) = workspace();
            put(&root, "a/n.md", "x");
            fs::create_dir_all(root.join("a/.git")).unwrap();
            fs::create_dir_all(root.join("a/node_modules")).unwrap();
            symlink("../../b", root.join("a/.git/up")).unwrap();
            symlink("../../b", root.join("a/node_modules/up")).unwrap();
            rename(&root, "a", "_archive/a").unwrap();
            assert!(root.join("_archive/a/n.md").exists());
        }
    }

    // Delete.

    fn trash_ok(_: &Path) -> Result<(), trash::Error> {
        Ok(())
    }

    /// Stands in for the OS trash: removes the folder like a move would.
    fn trash_by_removing(path: &Path) -> Result<(), trash::Error> {
        fs::remove_dir_all(path).map_err(|e| trash::Error::Unknown {
            description: e.to_string(),
        })
    }

    #[test]
    fn deletes_a_project_folder() {
        let (_dir, root) = workspace();
        put(&root, "a/n.md", "x");
        put(&root, "a/sub/m.md", "x");
        put(&root, "_archive/b/n.md", "x");
        let handed = std::cell::RefCell::new(Vec::new());
        let trash = |path: &Path| {
            handed.borrow_mut().push(path.to_path_buf());
            trash_by_removing(path)
        };
        delete_folder_with(&root, "a", trash).unwrap();
        delete_folder_with(&root, "_archive/b", trash_by_removing).unwrap();
        assert_eq!(*handed.borrow(), [root.join("a")]);
        assert!(listed(&root).is_empty());
        assert!(root.join("_archive").is_dir());
    }

    #[test]
    fn delete_refusals() {
        let (_dir, root) = workspace();
        for dir in ["inbox", "_archive/x", ".git", "node_modules", "p/sub"] {
            put(&root, &format!("{dir}/n.md"), "x");
        }
        put(&root, "file", "x");
        let called = Cell::new(false);
        let kind = |rel: &str| {
            delete_folder_with(&root, rel, |_| {
                called.set(true);
                Ok(())
            })
            .unwrap_err()
            .kind()
        };
        for rel in [
            "inbox",
            "Inbox",
            "_archive",
            ".git",
            "node_modules",
            "p/sub",
            "",
            "../x",
        ] {
            assert_eq!(kind(rel), "InvalidPath", "{rel}");
        }
        assert_eq!(kind("missing"), "NotFound");
        assert_eq!(kind("file"), "NotADirectory");
        assert!(!called.get());
    }

    #[cfg(unix)]
    #[test]
    fn delete_refuses_linked_project_folders() {
        use std::os::unix::fs::symlink;
        let (_dir, root) = workspace();
        let (_outside_dir, outside) = workspace();
        put(&outside, "n.md", "x");
        symlink(&outside, root.join("out")).unwrap();
        symlink(&outside, root.join("_archive")).unwrap();
        for rel in ["out", "_archive/x"] {
            let err = delete_folder_with(&root, rel, trash_ok).unwrap_err();
            assert_eq!(err.kind(), "InvalidPath", "{rel}");
        }
        assert!(outside.join("n.md").exists());
    }

    #[test]
    fn other_trash_errors_keep_the_folder() {
        let (_dir, root) = workspace();
        put(&root, "a/n.md", "x");
        let err = delete_folder_with(&root, "a", |_| {
            Err(trash::Error::Unknown {
                description: "/abs/path: no trash".into(),
            })
        })
        .unwrap_err();
        assert_eq!(err.kind(), "Io");
        assert_eq!(err.to_string(), "could not move a to the trash");
        assert!(root.join("a/n.md").exists());
    }

    #[cfg(all(
        unix,
        not(target_os = "macos"),
        not(target_os = "ios"),
        not(target_os = "android")
    ))]
    mod freedesktop {
        use super::*;
        use std::os::unix::fs::symlink;

        fn unavailable(_: &Path) -> Result<(), trash::Error> {
            Err(trash::Error::FileSystem {
                path: PathBuf::from("/home/u/.local/share/Trash/files"),
                source: io::Error::from(io::ErrorKind::PermissionDenied),
            })
        }

        #[test]
        fn keeps_the_folder_when_the_trash_cannot_be_used() {
            // Regression: a project used to be removed permanently here while
            // the app said it went to the trash.
            let (_dir, root) = workspace();
            let (_outside_dir, outside) = workspace();
            put(&outside, "secret.md", "s");
            put(&root, "a/n.md", "x");
            put(&root, "_archive/b/n.md", "x");
            symlink(&outside, root.join("a/out")).unwrap();
            for rel in ["a", "_archive/b"] {
                let err = delete_folder_with(&root, rel, unavailable).unwrap_err();
                assert_eq!(err.kind(), "Io", "{rel}");
                assert!(
                    err.to_string().starts_with(TRASH_UNAVAILABLE_PREFIX),
                    "{rel}"
                );
                assert_eq!(
                    err.to_string(),
                    format!(
                        "The system trash is not available for this folder; {rel} was not deleted"
                    )
                );
                assert!(root.join(rel).join("n.md").exists(), "{rel}");
            }
            assert!(root.join("a/out").exists());
            assert_eq!(fs::read_to_string(outside.join("secret.md")).unwrap(), "s");
            let json =
                serde_json::to_value(delete_folder_with(&root, "a", unavailable).unwrap_err())
                    .unwrap();
            assert_eq!(json["kind"], "Io");
            assert_eq!(
                json["message"],
                "The system trash is not available for this folder; a was not deleted"
            );
        }

        #[test]
        fn errors_about_the_folder_keep_it() {
            let (_dir, root) = workspace();
            put(&root, "a/n.md", "x");
            let err = delete_folder_with(&root, "a", |path| {
                Err(trash::Error::FileSystem {
                    path: path.to_path_buf(),
                    source: io::Error::from(io::ErrorKind::PermissionDenied),
                })
            })
            .unwrap_err();
            assert_eq!(err.kind(), "PermissionDenied");
            assert!(root.join("a/n.md").exists());
        }
    }
}
