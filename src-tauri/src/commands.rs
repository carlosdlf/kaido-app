//! Tauri commands. Each one is a thin wrapper that resolves the open
//! workspace and runs the real work (in `fs_ops`, `settings`, `state`) on a
//! blocking thread so the UI never waits on disk I/O.

use serde::Serialize;
use tauri::ipc::{Invoke, InvokeBody, Request};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, AppResult};
use crate::fs_ops::{self, FileContents, FileEntry, WriteCondition, WrittenFile};
use crate::settings::{self, SettingsDir};
use crate::state::AppState;

/// Event emitted with a [`crate::watcher::ChangeBatch`] payload.
pub const CHANGED_EVENT: &str = "workspace://changed";

/// The invoke handler with every command exposed to the frontend. Keep this
/// list in sync with `COMMANDS` in `build.rs`.
pub fn handler<R: Runtime>() -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        pick_workspace_folder,
        open_workspace,
        list_files,
        read_file,
        write_file,
        read_settings,
        write_settings,
    ]
}

#[derive(Debug, Serialize)]
pub struct OpenedWorkspace {
    pub root: String,
}

async fn blocking<T, F>(work: F) -> AppResult<T>
where
    F: FnOnce() -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| AppError::Io("a background task failed".into()))?
}

#[tauri::command]
pub async fn pick_workspace_folder<R: Runtime>(app: AppHandle<R>) -> AppResult<Option<String>> {
    let picked = blocking(move || Ok(app.dialog().file().blocking_pick_folder())).await?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|_| AppError::InvalidPath("the selected folder is not a local path".into()))?;
    path.into_os_string()
        .into_string()
        .map(Some)
        .map_err(|_| AppError::InvalidPath("the selected folder path is not valid UTF-8".into()))
}

#[tauri::command]
pub async fn open_workspace<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> AppResult<OpenedWorkspace> {
    let root = blocking(move || {
        let emitter = app.clone();
        app.state::<AppState>().open(&path, move |batch| {
            let _ = emitter.emit(CHANGED_EVENT, batch);
        })
    })
    .await?;
    let root = root
        .into_os_string()
        .into_string()
        .map_err(|_| AppError::InvalidPath("the workspace path is not valid UTF-8".into()))?;
    Ok(OpenedWorkspace { root })
}

#[tauri::command]
pub async fn list_files(state: State<'_, AppState>) -> AppResult<Vec<FileEntry>> {
    let root = state.root()?;
    blocking(move || fs_ops::list_files(&root)).await
}

#[tauri::command]
pub async fn read_file(state: State<'_, AppState>, path: String) -> AppResult<FileContents> {
    let root = state.root()?;
    blocking(move || fs_ops::read_file(&root, &path)).await
}

/// Name of the optional `write_file` argument holding the write condition.
const EXPECTED_HASH_KEY: &str = "expectedHash";

/// Reads the `expectedHash` argument of `write_file` from the raw request.
///
/// The argument has three states: missing (unconditional write), `null`
/// (create only) and a string (replace only if the current hash matches).
/// Tauri deserializes a missing key and `null` both as `None`, even for a
/// nested `Option<Option<_>>`, so the request body is inspected directly to
/// tell them apart. Any other JSON type is rejected.
fn write_condition(body: &InvokeBody) -> AppResult<WriteCondition> {
    let value = match body {
        InvokeBody::Json(args) => args.get(EXPECTED_HASH_KEY),
        InvokeBody::Raw(_) => None,
    };
    match value {
        None => Ok(WriteCondition::Unconditional),
        Some(serde_json::Value::Null) => Ok(WriteCondition::CreateOnly),
        Some(serde_json::Value::String(hash)) => Ok(WriteCondition::Matches(hash.clone())),
        // No error kind describes a malformed request, and `InvalidPath`
        // would point at the wrong argument; the message says what is wrong.
        Some(_) => Err(AppError::Io(format!(
            "invalid write_file request: {EXPECTED_HASH_KEY} must be a string or null"
        ))),
    }
}

#[tauri::command]
pub async fn write_file(
    state: State<'_, AppState>,
    request: Request<'_>,
    path: String,
    contents: String,
) -> AppResult<WrittenFile> {
    let condition = write_condition(request.body())?;
    let root = state.root()?;
    blocking(move || fs_ops::write_file(&root, &path, &contents, &condition)).await
}

#[tauri::command]
pub async fn read_settings(dir: State<'_, SettingsDir>) -> AppResult<Option<String>> {
    let dir = dir.0.clone();
    blocking(move || settings::read_settings(&dir)).await
}

