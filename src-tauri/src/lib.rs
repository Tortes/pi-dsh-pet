use std::sync::{Arc, Mutex};
use tauri::{Manager, State};

const WINDOW_WIDTH: f64 = 640.0;
const WINDOW_HEIGHT: f64 = 420.0;

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
    let mut args = std::env::args().skip(1);
    let port = args.next().and_then(|v| v.parse::<u16>().ok()).unwrap_or(0);
    let size = match args.next().as_deref() {
        Some("small") => 260,
        Some("large") => 540,
        _ => 400,
    };
    RuntimeConfig { port, size }
}

#[tauri::command]
fn show_pet(window: tauri::WebviewWindow) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())
}

#[tauri::command]
fn close_pet(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg(target_os = "windows")]
fn start_hit_test_loop(app: tauri::AppHandle, state: PetState) {
    use std::{thread, time::Duration};
    use tauri::PhysicalPosition;
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    thread::spawn(move || {
        let mut last_inside = false;

        loop {
            let mut point = POINT { x: 0, y: 0 };
            unsafe { GetCursorPos(&mut point) };

            if let Some(window) = app.get_webview_window("main") {
                let bounds = state.bounds.lock().map(|b| *b).unwrap_or_default();
                let origin = window.outer_position().unwrap_or(PhysicalPosition::new(0, 0));
                let scale = window.scale_factor().unwrap_or(1.0);

                // DOM bounds are CSS pixels relative to the WebView. Windows cursor
                // coordinates and Tauri window positions are physical pixels.
                let left = origin.x as f64 + bounds.left * scale;
                let top = origin.y as f64 + bounds.top * scale;
                let right = origin.x as f64 + bounds.right * scale;
                let bottom = origin.y as f64 + bounds.bottom * scale;

                let inside = (point.x as f64) >= left
                    && (point.x as f64) <= right
                    && (point.y as f64) >= top
                    && (point.y as f64) <= bottom;

                if inside != last_inside {
                    let _ = window.set_ignore_cursor_events(!inside);
                    last_inside = inside;
                }
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
            set_pet_bounds,
            runtime_config,
            show_pet,
            close_pet
        ])
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_always_on_top(true);
                let _ = window.set_ignore_cursor_events(true);

                // Place the compact pet window near the lower-right corner of
                // the primary display. The frontend itself stays transparent.
                if let Ok(Some(monitor)) = window.primary_monitor() {
                    let position = monitor.position();
                    let size = monitor.size();
                    let x = position.x + size.width as i32 - WINDOW_WIDTH as i32 - 24;
                    let y = position.y + size.height as i32 - WINDOW_HEIGHT as i32 - 64;
                    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
                }
            }

            start_hit_test_loop(app.handle().clone(), state.clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Pi desktop pet");
}
