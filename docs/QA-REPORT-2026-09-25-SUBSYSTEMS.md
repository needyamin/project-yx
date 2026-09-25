# Project YX — Subsystem QA Report: Advanced Audio · Advanced Video · Magic Removal

**Date:** 2026-09-25
**Companion to:** `docs/QA-REPORT-2026-09-25.md` (FFmpeg / playback / scheduler pass)
**Scope:** Deep audit of the three named subsystems + the zero-regression and
change-isolation requirements (§14–§22)
**Gates at completion:** `cargo test --workspace` **101 passed / 0 failed / 2 ignored**,
**0 source warnings**, `tsc && vite build` green, `npm run test:js` green

---

## 0. Method, and what "verified" means here

Baseline was re-established before any change, and every fix was re-verified
against the full gate set. Two principles were applied strictly:

- **Measure before optimising.** One suspicion was disproved by measurement and
  deliberately left alone (companion report §7.1). One was confirmed at 116 ms
  per frame and fixed (§5.2).
- **Distinguish "cannot reproduce here" from "fixed".** Where this environment
  cannot exercise a path, that is stated in §12 rather than glossed over.

A hard constraint of this environment must be stated up front because it bounds
what could be verified: **this sandbox cannot reliably create a child stdin
pipe.** `ffmpeg -version` with `stdin(piped)` fails with
`All pipe instances are busy (os error 231)` while the same command with
`stdin(null)` succeeds — measured across six stdio combinations. This is an
environment limitation, not an app defect, but it means the Magic Remove
*encoder* path (which inherently needs a raw-frame stdin pipe) could not be
exercised end-to-end here. See §12, R8.

---

## 1. Issues found

Severity uses the brief's priority order: correctness → stability →
synchronization → UX → responsiveness → performance → resources → maintainability.

| # | Issue | Severity | Component |
|---|---|---|---|
| G1 | Four FFmpeg invocations waited forever (`Command::output()` with no deadline) | **HIGH** | Advanced Audio preview, thumbnails, `probe_media`, recording remux |
| M1 | Cancelled Magic Remove render left a partial sidecar in the cache | **HIGH** | Magic Removal |
| M2 | A write error leaked a **running** encoder process | **HIGH** | Magic Removal |
| M3 | Mask shift cost **116 ms/frame at 4K** on the hot path | **HIGH** (performance) | Magic Removal |
| M4 | A decoder that died was indistinguishable from a clean EOF → silently truncated sidecar | **MEDIUM** | Magic Removal |
| M5 | Every decode allocated a stdin pipe that `-nostdin` guaranteed was unused | **MEDIUM** (resource) | Magic Removal / Blur tracking |
| A1 | "Hear processed result" had no staleness guard: a slow render could overwrite and play over a newer one, and could clear the busy state while a newer render ran | **MEDIUM** | Advanced Audio |
| A2 | Playback after the render used a hardcoded 120 ms delay | **MEDIUM** | Advanced Audio |

### G1 — Unbounded FFmpeg waits (Advanced Audio + shared)

**Reproduction.** Point any of these at media that ffmpeg cannot finish reading
(a network path that stops responding, a corrupt container, a wedged decoder):
import the file, scrub the timeline (thumbnail), press *Hear processed result*
(audio preview), or finish a recording. The operation never completes and never
explains itself; the surrounding UI waits on it forever.

**Root cause.** `Command::output()` blocks until the child exits, with no
deadline. Four call sites used it directly:

| Site | Consequence when it wedges |
|---|---|
| `probe_media` (`yx-media`) | Import, proxy enqueue, Magic Remove and export all hang |
| `get_media_thumbnail` | The thumbnail job never settles — and with the job-manager fix it also holds a concurrency slot |
| `render_audio_preview` | *Hear processed result* spins forever with no way out |
| `finalize_media_recording` | A finished recording is never adopted |

This is the same defect class already fixed for export in the companion report
(D1); these were the remaining instances.

**Fix.** One shared helper, `yx_media::run_bounded(&mut Command, timeout, what)`,
now used by all four (§3, G1). Deadlines: probe 30 s, thumbnail 20 s, audio
preview 180 s, remux 120 s.

