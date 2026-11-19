use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{Manager, State};

const PET_PADDING: f64 = 20.0;
const GRAVITY_DEFAULT: f64 = 1400.0;
const RESTITUTION_DEFAULT: f64 = 0.78;
const FRICTION_DEFAULT: f64 = 2.5;
const MAX_THROW_SPEED: f64 = 3600.0;

#[derive(Clone, Default)]
struct PetState {
    bounds: Arc<Mutex<Bounds>>,
    physics: Arc<Mutex<PhysicsConfig>>,
    menu_open: Arc<Mutex<bool>>,
}

#[derive(Clone, Copy, Default)]
struct Bounds {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PhysicsConfig {
    gravity: f64,
    restitution: f64,
    ground_friction: f64,
    ceiling_bounce: bool,
    throw_power: f64,
    drag_spring: bool,
}

impl Default for PhysicsConfig {
    fn default() -> Self {
        Self {
            gravity: GRAVITY_DEFAULT,
            restitution: RESTITUTION_DEFAULT,
            ground_friction: FRICTION_DEFAULT,
            ceiling_bounce: true,
            throw_power: 1.0,
            drag_spring: true,
        }
    }
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

#[tauri::command]
fn set_menu_open(state: State<'_, PetState>, open: bool) -> Result<(), String> {
    *state.menu_open.lock().map_err(|_| "menu mutex poisoned")? = open;
    Ok(())
}

#[tauri::command]
fn set_physics(state: State<'_, PetState>, physics: PhysicsConfig) -> Result<(), String> {
    if !physics.gravity.is_finite()
        || physics.gravity < 0.0
        || !physics.restitution.is_finite()
        || !(0.0..=1.0).contains(&physics.restitution)
        || !physics.ground_friction.is_finite()
        || physics.ground_friction < 0.0
        || !physics.throw_power.is_finite()
        || physics.throw_power <= 0.0
    {
        return Err("invalid pet physics configuration".into());
    }
    *state.physics.lock().map_err(|_| "physics mutex poisoned")? = physics;
    Ok(())
}

#[derive(serde::Serialize)]
struct RuntimeConfig {
    port: u16,
    size: u32,
}

fn requested_size() -> u32 {
    match std::env::args().nth(2).as_deref() {
        Some("small") => 260,
        Some("large") => 540,
        _ => 400,
    }
}

#[tauri::command]
fn runtime_config() -> RuntimeConfig {
    let port = std::env::args()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(0);
    RuntimeConfig { port, size: requested_size() }
}

#[tauri::command]
fn show_pet(window: tauri::WebviewWindow) -> Result<(), String> {
    window.show().map_err(|error| error.to_string())
}

#[tauri::command]
fn close_pet(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, PartialEq)]
struct ScreenRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[cfg(target_os = "windows")]
impl ScreenRect {
    fn right(self) -> f64 { self.x + self.width }
    fn bottom(self) -> f64 { self.y + self.height }
    fn contains(self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.right() && y >= self.y && y < self.bottom()
    }
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy)]
struct DragSample {
    at: Instant,
    x: f64,
    y: f64,
}

#[cfg(target_os = "windows")]
struct FlightState {
    x: f64,
    y: f64,
    vx: f64,
    vy: f64,
    screen: ScreenRect,
}

#[cfg(target_os = "windows")]
fn monitor_rects(window: &tauri::WebviewWindow) -> Vec<ScreenRect> {
    window.available_monitors().unwrap_or_default().iter().map(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        ScreenRect {
            x: position.x as f64,
            y: position.y as f64,
            width: size.width as f64,
            height: size.height as f64,
        }
    }).collect()
}

#[cfg(target_os = "windows")]
fn clamp_to_bounds(value: f64, min: f64, max: f64) -> f64 {
    if max < min { (min + max) / 2.0 } else { value.clamp(min, max) }
}

#[cfg(target_os = "windows")]
fn nearest_screen(screens: &[ScreenRect], x: f64, y: f64) -> Option<ScreenRect> {
    if let Some(screen) = screens.iter().copied().find(|screen| screen.contains(x, y)) {
        return Some(screen);
    }
    screens.iter().copied().min_by(|a, b| {
        let distance = |r: ScreenRect| {
            let dx = (r.x - x).max(0.0).max(x - r.right());
            let dy = (r.y - y).max(0.0).max(y - r.bottom());
            dx * dx + dy * dy
        };
        distance(*a).total_cmp(&distance(*b))
    })
}

