//! Quick capture: a global shortcut that toggles a small always-on-top
//! window. The window itself is declared in `tauri.conf.json` (hidden at
//! startup, so showing it is instant) and never touches the disk; it talks to
//! the main window through the narrow `capture_*` commands below, which relay
//! to hard-coded targets. The capture window's capability grants nothing else
//! besides listening to events, so it cannot touch other windows or forge
//! events for them.
//!
//! The show/hide decision, payload validation and caller checks are plain
//! functions so they can be tested without a running app.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, Runtime, WebviewWindow};

use crate::error::{AppError, AppResult};

/// Label of the capture window in `tauri.conf.json`.
pub const CAPTURE_WINDOW: &str = "capture";
/// Label of the main window in `tauri.conf.json`.
pub const MAIN_WINDOW: &str = "main";
/// The global shortcut that toggles the capture window.
pub const SHORTCUT: &str = "CommandOrControl+Alt+Space";
/// Event emitted to the capture window every time it is shown.
pub const SHOWN_EVENT: &str = "capture:shown";
/// Event relayed to the main window with a [`CaptureSubmit`] payload.
pub const SUBMIT_EVENT: &str = "capture:submit";
/// Event relayed to the main window to ask for the project list.
pub const PROJECTS_REQUEST_EVENT: &str = "capture:projects-request";

/// Width of the capture window in logical pixels.
pub const WIDTH: f64 = 560.0;
/// Smallest height the capture window may be given, in logical pixels.
pub const MIN_HEIGHT: u32 = 52;
/// Largest height the capture window may be given, in logical pixels.
pub const MAX_HEIGHT: u32 = 400;
/// Longest accepted capture id, in bytes.
pub const MAX_ID_LEN: usize = 64;
/// Longest accepted capture text, in bytes.
pub const MAX_TEXT_LEN: usize = 16 * 1024;
/// Longest accepted project name, in bytes.
pub const MAX_PROJECT_LEN: usize = 255;

/// What the captured text becomes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureKind {
    Task,
    Note,
}

/// A capture sent by the capture window, relayed as is to the main window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSubmit {
    pub id: String,
    pub kind: CaptureKind,
    pub text: String,
    pub project: String,
}

/// Checks a capture before it is relayed. Error messages never include the
/// captured text.
pub fn validate_submit(submit: &CaptureSubmit) -> AppResult<()> {
    let id = &submit.id;
    if id.is_empty()
        || id.len() > MAX_ID_LEN
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(AppError::InvalidPath(format!(
            "a capture id must be 1 to {MAX_ID_LEN} ASCII letters, digits or dashes"
        )));
    }
    if submit.text.trim().is_empty() {
        return Err(AppError::InvalidPath(
            "a capture needs some text".to_owned(),
        ));
    }
    if submit.text.len() > MAX_TEXT_LEN {
        return Err(AppError::TooLarge(format!(
            "a capture can be at most {} KiB",
            MAX_TEXT_LEN / 1024
        )));
    }
    let project = &submit.project;
    if project.is_empty() || project.len() > MAX_PROJECT_LEN || project.contains(['/', '\\', '\0'])
    {
        return Err(AppError::InvalidPath(format!(
            "a capture project must be 1 to {MAX_PROJECT_LEN} bytes without slashes, \
             backslashes or NUL"
        )));
    }
    Ok(())
}

/// Refuses a `capture_*` command called from any window but the capture
/// window. The capability already restricts these commands; this keeps them
/// safe if a capability is ever widened by mistake.
pub fn ensure_capture_caller(label: &str) -> AppResult<()> {
    if label == CAPTURE_WINDOW {
        Ok(())
    } else {
        Err(AppError::PermissionDenied(
            "only the quick capture window can use this command".to_owned(),
        ))
    }
}

/// The height the capture window is actually given for a requested height.
pub fn clamp_height(height: u32) -> u32 {
    height.clamp(MIN_HEIGHT, MAX_HEIGHT)
}

fn capture_window<R: Runtime>(app: &AppHandle<R>) -> AppResult<WebviewWindow<R>> {
    app.get_webview_window(CAPTURE_WINDOW)
        .ok_or_else(|| AppError::NotFound("the quick capture window was not found".to_owned()))
}

