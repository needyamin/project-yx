# Project YX

Open-source desktop video editor focused on **smooth editing on weak CPUs** and **4K / vertical export**, with a **minimal sticky UI** (bin, project monitor, timeline) and advanced tools tucked into menus.

Want to help? See **[CONTRIBUTING.md](CONTRIBUTING.md)** for Git collaboration (fork, branch, PR).

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

See [STACK.md](STACK.md) for full stack details.

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

### Always

- Rust stable (`rustup`) — `cargo` on `PATH`
- Node.js 20+
- **FFmpeg + ffprobe on `PATH`** (for local development; production release packages bundle them automatically)

### Windows development

- Visual Studio C++ Build Tools (Desktop development with C++)
- WebView2 (usually preinstalled on Windows 10/11)
- Windows SDK (needed for MSIX / `MakeAppx.exe`)

### Inno Setup

Install [Inno Setup 6](https://jrsoftware.org/isinfo.php) so `ISCC.exe` is available (`npm run dist:inno`).

### MSIX

Windows SDK with **MakeAppx.exe**. Development packages may be **unsigned**; sideload/signing requires a certificate (`YX_MSIX_PFX` / `YX_MSIX_PFX_PASSWORD`). Store submission needs a proper publisher identity matching the cert.

### Docker (Linux AppImage from Windows)

[Docker Desktop](https://www.docker.com/products/docker-desktop/) running, then `npm run dist:linux:docker`.

If `cargo` is missing in Git Bash after installing Rust:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
```

## Building and Distribution

All final packages land in the repo-root `dist/` folder. Version numbers come from the Cargo workspace (`Cargo.toml`) and must stay in sync with `apps/desktop/package.json` and `tauri.conf.json`.

### Why EXE / MSIX do not “include” AppImage

These are **different OS install formats**, not layers inside one file:

| File | Platform | Where you upload it |
|------|----------|---------------------|
| `Project-YX-Setup-<VERSION>.exe` | Windows | GitHub Releases, websites |
| `Project-YX-<VERSION>.msix` | Windows | Microsoft Store / sideload |
| `Project-YX-<VERSION>.AppImage` | Linux | GitHub Releases, Linux sites |

- An **EXE installer** and **MSIX** only package the Windows app.
- An **AppImage** only packages the Linux app.
- You cannot put an AppImage *inside* an EXE or MSIX — Linux users download the AppImage separately.
- On a Windows PC, AppImage is produced with **Docker** (`npm run dist:linux:docker`), then copied next to the Windows files in `dist/`.

### Production release (clean + force rebuild)

```bash
npm run dist:release
```

This is the **production** path. It:

1. Deletes previous `dist/` and `build/` artifacts
2. Force-builds Tauri into the workspace `target/` (never Cursor sandbox caches)
3. Signs updater artifacts (auto-loads `yx-updater.key`; empty password by default)
4. Writes:

```text
dist/
├── Project-YX-Setup-<VERSION>.exe
├── Project-YX-<VERSION>-Portable.zip
├── Project-YX-<VERSION>-Portable.exe
├── Project-YX-<VERSION>.msix
├── Project-YX-<VERSION>.AppImage   # via Docker
└── latest.json                     # when .sig signing succeeds
```

Windows only (skip Docker):

```bash
npm run dist:release -- --windows-only
```

After a successful signed build, upload **all** of these to the GitHub Release (tag like `V0.1.0`):

- `Project-YX-Setup-*.exe`
- `Project-YX-Setup-*.exe.sig`
- `latest.json`

Your current [V0.1.0 release](https://github.com/needyamin/project-yx/releases/tag/V0.1.0) only has the Setup EXE — without `.sig` + `latest.json`, Check for Updates cannot work.

**Updater signing:** `dist:release` auto-loads `apps/desktop/src-tauri/yx-updater.key` with an empty password. If your key is encrypted:

```bash
set TAURI_SIGNING_PRIVATE_KEY_PASSWORD=your-password
npm run dist:release
```

For a local unsigned test only:

```bash
set YX_ALLOW_UNSIGNED_RELEASE=1
npm run dist:release -- --windows-only
```

Client builds have no debug logging. FFmpeg consoles stay hidden; the main window shows after first paint.

### Development

```bash
npm run tauri dev
```

Vite serves at `http://localhost:1420/` while the desktop window opens.

### Production Build (compile only)

```bash
npm run build
```

### Windows NSIS (EXE)

```bash
npm run dist
```

or NSIS-only:

```bash
npm run dist:nsis
```

Output: `dist/Project-YX-Setup-<VERSION>.exe`

Also from `npm run dist`: portable ZIP / optional portable SFX EXE.

### Portable Windows

```bash
npm run dist:portable
```

- `dist/Project-YX-<VERSION>-Portable.zip` — extract and run (no installer)
- `dist/Project-YX-<VERSION>-Portable.exe` — self-extractor when 7-Zip SFX or IExpress is available

Tauri does not produce a true single-file portable app; the ZIP/SFX wraps the release binary and resources.

### Inno Setup (alternate Windows EXE)

```bash
npm run dist:inno
```

Requires Inno Setup 6 (`ISCC.exe`). Writes `dist/Project-YX-Setup-<VERSION>.exe`.

### MSIX (Microsoft Store)

```bash
npm run dist:msix
```

Requires Windows SDK `MakeAppx.exe`. Output: `dist/Project-YX-<VERSION>.msix`.

Store identity (Partner Center → Product identity):

```bash
set YX_MSIX_IDENTITY_NAME=YourPublisher.ProjectYX
set YX_MSIX_PUBLISHER=CN=Your-Store-Publisher-Id
set YX_MSIX_PUBLISHER_DISPLAY=Your Name
set YX_MSIX_PFX=C:\path\to\store-or-dev.pfx
set YX_MSIX_PFX_PASSWORD=...
npm run dist:msix
```

Local sideload signing without your own PFX:

```bash
set YX_MSIX_AUTO_SIGN=1
npm run dist:msix
```

### Windows packages together (EXE + MSIX)

```bash
npm run dist:win
```

Does **not** build AppImage (Linux). Use `dist:release` or `dist:linux:docker` for that.

### Linux AppImage

```bash
npm run dist:linux
```

Native Linux hosts only. From Windows:

```bash
npm run dist:linux:docker
```

Output: `dist/Project-YX-<VERSION>.AppImage` (separate file — not inside the Windows EXE/MSIX).

### Clean

```bash
npm run clean
```

Removes `dist/`, `build/`, and the Vite `apps/desktop/dist` output only — never source trees.

## Workspace layout

```
Cargo.toml                 # Rust workspace (authoritative version)
scripts/                   # dist packaging (Node)
installer/                 # Inno .iss + MSIX manifest template
docker/                    # Linux AppImage builder
crates/yx-*
apps/desktop               # Tauri + React
```

## App icon

`apps/desktop/public/logo.png` is the project mark. OS installer icons live under `apps/desktop/src-tauri/icons`.

```bash
cd apps/desktop
npm run icons
```

## Code signing

### Windows EXE / NSIS

- Development builds may be unsigned.
- Production: Authenticode signing recommended.
- Updater signatures use Tauri’s minisign key (`TAURI_SIGNING_PRIVATE_KEY` in CI). Never commit `yx-updater.key`.

### Inno Setup

The generated installer can be Authenticode-signed after build with `signtool`.

### MSIX

- Publisher in the manifest must match the signing certificate subject.
- Unsigned packages are for local/dev testing only.
- Microsoft Store signing follows Store partner center rules.

## Releases and auto-update

Published builds check:

`https://github.com/needyamin/project-yx/releases/latest/download/latest.json`

1. Generate signing keys once:

```bash
cd apps/desktop
npx tauri signer generate -w src-tauri/yx-updater.key
```

2. GitHub Actions secrets:
   - `TAURI_SIGNING_PRIVATE_KEY`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (if set)

3. Tag a release:

```bash
git tag v0.1.1
git push origin v0.1.1
```

The Release workflow runs `npm run dist:release -- --windows-only` (plus a Linux AppImage job), uploads `dist/*`, and publishes `latest.json` when updater signatures are present.

Help → **Check for Updates** uses that feed. Silent checks on launch stay quiet if the feed is missing.

## License

GPL-3.0-or-later (practical choice when shipping with GPL FFmpeg builds). Production release packages bundle FFmpeg and ffprobe directly for an out-of-the-box zero-setup experience, while the engine cleanly supports custom system PATH binaries as well.
