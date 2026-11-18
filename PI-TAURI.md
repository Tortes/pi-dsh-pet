# Pi + Rust/Tauri desktop pet

The Pi extension is the only lifecycle controller. The Windows Tauri executable is a child runtime and is not intended to be launched by double-clicking.

## Runtime architecture

Pi (WSL / Linux)
-> local HTTP + WebSocket server (127.0.0.1)
-> spawn Windows pi-dsh-pet.exe with [port, size] arguments
-> Tauri / WebView2 transparent pet window

Pi serves the upstream animation assets from `dsh-pet/assets`. Tauri loads the configuration and WebM files from that local server, then shows its window. The window stays hidden until initialization succeeds.

## Build the Windows runtime

Run on Windows (or use the Windows GitHub Actions runner):

    npm install
    npm run pet:build

The build script generates the required placeholder Windows ICO before invoking Tauri.

GitHub Actions uploads:
- `pi-dsh-pet.exe`
- the NSIS installer

## Install the executable for Pi in WSL

Download the `pi-dsh-pet-windows` artifact from the successful Tauri workflow and extract `pi-dsh-pet.exe`.

Preferred: place it at:

    pi/bin/pi-dsh-pet.exe

The Pi extension automatically searches that path. Alternatively, set `PI_DSH_PET_BIN` to a WSL-visible path, for example:

    export PI_DSH_PET_BIN=/mnt/c/Users/<you>/Apps/pi-dsh-pet.exe

Use a Linux/WSL path such as `/mnt/c/...`, not a raw `C:\\...` path.

## Use from Pi

Load this repository as a Pi package/extension, then use:

    /pet
    /pet small
    /pet large
    /pet-stop

- `/pet` starts the local asset server and then spawns the Windows runtime.
- `/pet-stop` asks the runtime to exit and uses `taskkill.exe` as a WSL fallback.
- Exiting Pi closes the pet.
- Agent lifecycle events are sent over the local WebSocket connection.

**Do not double-click `pi-dsh-pet.exe`.** It expects the Pi-provided port and asset server. A direct launch has no Pi session to connect to and intentionally leaves the window hidden.

## Current MVP

- Rust + Tauri 2 Windows runtime
- WebView2 rendering on Windows (not WSLg)
- compact transparent always-on-top window
- hidden until Pi assets/config load successfully
- Pi-served WebM assets and JSONC config
- local WebSocket Agent event channel
- basic thinking / tool / idle animation mapping
- native global cursor hit-testing for click-through behavior

## Not implemented yet

- full upstream physics and random animation scheduler
- multi-monitor-aware positioning and per-monitor DPI validation
- drag / throw interaction
- tray/menu, notifications, chat and other DSH features
- automatic binary download/install from the Pi package
- runtime crash recovery and reconnect supervision
