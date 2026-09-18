# Project YX — QA / Regression Matrix

Status legend: **PASS** verified · **PARTIAL** verified with gaps · **PENDING** not yet verified (needs packaged app / target hardware). Last updated: 2026-09-19.

## Automated gates (every change must pass)

| Gate | Command | Status |
|---|---|---|
| Rust workspace check | `cargo check --workspace` | PASS |
| Rust tests (incl. timeline engine, media, cache sweep) | `cargo test --workspace` | PASS (yx-timeline 33, yx-media 19, yx-desktop 2 + engine benches `#[ignore]`) |
| Engine benchmark budgets | `cargo test -p yx-timeline bench -- --ignored --nocapture` | PASS (0.09 ms snapshot @500 clips) |
| Frontend type-check + build | `cd apps/desktop && npm run build` | PASS |
| Production release pipeline | `npm run dist:release` | PASS (exit 0; NSIS/MSIX/portable/updater sig; AppImage needs Docker) |

## Playback & sync (real media)

| Scenario | Status | Notes |
|---|---|---|
| 4K30 playback (presented frames) | PASS | 99% (bench harness, idle machine) |
| 4K HEVC playback | PASS | 99% |
| 1080p60 playback | PENDING | ~78–92% presented frames; suspect webview pane pacing — verify in packaged WebView2 window before coding |
| A/V drift over 60 s | PASS | 12.3 ms max (mock-IPC harness) |
| Rapid seek A→B→C (latest wins) | PASS | latest-wins playhead + engineSync drops superseded responses |
| Play after seek / clip boundary crossing | PASS | updateUnderPlayhead boundary detection |

## Editing operations

| Operation | Status | Notes |
|---|---|---|
| Move / trim / split / slip (single + linked A/V) | PASS | drag latency 18 ms @500 clips; linked-partner preview cleared on gesture end (stale-preview bug fixed 2026-09-19) |
| Optimistic edit failure rollback | PASS | engineSync lastEngineTimeline() rollback |
| Undo / redo vs in-flight edits | PASS | shared engineSync sequence guard |
| Close gap / ripple (GUI follows immediately) | PASS | stale dragPreview eliminated 2026-09-19 |
| Save (.yxp) / open / new project | PASS | atomic tmp+rename; responses from previous project invalidated |
| Crash recovery (autosave) | PARTIAL | re-implemented 2026-09-19 (engine-authoritative, 3 s debounce); exit-time flush missing → last ≤3 s at risk; long-session adoption matrix pending |
| Magic Remove multi-region | PASS | commit serialization + duplicate consolidation |
| Magic Remove clip-scoped tracking/render | PASS | track+render bound to the clip's source range (`scopeIn`/`scopeOut`), sidecar keyed by scope; preview/playback/export remap element time by scope (unit-tested in magic.rs); trimmed-past-window clips fall back to the original |
| Export (H.264 4K, 9:16, GPU encoders) | PASS | originals-not-proxies verified |

## Media matrix (manual, needs real files)

| Media | Status |
|---|---|
| 720p/1080p/4K H.264, H.265, portrait, long recordings | PENDING hardware pass |
| Variable frame rate sources | PENDING |
| Images/GIF import & loop-on-export | PASS (unit + manual) |
| Malformed / missing media | PARTIAL — probe errors surfaced; no ffmpeg timeouts yet (hung-file freeze possible) |

## Hardware pass (manual — target machines only)

| Tier | Status |
|---|---|
| Low-end dual-core, 4 GB RAM | PENDING |
| Mid-range / integrated GPU | PENDING |
| High-end / discrete GPU (NVENC/QSV/AMF) | PARTIAL (encoder detection unit-tested) |
| HDD vs SSD project/media location | PENDING |

## Known open engineering items (tracked in context_memory.txt)

1. Export/proxy ffmpeg children are not killed on cancel/error; outputs written directly to final path (no tmp+rename).
2. `render_audio_preview`, recording save, `reprobe_hardware` run blocking ffmpeg on the main thread (need async + `spawn_blocking`).
3. Proxy-cache pruning needs a source-liveness check before LRU deletion.
4. No exit-time autosave flush (`RunEvent` handler absent).
5. Remaining unguarded single-shot invoke sites (delete/ripple, zones, auto-PiP, proxy hot-swap) — low risk.
