//! Helpers shared by tests.

/// Whether file permission bits are ignored for this process (root or a
/// process with `CAP_DAC_OVERRIDE`). Permission tests cannot fail in that
/// case, so they skip themselves and say so.
#[cfg(unix)]
pub fn skip_if_privileged(test: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let probe = dir.path().join("probe");
    std::fs::write(&probe, "x").unwrap();
    std::fs::set_permissions(&probe, std::fs::Permissions::from_mode(0o000)).unwrap();
    let privileged = std::fs::File::open(&probe).is_ok();
    if privileged {
        eprintln!("note: skipping {test}: file permissions do not apply to this user");
    }
    privileged
}

/// Sets a file's modification time to `secs` seconds ago.
pub fn backdate(path: &std::path::Path, secs: u64) {
    let file = std::fs::File::options().write(true).open(path).unwrap();
    let past = std::time::SystemTime::now() - std::time::Duration::from_secs(secs);
    file.set_modified(past).unwrap();
}
