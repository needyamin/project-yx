# Project YX — Stack

What Project YX is built with and how the pieces connect. Short version: **Tauri 2 shell + React UI + Rust engine crates + bundled FFmpeg. No Electron.**

App ID `com.projectyx.editor` · GPL-3.0-or-later · Version lives in root `Cargo.toml` (sync with `apps/desktop/package.json` and `tauri.conf.json`).

```
┌─────────────────────────────────────────────┐
│  React 19 + TypeScript UI (Vite 8)          │
│  bin · timeline · monitors · effects ·      │
│  audio/video tools · export · recorder      │
└──────────────────┬──────────────────────────┘
│  Tauri 2 IPC + asset protocol (WebView2 / WebKitGTK)
└──────────────────┬──────────────────────────┘
│  Rust crates (in-process)          │  FFmpeg / ffprobe subprocess (bundled)
└──────────────────┬─────────┬────────┘
                   ▼         ▼
        Timeline engine    Media pipeline
```

## Rust crates

| Crate | Responsibility |
|---|---|
| `yx-timeline` | Pure in-memory model: tracks, clips, cuts (normal/insert/overwrite), ripple/slip/spacer, transitions, filters, markers, zones, undo/redo. Zero disk I/O. |
| `yx-media` | FFmpeg/ffprobe driver: probing, effect filter chains (WYSIWYG with preview), background export with progress, loudnorm/de-esser/drawtext/lut3d etc. |
| `yx-detect` | Hardware probe at launch (CPU/RAM/GPU/encoders) → performance tier; binary discovery (next-to-exe → PATH). |
| `yx-proxy` | Background proxy transcoder: single worker queue, auto hot-swap when ready, skips audio/images. |
| `yx-compositor` | Preview filter budget and 16:9 / 9:16 aspect policy. |

## UI (apps/desktop/src)

| Module | Role |
|---|---|
| `bin/` | Project Bin: import, tabs (All/Audio/Effects/Applied), drag to timeline |
| `timeline/` | Timeline panel, ClipBlock drag engine, Ruler, screen recorder, voiceover |
| `monitors/` | Project Monitor (crop tool, transform drag, text overlay) and Clip Monitor |
| `audio/` + `video/` | Advanced Audio Tools (voice clean, waveform) and video dialogs |
| `effects/` | Effect catalog, WYSIWYG preview styles, inspector |
| `export/` | Presets, output preview, progress |
| `layout/` | Menubar, About dialog |

## Key engineering decisions

- **Imperative playback layer** — playhead, scrub and snap guides are painted via direct DOM writes on one `requestAnimationFrame` clock; React state only feeds the timecode at 4 Hz. Timeline clips are memoized, so playback and drags don't re-render them.
- **One media clock** — the rAF loop reads the active element per frame; cuts are double-buffered (hidden second `<video>`), gaps and still-image clips advance on wall clock.
- **WYSIWYG effects** — filters are stored once per clip; the monitor renders CSS approximations and export renders FFmpeg filter chains from the same params (crop fills via object-view-box ↔ `crop+scale`).
- **Proxy pipeline** — imports enqueue a background proxy; a Tauri event hot-swaps the timeline onto the proxy when ready. Images and audio skip proxies.
- **Recordings finalize through FFmpeg** — a stream-copy remux regenerates duration metadata that MediaRecorder omits, so clips import at their true length.
- **Voiceover + screen recorder** — MediaRecorder captures; recordings are saved to the app cache and placed on the timeline as normal clips at the playhead.
- **Bundled binaries** — `prepare-binaries.js` stages ffmpeg/ffprobe into `src-tauri/bin/`; Tauri resources ship them next to the exe (`<exe>/bin/`, `<exe>/resources/bin/` lookups).

## Packaging

| Command | Output |
|---|---|
| `npm run dist:win` | NSIS setup + MSIX (+ Inno `-inno` variant) |
| `npm run dist:release` | Full release: exe + msix + portable + updater `latest.json` |
| `npm run dist:linux:docker` | AppImage from any OS |

NSIS embeds the WebView2 offline runtime + FFmpeg. MSIX carries the same payload with the Store identity. Version bumps must touch root `Cargo.toml`, `apps/desktop/package.json`, `tauri.conf.json`, and root `package.json`.

## Roadmap

Keyframes/animation, advanced compositing (multi-layer preview), macOS builds, plugin SDK.
