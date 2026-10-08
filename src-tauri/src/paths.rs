//! Path confinement.
//!
//! Every path received from the frontend is relative to the workspace root and
//! `/`-separated. These helpers validate that form and resolve it to an
//! absolute path that is guaranteed (at resolution time) to stay inside the
//! canonical workspace root, following symlinks of the parts that exist.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use crate::error::{AppError, AppResult};

/// Canonicalizes the folder chosen as workspace root.
///
/// The path must be absolute and point to an existing directory.
pub fn canonical_root(path: &str) -> AppResult<PathBuf> {
    if path.is_empty() || path.contains('\0') {
        return Err(AppError::InvalidPath(
            "the workspace path is not valid".into(),
        ));
    }
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(AppError::InvalidPath(
            "the workspace path must be absolute".into(),
        ));
    }
    let root = dunce::canonicalize(path)
        .map_err(|e| AppError::from_io(&e, "open", "the workspace folder"))?;
    if !root.is_dir() {
        return Err(AppError::NotADirectory(
            "the workspace path is not a folder".into(),
        ));
    }
    Ok(root)
}

/// Validates a workspace-relative path and returns it as a relative `PathBuf`.
///
/// Rejected: empty paths, NUL bytes, backslashes, absolute paths, empty
/// segments (`a//b`, trailing `/`), `.` and `..` segments and, on Windows,
/// drive or stream separators (`:`).
pub fn validate_relative(rel: &str) -> AppResult<PathBuf> {
    let invalid = |why: &str| Err(AppError::InvalidPath(format!("invalid path: {why}")));
    if rel.is_empty() {
        return invalid("the path is empty");
    }
    if rel.contains('\0') {
        return invalid("the path contains a NUL byte");
    }
    if rel.contains('\\') {
        return invalid("use '/' as the path separator");
    }
    if rel.starts_with('/') || Path::new(rel).has_root() {
        return invalid("the path must be relative to the workspace");
    }
    let mut out = PathBuf::new();
    for segment in rel.split('/') {
        match segment {
            "" => return invalid("the path contains an empty segment"),
            "." | ".." => return invalid("'.' and '..' are not allowed"),
            _ => {}
        }
        if cfg!(windows) && segment.contains(':') {
            return invalid("':' is not allowed");
        }
        out.push(segment);
    }
    // Defense in depth: the loop above only lets plain names through.
    if !out.components().all(|c| matches!(c, Component::Normal(_))) {
        return invalid("the path must be relative to the workspace");
    }
    Ok(out)
}