### M1 — Cancelled render left a partial sidecar

**Reproduction.** Brush a mask, press ✨ Remove, press Cancel. Inspect
`%LOCALAPPDATA%/ProjectYX/magic-cache/` — a `<hash>.tmp.mp4` remains.

**Root cause.** `render_inpaint` has several failure exits and only ONE cleaned
up: the "encoder exited non-zero" branch. The cancel branch returned from the
frame loop *before* it, so every cancelled render leaked its partial output.
For a 4K clip that is hundreds of MB of garbage the user can neither see nor
reclaim.

**Fix.** An RAII guard (`RemoveOnDrop`) armed at function entry and disarmed only
on success, covering every current and future error path (§3, M1).

### M2 — A write error leaked a running encoder

**Reproduction.** Cause `enc_in.write_all` to fail (the encoder dies mid-render).
The function returns `Err`, but `enc_child` was a plain `Child` — and
`Child::drop` on Windows closes handles **without terminating the process**.
The encoder kept running and holding the output file.

**Fix.** The encoder is now wrapped in the crate's existing `KillOnDrop` guard
(made `pub(crate)`), reusing established infrastructure rather than adding a
second pattern (§19).

### M3 — Mask shift cost 116 ms/frame at 4K

**Reproduction.** Magic Remove on 4K media with a moving subject (tracked offset
non-zero). Measured directly.

**Root cause.** `shift_buffer` / `shift_buffer_bool` were naive per-pixel loops
with a bounds check per pixel, executed on **every frame whose tracked offset is
non-zero** — i.e. the normal case for a moving object — and they reallocated
both buffers per frame. Measured (debug): **58.24 ms + 57.99 ms = 116.23 ms per
frame at 4K**, 29.07 ms at 1080p. That is more than the entire rest of the
render.

**Fix.** Row-wise `copy_from_slice` into caller-owned buffers (rows are
contiguous, so a shift is one memmove per row), with the two buffers allocated
once per render instead of per frame (§3, M3; numbers in §5.2).

### M4 — A dead decoder looked like a clean EOF

**Reproduction (partial).** Not deterministically reproducible here — see the
limitation below.

**Root cause.** `FrameReader::next_frame` returned `Ok(false)` whenever the
stdout pipe hit EOF, with no check of the child's exit status, and the decoder's
`stderr` is `Stdio::null()`. A decoder that crashed on corrupt media was
therefore indistinguishable from a clean end of stream: the render produced a
sidecar with **fewer frames than the clip has** — a silently truncated result
the user would only notice as a frozen tail.

**Fix.** On EOF, `verify_exit()` now confirms the decoder exited successfully
and reports a clear error otherwise.

**Honest limitation.** I could not build a deterministic regression test: a
truncated MP4 is *tolerated* by ffmpeg (it warns "partial file" on stderr but
**exits 0** — measured at 5/10/20/30/50/70/90 % truncation), and a wholly
unreadable file fails at `probe_media` before the decoder is ever reached. The
fix is therefore defensive (it catches a hard decoder failure: crash, OOM kill,
unsupported codec surfacing at decode time) and **does not cover the
"partial file" case**, which needs a frame-count comparison — see R9.

### M5 — A needless pipe per decode

**Root cause.** `FrameReader::spawn` passed `Stdio::piped()` for stdin and then
immediately dropped it — while also passing `-nostdin`, which explicitly tells
ffmpeg not to read stdin. That allocated a Windows named-pipe instance per
decode for no purpose.

**Evidence it matters.** Removing it moved the pre-existing
`#[ignore]`d test's failure from the **decoder** spawn to the **encoder** spawn —
i.e. the decoder no longer consumes a pipe. Named pipes are a limited,
process-wide resource; exhausting them surfaces to the user as Magic Remove
refusing to run on a later clip with the cryptic
`All pipe instances are busy`.

**Fix.** `stdin(Stdio::null())` — the same immediate EOF with no pipe.

### A1 — Advanced Audio: no staleness guard on the processed preview

