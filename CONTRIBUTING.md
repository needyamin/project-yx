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
| Monitors, crop tool | `apps/desktop/src/monitors/` |
| Advanced Audio Tools, waveforms | `apps/desktop/src/audio/` |
| Effects catalog + inspector | `apps/desktop/src/effects/` |
| Export dialog | `apps/desktop/src/export/` |
| Menubar / About / chrome | `apps/desktop/src/layout/` |
| Tauri commands, tray | `apps/desktop/src-tauri/src/` |
| Timeline model, undo | `crates/yx-timeline/` |
| FFmpeg probe & export | `crates/yx-media/` |
| Hardware tiers, proxies | `crates/yx-detect/`, `crates/yx-proxy/` |

## Product rules

- Dense editor chrome, not marketing pages — match existing CSS tokens.
- Keep sticky tools and the keyboard map (S/X/M/Y/R, I/O, Space, Ctrl+B) unless the PR documents a change.
- Effects must stay roughly **WYSIWYG**: preview (CSS) and export (FFmpeg filters) read the same params.
- "Best" export = source size, max quality — no forced downscale.
- Weak CPUs come first: proxies and thread caps over raw power assumptions.
- Version bumps: edit **root `package.json` only** — build scripts sync `Cargo.toml`, `apps/desktop/package.json` and `tauri.conf.json` automatically (or run `npm run version:sync`).

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

| Change | Minimum check |
|---|---|
| UI only | `npm run tauri dev`, click through Bin / timeline / monitor |
| Timeline model | `cargo test -p yx-timeline` + UI smoke |
| Media / export | Import a clip, run an export preset |
| Audio/video tools | Open both dialogs, apply + hear/see the result |
| Recording | Screen recorder and voiceover buttons on the timeline |
| Packaging | `npm run dist:win` — only if you touched `scripts/` |

Don't commit `dist/`, `build/`, or `target/`.

## PR checklist

- [ ] Still Tauri 2 (no Electron)
- [ ] Build passes for your change
- [ ] No keys, `.pfx`, or `.env` in the diff
- [ ] Versions synced if bumped
- [ ] Shortcuts / sticky tools unchanged unless intentional
- [ ] Docs updated if commands, crates, or behavior changed

## Bug reports

Include: version (or commit) · OS · steps to reproduce · expected vs actual · screenshot/log if UI-related.

Questions or big refactors: open an issue or draft PR first. Thank you!
