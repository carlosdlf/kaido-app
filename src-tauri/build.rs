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
    "read_settings",
    "write_settings",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
