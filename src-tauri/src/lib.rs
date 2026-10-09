mod capture;
mod clone;
mod commands;
mod error;
mod fs_ops;
mod git;
mod paths;
mod settings;
mod setup;
mod shortcut;
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
            use tauri::Emitter;

            let config_dir = app.path().app_config_dir()?;
            // Registered before the main window loads, so the shortcut works
            // right away.
            #[cfg(desktop)]
            let status = shortcut::register_at_startup(
                &shortcut::AppShortcuts(app.handle()),
                shortcut::startup_settings(&config_dir).as_deref(),
            );
            #[cfg(not(desktop))]
            let status = shortcut::ShortcutStatus {
                registered: false,
                shortcut: None,
            };
            app.manage(shortcut::ShortcutState::new(status));

            let settings = settings::SettingsDir::new(config_dir);
            let handle = app.handle().clone();
            match settings::SettingsWatcher::start(&settings, move || {
                let _ = handle.emit_to(capture::MAIN_WINDOW, settings::CHANGED_EVENT, ());
            }) {
                Ok(watcher) => {
                    app.manage(watcher);
                }
                Err(err) => {
                    eprintln!("settings: changes made outside the app will not be noticed: {err}")
                }
            }
            app.manage(settings);
            Ok(())
        })
        .on_window_event(capture::on_window_event)
        .manage(state::AppState::default())
        .manage(git::GitOptions::default())
        .manage(sync::SyncControl::default())
        .manage(clone::CloneControl::default())
        .invoke_handler(commands::handler())
        .build(tauri::generate_context!())
        .expect("failed to build the Kaido application")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                // A clone only writes to the new folder it created: kill it
                // with every process it started and let it remove the folder.
                if !app
                    .state::<clone::CloneControl>()
                    .cancel_all_and_wait(CLONE_EXIT_WAIT)
                {
                    eprintln!("clone: a cancelled clone did not finish before exit");
                }
                // Stop git operations at a safe point; nothing is aborted here.
                app.state::<sync::SyncControl>().shutdown(SHUTDOWN_WAIT);
            }
        });
}

/// How long app exit waits for cancelled clones to stop and clean up.
const CLONE_EXIT_WAIT: std::time::Duration = std::time::Duration::from_secs(2);

/// How long app exit waits for a running sync to reach a safe point.
const SHUTDOWN_WAIT: std::time::Duration = std::time::Duration::from_secs(3);
