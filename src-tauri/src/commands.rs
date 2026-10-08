//! Tauri commands. Each one is a thin wrapper that resolves the open
//! workspace and runs the real work (in `fs_ops`, `settings`, `state`) on a
//! blocking thread so the UI never waits on disk I/O.

use serde::Serialize;
use tauri::ipc::Invoke;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, AppResult};
use crate::fs_ops::{self, FileEntry};
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
pub async fn read_file(state: State<'_, AppState>, path: String) -> AppResult<String> {
    let root = state.root()?;
    blocking(move || fs_ops::read_file(&root, &path)).await
}

#[tauri::command]
pub async fn write_file(
    state: State<'_, AppState>,
    path: String,
    contents: String,
) -> AppResult<FileEntry> {
    let root = state.root()?;
    blocking(move || fs_ops::write_file(&root, &path, &contents)).await
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

        let text = invoke(
            &webview,
            "read_file",
            serde_json::json!({ "path": "inbox/note.md" }),
        )
        .unwrap();
        assert_eq!(text, "# Hi\n");

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