#[tauri::command]
pub async fn write_settings(dir: State<'_, SettingsDir>, contents: String) -> AppResult<()> {
    let dir = dir.0.clone();
    blocking(move || settings::write_settings(&dir, &contents)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::Listener;
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{
        INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
    };
    use tauri::webview::{InvokeRequest, WebviewWindow, WebviewWindowBuilder};

    type TestApp = (
        tauri::App<MockRuntime>,
        WebviewWindow<MockRuntime>,
        tempfile::TempDir,
    );

    fn app() -> TestApp {
        let settings_dir = tempfile::tempdir().unwrap();
        let app = mock_builder()
            .manage(AppState::default())
            .manage(SettingsDir(settings_dir.path().join("config")))
            .invoke_handler(handler())
            .build(mock_context(noop_assets()))
            .unwrap();
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        (app, webview, settings_dir)
    }

    fn invoke(
        webview: &WebviewWindow<MockRuntime>,
        cmd: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, serde_json::Value> {
        let request = InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: if cfg!(windows) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .unwrap(),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        };
        get_ipc_response(webview, request).map(|body| body.deserialize().unwrap())
    }

    fn error_kind(result: Result<serde_json::Value, serde_json::Value>) -> String {
        let err = result.unwrap_err();
        assert!(err["message"].is_string(), "{err}");
        err["kind"].as_str().unwrap().to_owned()
    }

    #[test]
    fn workspace_commands_require_an_open_workspace() {
        let (_app, webview, _settings) = app();
        let none = serde_json::json!({});
        assert_eq!(
            error_kind(invoke(&webview, "list_files", none.clone())),
            "NoWorkspace"
        );
        let read = serde_json::json!({ "path": "a.md" });
        assert_eq!(
            error_kind(invoke(&webview, "read_file", read)),
            "NoWorkspace"
        );
        let write = serde_json::json!({ "path": "a.md", "contents": "x" });
        assert_eq!(
            error_kind(invoke(&webview, "write_file", write)),
            "NoWorkspace"
        );
    }

    #[test]
    fn open_rejects_invalid_folders() {
        let (_app, webview, _settings) = app();
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");
        let args = serde_json::json!({ "path": missing });
        assert_eq!(
            error_kind(invoke(&webview, "open_workspace", args)),
            "NotFound"
        );
        let args = serde_json::json!({ "path": "relative" });
        assert_eq!(
            error_kind(invoke(&webview, "open_workspace", args)),
            "InvalidPath"
        );
    }

    #[test]
    fn open_write_read_list_and_watch() {
        let (app, webview, _settings) = app();
        let dir = tempfile::tempdir().unwrap();
        let canonical = dunce::canonicalize(dir.path()).unwrap();

        let (tx, rx) = mpsc::channel();
        app.listen(CHANGED_EVENT, move |event| {
            let _ = tx.send(event.payload().to_owned());
        });

        let opened = invoke(
            &webview,
            "open_workspace",
            serde_json::json!({ "path": dir.path() }),
        )
        .unwrap();
        assert_eq!(opened, serde_json::json!({ "root": canonical }));

        let args = serde_json::json!({ "path": "inbox/note.md", "contents": "# Hi\n" });
        let entry = invoke(&webview, "write_file", args).unwrap();
        assert_eq!(entry["path"], "inbox/note.md");
        assert_eq!(entry["size"], 5);
        assert!(entry["modified"].as_u64().unwrap() > 0);
        let hash = fs_ops::content_hash(b"# Hi\n");
        assert_eq!(entry["hash"], hash);

        let read = invoke(
            &webview,
            "read_file",
            serde_json::json!({ "path": "inbox/note.md" }),
        )
        .unwrap();
        assert_eq!(
            read,
            serde_json::json!({ "contents": "# Hi\n", "hash": hash })
        );

        let list = invoke(&webview, "list_files", serde_json::json!({})).unwrap();
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert_eq!(list[0]["path"], "inbox/note.md");

        let args = serde_json::json!({ "path": "../escape.md", "contents": "x" });
        assert_eq!(
            error_kind(invoke(&webview, "write_file", args)),
            "InvalidPath"
        );

        // Creating `inbox/` may produce a separate rescan batch; wait for the
        // one that reports the note.
        let payload = loop {
            let raw = rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let payload: serde_json::Value = serde_json::from_str(&raw).unwrap();
            assert!(payload["rescan"].is_boolean(), "{payload}");
            let paths = payload["paths"].as_array().unwrap();
            if paths.iter().any(|p| p == "inbox/note.md") {
                break payload;
            }
        };
        let entries = payload["entries"].as_array().unwrap();
        assert!(
            entries.iter().any(|e| e["path"] == "inbox/note.md"),
            "{payload}"
        );
    }

    #[test]
    fn expected_hash_argument_has_three_states() {
        let condition = |args: serde_json::Value| write_condition(&InvokeBody::Json(args));
        let base = serde_json::json!({ "path": "a.md", "contents": "x" });
        assert_eq!(condition(base).unwrap(), WriteCondition::Unconditional);
        let null = serde_json::json!({ "path": "a.md", "contents": "x", "expectedHash": null });
        assert_eq!(condition(null).unwrap(), WriteCondition::CreateOnly);
        let hash = serde_json::json!({ "path": "a.md", "contents": "x", "expectedHash": "ab" });
        assert_eq!(
            condition(hash).unwrap(),
            WriteCondition::Matches("ab".into())
        );
        for bad in [
            serde_json::json!(1),
            serde_json::json!({}),
            serde_json::json!([]),
        ] {
            let err = condition(serde_json::json!({ "expectedHash": bad })).unwrap_err();
            assert_eq!(err.kind(), "Io");
            assert_eq!(
                err.to_string(),
                "invalid write_file request: expectedHash must be a string or null"
            );
        }
        assert_eq!(
            write_condition(&InvokeBody::Raw(Vec::new())).unwrap(),
            WriteCondition::Unconditional
        );
    }

    #[test]
    fn conditional_writes_through_ipc() {
        let (_app, webview, _settings) = app();
        let dir = tempfile::tempdir().unwrap();
        let open = serde_json::json!({ "path": dir.path() });
        invoke(&webview, "open_workspace", open).unwrap();
        let write = |args: serde_json::Value| invoke(&webview, "write_file", args);

        let created = write(serde_json::json!({
            "path": "a.md", "contents": "one", "expectedHash": null
        }))
        .unwrap();
        assert_eq!(created["hash"], fs_ops::content_hash(b"one"));
        let again = write(serde_json::json!({
            "path": "a.md", "contents": "two", "expectedHash": null
        }));
        assert_eq!(error_kind(again), "Conflict");

        let replaced = write(serde_json::json!({
            "path": "a.md", "contents": "two", "expectedHash": created["hash"]
        }))
        .unwrap();
        assert_eq!(replaced["hash"], fs_ops::content_hash(b"two"));
        let stale = write(serde_json::json!({
            "path": "a.md", "contents": "three", "expectedHash": created["hash"]
        }));
        assert_eq!(error_kind(stale), "Conflict");
        let missing = write(serde_json::json!({
            "path": "b.md", "contents": "x", "expectedHash": created["hash"]
        }));
        assert_eq!(error_kind(missing), "Conflict");
        let bad = write(serde_json::json!({
            "path": "a.md", "contents": "x", "expectedHash": 7
        }));
        assert_eq!(error_kind(bad), "Io");

        write(serde_json::json!({ "path": "a.md", "contents": "four" })).unwrap();
        let read = invoke(&webview, "read_file", serde_json::json!({ "path": "a.md" })).unwrap();
        assert_eq!(read["contents"], "four");
        assert!(!dir.path().join("b.md").exists());
    }

    #[test]
    fn settings_round_trip_through_ipc() {
        let (_app, webview, settings_dir) = app();
        let read = || invoke(&webview, "read_settings", serde_json::json!({}));
        assert_eq!(read().unwrap(), serde_json::Value::Null);

        let args = serde_json::json!({ "contents": "{\"version\":1}" });
        assert_eq!(
            invoke(&webview, "write_settings", args).unwrap(),
            serde_json::Value::Null
        );
        assert_eq!(read().unwrap(), "{\"version\":1}");
        let file = settings_dir
            .path()
            .join("config")
            .join(settings::SETTINGS_FILE);
        assert_eq!(std::fs::read_to_string(file).unwrap(), "{\"version\":1}");
    }

    #[test]
    fn settings_errors_reach_the_frontend() {
        let (_app, webview, settings_dir) = app();
        let config = settings_dir.path().join("config");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(config.join(settings::SETTINGS_FILE), [0xff, 0xfe]).unwrap();
        let result = invoke(&webview, "read_settings", serde_json::json!({}));
        assert_eq!(error_kind(result), "InvalidUtf8");
    }
}
