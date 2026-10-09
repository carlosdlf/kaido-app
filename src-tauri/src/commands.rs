//! Tauri commands. Each one is a thin wrapper that resolves the open
//! workspace and runs the real work (in `fs_ops`, `settings`, `state`,
//! `sync`) on a blocking thread so the UI never waits on disk I/O or git.
//!
//! File commands and git operations coordinate through the repository's
//! operation locks (see `state`).

use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::{Invoke, InvokeBody, Request};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, AppResult};
use crate::fs_ops::{self, FileContents, FileEntry, WriteCondition, WrittenFile};
use crate::git::GitOptions;
use crate::settings::{self, SettingsDir};
use crate::state::{AppState, TreeLock};
use crate::sync::{self, CommitResult, GitStatus, SyncControl, SyncResult};

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
        rename_file,
        delete_file,
        read_settings,
        write_settings,
        git_status,
        git_commit,
        git_sync,
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

/// Runs a file command on the open workspace's root, on a blocking thread,
/// holding the repository's working tree lock shared: it waits only while a
/// sync rebases, never for `git add` or `git commit`.
///
/// If another workspace was opened while it waited, it still runs on the
/// folder it was issued for, so the user's text is never lost. The guard
/// moves into the blocking task, so it is released when the work ends even
/// if the command's future is dropped.
async fn file_op<T, F>(state: &AppState, work: F) -> AppResult<T>
where
    F: FnOnce(&Path) -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    let workspace = state.current()?;
    let guard = Arc::clone(&workspace.lock.tree).read_owned().await;
    blocking(move || {
        let _guard = guard;
        work(&workspace.root)
    })
    .await
}

