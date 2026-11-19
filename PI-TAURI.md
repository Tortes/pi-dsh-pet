# Pi + Rust/Tauri desktop pet

Pi is the only lifecycle owner. The Windows Tauri executable is a child runtime and is not intended to be launched manually.

## Runtime flow

1. Pi starts the extension and the extension starts a localhost HTTP/WebSocket server.
2. Run `/pet` in Pi. The extension detects WSL, launches the Windows `pi-dsh-pet.exe`, and passes the server port and requested size as command-line arguments.
3. Tauri loads the upstream animation config/assets from the Pi server, applies the configured physics, publishes its hit-test bounds, then shows its transparent always-on-top window.
4. The extension waits for the WebSocket connection before reporting success.
5. Run `/pet-stop` to request a graceful close. The extension uses `taskkill.exe` as a fallback if the runtime does not exit.

Do not double-click the Windows executable. It requires the port argument and the Pi asset/event server.

## Agent animation state machine

The extension maps Pi lifecycle events into the six upstream DSH work-status slots:

| State | Trigger | Playback |
| --- | --- | --- |
| thinking | agent / turn starts | configured loop |
| waiting | tool request remains pending for 400 ms | configured loop |
| working | tool execution starts | configured loop |
| result | tool execution completes successfully | configured one-shot |
| success | agent ends without an error | configured one-shot |
| error | tool or agent ends with an error | configured one-shot |

Animation names are read from `animations.events.workStatus` in `dsh-pet/assets/config.jsonc`; no animation filenames are hard-coded in the renderer. Missing/invalid status slots are logged and leave the current animation unchanged.


## Context menu

Right-click the visible pet to open a transparent-window HTML context menu.

- The menu is generated from the loaded upstream animation config: idle, turn, drag, click responses, movement actions, categories, and event animation slots.
- Hovering a category opens a cascading submenu; submenus flip left when there is insufficient room on the right and are clamped to the Tauri viewport.
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
- The transparent Tauri host window is sized around the visible sprite with a small hit-test margin.

The current implementation uses full monitor rectangles. Taskbar/work-area avoidance, mixed-DPI edge cases, and hot-plug behavior still need manual validation on the target Windows desktop.

## Host/runtime reliability

- The WebSocket heartbeat runs every 2 seconds. A missing pong closes the socket and starts bounded reconnect attempts.
- If the Pi host disappears, the Windows runtime closes itself after the reconnect grace period instead of remaining as an orphan.
- If the Windows runtime exits unexpectedly after a successful connection, Pi restarts it with exponential backoff (up to five attempts).
- A failed recovery child is terminated before the next attempt.
- `session_shutdown` requests a graceful close; process exit also broadcasts shutdown and closes the local server.

## WSL -> Windows

The extension detects WSL using `WSL_DISTRO_NAME`, `WSL_INTEROP`, or the kernel release string. It selects `pi-dsh-pet.exe` in WSL and Windows, and `pi-dsh-pet` on native Linux.

Set `PI_DSH_PET_BIN` to override the runtime executable path. By default the extension searches:

- `pi/bin/pi-dsh-pet.exe`
- `src-tauri/target/release/pi-dsh-pet.exe`
- `src-tauri/target/debug/pi-dsh-pet.exe`

## Commands

    /pet
    /pet small
    /pet large
    /pet-status
    /pet-stop

## Build

On Windows:

    npm install
    npm run pet:build

GitHub Actions builds the Windows runtime and uploads the executable and NSIS installer.

## Validation boundary

Windows CI verifies compilation and packaging. It does not prove WSL2 localhost forwarding, actual pointer capture, throw feel, mixed-DPI monitor transitions, or crash recovery on a user's desktop. Those require manual runtime tests.
