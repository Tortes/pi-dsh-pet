# Pi + Rust/Tauri desktop pet

The repository keeps the upstream dsh-pet tree as the source of animation/config assets and adds a lightweight Pi adapter.

## Architecture

Pi (WSL/Linux)
-> localhost HTTP/WebSocket server
-> Windows pi-dsh-pet.exe
-> Tauri
-> Windows WebView2
-> transparent desktop window

The Pi process owns the Agent lifecycle. The Tauri process owns only the desktop UI.

The Windows runtime connects back to the Pi server on 127.0.0.1. WSL 2 localhost forwarding makes the WSL service reachable from Windows on localhost.

## Development

Build the Windows runtime on Windows:

    npm install
    npm run pet:build

Then make the generated executable available to the Pi extension, or set:

    PI_DSH_PET_BIN=/path/to/pi-dsh-pet.exe

The extension also searches src-tauri/target/release/pi-dsh-pet.exe and src-tauri/target/debug/pi-dsh-pet.exe.

From Pi:

    /pet
    /pet small
    /pet large
    /pet-stop

## Current MVP

- Rust + Tauri 2 desktop runtime
- Windows transparent / always-on-top window
- WebView2 renderer
- WSL -> Windows process boundary
- localhost WebSocket Agent events
- upstream WebM animation assets
- basic thinking / tool / idle state mapping
- global cursor hit-testing for click-through behavior

## Deliberately deferred

- multi-monitor work-area geometry
- full dsh-pet physics
- all 91 animation-state semantics
- tray/menu
- notifications and chat
- packaged Pi distribution with an embedded Windows binary
- automated runtime integration tests
