#!/usr/bin/env node
/**
 * Prepare FFmpeg and ffprobe binaries for bundling into Tauri installers and packages.
 *
 * Checks if ffmpeg/ffprobe exist in apps/desktop/src-tauri/bin/.
 * If not present, searches PATH or common installation locations and copies them over.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ROOT, TAURI_DIR } from "./lib/paths.js";

const BIN_DIR = path.join(TAURI_DIR, "bin");
const IS_WIN = process.platform === "win32";
const FFMPEG_EXE = IS_WIN ? "ffmpeg.exe" : "ffmpeg";
const FFPROBE_EXE = IS_WIN ? "ffprobe.exe" : "ffprobe";

export function findSystemBinary(name) {
  const exeName = IS_WIN && !name.endsWith(".exe") ? `${name}.exe` : name;
  const tool = IS_WIN ? "where.exe" : "which";
  const r = spawnSync(tool, [exeName], {
    encoding: "utf8",
    windowsHide: true,
  });

  if (r.status === 0 && r.stdout) {
    const lines = r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (const line of lines) {
      if (fs.existsSync(line)) {
        return line;
      }
    }
  }

  // Fallback scan of PATH
  const pathEnv = process.env.PATH || "";
  const sep = IS_WIN ? ";" : ":";
  for (const p of pathEnv.split(sep)) {
    if (!p) continue;
    const cand = path.join(p, exeName);
    if (fs.existsSync(cand)) {
      return cand;
    }
  }

  return null;
}

export function prepareBundledBinaries() {
  fs.mkdirSync(BIN_DIR, { recursive: true });

  const targets = [
    { name: "ffmpeg", file: FFMPEG_EXE },
    { name: "ffprobe", file: FFPROBE_EXE },
  ];

  let missingCount = 0;

  for (const { name, file } of targets) {
    const dest = path.join(BIN_DIR, file);
    if (fs.existsSync(dest)) {
      const st = fs.statSync(dest);
      if (st.size > 1024 * 1024) {
        console.log(`[yx-bin] ${file} already present in src-tauri/bin (${Math.round(st.size / 1024 / 1024)} MB)`);
        continue;
      }
    }

    console.log(`[yx-bin] Locating system ${name}...`);
    const src = findSystemBinary(name);
    if (src) {
      console.log(`[yx-bin] Copying ${src} → apps/desktop/src-tauri/bin/${file}...`);
      fs.copyFileSync(src, dest);
      const st = fs.statSync(dest);
      console.log(`[yx-bin] Successfully staged ${file} (${Math.round(st.size / 1024 / 1024)} MB)`);
    } else {
      console.warn(`[yx-bin] WARNING: Could not find ${name} on system PATH.`);
      missingCount++;
    }
  }

  if (missingCount > 0) {
    console.warn(`[yx-bin] Staging incomplete: ${missingCount} binary/binaries missing.`);
    return false;
  }

  return true;
}

// Run if called directly
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const ok = prepareBundledBinaries();
  if (!ok) {
    process.exitCode = 1;
  }
}
