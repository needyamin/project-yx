# Project YX - Pro Video Editing for Every Machine

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

### Import & Project Bin

- **Import** via dialog or **drag-and-drop** from the OS into the Project Bin (multi-file)
- Supports **video** (MP4, MOV, MKV, WebM, AVI, M4V), **audio** (MP3, WAV, AAC, M4A, FLAC, OGG), and **images** (PNG, JPG, JPEG, WebP, BMP, GIF)
- **Project Bin tabs:** Media · Audio · Effects · Applied — filter the bin view per context
- **Remove from bin** with confirmation when the clip is on the timeline
- **Drag from bin** directly onto the timeline at a precise drop position
- **Drag to Clip Monitor** to preview a bin item before adding it to the timeline

### Monitors

- **Clip Monitor** — preview any bin item in isolation; add to timeline from within; toggleable from View menu
- **Project Monitor** — live playback of the assembled timeline sequence
  - Volume knob + mute toggle
  - **Aspect ratio toggle:** 16:9 (landscape) or 9:16 (TikTok / Reels)
  - **Text overlay** — WYSIWYG preview of the Text / Title filter
  - **Transform handle** — drag, scale, and rotate clips directly on the monitor when the Transform filter is active
  - **Crop tool** — interactive drag-to-crop overlay on the monitor; toggle from the monitor toolbar
  - **Chroma Key eyedropper** — click any pixel in the monitor to set the key colour when Chroma Key is active

### Timeline & Editing

- **Sticky tools** (always visible in the timeline toolbar):
  - **Select** `S` — move and trim clips
  - **Split** `Ctrl+B` — split clip at playhead
  - **Cut / Razor** `X` — click a clip to cut at that point
  - **Spacer** `M` — drag to create or close space between clips
  - **Slip** `Y` — slide clip in/out points without moving its position
  - **Ripple** `R` — ripple-aware trim
- **More… menu** (in timeline toolbar):
  - Edit mode: **Normal / Insert / Overwrite**
  - **Set Zone In / Out** — mark an in/out region on the ruler
  - **Add Marker** — named markers on the timeline ruler
  - **Remove Space in All Tracks** — collapses gaps at the playhead across all tracks
  - **Link A/V / Unlink A/V** — link or break the video+audio bond of a clip pair
  - **Ripple Delete** — remove the selected clip and pull everything downstream
- **Edit → Lift Zone** — remove zone content, leave gap
- **Edit → Extract Zone** — remove zone content, ripple close the gap
- **Track management:** add video and audio tracks; mute or hide individual tracks
- **Snap** toggle (View menu) — clips snap to playhead, markers, and other clip edges
- **Zoom:** Ctrl+Wheel or toolbar buttons; drag ruler to scrub; Fit button

### Clip Properties

- **Clip speed** — 0.25× to 4× per clip (via Advanced Video Tools)
- **Reverse playback** — per-clip reverse toggle (via Advanced Video Tools)
- **Audio fades** — per-clip fade-in / fade-out envelope (via Advanced Audio Tools)
- **A/V linking** — video and audio clips from the same file stay in sync by default; unlink to edit independently

### Advanced Audio Tools

Right-click an audio clip → **Advanced Audio Tools**, or click the waveform icon on the bin item:

- **Overview tab:** volume gain slider, fade-in / fade-out handles, clip metadata
- **Waveform tab:** zoomable waveform view with drag-to-select; **Cut Selection** removes the selection and ripple-closes the gap
- **Effects tab:** one-click apply / remove audio effects for the clip
- Voice presets: **Male / Female / Child / Custom** (pitch semitones)

### Advanced Video Tools

Right-click a video clip → **Advanced Video Tools:**

- Fade-in / fade-out per clip
- Reverse and speed controls
- One-click apply / remove video effects for the clip
- **Open Applied** shortcut — jumps to the Applied tab in the bin for fine-tuning

### Effects & Filters

Effects are applied per-clip. Select a clip, then pick an effect from the **Effects** tab in the Project Bin, or use the clip right-click menu. Fine-tune parameters under the **Applied** tab (Effect Inspector).

#### Video effects