/// Runs a git operation on the open workspace, on a blocking thread,
/// holding the repository's git lock. `work` also gets the working tree lock,
/// to take while it rewrites the working tree. Fails with `Superseded` if
/// another workspace was opened while it waited.
async fn git_op<T, F>(state: &AppState, work: F) -> AppResult<T>
where
    F: FnOnce(&Path, &TreeLock) -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    let workspace = state.current()?;
    let guard = Arc::clone(&workspace.lock.git).lock_owned().await;
    if !state.is_current(&workspace) {
        return Err(AppError::Superseded);
    }
    let tree = Arc::clone(&workspace.lock.tree);
    blocking(move || {
        let _guard = guard;
        work(&workspace.root, &tree)
    })
    .await
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
        let options = app.state::<GitOptions>().inner().clone();
        // One operation lock per repository (see `state`).
        let key = move |root: &Path| sync::lock_key(&options, root).unwrap_or(root.to_path_buf());
        app.state::<AppState>()
            .open_keyed(&path, key, move |batch| {
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
    file_op(&state, move |root| {
        fs_ops::write_file(root, &path, &contents, &condition)
    })
    .await
}

#[tauri::command]
pub async fn rename_file(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> AppResult<WrittenFile> {
    file_op(&state, move |root| fs_ops::rename_file(root, &from, &to)).await
}

/// Checks the `expectedHash` argument of `delete_file`, which must be a
/// string. It is taken as a raw JSON value so a missing key, `null` and other
/// types all produce a typed error instead of a deserialization failure.
fn delete_hash(value: Option<serde_json::Value>) -> AppResult<String> {
    match value {
        Some(serde_json::Value::String(hash)) => Ok(hash),
        _ => Err(AppError::Io(format!(
            "invalid delete_file request: {EXPECTED_HASH_KEY} must be a string"
        ))),
    }
}

#[tauri::command]
pub async fn delete_file(
    state: State<'_, AppState>,
    path: String,
    expected_hash: Option<serde_json::Value>,
) -> AppResult<()> {
    let expected_hash = delete_hash(expected_hash)?;
    file_op(&state, move |root| {
        fs_ops::delete_file(root, &path, &expected_hash)
    })
    .await
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

/// Status of the workspace's git repository. Takes no lock and never
/// changes the repository.
#[tauri::command]
pub async fn git_status(
    state: State<'_, AppState>,
    git: State<'_, GitOptions>,
) -> AppResult<GitStatus> {
    let root = state.root()?;
    let options = git.inner().clone();
    blocking(move || sync::status(&options, &root)).await
}

#[tauri::command]
pub async fn git_commit(
    state: State<'_, AppState>,
    git: State<'_, GitOptions>,
    control: State<'_, SyncControl>,
    message: String,
) -> AppResult<CommitResult> {
    let options = git.inner().clone();
    let control = control.inner().clone();
    git_op(&state, move |root, _tree| {
        sync::commit(&options, root, &message, &control)
    })
    .await
}

#[tauri::command]
pub async fn git_sync(
    state: State<'_, AppState>,
    git: State<'_, GitOptions>,
    control: State<'_, SyncControl>,
) -> AppResult<SyncResult> {
    let options = git.inner().clone();
    let control = control.inner().clone();
    git_op(&state, move |root, tree| {
        sync::sync(&options, root, &control, tree)
    })
    .await
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
            .manage(crate::git::test_env::options())
            .manage(SyncControl::default())
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
    fn every_command_is_declared_and_granted() {
        let build = include_str!("../build.rs");
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let granted = capability["permissions"].as_array().unwrap();
        for cmd in [
            "rename_file",
            "delete_file",
            "git_status",
            "git_commit",
            "git_sync",
        ] {
            assert!(build.contains(&format!("\"{cmd}\"")), "{cmd}");
            let permission = format!("allow-{}", cmd.replace('_', "-"));
            assert!(granted.iter().any(|p| p == &permission), "{permission}");
        }
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
    fn rename_through_ipc() {
        let (_app, webview, _settings) = app();
        let dir = tempfile::tempdir().unwrap();
        let none = serde_json::json!({ "from": "a.md", "to": "b.md" });
        assert_eq!(
            error_kind(invoke(&webview, "rename_file", none.clone())),
            "NoWorkspace"
        );
        invoke(
            &webview,
            "open_workspace",
            serde_json::json!({ "path": dir.path() }),
        )
        .unwrap();
        std::fs::create_dir(dir.path().join("p")).unwrap();
        std::fs::write(dir.path().join("p/a.md"), "body").unwrap();
        std::fs::write(dir.path().join("p/taken.md"), "x").unwrap();

        let rename = |from: &str, to: &str| {
            invoke(
                &webview,
                "rename_file",
                serde_json::json!({ "from": from, "to": to }),
            )
        };
        let renamed = rename("p/a.md", "p/b.md").unwrap();
        assert_eq!(renamed["path"], "p/b.md");
        assert_eq!(renamed["size"], 4);
        assert!(renamed["modified"].as_u64().unwrap() > 0);
        assert_eq!(renamed["hash"], fs_ops::content_hash(b"body"));
        assert_eq!(renamed.as_object().unwrap().len(), 4);
        assert_eq!(error_kind(rename("p/b.md", "p/taken.md")), "Conflict");
        assert_eq!(error_kind(rename("p/b.md", "b.md")), "InvalidPath");
        assert_eq!(error_kind(rename("p/missing.md", "p/c.md")), "NotFound");
        assert!(dir.path().join("p/b.md").exists());
    }

    #[test]
    fn delete_hash_must_be_a_string() {
        assert_eq!(
            delete_hash(Some(serde_json::json!("ab"))).unwrap(),
            "ab".to_owned()
        );
        for bad in [
            None,
            Some(serde_json::Value::Null),
            Some(serde_json::json!(1)),
            Some(serde_json::json!({})),
        ] {
            let err = delete_hash(bad).unwrap_err();
            assert_eq!(err.kind(), "Io");
            assert_eq!(
                err.to_string(),
                "invalid delete_file request: expectedHash must be a string"
            );
        }
    }

    #[test]
    fn delete_errors_through_ipc() {
        // Successful deletes use the OS trash and are tested in `fs_ops`
        // with the trash replaced.
        let (_app, webview, _settings) = app();
        let dir = tempfile::tempdir().unwrap();
        let delete = |args: serde_json::Value| invoke(&webview, "delete_file", args);
        let hash = fs_ops::content_hash(b"body");
        let args = serde_json::json!({ "path": "a.md", "expectedHash": hash });
        assert_eq!(error_kind(delete(args)), "NoWorkspace");
        invoke(
            &webview,
            "open_workspace",
            serde_json::json!({ "path": dir.path() }),
        )
        .unwrap();
        std::fs::write(dir.path().join("a.md"), "changed").unwrap();

        let args = serde_json::json!({ "path": "a.md", "expectedHash": hash });
        assert_eq!(error_kind(delete(args)), "Conflict");
        let args = serde_json::json!({ "path": "missing.md", "expectedHash": hash });
        assert_eq!(error_kind(delete(args)), "NotFound");
        let args = serde_json::json!({ "path": ".kaido/config.json", "expectedHash": hash });
        assert_eq!(error_kind(delete(args)), "InvalidPath");
        for bad in [
            serde_json::json!({ "path": "a.md" }),
            serde_json::json!({ "path": "a.md", "expectedHash": null }),
            serde_json::json!({ "path": "a.md", "expectedHash": 3 }),
        ] {
            assert_eq!(error_kind(delete(bad)), "Io");
        }
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.md")).unwrap(),
            "changed"
        );
    }

    #[test]
    fn git_commands_through_ipc() {
        use crate::git::test_env::git;
        let (_app, webview, _settings) = app();
        for cmd in ["git_status", "git_sync"] {
            assert_eq!(
                error_kind(invoke(&webview, cmd, serde_json::json!({}))),
                "NoWorkspace"
            );
        }
        let message = serde_json::json!({ "message": "m" });
        assert_eq!(
            error_kind(invoke(&webview, "git_commit", message.clone())),
            "NoWorkspace"
        );

        let dir = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(dir.path()).unwrap();
        git(&base, &["init", "-q", "--bare", "-b", "main", "remote.git"]);
        git(&base, &["clone", "-q", "remote.git", "seed"]);
        std::fs::write(base.join("seed/README.md"), "x").unwrap();
        git(&base.join("seed"), &["add", "-A"]);
        git(&base.join("seed"), &["commit", "-q", "-m", "seed"]);
        git(
            &base.join("seed"),
            &["push", "-q", "origin", "HEAD:refs/heads/main"],
        );
        git(&base, &["clone", "-q", "remote.git", "notes"]);
        let notes = base.join("notes");
        invoke(
            &webview,
            "open_workspace",
            serde_json::json!({ "path": notes }),
        )
        .unwrap();

        let status = invoke(&webview, "git_status", serde_json::json!({})).unwrap();
        assert_eq!(status["state"], "ready");
        assert_eq!(status["branch"], "main");
        assert_eq!(status["upstream"], "origin/main");
        assert_eq!(status["changed"], serde_json::json!([]));

        let write = serde_json::json!({ "path": "inbox/a.md", "contents": "# A\n" });
        invoke(&webview, "write_file", write).unwrap();
        let status = invoke(&webview, "git_status", serde_json::json!({})).unwrap();
        assert_eq!(status["changed"], serde_json::json!(["inbox/a.md"]));

        let args = serde_json::json!({ "message": "Add inbox/a.md" });
        let done = invoke(&webview, "git_commit", args).unwrap();
        assert_eq!(done["paths"], serde_json::json!(["inbox/a.md"]));
        assert_eq!(done["commit"], git(&notes, &["rev-parse", "HEAD"]));
        let again = invoke(&webview, "git_commit", message).unwrap();
        assert_eq!(again, serde_json::json!({ "commit": null, "paths": [] }));

        let synced = invoke(&webview, "git_sync", serde_json::json!({})).unwrap();
        assert_eq!(
            synced,
            serde_json::json!({ "pulled": 0, "pushed": 1, "changed": [], "conflicts": [], "deferred": false })
        );

        let plain = tempfile::tempdir().unwrap();
        invoke(
            &webview,
            "open_workspace",
            serde_json::json!({ "path": plain.path() }),
        )
        .unwrap();
        let status = invoke(&webview, "git_status", serde_json::json!({})).unwrap();
        assert_eq!(
            status,
            serde_json::json!({ "state": "unavailable", "reason": "not-a-repo" })
        );
        let err = invoke(&webview, "git_sync", serde_json::json!({})).unwrap_err();
        assert_eq!(
            err,
            serde_json::json!({ "kind": "GitUnavailable", "message": "not-a-repo" })
        );
    }

    /// Polls until `done` is set or a few seconds passed.
    fn wait_for(done: &std::sync::atomic::AtomicBool) -> bool {
        let start = std::time::Instant::now();
        while !done.load(std::sync::atomic::Ordering::SeqCst) {
            if start.elapsed() > Duration::from_secs(5) {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        true
    }

    #[test]
    fn file_commands_wait_only_for_a_rebase() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};
        let (app, webview, _settings) = app();
        let dir = tempfile::tempdir().unwrap();
        invoke(
            &webview,
            "open_workspace",
            serde_json::json!({ "path": dir.path() }),
        )
        .unwrap();
        std::fs::write(dir.path().join("old.md"), "x").unwrap();
        std::fs::write(dir.path().join("gone.md"), "x").unwrap();

        // A running commit does not hold writes back.
        let lock = app.state::<AppState>().current().unwrap().lock;
        let git_guard = lock.git.try_lock().unwrap();
        let args = serde_json::json!({ "path": "during-commit.md", "contents": "x" });
        invoke(&webview, "write_file", args).unwrap();
        drop(git_guard);

        // Stand in for a running rebase.
        let guard = lock.tree.try_write().unwrap();

        let finished = Arc::new(AtomicBool::new(false));
        let spawn = |cmd: &'static str, args: serde_json::Value| {
            let webview = webview.clone();
            let finished = Arc::clone(&finished);
            std::thread::spawn(move || {
                let result = invoke(&webview, cmd, args);
                finished.store(true, Ordering::SeqCst);
                result
            })
        };
        let writer = spawn(
            "write_file",
            serde_json::json!({ "path": "new.md", "contents": "x" }),
        );
        std::thread::sleep(Duration::from_millis(300));
        assert!(!finished.load(Ordering::SeqCst));
        assert!(!dir.path().join("new.md").exists());

        // Reading and git status do not wait.
        invoke(
            &webview,
            "read_file",
            serde_json::json!({ "path": "old.md" }),
        )
        .unwrap();
        let status = invoke(&webview, "git_status", serde_json::json!({})).unwrap();
        assert_eq!(status["state"], "unavailable");

        drop(guard);
        assert!(wait_for(&finished));
        writer.join().unwrap().unwrap();
        assert!(dir.path().join("new.md").exists());

        // Renames and deletes wait too.
        let guard = lock.tree.try_write().unwrap();
        finished.store(false, Ordering::SeqCst);
        let renamer = spawn(
            "rename_file",
            serde_json::json!({ "from": "old.md", "to": "renamed.md" }),
        );
        std::thread::sleep(Duration::from_millis(200));
        assert!(!finished.load(Ordering::SeqCst));
        drop(guard);
        assert!(wait_for(&finished));
        renamer.join().unwrap().unwrap();

        let guard = lock.tree.try_write().unwrap();
        finished.store(false, Ordering::SeqCst);
        let hash = fs_ops::content_hash(b"y");
        let deleter = spawn(
            "delete_file",
            serde_json::json!({ "path": "gone.md", "expectedHash": hash }),
        );
        std::thread::sleep(Duration::from_millis(200));
        assert!(!finished.load(Ordering::SeqCst));
        drop(guard);
        assert!(wait_for(&finished));
        // The hash does not match, so the file stays; what matters is that
        // the command only ran once the lock was free.
        assert_eq!(error_kind(deleter.join().unwrap()), "Conflict");
    }

    #[test]
    fn git_operations_for_a_replaced_workspace_are_skipped() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};
        let (app, webview, _settings) = app();
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        invoke(
            &webview,
            "open_workspace",
            serde_json::json!({ "path": first.path() }),
        )
        .unwrap();
        let lock = app.state::<AppState>().current().unwrap().lock;
        let guard = lock.git.try_lock().unwrap();

        let done = Arc::new(AtomicBool::new(false));
        let spawn = |cmd: &'static str, args: serde_json::Value| {
            let webview = webview.clone();
            let done = Arc::clone(&done);
            std::thread::spawn(move || {
                let result = invoke(&webview, cmd, args);
                done.store(true, Ordering::SeqCst);
                result
            })
        };
        let syncer = spawn("git_sync", serde_json::json!({}));
        let writer = spawn(
            "write_file",
            serde_json::json!({ "path": "late.md", "contents": "x" }),
        );
        std::thread::sleep(Duration::from_millis(300));
        invoke(
            &webview,
            "open_workspace",
            serde_json::json!({ "path": second.path() }),
        )
        .unwrap();
        drop(guard);

        assert_eq!(error_kind(syncer.join().unwrap()), "Superseded");
        // A write issued for the old workspace still lands there.
        writer.join().unwrap().unwrap();
        assert!(first.path().join("late.md").exists());
        assert!(!second.path().join("late.md").exists());
    }

    #[test]
    fn git_status_explains_the_apps_rebase_without_taking_locks() {
        use crate::git::test_env::git;
        let (app, webview, _settings) = app();
        let dir = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(dir.path()).unwrap();
        git(&base, &["init", "-q", "-b", "main", "repo"]);
        let repo = base.join("repo");
        let write_commit = |rel: &str, text: &str, msg: &str| {
            std::fs::write(repo.join(rel), text).unwrap();
            git(&repo, &["add", "-A"]);
            git(&repo, &["commit", "-q", "-m", msg]);
        };
        write_commit("a.md", "base", "base");
        git(&repo, &["checkout", "-q", "-b", "other"]);
        write_commit("a.md", "other", "other");
        git(&repo, &["checkout", "-q", "main"]);
        write_commit("a.md", "main", "main");
        let out = crate::git::Git::new(&crate::git::test_env::options(), &repo)
            .run(crate::git::Mode::Write, ["rebase", "other"])
            .unwrap();
        assert!(!out.success);
        // As if a sync had started this rebase and the app had crashed.
        let state = |name: &str| {
            std::fs::read_to_string(repo.join(".git/rebase-merge").join(name))
                .unwrap()
                .trim()
                .to_owned()
        };
        let marker = sync::RebaseMarker {
            orig_head: state("orig-head"),
            onto: state("onto"),
        };
        std::fs::write(
            repo.join(".git").join(sync::REBASE_MARKER),
            marker.to_text(),
        )
        .unwrap();
        invoke(
            &webview,
            "open_workspace",
            serde_json::json!({ "path": repo }),
        )
        .unwrap();

        let lock = app.state::<AppState>().current().unwrap().lock;
        let _git = lock.git.try_lock().unwrap();
        let _tree = lock.tree.try_write().unwrap();
        for _ in 0..2 {
            let status = invoke(&webview, "git_status", serde_json::json!({})).unwrap();
            assert_eq!(status["pausedReason"], "operation-in-progress");
            assert_eq!(status["pausedMessage"], sync::APP_REBASE_MESSAGE);
        }
        assert!(repo.join(".git/rebase-merge").exists());
    }

    #[test]
    fn a_slow_commit_does_not_delay_file_writes() {
        use crate::git::test_env::git;
        use std::os::unix::fs::PermissionsExt;
        let (_app, webview, _settings) = app();
        let dir = tempfile::tempdir().unwrap();
        let repo = dunce::canonicalize(dir.path()).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        let hook = repo.join(".git/hooks/pre-commit");
        let started = repo.join(".git/hook-started");
        std::fs::write(
            &hook,
            format!("#!/bin/sh\ntouch '{}'\nsleep 2\n", started.display()),
        )
        .unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        invoke(
            &webview,
            "open_workspace",
            serde_json::json!({ "path": repo }),
        )
        .unwrap();
        std::fs::write(repo.join("a.md"), "a").unwrap();

        let committer = {
            let webview = webview.clone();
            std::thread::spawn(move || {
                invoke(
                    &webview,
                    "git_commit",
                    serde_json::json!({ "message": "Add a.md" }),
                )
            })
        };
        let start = std::time::Instant::now();
        while !started.exists() {
            assert!(start.elapsed() < Duration::from_secs(10));
            std::thread::sleep(Duration::from_millis(10));
        }
        let start = std::time::Instant::now();
        let args = serde_json::json!({ "path": "b.md", "contents": "typed meanwhile" });
        invoke(&webview, "write_file", args).unwrap();
        assert!(start.elapsed() < Duration::from_secs(1));
        let done = committer.join().unwrap().unwrap();
        assert_eq!(done["paths"], serde_json::json!(["a.md"]));
        // The write is picked up by the next commit.
        let next = invoke(
            &webview,
            "git_commit",
            serde_json::json!({ "message": "Add b.md" }),
        )
        .unwrap();
        assert_eq!(next["paths"], serde_json::json!(["b.md"]));
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
