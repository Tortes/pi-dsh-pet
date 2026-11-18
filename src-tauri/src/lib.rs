use std::sync::{Arc, Mutex};
use tauri::{Manager, State};

#[derive(Clone, Default)]
struct PetState {
    bounds: Arc<Mutex<Bounds>>,
}

#[derive(Clone, Copy, Default)]
struct Bounds {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

#[tauri::command]
fn set_ignore_cursor_events(window: tauri::WebviewWindow, ignore: bool) -> Result<(), String> {
    window.set_ignore_cursor_events(ignore).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_pet_bounds(
    state: State<'_, PetState>,
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
) -> Result<(), String> {
    let mut bounds = state.bounds.lock().map_err(|_| "bounds mutex poisoned")?;
    *bounds = Bounds { left, top, right, bottom };
    Ok(())
}

#[derive(serde::Serialize)]
struct RuntimeConfig {
    port: u16,
    size: u32,
}

#[tauri::command]
fn runtime_config() -> RuntimeConfig {
    RuntimeConfig {
        port: std::env::var("PI_DSH_PET_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0),
        size: std::env::var("PI_DSH_PET_SIZE")
            .ok()
            .and_then(|v| match v.as_str() {
                "small" => Some(260),
                "large" => Some(540),
                _ => Some(400),
            })
            .unwrap_or(400),
    }
}

#[tauri::command]
fn close_pet(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg(target_os = "windows")]
fn start_hit_test_loop(app: tauri::AppHandle, state: PetState) {
    use std::{thread, time::Duration};
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    thread::spawn(move || {
        let mut last_inside = false;

        loop {
            let mut point = POINT { x: 0, y: 0 };
            unsafe { GetCursorPos(&mut point) };

            let bounds = state.bounds.lock().map(|b| *b).unwrap_or_default();
            let inside = (point.x as f64) >= bounds.left
                && (point.x as f64) <= bounds.right
                && (point.y as f64) >= bounds.top
                && (point.y as f64) <= bounds.bottom;

            if inside != last_inside {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_ignore_cursor_events(!inside);
                }
                last_inside = inside;
            }

            thread::sleep(Duration::from_millis(25));
        }
    });
}

#[cfg(not(target_os = "windows"))]
fn start_hit_test_loop(_app: tauri::AppHandle, _state: PetState) {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = PetState::default();

    tauri::Builder::default()
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![
            set_ignore_cursor_events,
            set_pet_bounds,
            runtime_config,
            close_pet
        ])
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_always_on_top(true);
                let _ = window.set_ignore_cursor_events(true);
            }
            start_hit_test_loop(app.handle().clone(), state.clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Pi desktop pet");
}