**Reproduction.** With a slow effect chain, press *Hear processed result*, change
a filter, press it again. The first render can land last: `processed` is
overwritten with audio from the **previous** filter chain and played. Separately,
the first request's `finally` clears `processingPreview` while the second render
is still running, so the button re-enables and the spinner disappears while work
continues.

**Root cause.** No request identity — every `await` completion wrote the shared
`processed` / `processingPreview` state unconditionally.

**Fix.** A monotonic `hearSeqRef`; only the newest request may set `processed`,
report status, or clear the busy flag (§3, A1).

### A2 — Advanced Audio: hardcoded 120 ms delay before playback

**Root cause.** After setting `processed`, playback was started by
`setTimeout(…, 120)` — a guess at how long React would take to commit the new
`src` to the `<audio>` element. Fire too early and `play()` starts the
**previous** render's audio; the delay is also dead time in the common case.

**Fix.** An effect keyed on the committed state, which by definition runs after
the commit. No timer, no guess. (`play()` buffers internally, so no readiness
poll is needed.)

---

## 2. Fixes — code changed and why it resolves the root cause

| # | File | Change | Why it fixes the *cause*, not the symptom |
|---|---|---|---|
| G1 | `crates/yx-media/src/lib.rs` (+ 3 Tauri call sites) | New `run_bounded()`: drains both pipes on reader threads, polls `try_wait` against a deadline, kills on expiry | The absence of a deadline *was* the defect; one shared implementation means no future call site can forget it. Draining before waiting also removes the pipe-full deadlock that a naive `wait()` reintroduces. |
| M1 | `crates/yx-media/src/magic.rs` | `RemoveOnDrop` RAII guard, armed on entry, disarmed on success | A guard covers error paths that do not exist yet. Adding cleanup to the cancel branch alone would leave the next new `?` as another leak. |
| M2 | `crates/yx-media/src/magic.rs`, `lib.rs` | Encoder wrapped in the existing `KillOnDrop` | The process is now owned by a guard instead of by every individual exit path. |
| M3 | `crates/yx-media/src/magic.rs` | `shift_plane_into` / `shift_plane_bool_into` (row-wise memmove) + buffers hoisted out of the frame loop | The per-pixel branch and the per-frame allocation were the cost. Both removed; equivalence proven exhaustively (§4.2). |
| M4 | `crates/yx-media/src/magic.rs` | `FrameReader::verify_exit()` on EOF | Uses the one signal available (`stderr` is nulled) instead of assuming EOF implies success. |
| M5 | `crates/yx-media/src/magic.rs` | `stdin(Stdio::null())` in `FrameReader::spawn` | Aligns the plumbing with the `-nostdin` flag that was already there; removes a resource allocation rather than working around it. |
| A1 | `apps/desktop/src/audio/AdvancedAudioDialog.tsx` | `hearSeqRef` request identity | Makes the newest request authoritative by construction, the same latest-wins discipline the timeline already uses (`engineSync.nextSeq`). |
| A2 | `apps/desktop/src/audio/AdvancedAudioDialog.tsx` | `playRequest` state + commit-ordered effect | Removes the timing assumption entirely instead of tuning the constant. |

---

## 3. Testing — scenario, expected, actual, result

### 3.1 New Rust regression tests (7 added this pass)

| Test | Scenario | Expected | Actual | Result |
|---|---|---|---|---|
| `bounded_run_returns_output_for_a_fast_command` | Fast ffmpeg run | Both streams captured | stdout contained `ffmpeg version` | **PASS** |
| `bounded_run_kills_a_command_that_overruns_its_deadline` | 60 s of 1080p `veryslow` vs a 400 ms budget | Killed near budget, reported | Error contains "did not finish"; elapsed < 15 s | **PASS** |
| `bounded_run_reports_a_spawn_failure_instead_of_panicking` | Non-existent binary | `FfmpegFailed`, no panic | As expected | **PASS** |
| `cleanup_guard_removes_armed_files_only` | Armed vs disarmed guard; missing file | Delete only when armed; never panic | As expected | **PASS** |
| `cancelled_render_removes_its_partial_output` | Pre-cancelled real render (real ffmpeg) | `Err` and **no** file left | As expected | **PASS** |
| `shift_matches_reference_for_every_offset` | 6 sizes (incl. 1×1, 7×5, 13×11) × every offset in and around frame, both planes | Pixel-identical to brute-force reference | As expected | **PASS** |
| `reused_shift_buffers_leave_no_residue` | Reused buffer, zero shift and fully-out-of-frame shift | No residue; full clear | As expected | **PASS** |