| Effect | Description |
|---|---|
| Transform | Drag, scale, rotate, opacity (WYSIWYG on monitor) |
| Crop | Edge crop — fill-to-frame (WYSIWYG on monitor) |
| Exposure | Brightness adjustment |
| Contrast | Contrast adjustment |
| Saturation | Colour saturation |
| Temperature | Colour temperature (Kelvin) |
| Hue rotate | Hue shift in degrees |
| Vignette | Radial darkening vignette |
| Sharpen | Edge sharpening |
| Blur | Gaussian blur *(heavy)* |
| Flip | Horizontal / vertical flip |
| Chroma Key | Background removal by colour; eyedropper on monitor *(heavy)* |
| Text / Title | Text overlay — font size, colour, position, optional box; WYSIWYG on monitor |
| Video denoise | Temporal video noise reduction *(heavy)* |
| Stabilize | Video stabilisation *(heavy)* |
| LUT (.cube) | 3D colour look-up table for colour grading *(heavy)* |
| Cross Dissolve | Transition fade-in at the start of the clip |

#### Audio effects

| Effect | Description |
|---|---|
| Volume | Per-clip gain adjustment |
| Equalizer | 3-band EQ (bass / mid / treble) |
| Compressor | Dynamic range compression |
| High-pass | High-pass filter (cut low rumble) |
| Low-pass | Low-pass filter (cut high hiss) |
| Noise gate | Gate below a threshold |
| Noise remove | Spectral audio denoise *(heavy)* |
| Limiter | Hard ceiling limiter |
| Reverb | Simple reverb (delay + decay) |
| Invert phase | Phase inversion |
| Change voice | Pitch shift in semitones; Male / Female / Child presets |
| Normalize | Loudness normalisation to a target LUFS |

> **Heavy effects** are only enabled for preview on machines with a sufficient performance tier (`high`). They always render correctly on export regardless of tier.

### Export

- **Export popup** with presets:

  | Preset | Resolution | Notes |
  |---|---|---|
  | Best (recommended) | Source size | CRF 15, slow x264, max quality |
  | YouTube 1080p | 1920×1080 | 16:9, CBR-friendly |
  | TikTok / Reels | 1080×1920 | 9:16 vertical |
  | Instagram feed | 1080×1080 | 1:1 square |
  | 4K Ultra HD | 3840×2160 | 16:9 |
  | Draft / fast | 1280×720 | Quick preview encode |
  | Custom | Manual | Full codec / bitrate / CRF control |

- **Codecs:** H.264 or H.265 (HEVC)
- **Quality modes:** CRF (constant quality) or target bitrate
- **Hardware-accelerated export:** NVENC (NVIDIA) / Intel QSV / AMD AMF — auto-detected at launch based on tier
- **Background FFmpeg encode** with live **progress bar** (UI stays responsive during export)
- Export preview frame — thumbnail of the current monitor frame shown in the dialog
- Output format: `.mp4`

### Recording

- **Voiceover** — one-click microphone recording directly to the timeline; appears as a normal audio clip when done
- **Screen Recorder** — built-in screen capture tool (timeline toolbar):
  - OS-native screen / window / tab picker
  - **Microphone on/off** — configurable before recording; can be toggled **live** while recording
  - **Camera bubble** option — overlays webcam video
  - **System audio** capture — mixed with mic into one track
  - Auto-saves when the browser "Stop sharing" bar is closed
  - Lands on the timeline as a normal video+audio clip
  - 2-hour safety cap on recording length

### UI / Interface

- **Dark interface** (default) or **White interface** — toggle via View menu; persists per session
- **Full Screen** mode — View → Full Screen (Esc to exit)
- **Hide to Tray** — minimise to the system tray (File → Hide to Tray)
- **System tray** — right-click for "Check for Updates" shortcut
- **About dialog** — Help → About Project YX; shows version and links
- **Status bar** — live feedback on every action; shows performance tier at boot
- **Performance tier badge** in the title bar (potato → low → mid → high)

### Playback & editing performance

Project YX is engineered to stay smooth on weak machines:

