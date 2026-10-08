//! Device settings: a single `settings.json` in the app config folder.
//!
//! The backend stores the raw text only; parsing, validation and migrations
//! happen in the frontend.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};
use crate::fs_ops;

pub const SETTINGS_FILE: &str = "settings.json";

/// Folder holding `settings.json`, managed as app state. The app resolves it
/// from the OS app config folder at startup; tests point it at a temp folder.
pub struct SettingsDir(pub PathBuf);

/// Returns the raw settings text, or `None` if the file does not exist yet.
pub fn read_settings(config_dir: &Path) -> AppResult<Option<String>> {
    match fs_ops::read_text(&config_dir.join(SETTINGS_FILE), SETTINGS_FILE) {
        Ok(text) => Ok(Some(text)),
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

#[cfg(test)]
mod tests {
    use super::*;

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
    }
}