The equivalence test is the important one for M3: the mask is shifted on every
frame the subject moves, so a one-pixel error is not a rounding detail — it
offsets the removal region for the whole clip. Odd widths are included
specifically because that is where an indexing bug would hide.

### 3.2 Manual / behavioural verification

| Scenario | Expected | Actual | Result |
|---|---|---|---|
| Truncated MP4 (5–90 %) through probe + decode | — | ffprobe exit 0; **ffmpeg exit 0** (warns "partial file") | Recorded as R9 |
| Empty / random-bytes file | Rejected with a reason | ffprobe exit 1 with a message | **PASS** |
| Pre-existing 2-render test (`scoped_job_renders_only_its_window`) | Both renders succeed | Fails at the encoder spawn — **environment pipe limit**, and it failed *before* my changes too (at the decoder) | See R8 |
| Job-manager harness (`npm run test:js`) | 11 checks pass | 11 pass; **4 fail on the pre-fix module** | **PASS** |
| Backward-compat suite (7 tests, previous pass) | Legacy project opens/edits/saves/reopens | All pass | **PASS** |

### 3.3 Not testable in this environment (declared, not assumed)

No packaged-app run; no real 4K media; no 30/60-minute drift matrix; no
low-end-hardware pass; no pointer-driven UI session; Magic Remove encoder path
blocked by the stdin-pipe limitation (§0, R8). Nothing in this report claims
those.

---

## 4. Change boundary and shared-code impact (§18, §21)

Every change was checked against its callers before being made.

| Change | Who depends on it | Could it break? | How that was ruled out |
|---|---|---|---|
| `run_bounded` (new) | 4 call sites, all one-shot ffmpeg | A deadline could kill legitimate slow work | Deadlines are generous (20 s–180 s) and every site is a single-frame or single-clip operation. The audio preview keeps 180 s precisely because it runs a full effect chain. |
| `probe_media` now bounded | Import, proxy, Magic Remove, export | Same | 30 s is far above any real ffprobe. Verified by all existing media tests + the real-ffmpeg export suite. |
| `MediaInfo.is_variable_frame_rate` | `import_media` → TS `MediaInfo` | A **required** new field on a `Deserialize` type breaks older serialized data | Field is `#[serde(default)]`, matching the persisted timeline model's convention. Nothing consumes it in the UI yet. |
| `ensure_ffmpeg` caching | `probe_media`, export arg builders | A cached negative would hide a repaired install | Only the **success** case is cached. |
| `FrameReader` stdin → null | Magic Remove tracking/render, Blur auto-track | ffmpeg might need stdin | `-nostdin` was already passed; `null` yields the same immediate EOF. |
| `shift_plane_*` | Magic Remove render (tracking offsets) | A wrong shift silently corrupts masks | Exhaustive equivalence test vs a brute-force reference (§3.1). |
| `render_inpaint` cleanup | Magic Remove render | Could delete a **successful** render | `cleanup_guard_removes_armed_files_only` pins disarm-on-success specifically. |
| `AdvancedAudioDialog.hearProcessed` | Advanced Audio only | Could break the preview button | Contained to one component; `tsc` + the production build verify the types; the effect is strictly ordered after the commit. |

**Not touched, deliberately.** `magicRenderKey` / `magicResultReady` (the
staleness guard that already prevents a stale sidecar from being applied to
changed params — verified sound, so changing it would be gratuitous risk);
`App.tsx` and `ProjectMonitor.tsx` (the uncommitted A/V-sync work — see R7);
`reconcile.ts`'s comparison logic; the timeline model.

---

## 5. Performance

### 5.1 `probe_media` (companion report, restated)

231.45 ms → **117.42 ms** per probe (−49 %), 2 processes → 1.

### 5.2 Magic Remove mask shift — the significant win

Measured on the real functions, debug profile:

