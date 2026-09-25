# Contributing to Project YX

Thanks for helping build Project YX — a free, open-source desktop video editor (Tauri 2 + React + Rust) that stays smooth on weak CPUs.

Repo: <https://github.com/needyamin/project-yx> · Stack map: [STACK.md](STACK.md) · User docs: [README.md](README.md)

## Ground rules

1. **Tauri 2, not Electron.** Never add Electron, electron-builder, or rewrite the shell.
2. Keep the **Cargo workspace** and crates under `crates/` — don't flatten without discussion.
3. **FFmpeg/ffprobe** are bundled in releases via `prepare-binaries.js`; keep them on PATH for dev.
4. License is **GPL-3.0-or-later** — no incompatible proprietary deps.
5. Never commit secrets: `yx-updater.key`, `*.pfx`, `.env`, signing passwords.

## Dev setup

```bash
git clone https://github.com/needyamin/project-yx.git
cd project-yx && npm --prefix apps/desktop install
npm run dev          # Vite at localhost:1420 inside the Tauri window
npm run build        # sanity build
```

Windows: WebView2 + VS C++ Build Tools. FFmpeg: on PATH or `npm run prepare:bin`.

## Code map

| Area | Location |
|---|---|
| Project Bin, media drag/drop | `apps/desktop/src/bin/` |
| Timeline UI, tools, recorder, voiceover | `apps/desktop/src/timeline/` |
| Monitors, crop / Magic Remove / Blur / BG Key tools | `apps/desktop/src/monitors/` |
| The authoritative playhead store | `apps/desktop/src/playback/playbackClock.ts` |
| Background job scheduler (priority + cancel) | `apps/desktop/src/jobs/jobManager.ts` |
| Advanced Audio Tools, waveforms | `apps/desktop/src/audio/` |
| Advanced Video dialog | `apps/desktop/src/video/` |
| Effects catalog + inspector | `apps/desktop/src/effects/` |
| Export dialog | `apps/desktop/src/export/` |
| Menubar / About / chrome | `apps/desktop/src/layout/` |
| Tauri commands, tray | `apps/desktop/src-tauri/src/` |
| Timeline model, undo | `crates/yx-timeline/` |
| FFmpeg probe, export, Magic Remove | `crates/yx-media/` |
| Hardware tiers, proxies | `crates/yx-detect/`, `crates/yx-proxy/` |
| Frontend regression harness | `scripts/test-job-manager.mts` |

## Product rules

- Dense editor chrome, not marketing pages — match existing CSS tokens.
- Keep sticky tools and the keyboard map (S/X/M/Y/R, I/O, Space, Ctrl+B) unless the PR documents a change.
- Effects must stay roughly **WYSIWYG**: preview (CSS) and export (FFmpeg filters) read the same params.
- "Best" export = source size, max quality — no forced downscale.
- Weak CPUs come first: proxies and thread caps over raw power assumptions.
- Version bumps: edit **root `package.json` only** — build scripts sync `Cargo.toml`, `apps/desktop/package.json` and `tauri.conf.json` automatically (or run `npm run version:sync`). The version is also the MSIX package version (`0.1.3` → `0.1.3.0`), and the Microsoft Store rejects a submission that is not **strictly greater** than the published one — so **never reuse a version number**, even to re-release identical code. See the Store section in [README.md](README.md).

### Reliability rules (learned the hard way — see the QA reports in `docs/`)

- **Never call `Command::output()` for media work.** It has no deadline. Use
  `yx_media::run_bounded(&mut cmd, timeout, what)` — it drains both pipes on
  reader threads, enforces a deadline and kills the child on expiry. A wedged
  decoder must surface as a reported error, never as an operation that never
  finishes.
- **Never leak a child process.** Wrap any long-running ffmpeg child in a guard
  (`KillOnDrop`) so every error path kills it. `Child::drop` on Windows closes
  handles but does **not** terminate the process.
- **Never write an output file without an RAII cleanup guard** unless the caller
  renames it on success (see `RemoveOnDrop` in `magic.rs`). A cancelled render
  must not leave a partial sidecar.
- **Never assume EOF means success.** ffmpeg exits 0 on a truncated MP4, so a
  short read can be a silent truncation. Check exit status *and* frame counts.
