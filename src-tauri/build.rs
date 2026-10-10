/// Commands exposed to the frontend. Declaring them here generates an
/// `allow-<command>` permission for each one, so a window can only call the
/// commands its capability grants explicitly.
const COMMANDS: &[&str] = &[
    "pick_workspace_folder",
    "open_workspace",
    "list_files",
    "read_file",
    "write_file",
    "rename_file",
    "delete_file",
    "move_file",
    "rename_folder",
    "delete_folder",
    "read_settings",
    "write_settings",
    "git_status",
    "git_commit",
    "git_sync",
    "git_version",
    "git_clone",
    "git_clone_cancel",
    "scaffold_workspace",
    "ensure_workspace_files",
    "workspace_setup_status",
    "capture_shortcut_status",
    "set_capture_shortcut",
    "capture_submit",
    "capture_request_projects",
    "capture_hide",
    "capture_show",
    "capture_set_height",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
