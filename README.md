# Project YX — free video editor for any PC

Project YX is a free, open-source desktop video editor (Windows / Linux) built to stay smooth on weak computers and export sharp 4K and vertical (9:16) video — 100% offline, no account, no watermark, no telemetry.

**Made by ANSNEW TECH.** · GPL-3.0 · [Download](https://github.com/needyamin/project-yx/releases)

<img width="800" alt="Project YX" src="https://github.com/user-attachments/assets/28e1372d-7ab1-4865-ad84-99419bbb729e" />

## Features

- **Timeline editing** — split, ripple, slip, spacer, fade handles, unlimited undo/redo
- **Images & GIFs** — import, place, trim freely; loop on export
- **Screen recorder** — capture any screen/window with mic, straight to the timeline
- **Voiceover** — one-click mic recording onto an audio track
- **Effects** — Transform, Crop, Chroma key, Text/Titles, Vignette, Hue, Temperature, Sharpen, Blur, Cross dissolve, LUT (.cube)
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
| X | Razor | Ctrl+B | Split at playhead |
| M | Spacer | ← → | Step frame (Shift = 1s) |
| Y | Slip | Ctrl+Z / Y | Undo / redo |
| R | Ripple | Del | Delete clip |
| I / O | Zone in / out | Ctrl+wheel | Zoom timeline |

## Download & install

Grab **Project-YX-Setup-x64.exe** from [Releases](https://github.com/needyamin/project-yx/releases) — FFmpeg and WebView2 are bundled, so installation and editing work fully offline. A portable ZIP and a Microsoft Store (MSIX) package are also available.

## For developers

**Stack:** Tauri 2 · React 19 + TypeScript · Rust workspace · bundled FFmpeg · Vite 8 — no Electron.

| Crate | Role |
|---|---|
| `yx-timeline` | In-memory timeline model: tracks, cuts, transitions, undo |
| `yx-media` | FFmpeg/ffprobe driver: probing, filters, background export |
| `yx-detect` | Hardware probe → performance tier |
| `yx-proxy` | Background proxy transcoder |
| `yx-compositor` | Preview filter budget & aspect policy |

```bash
git clone https://github.com/needyamin/project-yx.git
cd project-yx && npm --prefix apps/desktop install
npm run dev        # develop
npm run dist:win   # build setup.exe + msix
```

Requirements: Rust stable, Node.js 20+, FFmpeg on PATH (bundled in releases).
Full stack map: [STACK.md](STACK.md) · Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)

## Repository layout

```
apps/desktop/        Tauri app: React UI + Rust shell
crates/yx-*          Rust engine crates
scripts/             Packaging (NSIS, Inno, MSIX, portable, AppImage)
installer/ docker/   Installer templates, Linux build
```

## License

GPL-3.0-or-later. Release packages bundle FFmpeg, which is compatible with this license.
