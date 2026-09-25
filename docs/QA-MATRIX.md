# Project YX — QA / Regression Matrix

Status legend: **PASS** verified by an automated test or a measurement ·
**PARTIAL** verified with a stated gap · **PENDING** not yet verified (needs the
packaged app / target hardware) · **N/A** deliberately not supported.

Last updated: **2026-09-25**. Full write-ups:
[docs/QA-REPORT-2026-09-25.md](QA-REPORT-2026-09-25.md) (FFmpeg / playback /
scheduler) and
[docs/QA-REPORT-2026-09-25-SUBSYSTEMS.md](QA-REPORT-2026-09-25-SUBSYSTEMS.md)
(Advanced Audio / Advanced Video / Magic Removal).

> Anything marked PASS below was executed on this machine. Anything PENDING was
> **not** executed, and no claim is made about it. Do not read this file as a
> general statement of quality — it is a ledger of what has and has not been
> checked.

## Automated gates (every change must pass)

| Gate | Command | Status |
|---|---|---|
| Rust workspace check | `cargo check --workspace --all-targets` | PASS — 0 source warnings |
| Rust tests | `cargo test --workspace` | PASS — **122 passed, 0 failed, 2 ignored** |
| Frontend type-check + build | `npm --prefix apps/desktop run build` | PASS |
| Frontend module regression harness | `npm run test:js` | PASS — 11 checks |
| Engine benchmark budgets | `cargo test -p yx-timeline bench -- --ignored --nocapture` | PASS (all within budget; per-edit validate() cost noted below) |
| Production release pipeline | `npm run dist:release` | PASS (exit 0; NSIS/MSIX/portable/updater sig; AppImage needs Docker) |

> The FFmpeg integration tests **skip silently** unless `ffmpeg` is on PATH.
> Export `apps/desktop/src-tauri/bin` first or the run proves nothing.

### Test inventory

| Suite | Count | Covers |
|---|---|---|
| `yx-timeline` (lib) | 36 | Edits, linked A/V, insert/overwrite, ripple, slip, spacer, zone lift/extract, 500-clip stress, validation |
| `yx-timeline/tests/project_compat.rs` | 7 | `.yxp` backward compatibility (old & new chains, lossless round-trip) |
| `yx-timeline/tests/speed_ripple.rs` | 21 | **Smart timeline**: speed as a duration edit, ripple vs. absolute, linked A/V sync, conflicts, transitions, undo/redo, save/reload, speed sweep |
| `yx-media` (lib) | 33 | Effect chains, export args, Magic Remove algorithms, region fragments, VFR/frame-rate parsing |
| `yx-media/tests/export_progress_ffmpeg.rs` | 4 | **Real FFmpeg**: export progress, mid-run cancel, pre-cancelled, stall watchdog |
| `yx-media/tests/bounded_process_ffmpeg.rs` | 3 | **Real FFmpeg**: bounded run success, deadline kill, spawn-failure reporting |
| `yx-media/tests/region_ffmpeg.rs` | 2 | **Real FFmpeg**: blur-region and bgmask filtergraphs |
| `yx-proxy` | 5 | Job lifecycle, queued cancel, retry, playback-path fallback |
| `yx-detect` / `yx-compositor` | 3 / 2 | Hardware tiering, preview filter budget |
| `yx-desktop` | 6 | Cache sweep (3), legacy-project export segments (3) |
| `scripts/test-job-manager.mts` | 11 checks | Scheduler: coalescing, concurrency cap, priority bump, cancelAll |

## FFmpeg process lifecycle

| Scenario | Status | Notes |
|---|---|---|
| Export stall (wedged encoder, no output) | PASS | Killed and reported after 120 s of silence; verified against real ffmpeg |
| Export cancel while running | PASS | Polled on every loop iteration; verified mid-encode |
| Export cancel when already cancelled | PASS | Returns `Cancelled` immediately |
| Export stdout read error | PASS | Treated as fatal — no `child.wait()` deadlock on a truncated drain |
| One-shot probe / thumbnail / audio preview / remux | PASS | All bounded via `run_bounded` (30 / 20 / 180 / 120 s); unbounded `Command::output()` eliminated |
| A silent command is killed at its deadline | PASS | Verified: 60 s 1080p `veryslow` encode vs a 400 ms budget |
| Spawn failure is reported, not panicked | PASS | Verified |
| Proxy job cancelled while QUEUED | PASS | Flag registered at request time and honoured before ffmpeg spawns |
| Proxy rename failure | PASS | Marks the job Failed (retryable) and removes the tmp file — no permanent `Running` wedge |
| Cancelled Magic Remove render | PASS | RAII guard removes the partial sidecar on every error path |
| Encoder write error | PASS | Encoder killed via `KillOnDrop`; no leaked running process |
| Decoder exits non-zero | PARTIAL | Reported via `verify_exit()`, but **not testable deterministically here** — see the truncation row below |
| Truncated / partial source | **PARTIAL — KNOWN GAP** | ffmpeg **tolerates** a partial MP4 and exits 0 (measured at 5–90 % truncation), so a short render is produced silently. A frame-count check is the fix |
| Magic Remove encoder path, end-to-end | **PENDING** | Not exercisable in the audit sandbox (it cannot create a child stdin pipe — `All pipe instances are busy`); needs a normal machine |