#[cfg(target_os = "windows")]
fn contact_velocity(vx: f64, vy: f64, edge: &str, physics: PhysicsConfig, dt: f64) -> (f64, f64) {
    let friction = (1.0 - physics.ground_friction * dt).max(0.0);
    match edge {
        "left" => (if vx.abs() < 40.0 { 0.0 } else { vx.abs() * physics.restitution }, vy * friction),
        "right" => (if vx.abs() < 40.0 { 0.0 } else { -vx.abs() * physics.restitution }, vy * friction),
        "ceiling" => (vx * friction, if vy.abs() < 40.0 { 0.0 } else { vy.abs() * physics.restitution }),
        _ => (vx * friction, if vy.abs() < 40.0 { 0.0 } else { -vy.abs() * physics.restitution }),
    }
}

#[cfg(target_os = "windows")]
fn release_velocity(trail: &VecDeque<DragSample>, now: Instant, throw_power: f64) -> (f64, f64) {
    let samples: Vec<DragSample> = trail.iter().copied()
        .filter(|sample| now.duration_since(sample.at).as_millis() <= 150)
        .collect();
    if samples.len() < 2 { return (0.0, 0.0); }
    let first = samples[0];
    let last = *samples.last().unwrap();
    let span = last.at.duration_since(first.at).as_secs_f64();
    if span < 0.020 { return (0.0, 0.0); }
    let base_vx = (last.x - first.x) / span;
    let base_vy = (last.y - first.y) / span;
    let base_speed = base_vx.hypot(base_vy);
    if base_speed < 1e-6 { return (0.0, 0.0); }

    let mut previous = first;
    let mut segment_speeds: Vec<(f64, Instant)> = Vec::new();
    for sample in samples.iter().skip(1) {
        let dt = sample.at.duration_since(previous.at).as_secs_f64();
        if dt >= 0.008 {
            segment_speeds.push(((sample.x - previous.x).hypot(sample.y - previous.y) / dt, sample.at));
            previous = *sample;
        }
    }
    let peak = segment_speeds.iter().map(|segment| segment.0).fold(base_speed, f64::max);
    let acceleration = if segment_speeds.len() >= 2 {
        let first_segment = segment_speeds[0];
        let last_segment = *segment_speeds.last().unwrap();
        (last_segment.0 - first_segment.0)
            / last_segment.1.duration_since(first_segment.1).as_secs_f64().max(0.020)
    } else { 0.0 };
    let raw_speed = (0.5 * base_speed + 0.5 * peak)
        * (1.0 + (acceleration.max(0.0) / 8000.0).min(1.0) * 0.6);
    let speed = MAX_THROW_SPEED * (1.0 - (-raw_speed / MAX_THROW_SPEED).exp()) * throw_power;
    if speed < 500.0 { return (0.0, 0.0); }
    (base_vx / base_speed * speed, base_vy / base_speed * speed)
}

