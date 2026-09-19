# Project YX — free video editor for any PC

Project YX is a free, open-source desktop video editor (Windows / Linux) built to stay smooth on weak computers and export sharp 4K and vertical (9:16) video — 100% offline, no account, no watermark, no telemetry.

**Made by ANSNEW TECH.** · GPL-3.0 · [Download](https://github.com/needyamin/project-yx/releases)

<img width="800" alt="Project YX" src="https://github.com/user-attachments/assets/28e1372d-7ab1-4865-ad84-99419bbb729e" />

## Features

- **Timeline editing** — split, ripple, slip, spacer, fade handles, unlimited undo/redo
- **Audio waveforms & video thumbnails** — clips show cached waveforms (decoded once per file, zoom-independent) and background-generated thumbnails; extreme zoom-out simplifies clips automatically
- **Project files** — save/open `.yxp`; nothing is saved or restored behind your back (fresh start on every launch)
- **Images & GIFs** — import, place, trim freely; loop on export
- **Screen recorder** — capture any screen/window with mic, straight to the timeline
- **Voiceover** — one-click mic recording onto an audio track
- **Effects** — Transform, Crop, Chroma key, Text/Titles, Vignette, Hue, Temperature, Sharpen, Blur, Cross dissolve, LUT (.cube)
- **Blur Region & BG Key tools** — drag a blurred box over a face/logo (shapes, feather, keyframes, auto-track) and remove backgrounds by color keying or hand-drawn areas
- **Magic Remove (AI Eraser)** — brush over a logo, watermark, text or object; auto-tracking follows it across frames and the background is intelligently rebuilt. Non-destructive, with adjustable brush size, feather, tracking accuracy and removal strength
- **Audio tools** — Noise removal, Voice clean presets, Compressor, EQ, Gate, De-esser, Normalize, Reverb, Pitch
- **Smart proxies** — heavy footage edits smoothly on weak CPUs; exports use the original quality
- **Export** — MP4 (H.264/H.265), 4K, 9:16 vertical, optional GPU encode (NVENC / QSV / AMF)
- **Works offline** — FFmpeg is bundled; nothing leaves your PC

## System requirements

| | Minimum | Recommended |
|---|---|---|
| OS | Windows 10/11 64-bit or Linux | Windows 11 64-bit |
| CPU | Dual-core | 6+ cores |
| RAM | 4 GB | 8–16 GB |
| GPU | Any (integrated OK) | Discrete GPU (optional, faster export) |
| Disk | ~500 MB + media | SSD |

The app detects your hardware at launch and adjusts proxies and quality automatically.

## Shortcuts

| Key | Action | Key | Action |
|---|---|---|---|
| S | Select tool | Space | Play / pause |
| X | Razor | J / K / L | Reverse / stop / play (L again = 2×, 4×) |
| M | Spacer | Ctrl+B | Split at playhead |
| Y | Slip | ← → | Step one frame of the project frame rate (Shift = 1s) |
| R | Ripple | Ctrl+Z / Y | Undo / redo |
| I / O | Zone in / out | Del | Delete clip |
| N | Toggle snapping | Ctrl+wheel | Zoom timeline |
| Ctrl+S | Save project (.yxp) | Ctrl+O | Open project |

## Download & install

Grab **Project-YX-Setup-x64.exe** from [Releases](https://github.com/needyamin/project-yx/releases) — FFmpeg and WebView2 are bundled, so installation and editing work fully offline. A portable ZIP and a Microsoft Store (MSIX) package are also available.

---

## For developers

**Stack:** Tauri 2 · React 19 + TypeScript · Rust workspace · bundled FFmpeg · Vite 8 — no Electron.

### Prerequisites

- **Rust** stable (`rustup`) and **Node.js 20+** — that's all to start
- **FFmpeg + ffprobe** — the app never downloads them. After cloning, get an FFmpeg build and run `npm run prepare:bin`: it copies `ffmpeg`/`ffprobe` into `apps/desktop/src-tauri/bin/` (gitignored), where both dev mode (media probing) and release packaging pick them up. They must also be on your PATH or a common install location for `prepare:bin` to find them
- **Docker** only for the Linux AppImage build on a Windows machine

### Develop

```bash
git clone https://github.com/needyamin/project-yx.git
cd project-yx
npm --prefix apps/desktop install   # first time only
npm run dev                         # vite + tauri window (http://localhost:1420)
```

### Versioning — one source of truth

The version lives **only in the root `package.json`** (`"version"`). Every `npm run dev` / `npm run build` / `npm run version:sync` rewrites it into `Cargo.toml` (`[workspace.package]`), `apps/desktop/package.json` and `tauri.conf.json` automatically. Never edit those by hand; `Cargo.lock` follows on the next cargo build.

### Build & release

| Command | What it produces (into `dist/`) |
|---|---|
| `npm run build` | Tauri release build (checked by CI/dev gates, not shipped) |
| `npm run dist:win` | Windows: NSIS `Setup.exe` + MSIX, single Tauri build |
| `npm run dist:release` | **Full release**: Setup.exe + portable ZIP + MSIX (+ Linux AppImage via Docker when available) + signed `latest.json` updater file |
| `npm run dist:portable` | Portable ZIP only |
| `npm run dist:nsis` / `dist:inno` / `dist:msix` | Individual Windows installers |
| `npm run dist:linux:docker` | Linux AppImage via Docker (use on Windows/macOS); `dist:linux` builds natively on Linux |
| `npm run prepare:bin` | Stage FFmpeg/ffprobe into the bundle dir |
| `npm run clean` | Remove `dist/` artifacts (never touches source) |

**Release checklist (short version):** bump `version` in root `package.json` → `npm run version:sync` → `npm run dist:release` → upload the new artifacts from `dist/` to a GitHub release. Updater signing happens automatically when `apps/desktop/src-tauri/yx-updater.key` exists (override with `TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]`; `YX_ALLOW_UNSIGNED_RELEASE=1` for an unsigned test build).

### Quality gates (run before committing)

```bash
cargo test --workspace        # Rust tests (bundled ffmpeg on PATH unlocks media tests)
cargo check --workspace
npm --prefix apps/desktop run build   # tsc + vite production bundle
```

A dev-only QA harness for the monitor tools lives at `apps/desktop/qa.html` (mounts the real app against a mock backend; see `src/dev/qa.ts`), and the performance harness at `benchmark/` — see [benchmark/README.md](benchmark/README.md).

### Repository layout

```
apps/desktop/        Tauri app: React UI + Rust shell
apps/desktop/qa.html  Dev-only monitor QA harness
crates/yx-*          Rust engine crates
benchmark/           Performance harness + generated test media (media gitignored)
scripts/             Packaging (NSIS, Inno, MSIX, portable, AppImage, updater)
installer/ docker/   Installer templates, Linux build
docs/                QA matrix
```

| Crate | Role |
|---|---|
| `yx-timeline` | In-memory timeline model: tracks, cuts, transitions, undo |
| `yx-media` | FFmpeg/ffprobe driver: probing, filters, background export |
| `yx-detect` | Hardware probe → performance tier |
| `yx-proxy` | Background proxy transcoder |
| `yx-compositor` | Preview filter budget & aspect policy |

Full stack map: [STACK.md](STACK.md) · Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · QA matrix: [docs/QA-MATRIX.md](docs/QA-MATRIX.md)

## License

GPL-3.0-or-later. Release packages bundle FFmpeg, which is compatible with this license.
