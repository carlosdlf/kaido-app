//! The quick capture global shortcut: which one is active, changing it
//! safely, and the one used at startup.
//!
//! A change registers the new shortcut first and only then releases the old
//! one, so a shortcut taken by another app never leaves the user without
//! one. The decisions are plain functions over a [`ShortcutRegistry`], so
//! they can be tested without a desktop session.

use std::sync::{Mutex, MutexGuard};

use serde::Serialize;

use crate::settings::SETTINGS_FILE;

/// The shortcut used when the settings do not choose one.
pub const DEFAULT_SHORTCUT: &str = "CommandOrControl+Alt+Space";
/// Settings key holding the shortcut (`null` disables it).
pub const SETTINGS_KEY: &str = "captureShortcut";

/// The active shortcut, returned by `capture_shortcut_status`. The main
/// window asks once it is ready instead of racing a startup event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ShortcutStatus {
    /// Whether `shortcut` is registered with the system.
    pub registered: bool,
    /// The shortcut in use, or the one that failed to register at startup;
    /// `null` when the user disabled it.
    pub shortcut: Option<String>,
}

/// The result of `set_capture_shortcut`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ShortcutChange {
    /// Whether the requested shortcut is now registered. Always `false`
    /// when it was disabled.
    pub registered: bool,
    /// The requested shortcut (also when it failed); `null` when disabled.
    pub shortcut: Option<String>,
    /// Why the requested shortcut could not be used; the previous one is
    /// still active then. `null` on success.
    pub message: Option<String>,
}

/// The shortcut state, managed by the app.
pub struct ShortcutState(Mutex<ShortcutStatus>);

impl ShortcutState {
    pub fn new(status: ShortcutStatus) -> Self {
        Self(Mutex::new(status))
    }

    pub fn lock(&self) -> MutexGuard<'_, ShortcutStatus> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn status(&self) -> ShortcutStatus {
        self.lock().clone()
    }
}

/// Registers and releases global shortcuts. Errors are messages.
pub trait ShortcutRegistry {
    fn register(&self, accelerator: &str) -> Result<(), String>;
    fn unregister(&self, accelerator: &str) -> Result<(), String>;
}

/// Longest accelerator accepted, as in the frontend.
#[cfg(desktop)]
pub const MAX_ACCELERATOR_LENGTH: usize = 100;

/// Parses an accelerator such as `CommandOrControl+Shift+K`. Two strings
/// naming the same keys parse to equal values.
///
/// As in the frontend, a global shortcut needs `Ctrl`, `Alt` or
/// `Super`/`Cmd` (`CommandOrControl` counts): with no modifier, or `Shift`
/// alone, it would take over normal typing.
#[cfg(desktop)]
pub fn parse(accelerator: &str) -> Result<tauri_plugin_global_shortcut::Shortcut, String> {
    use tauri_plugin_global_shortcut::Modifiers;
    if accelerator.len() > MAX_ACCELERATOR_LENGTH {
        return Err("the shortcut is too long".into());
    }
    let shortcut = accelerator
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map_err(|err| err.to_string())?;
    let required = Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER | Modifiers::META;
    if !shortcut.mods.intersects(required) {
        return Err("a shortcut needs Ctrl, Alt or Super (Cmd)".into());
    }
    Ok(shortcut)
}

/// Switches to `requested` (`None` disables the shortcut) and updates
/// `status`.
///
/// The new shortcut is registered before the old one is released; if it
/// cannot be parsed or registered, nothing changes and the error says why.
#[cfg(desktop)]
pub fn change_shortcut(
    registry: &impl ShortcutRegistry,
    status: &mut ShortcutStatus,
    requested: Option<&str>,
) -> ShortcutChange {
    let Some(requested) = requested.map(str::trim) else {
        release(registry, status);
        *status = ShortcutStatus {
            registered: false,
            shortcut: None,
        };
        return ShortcutChange {
            registered: false,
            shortcut: None,
            message: None,
        };
    };
    let failure = |message: String| ShortcutChange {
        registered: false,
        shortcut: Some(requested.to_owned()),
        message: Some(message),
    };
    let parsed = match parse(requested) {
        Ok(parsed) => parsed,
        Err(err) => return failure(format!("{requested} is not a valid shortcut: {err}")),
    };
    let unchanged = status.registered
        && status
            .shortcut
            .as_deref()
            .is_some_and(|current| parse(current).is_ok_and(|c| c == parsed));
    if !unchanged {
        if let Err(err) = registry.register(requested) {
            return failure(format!("could not register {requested}: {err}"));
        }
        release(registry, status);
    }
    *status = ShortcutStatus {
        registered: true,
        shortcut: Some(requested.to_owned()),
    };
    ShortcutChange {
        registered: true,
        shortcut: Some(requested.to_owned()),
        message: None,
    }
}