| | Before | After | Speed-up |
|---|---|---|---|
| 1080p alpha (u8) | 14.45 ms | 0.10 ms | **144×** |
| 1080p binary (bool) | 14.61 ms | 2.27 ms | 6.4× |
| **1080p total** | **29.07 ms/frame** | **2.37 ms/frame** | **12.3×** |
| 4K alpha (u8) | 58.24 ms | 0.60 ms | **97×** |
| 4K binary (bool) | 57.99 ms | 9.12 ms | 6.4× |
| **4K total** | **116.23 ms/frame** | **9.71 ms/frame** | **12.0×** |

**106 ms saved per frame at 4K.** For a 10 s 30 fps clip (300 frames) that is
roughly **32 seconds** off a single Magic Remove render, before counting the
removed per-frame allocation churn (~16 MB/frame at 4K). Release builds scale
the absolute numbers down, but the ratio holds — this was a per-pixel branch
where a memmove suffices.

### 5.3 Resource

- One fewer named-pipe allocation per decoded frame-run (M5).
- No leaked encoder process on write errors (M2).
- No leaked partial sidecar per cancelled render (M1).
- Bounded process count and lifetime for all one-shot FFmpeg calls (G1).

---

## 6. Regression matrix (§17) — results

| Area | Coverage | Result |
|---|---|---|
| **Timeline** — import/cut/trim/split/move/delete/undo/redo | `yx-timeline` 43 tests incl. 500-clip stress, insert/overwrite, ripple, slip, spacer, zone lift/extract | **PASS** |
| **Project** — save/close/reopen/continue/undo-after-reload | 7 backward-compat tests (legacy + new project chains, lossless round-trip) + 3 Tauri export-segment tests | **PASS** |
| **Rendering** — preview/export/multi-track/audio+video | `yx-media` 4 real-ffmpeg export tests (normal, mid-run cancel, pre-cancelled, stall watchdog) + 2 region-graph tests | **PASS** |
| **Advanced Audio** | `audio_effect_chain_includes_denoise_and_pitch`, `timeline_export_respects_audio_start_gap`, + the new bounded-preview path | **PASS** |
| **Advanced Video** | 4 video-chain tests (speed/`setpts`, reverse, transform clamp, speed+reverse), export arg tests, fps base | **PASS** |
| **Magic Removal** | 14 magic tests incl. mask raster/dilate/blur, tracking interpolation, scope hashing, shift equivalence, cleanup guard, cancelled render | **PASS** |
| **Blur Region / BG Key** | 7 region tests + 2 real-ffmpeg graph tests | **PASS** |
| **Synchronization** | Not exercisable here — see §12 R7 | **NOT VERIFIED** |
| **Media matrix** (720p→4K, 24–60 fps, VFR, codecs, containers) | Not exercisable here | **NOT VERIFIED** |

---

## 7. Backward compatibility (§20)

`crates/yx-timeline/tests/project_compat.rs` (7 tests) proves:

- **Old project → Open → Edit → Save → Reopen → Continue editing → Render**:
  a project JSON written *without* `source_path`, `fade_in`, `fade_out`,
  `reverse`, `speed`, `hidden`, `edit_mode`, `markers`, `zone_in`, `zone_out`
  loads with correct defaults, survives a full linked-A/V split → move → trim →
  retime → reverse → fade → add-filter → marker → zone edit sequence, undoes and
  redoes, and round-trips losslessly.
- **New project → Edit → Save → Reopen → Continue editing**: same guarantees.
- **Renamed filter kinds** (`video_denoise`, `magic_remove`, `blur_region`,
  `bg_mask`) still resolve via `serde(alias)`.
- **Unknown/future fields** do not make a project unopenable (pinned so a future
  `deny_unknown_fields` cannot break compatibility silently).
- **Export still works on legacy data**: 3 Tauri tests assert legacy clips yield
  exportable video *and* audio segments with defaults applied (notably
  `speed == 1.0`, since `0.0` would divide the duration by zero), and that
  muted/hidden tracks remain excluded.

The one compatibility risk **I** introduced — a required field on a
`Deserialize` type — was found by this review and fixed with `#[serde(default)]`.

