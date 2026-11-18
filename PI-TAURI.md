# Pi + Rust/Tauri desktop pet

Pi is the only lifecycle owner. The Windows Tauri executable is a child runtime and is not intended to be launched manually.

## Runtime flow

1. Pi starts the extension and the extension starts a localhost HTTP/WebSocket server.
2. Run `/pet` in Pi. The extension detects WSL, launches the Windows `pi-dsh-pet.exe`, and passes the server port and requested size as command-line arguments.
3. Tauri loads the upstream animation config/assets from the Pi server, then shows its transparent always-on-top window.
4. The extension waits for the WebSocket connection before reporting success.
5. Run `/pet-stop` to request a graceful close. The extension uses `taskkill.exe` as a fallback if the runtime does not exit.
6. `/pet-status` reports whether the runtime is connected.

Do not double-click the Windows executable. It requires the port argument and the Pi asset/event server. When started without them, the Tauri window remains hidden.

## WSL -> Windows

The extension detects WSL using `WSL_DISTRO_NAME`, `WSL_INTEROP`, or the kernel release string. It selects `pi-dsh-pet.exe` in WSL and Windows, and `pi-dsh-pet` on native Linux.

Set `PI_DSH_PET_BIN` to override the runtime executable path. By default the extension searches:

- `pi/bin/pi-dsh-pet.exe`
- `src-tauri/target/release/pi-dsh-pet.exe`
- `src-tauri/target/debug/pi-dsh-pet.exe`

## Build

On Windows:

    npm install
    npm run pet:build

The GitHub Actions workflow uploads both the standalone runtime executable and the NSIS installer as artifacts. The installer is useful for local testing, but the Pi extension should launch the executable directly.

## Commands

    /pet
    /pet small
    /pet large
    /pet-status
    /pet-stop

## Current MVP boundaries

- Pi-controlled lifecycle; no user double-click required
- Rust + Tauri 2, Windows WebView2
- transparent, always-on-top compact window
- upstream WebM assets served by the Pi extension
- Agent start / turn / tool / settled state mapping
- WSL-aware Windows executable selection
- WebSocket readiness check and graceful stop fallback

Multi-monitor placement, complete original pet physics, richer animation-state mapping, tray integration, notifications, and recovery after a Pi crash remain follow-up work.
