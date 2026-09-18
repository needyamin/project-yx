# Project YX — Stack

What Project YX is built with and how the pieces connect. Short version: **Tauri 2 shell + React UI + Rust engine crates + bundled FFmpeg. No Electron.**

App ID `com.projectyx.editor` · GPL-3.0-or-later · Version lives in root `package.json` (build scripts auto-sync `Cargo.toml`, `apps/desktop/package.json`, `tauri.conf.json`).

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
| `yx-timeline` | Pure in-memory model: tracks, clips, cuts (normal/insert/overwrite), ripple/slip/spacer, transitions, filters, markers, zones, undo/redo, consistency validation, engine benchmarks. Zero disk I/O. |
| `yx-media` | FFmpeg/ffprobe driver: probing, effect filter chains (WYSIWYG with preview), background export with progress, loudnorm/de-esser/drawtext/lut3d etc. |
| `yx-detect` | Hardware probe at launch (CPU/RAM/GPU/encoders) → performance tier; binary discovery (next-to-exe → PATH). |
| `yx-proxy` | Background proxy transcoder: single worker queue, auto hot-swap when ready, skips audio/images. |
| `yx-compositor` | Preview filter budget and 16:9 / 9:16 aspect policy. |

## UI (apps/desktop/src)

| Module | Role |
|---|---|
| `bin/` | Project Bin: import, tabs (All/Audio/Effects/Applied), drag to timeline |
| `timeline/` | Timeline panel, ClipBlock drag engine, Ruler, waveform/thumbnail surfaces, viewport culling, screen recorder, voiceover |
| `monitors/` | Project Monitor (crop tool, transform drag, text overlay) and Clip Monitor |
| `playback/` | The playback clock store: one authoritative playhead, throttled subscriptions for time-displaying leaves |
| `jobs/` | Background job scheduler: priorities (scrub > playback > visible > background), AbortSignal cancellation, request coalescing |
| `audio/` + `video/` | Advanced Audio Tools (voice clean, waveform) and video dialogs |
| `effects/` | Effect catalog, WYSIWYG preview styles, inspector |
| `export/` | Presets, output preview, progress |
| `layout/` | Menubar, About dialog |
| `dev/` | Benchmark harness (mock Tauri backend), served only by `bench.html` in dev |

## Key engineering decisions

- **Presented-frame playback clock** — in video mode the timeline position is derived from `requestVideoFrameCallback` metadata (each *delivered* frame carries its media timestamp), with a self-healing rAF sampler as fallback. Correct pacing for 23.976/29.97/60 fps; buffer starvation surfaces as status text, never a frozen clock.
- **One authoritative playhead** — `playback/playbackClock.ts` is the single store; timecodes, scrub sliders and overlay layers subscribe as tiny leaves, so playback and scrubbing re-render only those leaves — never the project tree. The playhead line, snap guides and fade styles are imperative DOM writes (~µs per publish).
- **Identity-preserving timeline updates** — the Rust engine returns the whole timeline per edit; `timeline/reconcile.ts` reuses previous object references for unchanged tracks/clips/filters so memoized clips skip re-render (moving clip #37 re-renders one clip, not 500).
- **Viewport culling + zoom-aware clips** — only clips intersecting the scrolled viewport render; extreme zoom-out drops handles/text/waveforms so DOM size stays independent of project length.
- **Background job manager** — waveforms and thumbnails go through a priority scheduler (scrub > playback > visible > background) with AbortSignal cancellation and request coalescing; the UI thread never blocks.
- **Waveform pipeline** — one decode + one 4096-bin peak overview per media file, computed in rAF chunks; drawing samples it at display resolution, so zooming never regenerates data.
- **Thumbnail pipeline** — FFmpeg extracts a 192px JPEG per (file, mtime, 0.25s bucket) into a disk cache on the blocking pool; unchanged media never regenerates, and original media is used (never proxies).
- **Persistence & recovery** — `.yxp` save/open with atomic tmp+rename writes on Rust's blocking pool; a background autosave lands a few seconds after every edit and is restored automatically at next launch after a crash.
- **WYSIWYG effects** — filters are stored once per clip; the monitor renders CSS approximations and export renders FFmpeg filter chains from the same params (crop fills via object-view-box ↔ `crop+scale`).
- **Proxy pipeline** — imports enqueue a background proxy; a Tauri event hot-swaps the timeline onto the proxy when ready. Images and audio skip proxies.
- **Recordings finalize through FFmpeg** — a stream-copy remux regenerates duration metadata that MediaRecorder omits, so clips import at their true length.
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