---

## 8. Feature isolation (§15)

| Change | Advanced Audio | Advanced Video | Magic Removal | Timeline | Export | Save/load |
|---|---|---|---|---|---|---|
| `run_bounded` + 4 call sites | improves (preview bounded) | unaffected | improves (probe bounded) | unaffected | unaffected | unaffected |
| Magic cleanup/pipe/shift/exit | unaffected | unaffected | **fixes** | unaffected | improves (shorter renders) | unaffected |
| Advanced Audio staleness + delay | **fixes** | unaffected | unaffected | unaffected | unaffected | unaffected |

Verified by running each subsystem's tests independently *and* the whole
workspace together (§6). No change to one subsystem altered another's tests.

---

## 9. Compliance with "no masking" (§19, §11)

- No `sleep()`/delay was added; two were **removed** (the 120 ms playback delay
  and, in the companion report, the polling promise chain).
- No polling was added except a 25 ms deadline poll inside `run_bounded`, which
  bounds how late a kill lands and synchronises nothing.
- No functionality was disabled or bypassed; no parallel/duplicate state system
  was introduced.
- Existing infrastructure was reused rather than duplicated: `KillOnDrop` for
  the encoder, the timeline's latest-wins sequence pattern for the audio
  preview, one shared bounded-run helper for four call sites.
- No error is swallowed: the new paths all surface a message; the magic render
  path additionally stopped discarding a failed promote.

---

## 10. Regression risk introduced by this pass

Stated explicitly, since the brief requires it:

1. **A generous deadline could kill legitimate slow work.** Mitigated by the
   budget sizes (20 s thumbnail → 180 s audio preview) and by the fact that each
   site is a single-frame or single-clip operation. Residual risk: an extremely
   slow machine rendering a very long audio preview could hit 180 s.
2. **`verify_exit()` could reject a decode that ffmpeg considers successful.**
   Only triggers on a non-zero exit, which on a normal decode does not happen.
   Verified by the full media suite passing.
3. **The audio-preview change alters when playback starts.** Previously a fixed
   120 ms; now the first commit after the render. Strictly later-or-equal, and
   never the wrong source.

---

## 11. Recommended architectural improvements

