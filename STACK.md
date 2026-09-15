# Project YX — Stack

This document describes the full technology stack used by **Project YX**: what each layer does, which packages are in use, and how they connect.

| | |
|---|---|
| **Product** | Project YX desktop video editor |
| **App ID** | `com.projectyx.editor` |
| **License** | GPL-3.0-or-later |
| **Repo** | https://github.com/needyamin/project-yx |
| **Version source** | Cargo workspace `[workspace.package].version` (keep in sync with `apps/desktop/package.json` and `tauri.conf.json`) |

---

## High-level architecture

```text
┌─────────────────────────────────────────────────────────┐
│  React 19 + TypeScript UI  (Vite 8)                     │
│  apps/desktop/src                                       │
└───────────────────────────┬─────────────────────────────┘
                            │ Tauri IPC / plugins
┌───────────────────────────▼─────────────────────────────┐
│  Tauri 2 shell  (yx-desktop)                            │
│  apps/desktop/src-tauri  · WebView2 (Windows)           │
└───────────────────────────┬─────────────────────────────┘
                            │ Rust crates
┌───────────────────────────▼─────────────────────────────┐
│  yx-timeline · yx-media · yx-detect                     │
│  yx-compositor · yx-proxy                               │
└───────────────────────────┬─────────────────────────────┘
                            │ subprocess / PATH
┌───────────────────────────▼─────────────────────────────┐
│  FFmpeg + ffprobe  (bundled in releases; PATH fallback) │
└─────────────────────────────────────────────────────────┘
```

**Not used:** Electron, electron-builder, or any Electron packaging path. This is a **Tauri 2** app only.

---

## Application shell

| Piece | Detail |
|--------|--------|
| Framework | **Tauri 2** |
| Binary / crate | `yx-desktop` (`apps/desktop/src-tauri`) |
| UI host | OS webview (**WebView2** on Windows; WebKitGTK on Linux) |
| Dev URL | `http://localhost:1420` |
| Frontend build output | `apps/desktop/dist` → `tauri.conf.json` `frontendDist` |
| Product name | Project YX |

### Tauri plugins (Rust + JS)

| Plugin | Role |
|--------|------|
| `@tauri-apps/plugin-dialog` / `tauri-plugin-dialog` | File open / save dialogs |
| `@tauri-apps/plugin-opener` / `tauri-plugin-opener` | Open URLs / paths externally |
| `@tauri-apps/plugin-updater` / `tauri-plugin-updater` | Auto-update from GitHub Releases |
| `@tauri-apps/plugin-process` / `tauri-plugin-process` | Relaunch / exit after update |
| `@tauri-apps/api` | Core IPC, events, path helpers |

Tauri features enabled in `yx-desktop`: `protocol-asset`, `tray-icon`.

---

## Frontend stack

| Technology | Version (approx.) | Role |
|------------|-------------------|------|
| **React** | 19.x | UI |
| **React DOM** | 19.x | Rendering |
| **TypeScript** | ~5.8 | Typing |
| **Vite** | 8.x | Dev server + production bundler |
| **@vitejs/plugin-react** | 6.x | React Fast Refresh / JSX |
| **@tauri-apps/cli** | 2.x | `tauri dev` / `tauri build` |

### UI areas (`apps/desktop/src`)

| Area | Path | Notes |
|------|------|--------|
| Shell / layout | `layout/` | Editor chrome, top menubar, performance tier indicator |
| Project bin | `bin/` | Media library (Media/Audio/Effects/Applied tabs), drag-and-drop |
| Monitors | `monitors/` | Clip + project preview, transform handles, crop tool, chroma eyedropper |
| Timeline | `timeline/` | Tracks, clips, sticky tools (S/X/M/Y/R), edit modes, zoom/snap |
| Recording | `timeline/` | Screen recorder (screen/mic/system audio/camera bubble) & voiceover |
| Audio tools | `audio/` | Advanced Audio Tools dialog, multi-channel waveform peak extraction & cutting |
| Video tools | `video/` | Advanced Video Tools dialog, clip speed (0.25×–4×), reverse playback |
| Effects | `effects/` | Catalog, inspector, preview CSS filters & FFmpeg mapping |
| UI components | `ui/` | Reusable editor context menus & overlays |
| Export | `export/` | Export dialog, resolution presets (YouTube, TikTok, Instagram, 4K) |
| Updates | `update/` | Check-for-updates UI dialog |

Styling is mostly plain CSS beside components (no Tailwind / UI kit required).

---

## Backend / Rust workspace

Root: [`Cargo.toml`](Cargo.toml) — workspace resolver `"2"`, edition **2021**.

### Workspace crates

| Crate | Path | Responsibility |
|-------|------|----------------|
| **yx-detect** | `crates/yx-detect` | CPU/GPU/encoder probe, binary resolution (`ffmpeg`/`ffprobe`), performance tiers |
| **yx-timeline** | `crates/yx-timeline` | Pure timeline model: tracks, clips, cuts, undo — **no I/O** |
| **yx-media** | `crates/yx-media` | FFmpeg CLI probe / export / progress parsing (no libav link in Phase 1) |
| **yx-compositor** | `crates/yx-compositor` | Filter budget / composition policy (wgpu path planned) |
| **yx-proxy** | `crates/yx-proxy` | Background proxy transcodes for smooth editing |
| **yx-desktop** | `apps/desktop/src-tauri` | Tauri commands, tray icon, wiring crates to the UI |