fn window_error(action: &str, err: tauri::Error) -> AppError {
    AppError::Io(format!(
        "could not {action} the quick capture window: {err}"
    ))
}

/// Relays a validated capture to the main window.
#[tauri::command]
pub fn capture_submit<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    payload: CaptureSubmit,
) -> AppResult<()> {
    ensure_capture_caller(window.label())?;
    validate_submit(&payload)?;
    app.emit_to(MAIN_WINDOW, SUBMIT_EVENT, payload)
        .map_err(|err| AppError::Io(format!("could not send the capture: {err}")))
}

/// Asks the main window for the project list; it answers with
/// `capture:projects`.
#[tauri::command]
pub fn capture_request_projects<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> AppResult<()> {
    ensure_capture_caller(window.label())?;
    app.emit_to(MAIN_WINDOW, PROJECTS_REQUEST_EVENT, serde_json::json!({}))
        .map_err(|err| AppError::Io(format!("could not ask for the projects: {err}")))
}

/// Hides the capture window.
#[tauri::command]
pub fn capture_hide<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>) -> AppResult<()> {
    ensure_capture_caller(window.label())?;
    capture_window(&app)?
        .hide()
        .map_err(|err| window_error("hide", err))
}

/// Shows, centers and focuses the capture window again, for example to
/// report a failed capture. Unlike the shortcut it does not emit
/// `capture:shown`, so the page keeps what was typed.
#[tauri::command]
pub fn capture_show<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>) -> AppResult<()> {
    ensure_capture_caller(window.label())?;
    reveal(&capture_window(&app)?).map_err(|err| window_error("show", err))
}

/// Resizes the capture window to its fixed width and the clamped height.
#[tauri::command]
pub fn capture_set_height<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    height: u32,
) -> AppResult<()> {
    ensure_capture_caller(window.label())?;
    let size = LogicalSize::new(WIDTH, f64::from(clamp_height(height)));
    capture_window(&app)?
        .set_size(size)
        .map_err(|err| window_error("resize", err))
}

/// Whether the global shortcut could be registered. Managed as app state and
/// returned by the `capture_shortcut_status` command, so the main window can
/// ask once it is ready instead of racing a startup event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ShortcutStatus {
    pub registered: bool,
    pub shortcut: String,
}

impl ShortcutStatus {
    pub fn new(registered: bool) -> Self {
        Self {
            registered,
            shortcut: SHORTCUT.to_owned(),
        }
    }
}

/// What a shortcut event does to the capture window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToggleAction {
    /// Key release, or anything else that must not change the window.
    Ignore,
    /// Show, center and focus the window, then tell it it was shown.
    Show,
    /// The window is in front of the user: put it away.
    Hide,
}

/// Decides what a shortcut event does. Only a press counts; a visible window
/// that lost focus (the user clicked elsewhere) is brought back rather than
/// hidden, so one press always ends with the window usable or gone.
pub fn toggle_action(pressed: bool, visible: bool, focused: bool) -> ToggleAction {
    if !pressed {
        ToggleAction::Ignore
    } else if visible && focused {
        ToggleAction::Hide
    } else {
        ToggleAction::Show
    }
}

/// The window operations the shortcut needs. Implemented for Tauri windows
/// and by a fake in tests.
pub trait CaptureWindow {
    fn is_visible(&self) -> tauri::Result<bool>;
    fn is_focused(&self) -> tauri::Result<bool>;
    fn show(&self) -> tauri::Result<()>;
    fn hide(&self) -> tauri::Result<()>;
    fn center(&self) -> tauri::Result<()>;
    fn set_focus(&self) -> tauri::Result<()>;
    fn emit_shown(&self) -> tauri::Result<()>;
}

