mod commands;
mod error;
mod fs_ops;
mod paths;
mod settings;
mod state;
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
        .invoke_handler(commands::handler())
        .run(tauri::generate_context!())
        .expect("failed to run the Kaido application");
}