## Playback & sync (real media)

| Scenario | Status | Notes |
|---|---|---|
| 4K30 playback (presented frames) | PARTIAL | 99 % on the bench harness, idle machine — not re-verified this pass |
| 4K HEVC playback | PARTIAL | 99 % (same caveat) |
| 1080p60 playback | PENDING | ~78–92 % presented frames; suspected WebView pane pacing — must be confirmed in the packaged window before changing code |
| A/V drift over 60 s | PARTIAL | 12.3 ms max (mock-IPC harness); 30–60 min matrix still pending |
| Speed ≠ 1 audio mapping | PASS | Element rate, drift target and export tempo all scale by clip speed |
| Rapid seek A→B→C (latest wins) | PASS | Latest-wins playhead + `engineSync` drops superseded responses |
| Play after seek / clip boundary crossing | PASS | `updateUnderPlayhead` boundary detection |
| Per-frame covering-set scan cost | PASS | **Measured** 0.19 ms/frame at 3000 clips (1.1 % of a 60 fps budget) — investigated and deliberately left alone |
| Playback under sustained use | PENDING | Needs the `/qa.html` harness in a real browser |

## Editing operations

| Operation | Status | Notes |
|---|---|---|
| Move / trim / split / slip (single + linked A/V) | PASS | Drag latency 18 ms @500 clips; linked-partner preview cleared on gesture end |
| Optimistic edit failure rollback | PASS | `engineSync` `lastEngineTimeline()` rollback |
| Undo / redo vs in-flight edits | PASS | Shared `engineSync` sequence guard |
| Close gap / ripple | PASS | Stale drag-preview eliminated |
| **Speed change as a duration edit** | PASS | 21 tests. Rate changes retime the clip AND its linked A/V partner, then resolve the freed/consumed space by edit mode: Normal keeps neighbours put and *reports* a collision, Insert ripples the same track only, Overwrite consumes the grown range. Transitions are re-clamped so a crossfade cannot outlive its clip. |
| **Speed sweep 0.1x–99x, both directions, all modes** | PASS | Every accepted speed leaves `validate()` empty; every refused one is a complete no-op. Undo/redo and save/reload verified across the sequence. |
| **Timeline invariant gate** | PASS | `apply()` validates after every edit and rolls back + reports on failure. This closed the same silent-overlap hole in `TrimClip` (extending) and `AddClip` (overlapping insert), not just speed. |
| Overlap detection in `validate()` | PASS | Same-track overlap is an error unless the later clip carries an enabled Transition (the deliberate crossfade overlap). |
| Save (.yxp) / open / new project | PASS | Atomic tmp+rename; responses from the previous project invalidated |
| Backward compatibility (old project → open → edit → save → reopen → continue → render) | PASS | 7 compatibility tests + 3 export-segment tests |
| Renamed effect kinds still load | PASS | `serde(alias)` for `video_denoise` / `magic_remove` / `blur_region` / `bg_mask` |
| Crash recovery / autosave | **N/A** | **Removed by user decree — nothing is written or restored behind the user's back.** Every launch starts fresh; unsaved work is lost on a crash. Do not re-add |
| Magic Remove multi-region | PASS | Commit serialization + duplicate consolidation |
| Magic Remove clip-scoped tracking/render | PASS | Track+render bound to the clip's source range; sidecar keyed by scope; preview/playback/export remap by scope |
| Magic Remove staleness guard | PASS | `magicRenderKey` / `magicResultReady` cover strokes, keyframes, feather, expand, accuracy, strength **and** scope coverage |
| Mask shift correctness | PASS | Row-wise shift proven pixel-identical to a brute-force reference for every offset over 6 sizes (incl. 1×1, 7×5, 13×11) |
| Magic Remove mask-shift performance | PASS | **Measured** 4K 116.23 → 9.71 ms/frame (12×); u8 plane 58.24 → 0.60 ms (97×) |
| Advanced Audio processed preview under repeated/overlapping use | PASS (logic) | Newest request is authoritative; busy state cannot be cleared by a superseded request. **No automated UI test** — no frontend runner |
| Export (H.264 4K, 9:16, GPU encoders) | PASS | Originals-not-proxies verified |

