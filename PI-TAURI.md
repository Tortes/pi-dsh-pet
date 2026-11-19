# Pi + Rust/Tauri desktop pet

Every Pi process that loads this extension registers with one shared local monitor. The monitor is a detached Node process that owns the asset/WebSocket server, aggregates progress from all registered Pi processes, and launches exactly one Windows Tauri pet. Do not launch the Tauri executable manually.

## Runtime flow

1. Each Pi process starts the shared monitor if it is not already running, then registers its PID, project directory, and current Agent state.
2. Run `/pet` in any registered Pi process. That Pi session acquires an owner-scoped Pet lease; the shared monitor launches the single `pi-dsh-pet.exe` runtime and passes its fixed loopback port and requested size.
3. Every registered Pi process reports Agent lifecycle and tool-execution events. A heartbeat keeps its registration alive; stale processes are removed automatically.
4. The monitor broadcasts the full process snapshot, the latest progress event, and an aggregate active count to Pet. Pet reacts to every new progress event with the matching animation. Completion and error events are queued in a conversation bubble; each message remains visible for 5 seconds, and the user can click **跳过** to advance. The right-click **Pi 进程状态** action queues a summary followed by one message per registered process.
5. Run `/pi-status` to list all registered Pi processes and their progress. `/pet-status` shows both Pet connectivity and the process list.
6. Run `/pet-stop` in any Pi process to revoke all Pet leases and close the shared Pet. Closing a Pi session releases only that session's lease; its lease is also reclaimed when its agent heartbeat expires. The Pet stops only when no owner leases remain. When the last Pi process unregisters (or its heartbeat expires), the monitor closes Pet and exits after a short grace period.
7. The monitor listens only on `127.0.0.1` (default port `39472`; override with `PI_DSH_PET_PORT`). Protocol version 2 exposes its PID, start time, port, and lease count through `/health`; an incompatible or unrelated service on the configured port is rejected rather than silently treated as the monitor. The new default port isolates this runtime from older monitor instances still bound to the previous default. On startup, the extension also checks the known legacy default port `39471` and sends `/pet/stop` only if it positively identifies a v1 Pi Pet monitor there.

Only Pi processes that load this extension can report Agent progress. A process without the extension can be detected by OS process tools, but its internal Agent/tool progress is not exposed to this monitor.

Do not double-click the Windows executable. It requires the shared monitor port and monitor asset/event server.

## Agent animation state machine

The extension maps Pi lifecycle events into the six upstream DSH work-status slots. It treats `agent_end` as an intermediate event because an automatic retry or compaction may follow; retryable failures do not flash an error, and final completion is reported on `agent_settled` (including its `aborted` flag):

| State | Trigger | Playback |
| --- | --- | --- |
| thinking | agent / turn starts | configured loop |
| waiting | tool request remains pending for 400 ms | configured loop |
| working | tool execution starts | configured loop |
| result | tool execution completes successfully | configured one-shot |
| success | `agent_settled` after a run without an error | configured one-shot |
| error | tool error, final unrecovered agent error, or an aborted `agent_settled` | configured one-shot |

Animation names are read from `animations.events.workStatus` in `dsh-pet/assets/config.jsonc`; no animation filenames are hard-coded in the renderer. Missing/invalid status slots are logged and leave the current animation unchanged.


## Context menu

Right-click the visible pet to open a transparent-window HTML context menu. The first item, **Pi 进程状态**, queries the shared monitor and reports the online count and each process through the Pet conversation bubble.

- The first-level menu directly lists animation categories (idle, turn, drag, click responses, movement actions, custom categories, and event animation slots); there is no redundant single-item “Actions” wrapper.
- Hovering a category opens its animation submenu. Panels are positioned in viewport coordinates, flip to the left when needed, avoid overlapping already-open panels, and stay inside the Tauri viewport. Cascading panels have no horizontal gap and remain open while the pointer travels between them; click outside or press Escape to dismiss, avoiding the fragile diagonal hover corridor used by auto-closing menus.
- Selecting an animation plays it once, then returns to the configured idle pool.
- Click outside or press Escape to close.
- While the menu is open, Pi tells the Rust host to disable click-through for the whole transparent window. Closing the menu restores normal sprite-only hit testing.
- DSH-host-specific actions (balance, weather, chat, todo, third-party host menu registrations, and sleep state) are not exposed yet because this Pi runtime does not currently implement their upstream host endpoints.

## Drag, throw, and display geometry

The Windows native pointer loop owns drag and throw input so the drag continues even when the cursor leaves the transparent pet window.

- Press on the visible sprite to grab it; move to drag; release to throw.
- Release velocity is estimated from a short recent pointer trail, with a dead zone to avoid accidental throws.
- Gravity, restitution, friction, ceiling behavior, and throw power are loaded from the upstream `physics` config.
- Flight uses substeps at high speed so a fast throw does not skip edge collisions.
- The active monitor is tracked across the monitor union. Adjacent screens permit crossing; unconnected gaps/edges bounce instead of letting the pet drift into invisible desktop space.
- The transparent Tauri host window is sized around the visible sprite with a small hit-test margin. Each Pet process receives a unique temporary WebView2 local-data directory, preventing a force-killed process's Chromium lock files/profile state from blocking the next launch. Startup removes stale PID-owned profiles after confirming their process is gone; normal shutdown removes the current profile. Other Tauri app directories are not redirected.

The current implementation uses full monitor rectangles. Taskbar/work-area avoidance, mixed-DPI edge cases, and hot-plug behavior still need manual validation on the target Windows desktop.

## Host/runtime reliability

- The shared monitor is detached from the Pi process that happened to start it first; another Pi process can continue reporting if that process exits.
- Pi agents heartbeat every 5 seconds. The monitor removes registrations after 16 seconds without a heartbeat.
- The Pet WebSocket heartbeat runs every 2 seconds. A missing pong closes the socket and starts bounded reconnect attempts.
- If the Pet runtime exits unexpectedly after a successful connection, the monitor restarts it with exponential backoff (up to five attempts).
- When no Pi agents remain, the monitor waits 20 seconds, closes Pet, and exits. A later Pi process can start a fresh monitor.
- The monitor listens only on loopback; it is not exposed to the LAN.

## WSL -> Windows

The shared monitor detects WSL using `WSL_DISTRO_NAME`, `WSL_INTEROP`, or the kernel release string. It selects `pi-dsh-pet.exe` in WSL and Windows, and `pi-dsh-pet` on native Linux.

Set `PI_DSH_PET_BIN` to override the runtime executable path. By default the extension searches:

- `pi/bin/pi-dsh-pet.exe`
- `src-tauri/target/release/pi-dsh-pet.exe`
- `src-tauri/target/debug/pi-dsh-pet.exe`

## Commands

    /pet
    /pet small
    /pet large
    /pet-status
    /pi-status
    /pet-stop

## Build

On Windows:

    npm install
    npm run pet:build

GitHub Actions builds the Windows runtime and uploads the executable and NSIS installer.

## Validation boundary

Windows CI verifies compilation, packaging, multi-agent monitor leases, protocol identity, and detached monitor session behavior. Runtime diagnostics are appended to `%TEMP%\\pi-dsh-pet\\logs\\pet-runtime.log`; WebView JavaScript exceptions and WebSocket failures are forwarded there. CI does not prove WSL2 localhost forwarding, actual pointer capture, throw feel, mixed-DPI monitor transitions, or forced-kill recovery on a user's desktop. Those require manual runtime tests.
