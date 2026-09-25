# Project YX — free video editor for any PC

Project YX is a free, open-source desktop video editor (Windows / Linux) built to stay smooth on weak computers and export sharp 4K and vertical (9:16) video — 100% offline, no account, no watermark, no telemetry.

**Made by ANSNEW TECH.** · GPL-3.0 · [Download](https://github.com/needyamin/project-yx/releases)

<img width="800" alt="Project YX" src="https://github.com/user-attachments/assets/28e1372d-7ab1-4865-ad84-99419bbb729e" />

---

## What it can and cannot do

Honest capability table. **Works today** = implemented. **Limitations** = what it
deliberately does *not* do, or where behaviour is narrower than you might assume.
What has actually been *measured* is separated out at the end of this section.

### Editing

| Capability | ✅ Works today | ⚠️ Limitations / not supported |
|---|---|---|
| Timeline editing | Split, ripple, slip, spacer, trim, move, delete, close gap, remove gaps, in/out zone lift & extract, markers | No nested sequences, no multicam, no compound clips |
| Speed / retime | Per-clip speed 0.25×–4×. A rate change is treated as a **duration edit**: the linked audio retimes with the video so the pair stays in sync, and the space it frees or consumes is resolved by the edit mode — **absolute positions** keep neighbours put and report a collision instead of overlapping them, **Insert** ripples the clip's own track, **Overwrite** consumes the range | Speed is per-clip and constant — **no speed ramps or time remapping curves**. Ripple only affects the edited track (and its linked partner), so background music stays where you put it |
| Undo / redo | 100-step history covering every edit including linked A/V pairs. A refused edit (e.g. a collision) is a complete no-op and leaves no undo step | History lives in the session only — it is **not** stored in the project file |
| Tools | Select / Razor / Spacer / Slip / Ripple, snapping toggle, Ctrl+wheel zoom | No blade-across-all-tracks |
| Linked A/V | Video+audio pairs move/trim/split/retime together; explicit link & unlink | Pairwise only — no grouping of 3+ clips |
| Transitions | Cross dissolve; its crossfade length is re-clamped automatically if a clip is later shortened | Cross dissolve only — no wipe / slide / zoom |
| Timeline consistency | Every edit is validated against the model's invariants and rolled back with a clear message if it would corrupt the timeline (overlaps, bad ranges, broken links) | Markers stay at their absolute time when clips ripple |
| Keyframes & animation | Position keyframes in the Blur Region tool; manual mask keyframes in Magic Remove | **No general keyframe system.** Transform, Crop, Text and the other effects are static values (roadmap) |

### Media & formats

| Capability | ✅ Works today | ⚠️ Limitations / not supported |
|---|---|---|
| Import | Video `mp4` `mov` `mkv` `webm` `avi` `m4v` · audio `mp3` `wav` `aac` `m4a` `flac` `ogg` · images `png` `jpg` `jpeg` `webp` `bmp` `gif` | Support is whatever the bundled FFmpeg build can decode; unsupported or broken files are rejected at import with a message |
| Images & GIFs | Import, place, trim freely, loop on export | No still-image sequence import |
| Frame rates | 24 / 25 / 30 / 50 / 60 and fractional NTSC rates (23.976, 29.97, 59.94) via presented-frame timing | **Variable-frame-rate sources are detected but not specially handled** — the flag exists in the media model, but frame↔time mapping still assumes a constant rate, so VFR footage can drift |
| Resolutions | 720p / 1080p / 1440p / 4K and vertical 9:16 | Preview decoding is done by the WebView's own decoder — there is no GPU-accelerated preview decode |
| Long media | Works, with automatic proxies for heavy footage | Relies on the OS file cache; no segmented/streaming media |
| Missing or moved media | Errors are reported per file | **No relink UI** — paths are absolute, so moved files must be re-imported |

### Playback & synchronisation

| Capability | ✅ Works today | ⚠️ Limitations / not supported |
|---|---|---|
| Transport | Play/pause, J/K/L shuttle (J reverse, L 2×/4×), frame stepping at the project frame rate, scrubbing | Reverse playback is seek-stepped (HTML5 media cannot play backwards), so it is inherently slower than forward |
| Clock | One authoritative playhead; a presented-frame clock drives the timeline with a self-healing fallback sampler | — |
| A/V sync | Speed- and pitch-aware drift locking; audio is clamped to its clip so it never outlives it | Measured 12.3 ms max drift over 60 s in the harness; 30–60 minute sessions are **not yet validated** |
| Adaptive quality | Hardware tier detected at launch; proxies, preview scale and encoder threads adjust | Preview renders effects as CSS approximations rather than decoded FFmpeg output (see *Effects*) |
| 1080p60 preview | Plays | Presents ~78–92 % of frames in the dev harness — suspected WebView pane pacing, not yet confirmed in the packaged window |

### Effects

| Capability | ✅ Works today | ⚠️ Limitations / not supported |
|---|---|---|
| Video effects | Transform, Crop, Chroma key, Text/Titles, Vignette, Hue, Temperature, Sharpen, Blur, Cross dissolve, LUT (`.cube`), plus look presets (VHS, Glow, Neon, Glitch, …) | Preview is a **CSS approximation** of the export filter chain — close, not pixel-identical. Effect *order* matters: a region tool added before a crop keeps parity; the reverse order does not |
| Blur Region | Drag a blurred box over a face/logo — shapes, feather, rotation, opacity, keyframes, auto-track | Animated blur *intensity* cross-fades between sharp and max sigma (position/size/rotation/feather/opacity are exact) |
| BG Key | Remove backgrounds by colour keying or hand-drawn rect/ellipse/lasso areas, with feather and invert | Masks are rasterised to a PNG shared by preview and export; lasso export requires that PNG (no vector fallback) |
| Magic Remove | Brush a logo/watermark/object; auto-tracking follows it and the background is rebuilt into a **non-destructive sidecar** — the original file is never modified. Clip-scoped, so a trimmed clip renders only its own range | **No AI/ML segmentation** — no ML dependencies are bundled, so this is temporal + spatial background reconstruction, not a learned inpainter. It struggles with large, fast-moving objects and detailed backgrounds. Removal *strength* animates as a cross-fade |
| Audio effects | Noise removal, voice-clean presets, Compressor, EQ, Gate, De-esser, Normalize, Reverb, Pitch | Preview pitch uses the media element's playback rate — an approximation. Stereo only; no surround/multichannel processing |

### Audio

| Capability | ✅ Works today | ⚠️ Limitations / not supported |
|---|---|---|
| Waveforms | One decode per file, cached, zoom-independent, drawn from a 4096-bin overview | Files the Web Audio API cannot decode show a blank waveform (by design — no retry storm) |
| Timeline audio | Multiple audio tracks, overdub/voiceover layer, per-clip volume, fades, per-track mute & hide | No bus/submix routing; track order is fixed by creation |
| Advanced Audio dialog | Per-clip effect chain with **Hear processed result** — renders the true export chain through FFmpeg and plays it back | The preview is a real FFmpeg pass, so long clips take time (bounded by a deadline, with a visible busy state and cancel) |
| Recording | Screen recorder (screen/window + mic) and one-click voiceover straight to the timeline | Recordings are finalised by a stream-copy remux; if that fails the raw file is used |

### Export

| Capability | ✅ Works today | ⚠️ Limitations / not supported |
|---|---|---|
| Containers & codecs | MP4 with H.264 or H.265 | **No ProRes, DNxHD, AV1, VP9 or WebM export** |
| Resolution & aspect | Up to 4K, 9:16 vertical, custom sizes | No HDR / 10-bit output |
| Quality | CRF or target bitrate, plus a source-matching "best" preset | No two-pass encoding |
| GPU encoding | NVENC / QSV / AMF with automatic software fallback | Encoders are detected, not benchmarked; a failing GPU encode silently retries in software |
| Progress & cancel | Live percentage, cancellable mid-encode; the partial file is discarded so a cancelled export never leaves a broken MP4 | No batch/queue export — one at a time |
| Export audio | AAC | Fixed AAC; no PCM / FLAC / WAV option |
| Source quality | Always encodes from the original media, never from a proxy | — |

### Project & data

| Capability | ✅ Works today | ⚠️ Limitations / not supported |
|---|---|---|
| Project files | `.yxp` save/open (Ctrl+S / Ctrl+O), atomic tmp+rename writes, validated on load | No project versioning beyond forward-compatible field defaults |
| Backward compatibility | Projects written by older builds open correctly — verified by a compatibility suite covering missing fields and renamed effect kinds | Unknown *future* fields are ignored rather than preserved |
| Crash recovery | — | **There is no autosave and no session restore, by design.** Nothing is written or restored behind your back; every launch starts fresh. Unsaved work is lost if the app crashes |
| Derived caches | Thumbnails, proxies, Magic Remove sidecars and masks live under `%LOCALAPPDATA%/ProjectYX`, size-capped and swept | The proxy cache is never auto-pruned (proxies are expensive to regenerate) |

### Platform & hardware

| Capability | ✅ Works today | ⚠️ Limitations / not supported |
|---|---|---|
| Windows | Windows 10/11 64-bit — NSIS installer, portable ZIP, Microsoft Store (MSIX) | — |
| Linux | AppImage | Built via Docker; less exercised than Windows |
| macOS | — | **No macOS build** (roadmap) |
| Weak hardware | Launch-time tier detection (potato → high) adjusts proxies, preview scale and encoder threads | The low-end-hardware acceptance pass on real target machines is still pending |
| GPU decode in preview | — | **Not used.** Preview decoding is the WebView's own decoder; only export uses hardware encoders |
| Offline | FFmpeg and WebView2 are bundled; no account, no telemetry, nothing leaves the PC | — |

### Verified vs. not yet verified

The tables above mix *implemented* with *verified*. Explicitly:

| Area | Status |
|---|---|
| Rust engine, export, proxies, project compatibility, FFmpeg process lifecycle | **Verified** — automated suite of 101 tests including real-FFmpeg integration tests ([docs/QA-MATRIX.md](docs/QA-MATRIX.md)) |
| 4K / high-bitrate / long-duration behaviour on real hardware | **Not yet verified** — needs the packaged app and real media |
| 30–60 minute A/V drift; low-end-hardware acceptance | **Not yet verified** |
| Magic Remove decode → inpaint → encode on real footage | **Not yet verified end-to-end** — the algorithms are unit-tested; the full render path needs a normal machine |
| Playback / monitor synchronisation under sustained use | **Not yet verified** — the `/qa.html` harness exists for exactly this |

Read "works today" as *implemented*, not *verified on your machine*. The reports
in [docs/](docs/) state precisely what was measured and what was not.

---

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

### Publishing to the Microsoft Store

The MSIX package version is derived from `package.json` as `Major.Minor.Build.0`
— so `0.1.3` ships as **`0.1.3.0`**. Partner Center requires each submission to be
**strictly greater** than the version already published, and a rejected version
number cannot be reused for the same Identity, so:

- **Never re-submit an existing version.** To re-release the same code, bump the
  version first (`0.1.3` → `0.1.4`), then rebuild.
- Confirm the version before uploading — `npm run dist:msix` prints the package
  identity and version it wrote into `AppxManifest.xml`.
- `store-identity.json` (gitignored) must match Partner Center → *Product
  management → Product identity*. Copy `store-identity.json.example` and fill in
  `identityName`, `publisher` and `publisherDisplayName`; a mismatch fails
  validation at upload time. Each field can also be overridden with
  `YX_MSIX_IDENTITY_NAME` / `YX_MSIX_PUBLISHER` / `YX_MSIX_PUBLISHER_DISPLAY`.
- **Signing:** Microsoft re-signs Store submissions, so no certificate is needed
  to upload. Signing is only for local sideload testing — either point
  `YX_MSIX_PFX` (+ `YX_MSIX_PFX_PASSWORD`) at your own certificate, or set
  `YX_MSIX_AUTO_SIGN=1` to have the script generate a self-signed one at
  `build/msix-cert/project-yx-dev.pfx`.
- Upload the `.msix` produced by `npm run dist:release`. GitHub releases and the
  Store package come from the same build, so their versions always agree.

### Quality gates (run before committing)

```bash
cargo test --workspace                    # Rust tests — 122 pass, 2 ignored
cargo check --workspace --all-targets     # must stay warning-free
npm --prefix apps/desktop run build       # tsc + vite production bundle
npm run test:js                           # frontend module regression harness
```

> **The FFmpeg integration tests skip silently unless `ffmpeg` is on PATH.**
> Export the bundled one first, or you will get a green run that tested nothing:
>
> ```bash
> export PATH="$PWD/apps/desktop/src-tauri/bin:$PATH"
> cargo test --workspace
> ```

### Test suites

| Suite | Count | Covers |
|---|---|---|
| `crates/yx-timeline` | 36 | Timeline model: edits, linked A/V, undo/redo, 500-clip stress, validation |
| `crates/yx-timeline/tests/speed_ripple.rs` | 21 | Smart timeline: speed as a duration edit, ripple vs. absolute positions, linked A/V sync, conflict detection, transitions, undo/redo, save/reload, speed sweep |
| `crates/yx-timeline/tests/project_compat.rs` | 7 | `.yxp` backward compatibility: old & new project chains, lossless round-trip |
| `crates/yx-media` | 33 | Effect-chain construction, export args, Magic Remove algorithms, region fragments |
| `crates/yx-media/tests/*` | 9 | **Real-FFmpeg** integration: export progress / cancel / stall watchdog, bounded process, region graphs |
| `crates/yx-proxy` | 5 | Proxy job lifecycle, cancel, retry, playback-path fallback |
| `crates/yx-detect` / `yx-compositor` | 3 / 2 | Hardware tiering, preview filter budget |
| `apps/desktop/src-tauri` | 6 | Cache sweep, legacy-project export segments |
| `scripts/test-job-manager.mts` | 11 checks | Frontend job scheduler: coalescing, concurrency cap, priority, cancel |

A dev-only QA harness for the monitor tools lives at `apps/desktop/qa.html` (mounts the real app against a mock backend; see `src/dev/qa.ts`), and the performance harness at `benchmark/` — see [benchmark/README.md](benchmark/README.md).

### Repository layout

```
apps/desktop/        Tauri app: React UI + Rust shell
apps/desktop/qa.html  Dev-only monitor QA harness
crates/yx-*          Rust engine crates
benchmark/           Performance harness + generated test media (media gitignored)
scripts/             Packaging (NSIS, Inno, MSIX, portable, AppImage, updater)
installer/ docker/   Installer templates, Linux build
docs/                QA matrix + audit reports
```

| Crate | Role |
|---|---|
| `yx-timeline` | In-memory timeline model: tracks, cuts, transitions, undo |
| `yx-media` | FFmpeg/ffprobe driver: probing, filters, background export, Magic Remove |
| `yx-detect` | Hardware probe → performance tier |
| `yx-proxy` | Background proxy transcoder |
| `yx-compositor` | Preview filter budget & aspect policy |

Full stack map: [STACK.md](STACK.md) · Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · QA matrix: [docs/QA-MATRIX.md](docs/QA-MATRIX.md) · Audit reports: [docs/QA-REPORT-2026-09-25.md](docs/QA-REPORT-2026-09-25.md) and [docs/QA-REPORT-2026-09-25-SUBSYSTEMS.md](docs/QA-REPORT-2026-09-25-SUBSYSTEMS.md)

## License

GPL-3.0-or-later. Release packages bundle FFmpeg, which is compatible with this license.
