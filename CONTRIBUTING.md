# Contributing to Project YX

Project YX is an open-source **desktop video editor** (Tauri 2 + React + Rust) focused on:

- Smooth editing on **weak CPUs** (proxies + performance tiers)
- **4K / vertical** export when the machine can handle encode
- A **minimal sticky UI**: Project Bin, monitors, timeline — advanced tools in menus

Repo: https://github.com/needyamin/project-yx  

Full stack map: [`STACK.md`](STACK.md) · User docs / dist: [`README.md`](README.md)

---

## Before you change anything

1. This is **Tauri 2**, not Electron. Do not add Electron, electron-builder, or rewrite the shell.
2. Keep the **Cargo workspace** and crates under `crates/` — do not flatten into a single crate without discussion.
3. **FFmpeg / ffprobe**: End-user release installers bundle FFmpeg and ffprobe automatically via `prepare-binaries.js`. For local development, keep `ffmpeg` and `ffprobe` on your system `PATH` (or run `npm run prepare:bin` to stage them into `apps/desktop/src-tauri/bin/`).
4. License is **GPL-3.0-or-later** — no incompatible proprietary deps.
5. Never commit secrets: `yx-updater.key`, `*.pfx`, `.env`, signing passwords.

---

## Dev setup (this repo)

```bash
git clone https://github.com/needyamin/project-yx.git
cd project-yx
npm --prefix apps/desktop install
npm run dev
# or: npm run tauri dev
```

- UI: Vite at `http://localhost:1420` inside the Tauri window  
- Need `ffmpeg` + `ffprobe` on PATH for import/export (or run `npm run prepare:bin`)  
- Windows: WebView2 + VS C++ Build Tools  

Sanity build:

```bash
npm run build
```

Stage bundled binaries locally:

```bash
npm run prepare:bin
```

Icon refresh (from `apps/desktop/public/logo.png`):

```bash
cd apps/desktop && npm run icons
```

---

## Where code lives in *this* project

| You want to work on… | Go here |
|----------------------|---------|
| Project Bin, drag/drop media | `apps/desktop/src/bin/` |
| Timeline UI, tools, shortcuts | `apps/desktop/src/timeline/` |
| Screen recorder & voiceover | `apps/desktop/src/timeline/ScreenRecorderButton.tsx`, `VoiceoverButton.tsx` |
| Clip / project monitors, crop tool | `apps/desktop/src/monitors/` |
| Advanced Audio Tools dialog, waveforms | `apps/desktop/src/audio/` |
| Advanced Video Tools dialog, speed/reverse | `apps/desktop/src/video/` |
| Effects catalog + Applied inspector | `apps/desktop/src/effects/` |
| Export dialog / presets | `apps/desktop/src/export/` |
| Menubar / editor chrome | `apps/desktop/src/layout/` |
| Context menus & reusable UI | `apps/desktop/src/ui/` |
| Auto-update check UI | `apps/desktop/src/update/` |
| Tauri commands, tray, wiring | `apps/desktop/src-tauri/src/` |
| Tracks / clips / undo (pure model) | `crates/yx-timeline/` |
| FFmpeg probe & export | `crates/yx-media/` |
| Hardware tiers & binary discovery | `crates/yx-detect/` |
| Proxy jobs | `crates/yx-proxy/` |
| Filter / preview budget | `crates/yx-compositor/` |
| Binary staging & bundling | `scripts/prepare-binaries.js` |
| NSIS / portable / Inno / MSIX / AppImage | `scripts/`, `installer/`, `docker/` |

App id: `com.projectyx.editor` · Product name: **Project YX**

---

## Product rules (keep PRs aligned)

- **UI:** dense editor chrome, not a marketing landing page. Prefer matching existing CSS/tokens in `App.css` / panel styles.
- **Timeline:** preserve sticky tools (Select, Razor, Split, Fit) and keyboard map (S/X/M/Y/R, I/O, Space, etc.) unless the PR intentionally changes them and documents it.
- **Effects:** catalog + Applied panel stay consistent (`effects.ts` kind meta shared by bin + inspector). Preview should stay roughly WYSIWYG with export filters when you touch either side.
- **Export:** “Best” means source size / high quality path — don’t force downscale without a clear preset reason.
- **Weak CPUs:** prefer proxies / thread caps via `yx-detect` / `yx-proxy` over assuming everyone has a strong machine.
- **Versions:** if you bump version, update **all three**: root `Cargo.toml` workspace version, `apps/desktop/package.json`, `apps/desktop/src-tauri/tauri.conf.json`.

---

## Git workflow

```bash
# Fork on GitHub, then:
git clone https://github.com/<you>/project-yx.git
cd project-yx
git remote add upstream https://github.com/needyamin/project-yx.git

git fetch upstream
git checkout -b feature/yx-short-name upstream/main

# …edit, test…
git add -p   # or git add <paths> — avoid adding dist/, keys, node_modules
git commit -m "Fix timeline ripple delete leaving gap"
git push -u origin HEAD
```

Open a PR into `needyamin/project-yx` with: what, why, how you tested (OS + short steps).

### Branch names that fit this repo

- `feature/effects-chromakey-preview`
- `fix/ffmpeg-export-progress`
- `fix/bin-dnd-timeline`
- `docs/stack`
- `chore/dist-msix-publisher`

---

## How to test your change

Match the area you touched:

| Change type | Minimum check |
|-------------|---------------|
| UI only | `npm run tauri dev` — click through Bin / timeline / monitor |
| Timeline model | `cargo test -p yx-timeline` (and UI smoke) |
| Media / export | Import a short clip, run an export preset, confirm progress |
| Audio / Video tools | Right-click clip → open Advanced Audio/Video dialogs, test waveform selection / speed |
| Recording | Trigger Screen Recorder and Voiceover buttons on the timeline |
| Effects | Apply effect, toggle on/off, confirm monitor + export if filters changed |
| Packaging | `npm run dist:nsis` or `npm run dist:release -- --windows-only` — only if you edited `scripts/` / installer |

Do **not** commit `dist/`, `build/`, or `target/`.

---

## PR checklist (Project YX)

- [ ] Still Tauri 2 (no Electron)
- [ ] `npm run tauri dev` or `npm run build` works for your change
- [ ] No `yx-updater.key`, `.pfx`, or `.env` in the diff
- [ ] Versions synced if bumped
- [ ] Timeline shortcuts / sticky tools unchanged unless intentional
- [ ] README or STACK updated if you add commands, crates, or user-facing behavior

---

## Issues

When filing a bug on GitHub, include:

- Project YX version (or commit)
- OS (e.g. Windows 11)
- FFmpeg available? (`ffmpeg -version`)
- Steps (import → timeline → export / effect)
- Expected vs actual
- Screenshot or log snippet if UI / encode related

---

## Packaging / release (maintainers & interested contributors)

Everyday PRs do **not** need release signing.

- Local updater key: `apps/desktop/src-tauri/yx-updater.key` (gitignored)
- CI secrets: `TAURI_SIGNING_PRIVATE_KEY` (+ password if any)
- Release one-shot: `npm run dist:release` → EXE + MSIX + AppImage (Docker) into `dist/`

See README **Building and Distribution**.

---

Questions or large refactors: open an issue or draft PR first. Thanks for helping build Project YX.