/// Releases the registered shortcut, if any. A failure is only logged: the
/// new state is what the user asked for.
#[cfg(desktop)]
fn release(registry: &impl ShortcutRegistry, status: &ShortcutStatus) {
    if let (true, Some(old)) = (status.registered, status.shortcut.as_deref())
        && let Err(err) = registry.unregister(old)
    {
        eprintln!("quick capture: could not release {old}: {err}");
    }
}

/// The shortcut to register at startup, from the raw settings text:
/// `captureShortcut` when it is a valid accelerator, nothing when it is
/// `null`, and [`DEFAULT_SHORTCUT`] otherwise (no file, invalid JSON, a
/// missing or invalid value). The frontend applies the same fallback.
#[cfg(desktop)]
pub fn startup_shortcut(settings: Option<&str>) -> Option<String> {
    let value = settings
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .and_then(|json| json.get(SETTINGS_KEY).cloned());
    match value {
        Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(accelerator)) if parse(accelerator.trim()).is_ok() => {
            Some(accelerator.trim().to_owned())
        }
        _ => Some(DEFAULT_SHORTCUT.to_owned()),
    }
}

/// Registers the startup shortcut (see [`startup_shortcut`]) and returns
/// the resulting status. A failure (the shortcut is taken, or the desktop
/// does not allow global shortcuts) is logged; the app runs without it.
#[cfg(desktop)]
pub fn register_at_startup(
    registry: &impl ShortcutRegistry,
    settings: Option<&str>,
) -> ShortcutStatus {
    let mut status = ShortcutStatus {
        registered: false,
        shortcut: None,
    };
    let requested = startup_shortcut(settings);
    let change = change_shortcut(registry, &mut status, requested.as_deref());
    if let Some(error) = &change.message {
        eprintln!("quick capture: {error}");
    }
    ShortcutStatus {
        registered: change.registered,
        shortcut: change.shortcut,
    }
}

/// The app's global shortcuts, through the global shortcut plugin. Without
/// the plugin (tests with a mock runtime) every registration fails.
#[cfg(desktop)]
pub struct AppShortcuts<'a, R: tauri::Runtime>(pub &'a tauri::AppHandle<R>);

#[cfg(desktop)]
impl<R: tauri::Runtime> ShortcutRegistry for AppShortcuts<'_, R> {
    fn register(&self, accelerator: &str) -> Result<(), String> {
        use tauri::Manager;
        use tauri_plugin_global_shortcut::{GlobalShortcut, ShortcutState as KeyState};
        let shortcuts = self
            .0
            .try_state::<GlobalShortcut<R>>()
            .ok_or_else(|| "global shortcuts are not available".to_owned())?;
        shortcuts
            .on_shortcut(accelerator, |app, _shortcut, event| {
                crate::capture::handle_shortcut(app, event.state == KeyState::Pressed);
            })
            .map_err(|err| err.to_string())
    }

    fn unregister(&self, accelerator: &str) -> Result<(), String> {
        use tauri::Manager;
        use tauri_plugin_global_shortcut::GlobalShortcut;
        let shortcuts = self
            .0
            .try_state::<GlobalShortcut<R>>()
            .ok_or_else(|| "global shortcuts are not available".to_owned())?;
        shortcuts
            .unregister(accelerator)
            .map_err(|err| err.to_string())
    }
}