/// Converts an absolute path inside `root` to the `/`-separated relative form
/// used over IPC. Returns `None` for paths outside `root`, the root itself and
/// non-UTF-8 paths.
pub fn to_relative(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for component in rel.components() {
        match component {
            Component::Normal(name) => parts.push(name.to_str()?),
            _ => return None,
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

fn ensure_inside(root: &Path, resolved: &Path, rel: &str) -> AppResult<()> {
    if resolved.starts_with(root) {
        Ok(())
    } else {
        Err(AppError::OutsideWorkspace(format!(
            "{rel} points outside the workspace"
        )))
    }
}

fn canonicalize_existing(path: &Path, action: &str, rel: &str) -> AppResult<PathBuf> {
    dunce::canonicalize(path).map_err(|e| {
        if e.kind() == io::ErrorKind::NotFound && is_symlink(path) {
            AppError::InvalidPath(format!("{rel} is a link to a missing location"))
        } else {
            AppError::from_io(&e, action, rel)
        }
    })
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

/// Resolves a relative path that must already exist (for reading).
///
/// `root` must be canonical (see [`canonical_root`]).
pub fn resolve_existing(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let rel_path = validate_relative(rel)?;
    let resolved = canonicalize_existing(&root.join(rel_path), "open", rel)?;
    ensure_inside(root, &resolved, rel)?;
    Ok(resolved)
}

/// Resolves a relative path for writing. The target and its parents may not
/// exist yet; the deepest existing ancestor is canonicalized (following
/// symlinks) and must lie inside `root`. If the target exists and is a
/// symlink, the returned path is the link's resolved target, which must also
/// be inside `root`.
///
/// `root` must be canonical (see [`canonical_root`]).
pub fn resolve_for_write(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let rel_path = validate_relative(rel)?;
    let full = root.join(&rel_path);

    match fs::symlink_metadata(&full) {
        Ok(_) => {
            let resolved = canonicalize_existing(&full, "write", rel)?;
            ensure_inside(root, &resolved, rel)?;
            if resolved.is_dir() {
                return Err(AppError::InvalidPath(format!(
                    "{rel} is a folder, not a file"
                )));
            }
            return Ok(resolved);
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(AppError::from_io(&e, "write", rel)),
    }

    // Walk up to the deepest ancestor that exists. `root` exists, so the
    // walk always ends inside the workspace.
    let mut ancestor = full.as_path();
    loop {
        ancestor = match ancestor.parent() {
            Some(parent) => parent,
            None => {
                return Err(AppError::NotFound(
                    "the workspace folder was not found".into(),
                ));
            }
        };
        match fs::symlink_metadata(ancestor) {
            Ok(_) => break,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(AppError::from_io(&e, "write", rel)),
        }
    }

    let resolved_ancestor = canonicalize_existing(ancestor, "write", rel)?;
    ensure_inside(root, &resolved_ancestor, rel)?;
    if !resolved_ancestor.is_dir() {
        return Err(AppError::NotADirectory(format!(
            "a parent of {rel} is not a folder"
        )));
    }
    let remainder = full
        .strip_prefix(ancestor)
        .map_err(|_| AppError::InvalidPath(format!("invalid path: {rel}")))?;
    Ok(resolved_ancestor.join(remainder))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn workspace() -> (TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        (dir, root)
    }

    fn kind<T: std::fmt::Debug>(r: AppResult<T>) -> &'static str {
        r.unwrap_err().kind()
    }

    #[test]
    fn accepts_plain_relative_paths() {
        assert_eq!(validate_relative("a.md").unwrap(), PathBuf::from("a.md"));
        assert_eq!(
            validate_relative("proj/sub/a.md").unwrap(),
            Path::new("proj").join("sub").join("a.md")
        );
        assert!(validate_relative(".kaido/config.json").is_ok());
        assert!(validate_relative("..notes.md").is_ok());
    }

    #[test]
    fn rejects_malformed_relative_paths() {
        for bad in [
            "",
            "/etc/passwd",
            "/",
            "..",
            "../a.md",
            "a/../../b.md",
            "a/..",
            "./a.md",
            "a/./b.md",
            "a//b.md",
            "a/",
            "a\0b.md",
            "a\\b.md",
            "..\\a.md",
        ] {
            assert_eq!(kind(validate_relative(bad)), "InvalidPath", "{bad:?}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn rejects_drive_and_stream_syntax_on_windows() {
        for bad in ["C:/x.md", "C:x.md", "a.md:stream"] {
            assert_eq!(kind(validate_relative(bad)), "InvalidPath", "{bad:?}");
        }
    }

    #[test]
    fn canonical_root_requires_existing_absolute_dir() {
        let (_dir, root) = workspace();
        assert_eq!(canonical_root(root.to_str().unwrap()).unwrap(), root);
        assert_eq!(kind(canonical_root("")), "InvalidPath");
        assert_eq!(kind(canonical_root("relative/dir")), "InvalidPath");
        assert_eq!(kind(canonical_root("/tmp\0x")), "InvalidPath");
        let missing = root.join("missing");
        assert_eq!(kind(canonical_root(missing.to_str().unwrap())), "NotFound");
        let file = root.join("f.md");
        fs::write(&file, "x").unwrap();
        assert_eq!(
            kind(canonical_root(file.to_str().unwrap())),
            "NotADirectory"
        );
    }

    #[test]
    fn to_relative_uses_forward_slashes() {
        let root = Path::new("/w");
        assert_eq!(
            to_relative(root, &root.join("p").join("a.md")).as_deref(),
            Some("p/a.md")
        );
        assert_eq!(to_relative(root, root), None);
        assert_eq!(to_relative(root, Path::new("/other/a.md")), None);
        assert_eq!(to_relative(root, &root.join("..").join("x")), None);
    }

    #[cfg(unix)]
    #[test]
    fn to_relative_skips_non_utf8() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        let root = Path::new("/w");
        let path = root.join(OsStr::from_bytes(b"bad\xff.md"));
        assert_eq!(to_relative(root, &path), None);
    }

    #[test]
    fn resolve_existing_finds_files() {
        let (_dir, root) = workspace();
        fs::create_dir(root.join("p")).unwrap();
        fs::write(root.join("p/a.md"), "x").unwrap();
        assert_eq!(
            resolve_existing(&root, "p/a.md").unwrap(),
            root.join("p").join("a.md")
        );
        assert_eq!(kind(resolve_existing(&root, "p/missing.md")), "NotFound");
        assert_eq!(kind(resolve_existing(&root, "../x.md")), "InvalidPath");
    }

    #[test]
    fn resolve_for_write_handles_new_and_existing_files() {
        let (_dir, root) = workspace();
        fs::write(root.join("a.md"), "x").unwrap();
        assert_eq!(resolve_for_write(&root, "a.md").unwrap(), root.join("a.md"));
        assert_eq!(resolve_for_write(&root, "b.md").unwrap(), root.join("b.md"));
        assert_eq!(
            resolve_for_write(&root, "new/deep/c.md").unwrap(),
            root.join("new").join("deep").join("c.md")
        );
    }

    #[test]
    fn resolve_for_write_rejects_folders_and_file_parents() {
        let (_dir, root) = workspace();
        fs::create_dir(root.join("p")).unwrap();
        fs::write(root.join("file.md"), "x").unwrap();
        assert_eq!(kind(resolve_for_write(&root, "p")), "InvalidPath");
        assert_eq!(
            kind(resolve_for_write(&root, "file.md/x.md")),
            "NotADirectory"
        );
        assert_eq!(
            kind(resolve_for_write(&root, "file.md/a/x.md")),
            "NotADirectory"
        );
        assert_eq!(kind(resolve_for_write(&root, "")), "InvalidPath");
    }

    #[cfg(unix)]
    mod symlinks {
        use super::*;
        use std::os::unix::fs::symlink;

        #[test]
        fn rejects_file_symlink_escaping_the_workspace() {
            let (_dir, root) = workspace();
            let (_outside_dir, outside) = workspace();
            fs::write(outside.join("secret.md"), "s").unwrap();
            symlink(outside.join("secret.md"), root.join("link.md")).unwrap();
            assert_eq!(kind(resolve_existing(&root, "link.md")), "OutsideWorkspace");
            assert_eq!(
                kind(resolve_for_write(&root, "link.md")),
                "OutsideWorkspace"
            );
        }

        #[test]
        fn rejects_dir_symlink_escaping_the_workspace() {
            let (_dir, root) = workspace();
            let (_outside_dir, outside) = workspace();
            fs::write(outside.join("secret.md"), "s").unwrap();
            symlink(&outside, root.join("out")).unwrap();
            assert_eq!(
                kind(resolve_existing(&root, "out/secret.md")),
                "OutsideWorkspace"
            );
            assert_eq!(
                kind(resolve_for_write(&root, "out/secret.md")),
                "OutsideWorkspace"
            );
            assert_eq!(
                kind(resolve_for_write(&root, "out/new.md")),
                "OutsideWorkspace"
            );
            assert_eq!(
                kind(resolve_for_write(&root, "out/new/deep.md")),
                "OutsideWorkspace"
            );
        }

        #[test]
        fn follows_symlinks_that_stay_inside() {
            let (_dir, root) = workspace();
            fs::create_dir(root.join("real")).unwrap();
            fs::write(root.join("real/a.md"), "x").unwrap();
            symlink(root.join("real"), root.join("alias")).unwrap();
            symlink(root.join("real/a.md"), root.join("a-link.md")).unwrap();
            let target = root.join("real").join("a.md");
            assert_eq!(resolve_existing(&root, "alias/a.md").unwrap(), target);
            assert_eq!(resolve_for_write(&root, "a-link.md").unwrap(), target);
            assert_eq!(
                resolve_for_write(&root, "alias/new.md").unwrap(),
                root.join("real").join("new.md")
            );
        }

        #[test]
        fn rejects_dangling_symlinks() {
            let (_dir, root) = workspace();
            symlink(root.join("nowhere.md"), root.join("dangling.md")).unwrap();
            symlink(root.join("nowhere"), root.join("dangling-dir")).unwrap();
            assert_eq!(kind(resolve_existing(&root, "dangling.md")), "InvalidPath");
            assert_eq!(kind(resolve_for_write(&root, "dangling.md")), "InvalidPath");
            assert_eq!(
                kind(resolve_for_write(&root, "dangling-dir/a.md")),
                "InvalidPath"
            );
        }

        #[test]
        fn unreadable_parent_is_permission_denied() {
            use std::os::unix::fs::PermissionsExt;
            let (_dir, root) = workspace();
            if crate::test_support::skip_if_privileged("unreadable_parent") {
                return;
            }
            fs::create_dir(root.join("locked")).unwrap();
            fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o000)).unwrap();
            let result = resolve_for_write(&root, "locked/x.md");
            let existing = resolve_existing(&root, "locked/x.md");
            fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(kind(result), "PermissionDenied");
            assert_eq!(kind(existing), "PermissionDenied");
        }
    }
}