1. **One supervised-subprocess primitive.** There are now four hand-rolled
   process-lifecycle implementations (`run_bounded`, `run_ffmpeg_progress`,
   `yx-proxy`'s poll loop, `FrameReader`/`render_inpaint`). Each got a different
   subset of drain/deadline/cancel/exit-status handling right, and every defect
   in this report (G1, M1, M2, M4) came from a different one. Consolidating them
   would have prevented all four.
2. **Make the Magic pipeline a single ffmpeg process where possible.** The
   decoder→Rust→encoder pair exists because the inpainting is custom Rust code.
   If the per-pixel work were expressed as an ffmpeg filter, the raw-frame pipe
   (and its Windows pipe-instance cost) disappears entirely.
3. **Replace the boolean mask with a byte plane.** `shift_plane_bool_into` is
   still 9.12 ms/frame at 4K because `<[bool]>::copy_from_slice` is not lowered
   to a memcpy. A `Vec<u8>` mask would make it ~0.6 ms like the alpha plane —
   a further ~9 ms/frame at 4K. Deferred deliberately: `Vec<bool>` is threaded
   through `rasterize_mask`, `dilate_bool` and `spatial_fill_pixel`, so this is
   a representation change that warrants its own regression pass.
4. **Compare decoded frame count against the expected count** to close the
   "partial file exits 0" gap (R9).
5. **Adopt a frontend test runner** (Vitest fits the existing Vite 8 setup).
   `scripts/test-job-manager.mts` proved these modules are testable in
   isolation; the Advanced Audio fix (A1/A2) has no automated coverage because
   there is still no runner.

---

## 12. Remaining issues

### New in this pass

| # | Issue | Severity | Why not fixed |
|---|---|---|---|
| R8 | **Magic Remove's encoder path cannot be exercised in this environment.** The sandbox cannot reliably create a child stdin pipe (`All pipe instances are busy`), which the raw-frame encoder inherently needs. | — (environment) | Not an app defect. Verified that `stdin(null)` works and that the pre-existing 2-render test failed *before* my changes too. Must be validated on a normal machine. |
| R9 | **A truncated source is silently rendered short.** ffmpeg tolerates a partial MP4 and **exits 0** (measured at 5–90 % truncation), so neither `verify_exit()` nor probe catches it. | **MEDIUM** | Fix requires comparing the decoded frame count to `total_frames`, which needs a tolerance decision and risks false positives on legitimate short renders. Recorded with evidence rather than guessed at. |
| R10 | `shift_plane_bool_into` is still 9.12 ms/frame at 4K. | **LOW** (performance) | Needs the mask representation change in §11.3. |
| R11 | No automated coverage for the Advanced Audio dialog fixes (A1/A2). | **MEDIUM** (test gap) | No frontend test runner exists; `tsc` + production build only prove they compile. |

### Carried over from the companion report

| # | Issue | Severity |
|---|---|---|
| R1 | No export mutual exclusion — two exports share one `export_cancel` flag and can un-cancel each other | MEDIUM |
| R2 | `ProxyManager::cancel` is unreachable (no command, no UI path) | MEDIUM |
| R3 | `transitioningRef` 50 ms pause-suppression window is still a hardcoded timing assumption | MEDIUM |
| R4 | `waveformPeaks` `overviewCache`/`overviewFailed` remain unbounded | LOW |
| R5 | Export's non-timeline branch still probes synchronously inside an `async fn` | LOW |
| R6 | `FrameReader` still nulls ffmpeg's `stderr`, so decode failures carry no ffmpeg detail | LOW |
| R7 | **Playback / A-V synchronisation and the 4K media matrix are unverified** — they need the packaged app, the `/qa.html` harness and real media | **HIGH (unverified)** |

---

## 13. Production-readiness assessment

**The three subsystems are materially more reliable than at the start of this
pass, and nothing here is claimed beyond what was measured.**

**What the evidence supports**

- **Magic Removal no longer leaks.** Cancelled renders leave no partial sidecar;
  write errors no longer leak a running encoder; every decode allocates one
  fewer pipe; a hard decoder failure is now reported instead of silently
  producing a short result.
- **Magic Removal is ~12× faster on its hot path** — 116 ms → 9.7 ms per frame
  at 4K, measured, with the mask shift proven pixel-identical to a brute-force
  reference across every offset and six buffer sizes.
- **Advanced Audio's processed preview is correct under repeated/overlapping
  use**: the newest request is authoritative, the busy state cannot be cleared
  by a superseded request, and playback can no longer start the previous render.
- **Four previously unbounded waits now have deadlines**, converting "spins
  forever" into a reported error across audio preview, thumbnails, probing and
  recording finalize.
- **Zero regressions in the verifiable surface**: 101 tests pass (from a
  baseline of 77), 0 warnings, backward compatibility proven for old *and* new
  projects, and each subsystem verified independently and together.

**What the evidence does not support**

- **The Magic Remove encoder path is not end-to-end verified here** (R8). The
  algorithm-level work is covered by 14 tests, but the actual
  decode→inpaint→encode cycle could not run in this sandbox.
- **A truncated source still renders short** (R9).
- **Playback, A-V synchronisation and the 4K media matrix remain unverified**
  (R7) — unchanged from the companion report, and still the largest gap between
  this codebase and a release.
- **No automated coverage for the Advanced Audio dialog** (R11).

**Recommended gate before release**

1. Run the full Magic Remove workflow on a normal machine, including cancel and
   re-render, and confirm the encoder path works end to end (R8).
2. Run `/qa.html` with `?seed=speed|split|reverse|speedcut|reverse-overlap` in
   the packaged WebView2 window (R7).
3. Execute the 30/60-minute drift matrix and the 4K/low-end-hardware acceptance
   pass with real media (R7).
4. Decide and implement R9 (frame-count check) and R1 (export mutual exclusion).
5. Add a frontend test runner and cover A1/A2 (R11).

Until 1–3 are done, statements about Magic Remove's real rendering behaviour and
about 4K playback would be assumptions, not measurements.