#[cfg(target_os = "windows")]
fn start_pointer_loop(app: tauri::AppHandle, state: PetState) {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    thread::spawn(move || {
        let mut dragging = false;
        let mut drag_offset = (0.0_f64, 0.0_f64);
        let mut drag_position = (0.0_f64, 0.0_f64);
        let mut drag_velocity = (0.0_f64, 0.0_f64);
        let mut last_drag_frame = Instant::now();
        let mut trail = VecDeque::<DragSample>::new();
        let mut flight: Option<FlightState> = None;
        let mut last_frame = Instant::now();
        let mut last_monitor_check = Instant::now();
        let mut last_hit_inside = false;

        loop {
            let Some(window) = app.get_webview_window("main") else { break; };
            let mut point = POINT { x: 0, y: 0 };
            unsafe { GetCursorPos(&mut point); }
            let cursor_x = point.x as f64;
            let cursor_y = point.y as f64;
            let now = Instant::now();
            let pressed = unsafe { GetAsyncKeyState(VK_LBUTTON as i32) } < 0;
            let bounds = state.bounds.lock().map(|value| *value).unwrap_or_default();
            let origin = window.outer_position().unwrap_or(tauri::PhysicalPosition::new(0, 0));
            let scale = window.scale_factor().unwrap_or(1.0);
            let body_left = origin.x as f64 + bounds.left * scale;
            let body_top = origin.y as f64 + bounds.top * scale;
            let body_right = origin.x as f64 + bounds.right * scale;
            let body_bottom = origin.y as f64 + bounds.bottom * scale;
            // Keep the whole transparent host window interactive while its HTML context menu is open.
            // The menu can extend beyond the sprite hit box; otherwise native click-through would eat its clicks.
            let menu_open = state.menu_open.lock().map(|value| *value).unwrap_or(false);
            let inside = menu_open || (
                cursor_x >= body_left && cursor_x <= body_right
                    && cursor_y >= body_top && cursor_y <= body_bottom
            );

            if !dragging && pressed && inside {
                dragging = true;
                flight = None;
                drag_offset = (cursor_x - origin.x as f64, cursor_y - origin.y as f64);
                drag_position = (origin.x as f64, origin.y as f64);
                drag_velocity = (0.0, 0.0);
                last_drag_frame = now;
                trail.clear();
                trail.push_back(DragSample { at: now, x: cursor_x, y: cursor_y });
                let _ = window.set_ignore_cursor_events(false);
            }

            if dragging && pressed {
                let target_x = cursor_x - drag_offset.0;
                let target_y = cursor_y - drag_offset.1;
                let physics = state.physics.lock().map(|value| *value).unwrap_or_default();
                let drag_dt = now.duration_since(last_drag_frame).as_secs_f64().clamp(0.0, 0.05);
                if physics.drag_spring {
                    drag_velocity.0 += ((target_x - drag_position.0) * 200.0 - drag_velocity.0 * 30.0)
                        * physics.throw_power * drag_dt;
                    drag_velocity.1 += ((target_y - drag_position.1) * 200.0 - drag_velocity.1 * 30.0)
                        * physics.throw_power * drag_dt;
                    drag_position.0 += drag_velocity.0 * drag_dt;
                    drag_position.1 += drag_velocity.1 * drag_dt;
                } else {
                    drag_position = (target_x, target_y);
                    drag_velocity = (0.0, 0.0);
                }
                let _ = window.set_position(tauri::PhysicalPosition::new(
                    drag_position.0.round() as i32,
                    drag_position.1.round() as i32,
                ));
                last_drag_frame = now;
                trail.push_back(DragSample { at: now, x: cursor_x, y: cursor_y });
                while trail.front().is_some_and(|sample| now.duration_since(sample.at).as_millis() > 200) {
                    trail.pop_front();
                }
                last_hit_inside = true;
            } else if dragging {
                dragging = false;
                let physics = state.physics.lock().map(|value| *value).unwrap_or_default();
                let (vx, vy) = release_velocity(&trail, now, physics.throw_power);
                if vx.abs() > 0.0 || vy.abs() > 0.0 {
                    let position = window.outer_position().unwrap_or(tauri::PhysicalPosition::new(0, 0));
                    let screens = monitor_rects(&window);
                    let center_x = position.x as f64 + (bounds.left + bounds.right) * scale / 2.0;
                    let center_y = position.y as f64 + (bounds.top + bounds.bottom) * scale / 2.0;
                    if let Some(screen) = nearest_screen(&screens, center_x, center_y) {
                        flight = Some(FlightState {
                            x: position.x as f64,
                            y: position.y as f64,
                            vx,
                            vy,
                            screen,
                        });
                    }
                } else {
                    // A gentle release should not leave the sprite lagging behind the final pointer position.
                    let final_x = (cursor_x - drag_offset.0).round() as i32;
                    let final_y = (cursor_y - drag_offset.1).round() as i32;
                    let _ = window.set_position(tauri::PhysicalPosition::new(final_x, final_y));
                }
                trail.clear();
            }

            if !dragging {
                if let Some(ref mut body) = flight {
                    let dt = now.duration_since(last_frame).as_secs_f64().clamp(0.0, 0.05);
                    let physics = state.physics.lock().map(|value| *value).unwrap_or_default();
                    let screens = monitor_rects(&window);
                    let left_offset = bounds.left * scale;
                    let top_offset = bounds.top * scale;
                    let right_offset = bounds.right * scale;
                    let bottom_offset = bounds.bottom * scale;
                    let steps = ((body.vx.hypot(body.vy) * dt / 8.0).ceil() as usize).clamp(1, 64);
                    let step_dt = if steps > 0 { dt / steps as f64 } else { dt };

                    for _ in 0..steps {
                        body.vy += physics.gravity * scale * step_dt;
                        body.x += body.vx * step_dt;
                        body.y += body.vy * step_dt;

                        let center_x = body.x + (left_offset + right_offset) / 2.0;
                        let center_y = body.y + (top_offset + bottom_offset) / 2.0;
                        if !screens.contains(&body.screen) {
                            if let Some(screen) = nearest_screen(&screens, center_x, center_y) {
                                body.screen = screen;
                            } else {
                                break;
                            }
                        }
                        if let Some(screen) = screens.iter().copied().find(|screen| screen.contains(center_x, center_y)) {
                            body.screen = screen;
                        }
                        let screen = body.screen;
                        let min_x = screen.x - left_offset;
                        let max_x = screen.right() - right_offset;

                        if body.x < min_x {
                            let neighbor = screens.iter().any(|candidate| candidate.contains(screen.x - 1.0, center_y));
                            if !neighbor {
                                body.x = min_x;
                                (body.vx, body.vy) = contact_velocity(body.vx, body.vy, "left", physics, step_dt);
                            }
                        } else if body.x > max_x {
                            let neighbor = screens.iter().any(|candidate| candidate.contains(screen.right(), center_y));
                            if !neighbor {
                                body.x = max_x;
                                (body.vx, body.vy) = contact_velocity(body.vx, body.vy, "right", physics, step_dt);
                            }
                        }

                        let center_x = body.x + (left_offset + right_offset) / 2.0;
                        let center_y = body.y + (top_offset + bottom_offset) / 2.0;
                        if let Some(next_screen) = screens.iter().copied().find(|candidate| candidate.contains(center_x, center_y)) {
                            body.screen = next_screen;
                        }
                        let screen = body.screen;
                        let min_y = screen.y - top_offset;
                        let max_y = screen.bottom() - bottom_offset;
                        if body.y < min_y && physics.ceiling_bounce {
                            let neighbor = screens.iter().any(|candidate| candidate.contains(center_x, screen.y - 1.0));
                            if !neighbor {
                                body.y = min_y;
                                (body.vx, body.vy) = contact_velocity(body.vx, body.vy, "ceiling", physics, step_dt);
                            }
                        } else if body.y > max_y {
                            let neighbor = screens.iter().any(|candidate| candidate.contains(center_x, screen.bottom()));
                            if !neighbor {
                                body.y = max_y;
                                (body.vx, body.vy) = contact_velocity(body.vx, body.vy, "floor", physics, step_dt);
                            }
                        }
                    }

                    let _ = window.set_position(tauri::PhysicalPosition::new(body.x.round() as i32, body.y.round() as i32));
                    let floor_y = body.screen.bottom() - bottom_offset;
                    let ceiling_y = body.screen.y - top_offset;
                    let left_x = body.screen.x - left_offset;
                    let right_x = body.screen.right() - right_offset;
                    let at_contact = (body.y - floor_y).abs() < 1.0
                        || (body.x - left_x).abs() < 1.0
                        || (body.x - right_x).abs() < 1.0
                        || (physics.ceiling_bounce && (body.y - ceiling_y).abs() < 1.0);
                    if at_contact && body.vx.abs() < 15.0 && body.vy.abs() < 15.0 {
                        flight = None;
                    }
                }
                if flight.is_none() && now.duration_since(last_monitor_check).as_millis() >= 750 {
                    last_monitor_check = now;
                    let screens = monitor_rects(&window);
                    let scale = window.scale_factor().unwrap_or(1.0);
                    let origin = window.outer_position().unwrap_or(tauri::PhysicalPosition::new(0, 0));
                    let left_offset = bounds.left * scale;
                    let top_offset = bounds.top * scale;
                    let right_offset = bounds.right * scale;
                    let bottom_offset = bounds.bottom * scale;
                    let center_x = origin.x as f64 + (left_offset + right_offset) / 2.0;
                    let center_y = origin.y as f64 + (top_offset + bottom_offset) / 2.0;
                    if !screens.iter().any(|screen| screen.contains(center_x, center_y)) {
                        if let Some(screen) = nearest_screen(&screens, center_x, center_y) {
                            let min_x = screen.x - left_offset;
                            let max_x = screen.right() - right_offset;
                            let min_y = screen.y - top_offset;
                            let max_y = screen.bottom() - bottom_offset;
                            let x = clamp_to_bounds(origin.x as f64, min_x, max_x);
                            let y = clamp_to_bounds(origin.y as f64, min_y, max_y);
                            let _ = window.set_position(tauri::PhysicalPosition::new(x.round() as i32, y.round() as i32));
                        }
                    }
                }
                if inside != last_hit_inside {
                    let _ = window.set_ignore_cursor_events(!inside);
                    last_hit_inside = inside;
                }
            }

            last_frame = now;
            thread::sleep(Duration::from_millis(16));
        }
    });
}

#[cfg(not(target_os = "windows"))]
fn start_pointer_loop(_app: tauri::AppHandle, _state: PetState) {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = PetState::default();

    tauri::Builder::default()
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![
            set_pet_bounds,
            set_physics,
            set_menu_open,
            runtime_config,
            show_pet,
            close_pet
        ])
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                let size = requested_size() as f64;
                let width = size + PET_PADDING * 2.0;
                let height = size * 9.0 / 16.0 + PET_PADDING * 2.0;
                let _ = window.set_size(tauri::LogicalSize::new(width, height));
                let _ = window.set_always_on_top(true);
                let _ = window.set_ignore_cursor_events(true);

                if let Ok(Some(monitor)) = window.primary_monitor() {
                    let position = monitor.position();
                    let monitor_size = monitor.size();
                    let scale = monitor.scale_factor();
                    let x = position.x + monitor_size.width as i32 - (width * scale) as i32 - (24.0 * scale) as i32;
                    let y = position.y + monitor_size.height as i32 - (height * scale) as i32 - (64.0 * scale) as i32;
                    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
                }
            }

            start_pointer_loop(app.handle().clone(), state.clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Pi desktop pet");
}