## Media matrix (manual, needs real files)

| Media | Status |
|---|---|
| 720p / 1080p / 4K H.264, H.265, portrait, long recordings | **PENDING** hardware pass |
| Variable frame rate sources | **PARTIAL** — detected and flagged in the media model (`is_variable_frame_rate`); the UI does not act on it yet, so VFR can drift |
| Fractional frame rates (23.976 / 29.97 / 59.94) | PASS — presented-frame clock, plus unit tests for rate parsing |
| Images / GIF import & loop-on-export | PASS (unit + manual) |
| Malformed / missing / unreadable media | PASS — probe errors surfaced, and all one-shot FFmpeg calls are now bounded (previously a hung file could freeze the operation indefinitely) |
| Truncated but parseable media | **PARTIAL** — see the truncation row in the process-lifecycle table |

## Hardware pass (manual — target machines only)

| Tier | Status |
|---|---|
| Low-end dual-core, 4 GB RAM | **PENDING** |
| Mid-range / integrated GPU | **PENDING** |
| High-end / discrete GPU (NVENC / QSV / AMF) | PARTIAL (encoder detection unit-tested; a failing GPU encode falls back to software) |
| HDD vs SSD project/media location | **PENDING** |

## Known open engineering items

Tracked with root causes in the QA reports; summarised here.

1. **Per-edit validation cost.** `apply()` now runs `validate()` after every edit (0.154 ms @100 clips, 0.924 ms @500), which makes an edit ~1.05 ms @500 clips versus the 0.105 ms baseline. Affordable because the edit round-trip is dominated by IPC (6.4 ms serialize + 3.6 ms deserialize @500), but do not add further per-edit passes without re-measuring.
2. **Markers stay absolute when clips ripple.** They are user-placed timeline cues, so moving them silently would violate the "preserve user intent" rule. Revisit if users report misaligned markers after a ripple.
3. **No general keyframe system.** Transform / Crop / Text are static values; only the Blur Region tool has position keyframes, and Magic Remove has manual mask keyframes.
4. **Truncated source renders short.** ffmpeg tolerates a partial MP4 and exits 0, so neither the exit-status check nor probe catches it. Fix = compare the decoded frame count against the expected count (needs a tolerance decision).
5. **No export mutual exclusion.** Two concurrent exports share one `export_cancel` flag and can un-cancel each other. The UI currently serialises exports, so the race is not reachable from the normal path.
6. **`ProxyManager::cancel` is unreachable** — no Tauri command and no UI path calls it, so proxies for deleted media keep encoding. The API itself is now correct for whoever wires it.
7. **Magic Remove encoder path is not end-to-end verified** (needs a normal machine; the audit sandbox cannot create child stdin pipes).
8. **`transitioningRef` 50 ms pause-suppression window** is still a hardcoded timing assumption. It is load-bearing for gap/cut playback, so changing it needs a reproduction of the original failure.
9. **`shift_plane_bool_into` is still 9.12 ms/frame at 4K** because `<[bool]>::copy_from_slice` is not lowered to a memcpy. Converting the mask to `Vec<u8>` would recover ~9 ms/frame but touches `rasterize_mask` / `dilate_bool` / `spatial_fill_pixel`.
10. **`FrameReader` nulls ffmpeg's stderr**, so decode failures carry no ffmpeg detail (only the exit status).
11. **`waveformPeaks` `overviewCache` / `overviewFailed` remain unbounded** (one small entry per media file); `decodedCache` is capped at 24.
12. **Export's non-timeline branch probes synchronously inside an `async fn`** (cold path, no proxy fan-out).
13. **No frontend test runner.** `scripts/test-job-manager.mts` proves the modules are testable from Node; Vitest would fit the existing Vite 8 setup and would close the coverage gap on the dialogs and monitor tools.
14. **Playback, A/V synchronisation and the 4K media matrix remain unverified** — the largest gap between this codebase and a release.
