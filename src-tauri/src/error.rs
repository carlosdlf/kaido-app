//! Error type shared by every command.
//!
//! Errors cross the IPC boundary as `{ "kind": ErrorKind, "message": string }`.
//! Messages are written for humans and only ever mention paths relative to the
//! workspace root, never absolute paths.

use std::io;

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AppError {
    #[error("no workspace is open")]
    NoWorkspace,
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    NotADirectory(String),
    #[error("{0}")]
    OutsideWorkspace(String),
    #[error("{0}")]
    InvalidPath(String),
    #[error("{0}")]
    InvalidUtf8(String),
    #[error("{0}")]
    PermissionDenied(String),
    #[error("{0}")]
    TooLarge(String),
    #[error("{0}")]
    Conflict(String),
    #[error("superseded by a newer request to open a workspace")]
    Superseded,
    #[error("{0}")]
    Io(String),
    /// Git is not installed or the workspace is not in a repository. The
    /// message is the reason: `git-missing` or `not-a-repo`.
    #[error("{0}")]
    GitUnavailable(String),
    /// The repository is in a state where the operation must not run. The
    /// message starts with the reason (`detached-head`, `unmerged-files`…);
    /// for `unmerged-files` found during a sync it is followed by `: ` and
    /// the list of files.
    #[error("{0}")]
    GitPaused(String),
    /// The remote could not be reached, or git timed out.
    #[error("{0}")]
    GitNetwork(String),
    /// The remote refused the credentials.
    #[error("{0}")]
    GitAuth(String),
    /// Any other git failure, with git's sanitized output.
    #[error("{0}")]
    GitFailed(String),
}

impl AppError {
    /// The `kind` value sent to the frontend.
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::NoWorkspace => "NoWorkspace",
            AppError::NotFound(_) => "NotFound",
            AppError::NotADirectory(_) => "NotADirectory",
            AppError::OutsideWorkspace(_) => "OutsideWorkspace",
            AppError::InvalidPath(_) => "InvalidPath",
            AppError::InvalidUtf8(_) => "InvalidUtf8",
            AppError::PermissionDenied(_) => "PermissionDenied",
            AppError::TooLarge(_) => "TooLarge",
            AppError::Conflict(_) => "Conflict",
            AppError::Superseded => "Superseded",
            AppError::Io(_) => "Io",
            AppError::GitUnavailable(_) => "GitUnavailable",
            AppError::GitPaused(_) => "GitPaused",
            AppError::GitNetwork(_) => "GitNetwork",
            AppError::GitAuth(_) => "GitAuth",
            AppError::GitFailed(_) => "GitFailed",
        }
    }

    /// Maps an I/O error to an [`AppError`], describing the failed action and
    /// the target with a label that is safe to show (a relative path or a
    /// generic name).
    ///
    /// The OS error description is only included for the generic `Io` kind;
    /// `std::io::Error` never embeds file paths in its message.
    pub fn from_io(err: &io::Error, action: &str, label: &str) -> Self {
        match err.kind() {
            io::ErrorKind::NotFound => AppError::NotFound(format!("{label} was not found")),
            io::ErrorKind::PermissionDenied => AppError::PermissionDenied(format!(
                "permission denied while trying to {action} {label}"
            )),
            io::ErrorKind::NotADirectory => {
                AppError::NotADirectory(format!("a parent of {label} is not a directory"))
            }
            _ => AppError::Io(format!("could not {action} {label}: {err}")),
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("kind", self.kind())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_kind_and_message() {
        let json = serde_json::to_value(AppError::NotFound("notes/a.md was not found".into()))
            .unwrap_or_default();
        assert_eq!(
            json,
            serde_json::json!({ "kind": "NotFound", "message": "notes/a.md was not found" })
        );
        let json = serde_json::to_value(AppError::NoWorkspace).unwrap_or_default();
        assert_eq!(
            json,
            serde_json::json!({ "kind": "NoWorkspace", "message": "no workspace is open" })
        );
        let json = serde_json::to_value(AppError::Conflict("a.md already exists".into()))
            .unwrap_or_default();
        assert_eq!(
            json,
            serde_json::json!({ "kind": "Conflict", "message": "a.md already exists" })
        );
    }

    #[test]
    fn every_variant_has_its_kind() {
        let cases = [
            (AppError::NoWorkspace, "NoWorkspace"),
            (AppError::NotFound(String::new()), "NotFound"),
            (AppError::NotADirectory(String::new()), "NotADirectory"),
            (
                AppError::OutsideWorkspace(String::new()),
                "OutsideWorkspace",
            ),
            (AppError::InvalidPath(String::new()), "InvalidPath"),
            (AppError::InvalidUtf8(String::new()), "InvalidUtf8"),
            (
                AppError::PermissionDenied(String::new()),
                "PermissionDenied",
            ),
            (AppError::TooLarge(String::new()), "TooLarge"),
            (AppError::Conflict(String::new()), "Conflict"),
            (AppError::Superseded, "Superseded"),
            (AppError::Io(String::new()), "Io"),
            (AppError::GitUnavailable(String::new()), "GitUnavailable"),
            (AppError::GitPaused(String::new()), "GitPaused"),
            (AppError::GitNetwork(String::new()), "GitNetwork"),
            (AppError::GitAuth(String::new()), "GitAuth"),
            (AppError::GitFailed(String::new()), "GitFailed"),
        ];
        for (err, kind) in cases {
            assert_eq!(err.kind(), kind);
        }
    }

    #[test]
    fn maps_io_error_kinds() {
        let map = |kind| AppError::from_io(&io::Error::from(kind), "read", "a.md");
        assert_eq!(map(io::ErrorKind::NotFound).kind(), "NotFound");
        assert_eq!(
            map(io::ErrorKind::PermissionDenied).kind(),
            "PermissionDenied"
        );
        assert_eq!(map(io::ErrorKind::NotADirectory).kind(), "NotADirectory");
        let other = map(io::ErrorKind::Other);
        assert_eq!(other.kind(), "Io");
        assert!(other.to_string().starts_with("could not read a.md"));
    }
}