/// Reads the settings file for [`register_at_startup`]; unreadable settings
/// count as missing.
pub fn startup_settings(config_dir: &std::path::Path) -> Option<String> {
    std::fs::read_to_string(config_dir.join(SETTINGS_FILE)).ok()
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashSet;

    /// Registers anything not in `taken`, and records calls.
    #[derive(Default)]
    struct FakeRegistry {
        taken: HashSet<String>,
        registered: RefCell<HashSet<String>>,
        calls: RefCell<Vec<String>>,
        fail_unregister: bool,
    }

    impl FakeRegistry {
        fn taking(shortcut: &str) -> Self {
            Self {
                taken: HashSet::from([shortcut.to_owned()]),
                ..Self::default()
            }
        }

        fn calls(&self) -> Vec<String> {
            self.calls.borrow().clone()
        }

        fn active(&self) -> Vec<String> {
            let mut active: Vec<_> = self.registered.borrow().iter().cloned().collect();
            active.sort();
            active
        }
    }

    impl ShortcutRegistry for FakeRegistry {
        fn register(&self, accelerator: &str) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("+{accelerator}"));
            if self.taken.contains(accelerator) {
                return Err("already in use".into());
            }
            self.registered.borrow_mut().insert(accelerator.to_owned());
            Ok(())
        }

        fn unregister(&self, accelerator: &str) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("-{accelerator}"));
            if self.fail_unregister {
                return Err("no".into());
            }
            self.registered.borrow_mut().remove(accelerator);
            Ok(())
        }
    }

    fn active(shortcut: &str) -> ShortcutStatus {
        ShortcutStatus {
            registered: true,
            shortcut: Some(shortcut.to_owned()),
        }
    }

    #[test]
    fn a_change_registers_the_new_shortcut_before_releasing_the_old() {
        let registry = FakeRegistry::default();
        let mut status = register_at_startup(&registry, None);
        assert_eq!(status, active(DEFAULT_SHORTCUT));
        let change = change_shortcut(&registry, &mut status, Some(" Alt+Shift+K "));
        assert_eq!(
            change,
            ShortcutChange {
                registered: true,
                shortcut: Some("Alt+Shift+K".into()),
                message: None,
            }
        );
        assert_eq!(status, active("Alt+Shift+K"));
        assert_eq!(
            registry.calls(),
            [
                format!("+{DEFAULT_SHORTCUT}"),
                "+Alt+Shift+K".into(),
                format!("-{DEFAULT_SHORTCUT}"),
            ]
        );
        assert_eq!(registry.active(), ["Alt+Shift+K"]);
    }

    #[test]
    fn a_failed_change_keeps_the_old_shortcut() {
        let registry = FakeRegistry::taking("Control+Shift+P");
        let mut status = register_at_startup(&registry, None);
        let change = change_shortcut(&registry, &mut status, Some("Control+Shift+P"));
        assert!(!change.registered);
        assert_eq!(change.shortcut.as_deref(), Some("Control+Shift+P"));
        assert_eq!(
            change.message.as_deref(),
            Some("could not register Control+Shift+P: already in use")
        );
        assert_eq!(status, active(DEFAULT_SHORTCUT));
        assert_eq!(registry.active(), [DEFAULT_SHORTCUT]);
        assert!(!registry.calls().iter().any(|c| c.starts_with('-')));
    }

    #[test]
    fn an_invalid_shortcut_changes_nothing() {
        let registry = FakeRegistry::default();
        let mut status = active(DEFAULT_SHORTCUT);
        for bad in [
            "",
            "Control+",
            "Control+Shift+NoSuchKey",
            "K",
            "Space",
            "Shift+K",
            "Shift+F5",
        ] {
            let change = change_shortcut(&registry, &mut status, Some(bad));
            assert!(!change.registered, "{bad}");
            assert!(
                change.message.unwrap().contains("is not a valid shortcut"),
                "{bad}"
            );
        }
        assert_eq!(status, active(DEFAULT_SHORTCUT));
        assert!(registry.calls().is_empty());
    }

    #[test]
    fn shortcuts_need_a_modifier_other_than_shift() {
        for ok in [
            "CommandOrControl+Alt+Space",
            "CmdOrCtrl+K",
            "Control+Shift+K",
            "Alt+F5",
            "Super+1",
            "Shift+Alt+K",
        ] {
            assert!(parse(ok).is_ok(), "{ok}");
        }
        for bad in ["K", "Shift+K", "F12", "Shift+Space"] {
            assert_eq!(
                parse(bad).unwrap_err(),
                "a shortcut needs Ctrl, Alt or Super (Cmd)",
                "{bad}"
            );
        }
        let long = format!("Control+{}", "Shift+".repeat(20));
        assert_eq!(parse(&long).unwrap_err(), "the shortcut is too long");
    }

    #[test]
    fn the_same_shortcut_is_not_registered_twice() {
        let registry = FakeRegistry::default();
        let mut status = register_at_startup(&registry, None);
        let change = change_shortcut(&registry, &mut status, Some("commandorcontrol+alt+space"));
        assert!(change.registered);
        assert_eq!(registry.calls().len(), 1);
        assert_eq!(registry.active(), [DEFAULT_SHORTCUT]);
    }

    #[test]
    fn disabling_releases_the_shortcut() {
        let registry = FakeRegistry::default();
        let mut status = register_at_startup(&registry, None);
        let change = change_shortcut(&registry, &mut status, None);
        assert_eq!(
            change,
            ShortcutChange {
                registered: false,
                shortcut: None,
                message: None,
            }
        );
        assert_eq!(
            status,
            ShortcutStatus {
                registered: false,
                shortcut: None
            }
        );
        assert!(registry.active().is_empty());
        // Enabling again from disabled releases nothing.
        let change = change_shortcut(&registry, &mut status, Some("Alt+K"));
        assert!(change.registered);
        assert_eq!(
            registry.calls(),
            [
                format!("+{DEFAULT_SHORTCUT}"),
                format!("-{DEFAULT_SHORTCUT}"),
                "+Alt+K".into()
            ]
        );
    }

    #[test]
    fn a_failed_release_still_switches() {
        let registry = FakeRegistry {
            fail_unregister: true,
            ..FakeRegistry::default()
        };
        let mut status = register_at_startup(&registry, None);
        let change = change_shortcut(&registry, &mut status, Some("Alt+K"));
        assert!(change.registered);
        assert_eq!(status, active("Alt+K"));
    }

    #[test]
    fn a_shortcut_that_failed_at_startup_is_not_released() {
        let registry = FakeRegistry::taking(DEFAULT_SHORTCUT);
        let mut status = register_at_startup(&registry, None);
        assert_eq!(
            status,
            ShortcutStatus {
                registered: false,
                shortcut: Some(DEFAULT_SHORTCUT.into())
            }
        );
        let change = change_shortcut(&registry, &mut status, Some("Alt+K"));
        assert!(change.registered);
        assert_eq!(
            registry.calls(),
            [format!("+{DEFAULT_SHORTCUT}"), "+Alt+K".into()]
        );
    }

    #[test]
    fn startup_shortcut_follows_the_settings() {
        let default = Some(DEFAULT_SHORTCUT.to_owned());
        assert_eq!(startup_shortcut(None), default);
        assert_eq!(startup_shortcut(Some("not json")), default);
        assert_eq!(startup_shortcut(Some("[]")), default);
        assert_eq!(startup_shortcut(Some("{\"version\":1}")), default);
        assert_eq!(
            startup_shortcut(Some("{\"captureShortcut\":\"Nope+Nope\"}")),
            default
        );
        assert_eq!(startup_shortcut(Some("{\"captureShortcut\":3}")), default);
        for unsafe_shortcut in ["K", "Shift+K", "F5"] {
            let text = format!("{{\"captureShortcut\":\"{unsafe_shortcut}\"}}");
            assert_eq!(startup_shortcut(Some(&text)), default, "{unsafe_shortcut}");
        }
        assert_eq!(startup_shortcut(Some("{\"captureShortcut\":null}")), None);
        assert_eq!(
            startup_shortcut(Some("{\"captureShortcut\":\"Alt+Shift+K\"}")),
            Some("Alt+Shift+K".into())
        );
        let registry = FakeRegistry::default();
        assert_eq!(
            register_at_startup(&registry, Some("{\"captureShortcut\":null}")),
            ShortcutStatus {
                registered: false,
                shortcut: None
            }
        );
        assert!(registry.calls().is_empty());
    }

    #[test]
    fn startup_settings_are_read_from_the_config_folder() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(startup_settings(dir.path()), None);
        std::fs::write(dir.path().join(SETTINGS_FILE), "{}").unwrap();
        assert_eq!(startup_settings(dir.path()).as_deref(), Some("{}"));
    }

    #[test]
    fn status_serializes_for_the_frontend() {
        let status = serde_json::to_value(active(DEFAULT_SHORTCUT)).unwrap();
        assert_eq!(
            status,
            serde_json::json!({ "registered": true, "shortcut": DEFAULT_SHORTCUT })
        );
        let state = ShortcutState::new(ShortcutStatus {
            registered: false,
            shortcut: None,
        });
        assert_eq!(
            serde_json::to_value(state.status()).unwrap(),
            serde_json::json!({ "registered": false, "shortcut": null })
        );
        let change = ShortcutChange {
            registered: false,
            shortcut: Some("Alt+K".into()),
            message: Some("x".into()),
        };
        assert_eq!(
            serde_json::to_value(change).unwrap(),
            serde_json::json!({ "registered": false, "shortcut": "Alt+K", "message": "x" })
        );
    }
}