### Shared Rust dependencies (workspace)

- `serde` / `serde_json` — serialization
- `thiserror` / `anyhow` — errors
- `uuid` — IDs
- `parking_lot` — locks
- `tracing` — logging

### Release profile

Configured for smaller/faster shipping binaries: `lto = true`, `opt-level = 3`, `codegen-units = 1`, `panic = "abort"`, `strip = true`.

---

## Media pipeline

| Concern | How it works |
|---------|----------------|
| Probe / import | `ffprobe` via `yx-media` |
| Export | `ffmpeg` subprocess with progress parsing (`command_no_window` suppresses console flashes) |
| Preview effects | Real-time CSS filters & WebGL canvas overlays with WYSIWYG monitor interaction |
| Waveforms | Client-side audio peak extraction via Web Audio API (`audio/waveformPeaks.ts`) |
| Recording | Screen capture & microphone recording via browser `MediaStream` / `MediaRecorder` APIs |
| Proxies | `yx-proxy` generates lighter edit media; export prefers originals |
| Hardware | `yx-detect` influences proxy/export choices and NVENC / QSV / AMF hardware acceleration |

**Bundling & Runtime:** Releases bundle `ffmpeg` and `ffprobe` directly into the package (`bin/` resources via `scripts/prepare-binaries.js`) for zero-setup out-of-the-box editing and 4K export. The engine (`yx-detect`) automatically checks the application directory first and cleanly falls back to system `PATH` if custom binaries are desired.

---

## Tooling & packaging

| Tool | Role |
|------|------|
| **npm** (root + `apps/desktop`) | Scripts: `dev`, `build`, `dist:*`, `clean`, `prepare:bin` |
| **Node scripts** | `scripts/` — binary preparation (`prepare-binaries.js`), NSIS copy, portable ZIP/SFX, Inno, MSIX, Docker Linux |
| **Inno Setup** | Optional Windows installer (`ISCC.exe`) |
| **Windows SDK MakeAppx** | MSIX packaging |
| **Docker** | Linux AppImage build from Windows (`docker/`) |
| **GitHub Actions** | `.github/workflows/release.yml` — Windows + Linux release artifacts |
| **Tauri updater** | Minisign keypair; `latest.json` on GitHub Releases |

### Distribution outputs (`dist/`)

| Artifact | Platform | Typical use |
|----------|----------|-------------|
| `Project-YX-Setup-<ver>.exe` | Windows | NSIS / Inno installer |
| `Project-YX-<ver>.msix` | Windows | Store / sideload |
| `Project-YX-<ver>-Portable.zip` (+ optional SFX `.exe`) | Windows | No-install portable |
| `Project-YX-<ver>.AppImage` | Linux | Portable Linux binary |

---

## Platforms & OS dependencies

| Platform | Needs |
|----------|--------|
| **Windows** | WebView2, VS C++ Build Tools (dev), optional Inno + Windows SDK |
| **Linux** | WebKitGTK 4.1+, related GTK/AppImage deps (see `docker/Dockerfile`) |
| **All** | Rust stable, Node 20+, FFmpeg/ffprobe |

---

## Security & identity

| Item | Detail |
|------|--------|
| Bundle identifier | `com.projectyx.editor` |
| CSP | Set in `tauri.conf.json` (restrictive defaults + asset/media allowances) |
| Asset protocol | Enabled for local media preview scopes |
| Updater pubkey | Embedded in `tauri.conf.json`; **private** key stays local / CI secret |
| Secrets ignored | `.env`, `*.key`, `*.pfx`, etc. (see `.gitignore`) |

---

## Repository map

```text
project-yx/
├── apps/desktop/          # Tauri + React app
│   ├── src/               # Frontend
│   ├── src-tauri/         # Rust shell + icons + tauri.conf.json
│   └── package.json
├── crates/                # Shared Rust engine crates
├── scripts/               # Distribution automation (Node ESM)
├── installer/             # Inno .iss + MSIX manifest template
├── docker/                # Linux AppImage builder
├── package.json           # Root npm scripts
├── Cargo.toml             # Rust workspace
├── STACK.md               # This file
├── CONTRIBUTING.md        # Git collaboration
└── README.md              # User / build overview
```

---

## Design goals that shape the stack

1. **Edit smoothly on weak CPUs** — proxies + performance tiers (`yx-detect` / `yx-proxy`).
2. **Still export high quality / 4K / vertical** — FFmpeg export presets, not forced downscale on “Best”.
3. **Minimal sticky UI** — React panels, not a heavy web framework stack.
4. **Smaller native footprint than Electron** — Tauri + system webview.
5. **Open-source licensing** — GPL-3.0-or-later, compatible with typical GPL FFmpeg builds when users install FFmpeg themselves.

---

## Related docs

- [README.md](README.md) — features, prerequisites, dist commands  
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to collaborate via Git  
- `task.md` — historical packaging requirements / notes (not required for day-to-day development)
