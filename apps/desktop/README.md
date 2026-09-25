# apps/desktop — the Project YX app

The Tauri 2 application: a React 19 + TypeScript UI (`src/`) in a Rust shell
(`src-tauri/`). See the root [README.md](../README.md) for the product overview
and [STACK.md](../STACK.md) for how the pieces connect.

## Layout

| Path | What it is |
|---|---|
| `src/` | React UI — bin, timeline, monitors, playback clock, job scheduler, effects, export, dialogs |
| `src-tauri/` | Rust shell: every Tauri command + `AppState`, tray, window setup |
| `src-tauri/bin/` | Bundled `ffmpeg.exe` / `ffprobe.exe` (**gitignored** — created by `npm run prepare:bin`) |
| `src/dev/` | Dev-only harnesses: `mockTauri.ts`, `bench.ts`, `qa.ts`. Not in the production bundle |
| `bench.html`, `qa.html` | Dev-only entry points for the benchmark and monitor-QA harnesses |
| `vite.config.ts` | Vite 8 config (dev server on port 1420, `strictPort`) |

## Commands

Run these from the **repository root**, not from here:

```bash
npm run dev        # vite + the Tauri window (http://localhost:1420)
npm run build      # tsc + vite production bundle (the release build is `npm run dist:*`)
npm run test:js    # frontend module regression harness
```

Inside this directory the equivalent scripts are `npm run tauri dev`,
`npm run build` and `npm run tauri build`.

## Dev-only harnesses

Both mount the **real** app against a mock Tauri backend, so they exercise real
components without a Rust build:

```bash
npx vite                                   # from apps/desktop
# then open:
#   http://localhost:1420/bench.html       performance harness
#   http://localhost:1420/qa.html          monitor-tool QA harness
```

`qa.html` accepts seeds that reproduce specific regression classes —
`?seed=speed`, `?seed=split`, `?seed=reverse`, `?seed=reverse-overlap`,
`?seed=speedcut`, `?seed=blur`, `?seed=chroma`, `?seed=all` — and
`?media=cross` to reproduce a cross-origin canvas-taint case.

**Note:** when the browser pane is hidden, Chromium starves
`requestAnimationFrame` and `ResizeObserver`. `qa.ts` installs timer-based shims
so gestures and layout still run headless; app code is untouched.

Neither harness is part of the production bundle — Vite only builds `index.html`.

## Working in the UI layer

- **The playhead has one owner.** `src/playback/playbackClock.ts` is the single
  store. Time-displaying leaves subscribe with `usePlayheadTime()`; nothing else
  keeps its own playhead state. `App.tsx` must not hold playhead React state.
- **Timeline edits go through `engineSync`.** Every timeline-mutating invoke
  returns `null` for a stale or failed response — never apply a `null`.
- **Background work goes through `jobs.enqueue()`.** It handles priority,
  cancellation and coalescing, and caps concurrency. Do not spawn ad-hoc async
  work that outlives a component.
- **Expensive work never runs on the UI thread.** Disk, FFmpeg and decode work
  belongs in Rust on a blocking pool.
- The architecture invariants that must not be broken are documented in
  [`context_memory.txt`](../context_memory.txt) at the repository root.