- **Proxy editing** — imports transcode to a lightweight proxy in a **single background queue** (never blocks the UI); when a proxy is ready the timeline **hot-swaps automatically** and preview gets smoother with no restart
- **Gapless cuts** — the project monitor double-buffers video, preloading the next clip so cuts between files don't stall the decoder
- **Frame-driven playback clock** — the playhead, audio sync and cut handling run on `requestAnimationFrame` (display refresh rate), not the 4 Hz `timeupdate` event
- **Zero re-render timeline** — playhead, scrubbing and snap guides are painted imperatively; clips only re-render when their own data changes, so long timelines keep dragging and scrubbing fluid
- **One-time waveform decode** — audio peaks decode each file once and survive trimming
- **Performance tiers** — `yx-detect` probes CPU/RAM/GPU at launch and picks a tier (potato → high) that caps encode threads and proxy quality accordingly
- **Dual audio layer** — a second audio element handles overdub/voiceover layers independently so multiple audio tracks play in sync without decoder conflicts

### Auto-update

- **Auto-update** from [GitHub Releases](https://github.com/needyamin/project-yx/releases) — silent background check on launch; interactive via **Help → Check for Updates** or **File → Check for Updates**

## System Requirements

### End users

| | Minimum | Recommended |
|---|---|---|
| **OS** | Windows 10 64-bit or Linux (AppImage) | Windows 11 64-bit |
| **CPU** | Dual-core x86-64 (2 cores / 2 threads) | 6+ cores (Intel i5/Ryzen 5 or better) |
| **RAM** | 4 GB | 8–16 GB (16 GB for 4K projects) |
| **GPU** | Integrated graphics | Discrete GPU (NVIDIA / AMD / Intel with NVENC, QSV or AMF) |
| **Storage** | 500 MB app + space for media | SSD; space for proxy cache + exports |
| **Display** | 1280 × 720 | 1920 × 1080 or higher |
| **Runtime** | WebView2 (preinstalled on Windows 10/11) | — |

Notes:

- FFmpeg + ffprobe are **bundled** in release packages — no manual install needed for normal use
- The performance tier and proxy quality are **auto-detected** at launch; weak machines automatically edit from proxies
- The proxy cache lives outside the repo at `%LOCALAPPDATA%\ProjectYX\proxy-cache` (Windows) — delete it anytime to reclaim space; proxies regenerate on demand
- On Linux, AppImage builds require the usual WebKitGTK/Tauri runtime libraries (`webkit2gtk`), which the AppImage bundling targets

## Timeline shortcuts

| Key | Action |
|---|---|
| `S` | Select / move / trim |
| `X` | Razor (Cut) |
| `M` | Spacer tool |
| `Y` | Slip |
| `R` | Ripple |
| `I` / `O` | Zone in / out |
| `Space` | Play / pause |
| `Ctrl+B` | Split clip at playhead |
| `←` / `→` | Step ~1 frame (hold `Shift`: 1 second) |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo |
| `Del` / `Backspace` | Delete selected clip |

Timeline navigation: **Ctrl+wheel** zooms, drag the ruler to scrub.

Modes: **Normal**, **Insert**, **Overwrite** (via **More…** or context menu). Zone: Lift / Extract (via Edit menu or context menu).

## Menu reference

| Menu | Items |
|---|---|
| **File** | Import…, Export…, Check for Updates…, Hide to Tray, Quit |
| **Edit** | Undo, Redo, Delete, Ripple Delete, Split at Playhead, Link/Unlink A/V, Lift Zone, Extract Zone |
| **View** | Aspect 16:9 / 9:16, Fit Timeline, Zoom In/Out, Snap On/Off, Show/Hide Clip Monitor, Dark/White Interface, Full Screen |
| **Run** | Play/Pause, Export… |
| **Help** | Documentation, Contact Us, Report Issue, Check for Updates…, About Project YX |

## Prerequisites (development only — end users just download a release)

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

### Why EXE / MSIX do not "include" AppImage

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
- Updater signatures use Tauri's minisign key (`TAURI_SIGNING_PRIVATE_KEY` in CI). Never commit `yx-updater.key`.

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
