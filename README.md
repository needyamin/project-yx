# Project YX

Open-source desktop video editor focused on **smooth editing on weak CPUs** and **4K / vertical export**, with a **minimal sticky UI** (bin, project monitor, timeline) and advanced tools tucked into menus.

<img width="800" height="450" alt="Image" src="https://github.com/user-attachments/assets/28e1372d-7ab1-4865-ad84-99419bbb729e" />

## Stack

- **Tauri 2** app shell
- **React + TypeScript** UI (Project Bin, monitors, timeline, export dialog)
- **Rust** media engine crates:
  - `yx-detect` — hardware probe + performance tiers
  - `yx-timeline` — tracks / clips / undo, edit modes, markers, zone
  - `yx-media` — FFmpeg probe + subprocess export with progress
  - `yx-compositor` — preview filter budget (wgpu path next)
  - `yx-proxy` — background proxy media for editing

See [STACK_PLAN.md](STACK_PLAN.md) for architecture details.

## Features

- **Import** via dialog or **drag-and-drop** from the OS into the Project Bin (multi-file)
- **Sticky tools:** Select, Razor, Split, Fit — more tools under **More…** and right-click
- **Optional** 9:16 TikTok / phone preview (default remains 16:9)
- **Export popup** with presets (Best = same size as source · max quality; YouTube, TikTok, Instagram, 4K, Draft, Custom)
- **Background FFmpeg encode** with live **progress bar** (UI stays responsive)
- Best export uses software x264, CRF 15, slow preset, source fps/size (no forced downscale)
- Proxies + capped encode threads for weaker CPUs
- **Auto-update** from [GitHub Releases](https://github.com/needyamin/project-yx/releases) (Help → Check for Updates)

## Timeline shortcuts

| Key | Action |
|---|---|
| S | Select / move / trim |
| X | Razor |
| M | Spacer |
| Y | Slip |
| R | Ripple |
| I / O | Zone in / out |
| Space | Play / pause |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Del | Delete clip |

Modes: **Normal**, **Insert**, **Overwrite** (via **More…** or context menu). Zone: Lift / Extract.

## Prerequisites

- Rust stable (`rustup`) — `cargo` on `PATH` (`~/.cargo/bin`)
- Node.js 20+
- FFmpeg + ffprobe on `PATH`
- Windows: WebView2 (usually preinstalled)

If `cargo` is missing in Git Bash after installing Rust:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
```

`npm run tauri` also prepends `~/.cargo/bin` automatically.

## Develop

From the repo root:

```bash
npm run tauri dev
```

Vite serves at `http://localhost:1420/` while the desktop window opens.

Build a release:

```bash
npm run build
```

## Workspace layout

```
Cargo.toml                 # Rust workspace
crates/yx-detect
crates/yx-timeline
crates/yx-media
crates/yx-compositor
crates/yx-proxy
apps/desktop               # Tauri + React
```

## App icon

`apps/desktop/public/logo.png` is the project mark (favicons / window). OS installer icons live under `apps/desktop/src-tauri/icons`.

After changing the logo, regenerate the OS icon set:

```bash
cd apps/desktop
npm run icons
```

## Releases and auto-update

Published builds check:

`https://github.com/needyamin/project-yx/releases/latest/download/latest.json`

1. Generate signing keys once (already used for this repo’s pubkey in `tauri.conf.json`):

```bash
cd apps/desktop
npx tauri signer generate -w src-tauri/yx-updater.key
```

2. Add GitHub Actions secrets (repo → Settings → Secrets):
   - `TAURI_SIGNING_PRIVATE_KEY` — full contents of `yx-updater.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — key password (if set)

3. Push a version tag to publish:

```bash
git tag v0.1.1
git push origin v0.1.1
```

The **Release** workflow builds Windows installers, uploads updater signatures, and writes `latest.json`. Installed apps then update via **Help → Check for Updates…** (or a quiet check on launch).

Never commit `yx-updater.key`.

## License

GPL-3.0-or-later (practical choice when shipping with GPL FFmpeg builds).