- **No autosave, no session restore.** Removed by user decree — nothing may be
  written or restored behind the user's back. Every launch starts fresh.
  Do not re-add `adopt_autosave`, session restore, or an exit-time flush.
- **No `sleep()`-based synchronisation and no hardcoded delays** to paper over a
  race. Drive UI state from real events (a commit-ordered effect, a media
  element event) or from a generation/sequence guard.
- **Latest-wins everywhere.** Anything that awaits and then writes shared state
  must carry a sequence id and drop superseded responses (`engineSync.nextSeq`,
  the `hearSeqRef` pattern in `AdvancedAudioDialog`).
- **Every edit must leave a valid timeline.** `TimelineEditor::apply()` runs
  `Timeline::validate()` after every command and rolls the edit back with
  `TimelineError::InvalidResult` if it fails, so a rejected edit is a complete
  no-op. Do not add a command that relies on producing an invalid intermediate
  state — fix the command instead. Two clips on one track may only overlap when
  the later one carries an enabled `Transition` (that is the deliberate
  crossfade overlap).
- **A duration change is a timeline operation, not a property write.** Anything
  that changes how long a clip occupies the timeline (speed, trim, replace)
  must resolve the freed/consumed space according to `edit_mode`, and must
  retime a linked A/V partner with it. Use `shift_clips_after` (same track
  only — never ripple unrelated tracks), `overwrite_range_except`, and
  `clamp_transitions_on_track`. Do not add `if speed_changed: move_next_clip()`
  special cases.

## Git workflow

```bash
git clone https://github.com/<you>/project-yx.git
git remote add upstream https://github.com/needyamin/project-yx.git
git checkout -b feature/short-name upstream/main
# edit, test
git commit -m "Fix: short description"
git push -u origin HEAD   # open a PR with what/why/how tested
```

## Test your change

Run the full gates first — they are cheap and catch most regressions:

```bash
export PATH="$PWD/apps/desktop/src-tauri/bin:$PATH"   # unlocks the FFmpeg tests
cargo test --workspace                    # 101 pass, 2 ignored
cargo check --workspace --all-targets     # must stay warning-free
npm --prefix apps/desktop run build       # tsc + vite
npm run test:js                           # frontend module harness
```

Then, depending on what you touched:

| Change | Minimum check |
|---|---|
| UI only | `npm run tauri dev`, click through Bin / timeline / monitor |
| Timeline model | `cargo test -p yx-timeline` + UI smoke; keep `Timeline::validate()` empty |
| **Duration / speed / ripple** | `cargo test -p yx-timeline --test speed_ripple` — it sweeps 0.1×–99× across every edit mode and asserts the timeline stays valid, and that a refused edit is a no-op |
| Media / export / FFmpeg | `cargo test -p yx-media` (with ffmpeg on PATH) + one real export preset |
| Advanced Audio / Video dialogs | Open both dialogs, apply + hear/see the result; check the busy state under repeated clicks |
| Magic Remove / Blur / BG Key | Full workflow incl. **Cancel**, then re-run; confirm no `*.tmp.mp4` is left in `%LOCALAPPDATA%/ProjectYX/magic-cache` |
| Job scheduler | `npm run test:js` (it accepts a module path, so you can point it at a revision to prove a regression) |
| Project format | Add a case to `crates/yx-timeline/tests/project_compat.rs` — old projects must keep opening |
| Recording | Screen recorder and voiceover buttons on the timeline |
| Packaging | `npm run dist:win` — only if you touched `scripts/` |

Don't commit `dist/`, `build/`, or `target/`.

## PR checklist

- [ ] Still Tauri 2 (no Electron)
- [ ] `cargo test --workspace` + `cargo check --workspace --all-targets` clean (0 warnings)
- [ ] `npm --prefix apps/desktop run build` passes; `npm run test:js` passes if you touched the scheduler
- [ ] No unbounded FFmpeg waits and no leaked children introduced (see reliability rules)
- [ ] No keys, `.pfx`, or `.env` in the diff
- [ ] Versions synced if bumped
- [ ] Shortcuts / sticky tools unchanged unless intentional
- [ ] Docs updated if commands, crates, or behaviour changed — including the capability table in `README.md` and the status ledger in `docs/QA-MATRIX.md`

## Bug reports

Include: version (or commit) · OS · steps to reproduce · expected vs actual · screenshot/log if UI-related.

Questions or big refactors: open an issue or draft PR first. Thank you!
