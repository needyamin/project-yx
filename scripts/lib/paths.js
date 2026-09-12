import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repository root (…/Project YX). */
export const ROOT = path.resolve(__dirname, "..", "..");

export const DIST_DIR = path.join(ROOT, "dist");
export const BUILD_DIR = path.join(ROOT, "build");
export const DESKTOP_DIR = path.join(ROOT, "apps", "desktop");
export const TAURI_DIR = path.join(DESKTOP_DIR, "src-tauri");
export const WORKSPACE_TARGET = path.join(ROOT, "target");
export const TAURI_TARGET = path.join(TAURI_DIR, "target");

export function releaseDir() {
  const cargoTarget = process.env.CARGO_TARGET_DIR;
  const candidates = [
    // Prefer real workspace target; ignore Cursor sandbox CARGO_TARGET_DIR
    path.join(WORKSPACE_TARGET, "release"),
    path.join(TAURI_TARGET, "release"),
    cargoTarget && !isUnreliablePath(cargoTarget)
      ? path.join(cargoTarget, "release")
      : null,
  ].filter(Boolean);

  // Prefer a release dir that actually has the app or an NSIS bundle
  for (const dir of candidates) {
    if (!dir || !fs.existsSync(dir) || isUnreliablePath(dir)) continue;
    const hasExe = fs.existsSync(path.join(dir, "yx-desktop.exe"));
    const hasNsis = fs.existsSync(path.join(dir, "bundle", "nsis"));
    if (hasExe || hasNsis) return dir;
  }

  const discovered = discoverReleaseDir();
  if (discovered) return discovered;

  // Last resort: first existing candidate (may be empty before first build)
  for (const dir of candidates) {
    if (dir && fs.existsSync(dir) && !isUnreliablePath(dir)) return dir;
  }

  return path.join(WORKSPACE_TARGET, "release");
}

export function isUnreliablePath(dir) {
  return /cursor-sandbox-cache/i.test(String(dir).replace(/\\/g, "/"));
}

function discoverReleaseDir() {
  // Never scan Cursor sandbox caches — those produced the stale installer without console-hide fixes
  const roots = [WORKSPACE_TARGET, TAURI_TARGET];

  let best = null;
  let bestMtime = 0;

  function consider(relDir) {
    try {
      if (/cursor-sandbox-cache/i.test(relDir)) return; // never prefer agent sandbox builds
      const st = fs.statSync(relDir);
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        best = relDir;
      }
    } catch {
      /* ignore */
    }
  }

  function walk(dir, depth) {
    if (depth > 6 || !fs.existsSync(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.name === "release") {
        const exe = path.join(full, "yx-desktop.exe");
        const nsis = path.join(full, "bundle", "nsis");
        if (fs.existsSync(exe) || fs.existsSync(nsis)) consider(full);
      } else if (e.name === "target" || e.name === "cargo-target" || e.name.length === 32 || e.name.includes("cargo")) {
        walk(full, depth + 1);
      } else if (depth < 3) {
        walk(full, depth + 1);
      }
    }
  }

  for (const root of roots) walk(root, 0);
  return best;
}


export function bundleDir(kind) {
  return path.join(releaseDir(), "bundle", kind);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function ensureDist() {
  ensureDir(DIST_DIR);
  return DIST_DIR;
}

export function ensureBuild() {
  ensureDir(BUILD_DIR);
  return BUILD_DIR;
}