impl<R: Runtime> CaptureWindow for WebviewWindow<R> {
    fn is_visible(&self) -> tauri::Result<bool> {
        WebviewWindow::is_visible(self)
    }
    fn is_focused(&self) -> tauri::Result<bool> {
        WebviewWindow::is_focused(self)
    }
    fn show(&self) -> tauri::Result<()> {
        WebviewWindow::show(self)
    }
    fn hide(&self) -> tauri::Result<()> {
        WebviewWindow::hide(self)
    }
    fn center(&self) -> tauri::Result<()> {
        WebviewWindow::center(self)
    }
    fn set_focus(&self) -> tauri::Result<()> {
        WebviewWindow::set_focus(self)
    }
    fn emit_shown(&self) -> tauri::Result<()> {
        self.emit_to(self.label(), SHOWN_EVENT, ())
    }
}

/// Applies a shortcut event to the capture window and returns what it did.
/// A window state that cannot be read counts as hidden, so the press shows
/// the window. Failures are logged and stop the sequence; they never panic.
pub fn apply_shortcut(window: &impl CaptureWindow, pressed: bool) -> ToggleAction {
    let visible = window.is_visible().unwrap_or(false);
    let focused = visible && window.is_focused().unwrap_or(false);
    let action = toggle_action(pressed, visible, focused);
    let result = match action {
        ToggleAction::Ignore => Ok(()),
        ToggleAction::Hide => window.hide(),
        ToggleAction::Show => show(window),
    };
    if let Err(err) = result {
        eprintln!("quick capture: could not update the capture window: {err}");
    }
    action
}

fn show(window: &impl CaptureWindow) -> tauri::Result<()> {
    reveal(window)?;
    window.emit_shown()
}

/// Centers, shows and focuses the window without emitting `capture:shown`,
/// so the page keeps its state (used when a failed capture comes back).
pub fn reveal(window: &impl CaptureWindow) -> tauri::Result<()> {
    // Center before showing so the window does not jump on screen. Centering
    // is cosmetic: a failure there must not keep the window hidden.
    if let Err(err) = window.center() {
        eprintln!("quick capture: could not center the capture window: {err}");
    }
    window.show()?;
    window.set_focus()
}

/// Handles a shortcut event for the running app.
pub fn handle_shortcut<R: Runtime>(app: &AppHandle<R>, pressed: bool) -> ToggleAction {
    if !pressed {
        return ToggleAction::Ignore;
    }
    match app.get_webview_window(CAPTURE_WINDOW) {
        Some(window) => apply_shortcut(&window, pressed),
        None => {
            eprintln!("quick capture: the capture window does not exist");
            ToggleAction::Ignore
        }
    }
}

/// Registers the global shortcut and returns whether it worked. A failure
/// (usually the shortcut is taken by another app, or the desktop does not
/// allow global shortcuts) is logged and the app keeps running without it.
#[cfg(desktop)]
pub fn register_shortcut<R: Runtime>(app: &AppHandle<R>) -> bool {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let result = app
        .global_shortcut()
        .on_shortcut(SHORTCUT, |app, _shortcut, event| {
            handle_shortcut(app, event.state == ShortcutState::Pressed);
        });
    match result {
        Ok(()) => true,
        Err(err) => {
            eprintln!("quick capture: could not register {SHORTCUT}: {err}");
            false
        }
    }
}

/// What a window event leads to, beyond Tauri's default handling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowEventAction {
    /// Default handling.
    None,
    /// Keep the window (it is reused) and hide it instead of closing it.
    HideInsteadOfClose,
    /// The main window is gone: quit, since the hidden capture window would
    /// otherwise keep the app running without a way to reach it.
    Exit,
}

/// The kinds of window events the app reacts to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowEventKind {
    CloseRequested,
    Destroyed,
    Other,
}

pub fn window_event_action(label: &str, kind: WindowEventKind) -> WindowEventAction {
    match kind {
        WindowEventKind::CloseRequested if label == CAPTURE_WINDOW => {
            WindowEventAction::HideInsteadOfClose
        }
        WindowEventKind::Destroyed if label == MAIN_WINDOW => WindowEventAction::Exit,
        _ => WindowEventAction::None,
    }
}

