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
| `yx-media` | FFmpeg/ffprobe driver: probing, effect filter chains (WYSIWYG with preview), background export with progress, loudnorm/de-esser/drawtext/lut3d etc., and the Magic Remove engine (mask rasterisation, template tracking, temporal+spatial background reconstruction). Owns `run_bounded` — the deadline wrapper every one-shot ffmpeg/ffprobe call must use. |
| `yx-detect` | Hardware probe at launch (CPU/RAM/GPU/encoders) → performance tier; binary discovery (next-to-exe → PATH). |
| `yx-proxy` | Background proxy transcoder: single worker queue, auto hot-swap when ready, skips audio/images. |
| `yx-compositor` | Preview filter budget and 16:9 / 9:16 aspect policy. |

## UI (apps/desktop/src)

| Module | Role |
|---|---|
| `bin/` | Project Bin: import, tabs (All/Audio/Effects/Applied), drag to timeline |
| `timeline/` | Timeline panel, ClipBlock drag engine, Ruler, waveform/thumbnail surfaces, viewport culling, screen recorder, voiceover |
| `monitors/` | Project Monitor (crop, transform drag, text overlay, **Magic Remove** brush + tracking, **Blur Region**, **BG Key**) and Clip Monitor |
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
- **Persistence — explicit save only.** `.yxp` save/open with atomic tmp+rename writes on Rust's blocking pool. **There is no autosave, no session restore and no exit-time flush — by user decree.** Nothing is written or restored behind the user's back; every launch boots the engine's fresh empty timeline, and unsaved work is lost if the app dies. Do not re-add it.
- **WYSIWYG effects** — filters are stored once per clip; the monitor renders CSS approximations and export renders FFmpeg filter chains from the same params (crop fills via object-view-box ↔ `crop+scale`).
- **Proxy pipeline** — imports enqueue a background proxy through one long-lived dispatcher thread; a Tauri event hot-swaps the timeline onto the proxy when ready. Images and audio skip proxies.
- **Recordings finalize through FFmpeg** — a stream-copy remux regenerates duration metadata that MediaRecorder omits, so clips import at their true length.
- **Bundled binaries** — `prepare-binaries.js` stages ffmpeg/ffprobe into `src-tauri/bin/`; Tauri resources ship them next to the exe (`<exe>/bin/`, `<exe>/resources/bin/` lookups).

## Reliability & failure handling

These are the rules the QA passes established; they exist because each one was
a real defect first. See `docs/QA-REPORT-2026-09-25.md` and
`docs/QA-REPORT-2026-09-25-SUBSYSTEMS.md`.

- **Every one-shot ffmpeg/ffprobe call has a deadline.** `yx_media::run_bounded(cmd, timeout, what)` drains both pipes on reader threads, polls `try_wait` against a deadline and kills on expiry. `Command::output()` has no timeout and must not be used for media — a wedged decoder used to hang import, thumbnails, the audio preview and recording finalize forever with no diagnostic.
- **Long-running encodes are supervised.** Export runs a `-progress pipe:1` reader on its own thread and polls cancellation every iteration; a stall of 120 s kills the child and reports it. `KillOnDrop` guards guarantee no error path leaks a running encoder — `Child::drop` on Windows closes handles but does **not** terminate the process.
- **Output files are guarded.** Exports and proxy transcodes write to a sibling tmp path and rename on success; `render_inpaint` uses an RAII `RemoveOnDrop` guard armed on entry and disarmed on success, so a cancelled Magic Remove cannot leave a partial sidecar in the cache.
- **EOF is not success.** ffmpeg exits 0 on a truncated MP4, so `FrameReader` verifies the decoder's exit status at end of stream instead of treating EOF as a clean finish. (A frame-count comparison is still open — see the QA matrix.)
- **Every edit must leave a valid timeline.** `TimelineEditor::apply()` runs `Timeline::validate()` after every command and rolls the edit back with `InvalidResult` if it fails, so a refused edit is a complete no-op. `validate()` treats a same-track overlap as corruption unless the later clip carries an enabled `Transition` (the deliberate crossfade overlap `AddTransition` creates). Measured cost: 0.15 ms @100 clips, 0.92 ms @500 — affordable because an edit round-trip is dominated by IPC.
- **A duration change is a timeline operation.** Speed/trim/replace changes go through helpers that resolve the freed or consumed space by `edit_mode` (`Normal` keeps neighbours put and reports a collision, `Insert` ripples the clip's own track, `Overwrite` consumes the range via `overwrite_range_except`) and retime a linked A/V partner with the clip. Transitions are re-clamped so a crossfade cannot outlive the clip that carries it. Ripple is deliberately per-track: background music and SFX never move.
- **Latest-wins on every async write.** Responses that can complete out of order carry a sequence id and superseded ones are dropped: `engineSync` for timeline edits, `hearSeqRef` for the Advanced Audio preview. A slow response must never overwrite newer state.
- **Cancellation is cooperative and polled, never a timer.** Export, proxy jobs, Magic Remove tracking/render and Blur auto-track all use an `AtomicBool` polled by the worker; no `sleep()`-based synchronisation or hardcoded delay is used to paper over a race.
- **Bounded concurrency and bounded caches.** The frontend job manager caps concurrent background jobs and holds a slot until a job actually settles; derived caches (thumbs 200 MB, magic-cache 2 GB, audio-previews 512 MB, bg-mask 64 MB) are swept on a liveness-aware LRU, and the in-memory thumbnail maps are FIFO-capped.

## Packaging

| Command | Output |
|---|---|
| `npm run dist:win` | NSIS setup + MSIX (+ Inno `-inno` variant) |
| `npm run dist:release` | Full release: exe + msix + portable + updater `latest.json` |
| `npm run dist:linux:docker` | AppImage from any OS |

NSIS embeds the WebView2 offline runtime + FFmpeg. MSIX carries the same payload with the Store identity. Version bumps must touch root `Cargo.toml`, `apps/desktop/package.json`, `tauri.conf.json`, and root `package.json`.

## Roadmap

Keyframes/animation (a general system — the Blur Region tool has position keyframes today), advanced compositing (multi-layer preview), macOS builds, plugin SDK, variable-frame-rate handling end-to-end, and a frame-count check for truncated sources.
