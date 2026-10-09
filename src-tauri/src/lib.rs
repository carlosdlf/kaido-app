mod commands;
mod error;
mod fs_ops;
mod git;
mod paths;
mod settings;
mod state;
mod sync;
#[cfg(test)]
mod test_support;
mod watch_tree;
mod watcher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            app.manage(settings::SettingsDir(config_dir));
            Ok(())
        })
        .manage(state::AppState::default())
        .manage(git::GitOptions::default())
        .manage(sync::SyncControl::default())
        .invoke_handler(commands::handler())
        .build(tauri::generate_context!())
        .expect("failed to build the Kaido application")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                // Stop git operations at a safe point; nothing is aborted here.
                app.state::<sync::SyncControl>().shutdown(SHUTDOWN_WAIT);
            }
        });
}

/// How long app exit waits for a running sync to reach a safe point.
const SHUTDOWN_WAIT: std::time::Duration = std::time::Duration::from_secs(3);