/// Window event hook installed on the app builder.
pub fn on_window_event<R: Runtime>(window: &tauri::Window<R>, event: &tauri::WindowEvent) {
    let kind = match event {
        tauri::WindowEvent::CloseRequested { .. } => WindowEventKind::CloseRequested,
        tauri::WindowEvent::Destroyed => WindowEventKind::Destroyed,
        _ => WindowEventKind::Other,
    };
    match window_event_action(window.label(), kind) {
        WindowEventAction::None => {}
        WindowEventAction::HideInsteadOfClose => {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
            }
            if let Err(err) = window.hide() {
                eprintln!("quick capture: could not hide the capture window: {err}");
            }
        }
        WindowEventAction::Exit => window.app_handle().exit(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::Listener;
    use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};
    use tauri::webview::WebviewWindowBuilder;

    #[test]
    fn toggle_ignores_key_release() {
        for visible in [false, true] {
            for focused in [false, true] {
                assert_eq!(toggle_action(false, visible, focused), ToggleAction::Ignore);
            }
        }
    }

    #[test]
    fn toggle_hides_only_a_visible_focused_window() {
        assert_eq!(toggle_action(true, true, true), ToggleAction::Hide);
        assert_eq!(toggle_action(true, true, false), ToggleAction::Show);
        assert_eq!(toggle_action(true, false, false), ToggleAction::Show);
        // A hidden window reporting focus (stale state) is still shown.
        assert_eq!(toggle_action(true, false, true), ToggleAction::Show);
    }

    #[derive(Default)]
    struct FakeWindow {
        visible: Cell<bool>,
        focused: Cell<bool>,
        unreadable: bool,
        fail: Option<&'static str>,
        calls: RefCell<Vec<&'static str>>,
    }

    impl FakeWindow {
        fn new(visible: bool, focused: bool) -> Self {
            let window = Self::default();
            window.visible.set(visible);
            window.focused.set(focused);
            window
        }

        fn step(&self, name: &'static str) -> tauri::Result<()> {
            self.calls.borrow_mut().push(name);
            if self.fail == Some(name) {
                Err(tauri::Error::WindowNotFound)
            } else {
                Ok(())
            }
        }

        fn calls(&self) -> Vec<&'static str> {
            self.calls.borrow().clone()
        }
    }

    impl CaptureWindow for FakeWindow {
        fn is_visible(&self) -> tauri::Result<bool> {
            if self.unreadable {
                return Err(tauri::Error::WindowNotFound);
            }
            Ok(self.visible.get())
        }
        fn is_focused(&self) -> tauri::Result<bool> {
            if self.unreadable {
                return Err(tauri::Error::WindowNotFound);
            }
            Ok(self.focused.get())
        }
        fn show(&self) -> tauri::Result<()> {
            self.step("show")?;
            self.visible.set(true);
            Ok(())
        }
        fn hide(&self) -> tauri::Result<()> {
            self.step("hide")?;
            self.visible.set(false);
            self.focused.set(false);
            Ok(())
        }
        fn center(&self) -> tauri::Result<()> {
            self.step("center")
        }
        fn set_focus(&self) -> tauri::Result<()> {
            self.step("focus")?;
            self.focused.set(true);
            Ok(())
        }
        fn emit_shown(&self) -> tauri::Result<()> {
            self.step("emit")
        }
    }

    #[test]
    fn press_on_hidden_window_shows_centers_focuses_and_notifies() {
        let window = FakeWindow::new(false, false);
        assert_eq!(apply_shortcut(&window, true), ToggleAction::Show);
        assert_eq!(window.calls(), ["center", "show", "focus", "emit"]);
        assert!(window.visible.get() && window.focused.get());
    }

    #[test]
    fn second_press_hides_and_third_shows_again() {
        let window = FakeWindow::new(false, false);
        apply_shortcut(&window, true);
        assert_eq!(apply_shortcut(&window, true), ToggleAction::Hide);
        assert!(!window.visible.get());
        assert_eq!(apply_shortcut(&window, true), ToggleAction::Show);
        assert!(window.visible.get());
    }

    #[test]
    fn press_on_visible_unfocused_window_brings_it_back() {
        let window = FakeWindow::new(true, false);
        assert_eq!(apply_shortcut(&window, true), ToggleAction::Show);
        assert_eq!(window.calls(), ["center", "show", "focus", "emit"]);
    }

    #[test]
    fn release_does_nothing() {
        let window = FakeWindow::new(true, true);
        assert_eq!(apply_shortcut(&window, false), ToggleAction::Ignore);
        assert!(window.calls().is_empty());
        assert!(window.visible.get());
    }

    #[test]
    fn unreadable_state_counts_as_hidden() {
        let window = FakeWindow {
            unreadable: true,
            ..FakeWindow::default()
        };
        assert_eq!(apply_shortcut(&window, true), ToggleAction::Show);
        assert_eq!(window.calls(), ["center", "show", "focus", "emit"]);
    }

    #[test]
    fn failed_centering_still_shows_the_window() {
        let window = FakeWindow {
            fail: Some("center"),
            ..FakeWindow::default()
        };
        assert_eq!(apply_shortcut(&window, true), ToggleAction::Show);
        assert_eq!(window.calls(), ["center", "show", "focus", "emit"]);
    }

    #[test]
    fn failed_show_stops_the_sequence() {
        let window = FakeWindow {
            fail: Some("show"),
            ..FakeWindow::default()
        };
        assert_eq!(apply_shortcut(&window, true), ToggleAction::Show);
        assert_eq!(window.calls(), ["center", "show"]);
    }

    #[test]
    fn failed_hide_is_reported_without_panicking() {
        let window = FakeWindow {
            fail: Some("hide"),
            ..FakeWindow::new(true, true)
        };
        assert_eq!(apply_shortcut(&window, true), ToggleAction::Hide);
        assert_eq!(window.calls(), ["hide"]);
    }

    #[test]
    fn reveal_does_not_notify_the_page() {
        let window = FakeWindow::new(false, false);
        assert!(reveal(&window).is_ok());
        assert_eq!(window.calls(), ["center", "show", "focus"]);
        assert!(window.visible.get() && window.focused.get());

        let window = FakeWindow {
            fail: Some("center"),
            ..FakeWindow::default()
        };
        assert!(reveal(&window).is_ok());
        assert_eq!(window.calls(), ["center", "show", "focus"]);

        let window = FakeWindow {
            fail: Some("show"),
            ..FakeWindow::default()
        };
        assert!(reveal(&window).is_err());
        assert_eq!(window.calls(), ["center", "show"]);
    }

    #[test]
    fn status_names_the_shortcut() {
        let status = serde_json::to_value(ShortcutStatus::new(false)).unwrap();
        assert_eq!(
            status,
            serde_json::json!({ "registered": false, "shortcut": SHORTCUT })
        );
        assert!(ShortcutStatus::new(true).registered);
    }

    #[test]
    fn window_events() {
        use WindowEventAction as A;
        use WindowEventKind as K;
        assert_eq!(
            window_event_action(CAPTURE_WINDOW, K::CloseRequested),
            A::HideInsteadOfClose
        );
        assert_eq!(window_event_action(MAIN_WINDOW, K::CloseRequested), A::None);
        assert_eq!(window_event_action(MAIN_WINDOW, K::Destroyed), A::Exit);
        assert_eq!(window_event_action(CAPTURE_WINDOW, K::Destroyed), A::None);
        assert_eq!(window_event_action(MAIN_WINDOW, K::Other), A::None);
        assert_eq!(window_event_action(CAPTURE_WINDOW, K::Other), A::None);
    }

    fn mock_app(with_capture: bool) -> tauri::App<MockRuntime> {
        let app = mock_builder().build(mock_context(noop_assets())).unwrap();
        WebviewWindowBuilder::new(&app, MAIN_WINDOW, Default::default())
            .build()
            .unwrap();
        if with_capture {
            WebviewWindowBuilder::new(&app, CAPTURE_WINDOW, Default::default())
                .build()
                .unwrap();
        }
        app
    }

    #[test]
    fn shortcut_press_notifies_the_capture_window_only() {
        let app = mock_app(true);
        let (tx, rx) = mpsc::channel();
        let capture = app.get_webview_window(CAPTURE_WINDOW).unwrap();
        let to_capture = tx.clone();
        capture.listen(SHOWN_EVENT, move |_| {
            let _ = to_capture.send(CAPTURE_WINDOW);
        });
        let main = app.get_webview_window(MAIN_WINDOW).unwrap();
        main.listen(SHOWN_EVENT, move |_| {
            let _ = tx.send(MAIN_WINDOW);
        });

        // The mock window reports visible but not focused, so a press shows it.
        assert_eq!(handle_shortcut(app.handle(), true), ToggleAction::Show);
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            CAPTURE_WINDOW
        );
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());

        assert_eq!(handle_shortcut(app.handle(), false), ToggleAction::Ignore);
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
    }

    #[test]
    fn shortcut_without_capture_window_is_ignored() {
        let app = mock_app(false);
        assert_eq!(handle_shortcut(app.handle(), true), ToggleAction::Ignore);
    }

    #[test]
    fn config_declares_a_hidden_reusable_capture_window() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let windows = config["app"]["windows"].as_array().unwrap();
        let capture = windows
            .iter()
            .find(|w| w["label"] == CAPTURE_WINDOW)
            .expect("capture window declared");
        assert_eq!(capture["url"], "capture.html");
        for (key, value) in [
            ("visible", false),
            ("decorations", false),
            ("alwaysOnTop", true),
            ("skipTaskbar", true),
            ("resizable", false),
            ("center", true),
        ] {
            assert_eq!(capture[key], value, "{key}");
        }
        assert!(windows.iter().any(|w| w["label"] == MAIN_WINDOW));
    }

    #[test]
    fn capture_capability_is_minimal() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/capture.json")).unwrap();
        assert_eq!(capability["windows"], serde_json::json!([CAPTURE_WINDOW]));
        let mut granted: Vec<&str> = capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap())
            .collect();
        granted.sort_unstable();
        assert_eq!(
            granted,
            [
                "allow-capture-hide",
                "allow-capture-request-projects",
                "allow-capture-set-height",
                "allow-capture-show",
                "allow-capture-submit",
                "core:event:allow-listen",
                "core:event:allow-unlisten",
            ]
        );
        let build = include_str!("../build.rs");
        for cmd in CAPTURE_COMMANDS {
            assert!(build.contains(&format!("\"{cmd}\"")), "{cmd}");
        }

        let main: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert_eq!(main["windows"], serde_json::json!([MAIN_WINDOW]));
        let main_grants = main["permissions"].as_array().unwrap();
        for cmd in CAPTURE_COMMANDS {
            let permission = format!("allow-{}", cmd.replace('_', "-"));
            assert!(
                !main_grants.iter().any(|p| p == &permission),
                "{permission}"
            );
        }
    }

    const CAPTURE_COMMANDS: [&str; 5] = [
        "capture_submit",
        "capture_request_projects",
        "capture_hide",
        "capture_show",
        "capture_set_height",
    ];

    fn submit(id: &str, text: &str, project: &str) -> CaptureSubmit {
        CaptureSubmit {
            id: id.to_owned(),
            kind: CaptureKind::Task,
            text: text.to_owned(),
            project: project.to_owned(),
        }
    }

    fn kind_of(result: AppResult<()>) -> &'static str {
        result.unwrap_err().kind()
    }

    #[test]
    fn valid_submits_pass() {
        assert_eq!(validate_submit(&submit("a", "x", "inbox")), Ok(()));
        let id = "a-Z9".repeat(16);
        assert_eq!(id.len(), MAX_ID_LEN);
        let text = "é".repeat(MAX_TEXT_LEN / 2);
        assert_eq!(text.len(), MAX_TEXT_LEN);
        let project = "p".repeat(MAX_PROJECT_LEN);
        assert_eq!(validate_submit(&submit(&id, &text, &project)), Ok(()));
        assert_eq!(
            validate_submit(&submit("1", "  buy milk ", "Café . notes")),
            Ok(())
        );
    }

    #[test]
    fn invalid_ids_are_rejected() {
        let long = "a".repeat(MAX_ID_LEN + 1);
        for id in ["", "a b", "a_b", "a/b", "é", "a\0", long.as_str()] {
            assert_eq!(
                kind_of(validate_submit(&submit(id, "x", "inbox"))),
                "InvalidPath",
                "{id:?}"
            );
        }
    }

    #[test]
    fn blank_or_oversized_text_is_rejected() {
        for text in ["", "   ", "\n\t "] {
            let err = validate_submit(&submit("a", text, "inbox")).unwrap_err();
            assert_eq!(err.kind(), "InvalidPath");
        }
        let long = "x".repeat(MAX_TEXT_LEN + 1);
        let err = validate_submit(&submit("a", &long, "inbox")).unwrap_err();
        assert_eq!(err.kind(), "TooLarge");
        assert!(!err.to_string().contains("xxx"));
    }

    #[test]
    fn invalid_projects_are_rejected() {
        let long = "p".repeat(MAX_PROJECT_LEN + 1);
        for project in ["", "a/b", "a\\b", "a\0b", "/", long.as_str()] {
            assert_eq!(
                kind_of(validate_submit(&submit("a", "x", project))),
                "InvalidPath",
                "{project:?}"
            );
        }
    }

    #[test]
    fn submit_round_trips_as_camel_case_json() {
        let json = serde_json::json!({
            "id": "c1", "kind": "note", "text": "Idea", "project": "inbox"
        });
        let parsed: CaptureSubmit = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(parsed.kind, CaptureKind::Note);
        assert_eq!(serde_json::to_value(&parsed).unwrap(), json);
        let task = serde_json::to_value(CaptureKind::Task).unwrap();
        assert_eq!(task, "task");
        let bad = serde_json::json!({
            "id": "c1", "kind": "Task", "text": "x", "project": "inbox"
        });
        assert!(serde_json::from_value::<CaptureSubmit>(bad).is_err());
    }

    #[test]
    fn only_the_capture_window_may_call() {
        assert_eq!(ensure_capture_caller(CAPTURE_WINDOW), Ok(()));
        for label in [MAIN_WINDOW, "", "Capture", "capture2"] {
            assert_eq!(kind_of(ensure_capture_caller(label)), "PermissionDenied");
        }
    }

    #[test]
    fn heights_are_clamped() {
        assert_eq!(clamp_height(0), MIN_HEIGHT);
        assert_eq!(clamp_height(MIN_HEIGHT), MIN_HEIGHT);
        assert_eq!(clamp_height(200), 200);
        assert_eq!(clamp_height(MAX_HEIGHT), MAX_HEIGHT);
        assert_eq!(clamp_height(u32::MAX), MAX_HEIGHT);
    }

    mod ipc {
        use super::*;
        use tauri::ipc::{CallbackFn, InvokeBody};
        use tauri::test::{INVOKE_KEY, get_ipc_response};
        use tauri::webview::InvokeRequest;

        fn app(with_capture: bool) -> tauri::App<MockRuntime> {
            let app = mock_builder()
                .invoke_handler(crate::commands::handler())
                .build(mock_context(noop_assets()))
                .unwrap();
            WebviewWindowBuilder::new(&app, MAIN_WINDOW, Default::default())
                .build()
                .unwrap();
            if with_capture {
                WebviewWindowBuilder::new(&app, CAPTURE_WINDOW, Default::default())
                    .build()
                    .unwrap();
            }
            app
        }

        fn invoke(
            app: &tauri::App<MockRuntime>,
            from: &str,
            cmd: &str,
            args: serde_json::Value,
        ) -> Result<serde_json::Value, serde_json::Value> {
            let webview = app.get_webview_window(from).unwrap();
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
            get_ipc_response(&webview, request).map(|body| body.deserialize().unwrap())
        }

        fn error_kind(result: Result<serde_json::Value, serde_json::Value>) -> String {
            let err = result.unwrap_err();
            assert!(err["message"].is_string(), "{err}");
            err["kind"].as_str().unwrap().to_owned()
        }

        /// Records which windows receive `event`.
        fn record(
            app: &tauri::App<MockRuntime>,
            event: &'static str,
        ) -> mpsc::Receiver<(&'static str, String)> {
            let (tx, rx) = mpsc::channel();
            for label in [MAIN_WINDOW, CAPTURE_WINDOW] {
                let tx = tx.clone();
                app.get_webview_window(label)
                    .unwrap()
                    .listen(event, move |e| {
                        let _ = tx.send((label, e.payload().to_owned()));
                    });
            }
            rx
        }

        fn valid_payload() -> serde_json::Value {
            serde_json::json!({
                "payload": { "id": "c-1", "kind": "task", "text": "Buy milk", "project": "inbox" }
            })
        }

        #[test]
        fn submit_is_relayed_to_the_main_window_only() {
            let app = app(true);
            let rx = record(&app, SUBMIT_EVENT);
            let result = invoke(&app, CAPTURE_WINDOW, "capture_submit", valid_payload());
            assert_eq!(result, Ok(serde_json::Value::Null));
            let (to, payload) = rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(to, MAIN_WINDOW);
            let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
            assert_eq!(payload, valid_payload()["payload"]);
            assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
        }

        #[test]
        fn invalid_submit_is_not_relayed() {
            let app = app(true);
            let rx = record(&app, SUBMIT_EVENT);
            let mut args = valid_payload();
            args["payload"]["project"] = "../etc".into();
            assert_eq!(
                error_kind(invoke(&app, CAPTURE_WINDOW, "capture_submit", args)),
                "InvalidPath"
            );
            assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
        }

        #[test]
        fn projects_request_is_relayed_to_the_main_window_only() {
            let app = app(true);
            let rx = record(&app, PROJECTS_REQUEST_EVENT);
            let result = invoke(
                &app,
                CAPTURE_WINDOW,
                "capture_request_projects",
                serde_json::json!({}),
            );
            assert_eq!(result, Ok(serde_json::Value::Null));
            let (to, payload) = rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!((to, payload.as_str()), (MAIN_WINDOW, "{}"));
            assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
        }

        #[test]
        fn show_does_not_emit_the_shown_event() {
            let app = app(true);
            let rx = record(&app, SHOWN_EVENT);
            assert_eq!(
                invoke(&app, CAPTURE_WINDOW, "capture_show", serde_json::json!({})),
                Ok(serde_json::Value::Null)
            );
            assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
        }

        #[test]
        fn window_commands_work_from_the_capture_window() {
            let app = app(true);
            let none = serde_json::json!({});
            assert_eq!(
                invoke(&app, CAPTURE_WINDOW, "capture_hide", none),
                Ok(serde_json::Value::Null)
            );
            for height in [0, 120, 10_000] {
                let args = serde_json::json!({ "height": height });
                assert_eq!(
                    invoke(&app, CAPTURE_WINDOW, "capture_set_height", args),
                    Ok(serde_json::Value::Null)
                );
            }
            let negative = serde_json::json!({ "height": -1 });
            assert!(invoke(&app, CAPTURE_WINDOW, "capture_set_height", negative).is_err());
        }

        #[test]
        fn other_windows_are_refused() {
            let app = app(true);
            let submits = record(&app, SUBMIT_EVENT);
            let requests = record(&app, PROJECTS_REQUEST_EVENT);
            for (cmd, args) in [
                ("capture_submit", valid_payload()),
                ("capture_request_projects", serde_json::json!({})),
                ("capture_hide", serde_json::json!({})),
                ("capture_show", serde_json::json!({})),
                ("capture_set_height", serde_json::json!({ "height": 100 })),
            ] {
                assert_eq!(
                    error_kind(invoke(&app, MAIN_WINDOW, cmd, args)),
                    "PermissionDenied",
                    "{cmd}"
                );
            }
            assert!(submits.recv_timeout(Duration::from_millis(200)).is_err());
            assert!(requests.try_recv().is_err());
        }

        #[test]
        fn missing_capture_window_is_reported() {
            let app = app(false);
            assert_eq!(capture_window(app.handle()).unwrap_err().kind(), "NotFound");
            assert!(capture_window(self::app(true).handle()).is_ok());
        }

        #[test]
        fn window_errors_name_the_action() {
            let err = window_error("hide", tauri::Error::WindowNotFound);
            assert_eq!(err.kind(), "Io");
            assert!(
                err.to_string()
                    .starts_with("could not hide the quick capture window")
            );
        }
    }
}
