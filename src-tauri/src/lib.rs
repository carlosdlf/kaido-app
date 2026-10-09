mod capture;
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

    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());

    builder
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            app.manage(settings::SettingsDir(config_dir));
            #[cfg(desktop)]
            let registered = capture::register_shortcut(app.handle());
            #[cfg(not(desktop))]
            let registered = false;
            app.manage(capture::ShortcutStatus::new(registered));
            Ok(())
        })
        .on_window_event(capture::on_window_event)
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
