import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DESKTOP_DIR, BUILD_DIR, TAURI_DIR, ROOT, ensureBuild, releaseDir, bundleDir, isUnreliablePath } from "./paths.js";
import { getVersion, syncVersions } from "./version.js";

/** Quote an argv token for cmd.exe when spawnSync(..., { shell: true }). */
function winShellArg(arg) {
  if (process.platform !== "win32") return arg;
  if (!/[\s&()[\]{}^=;!'+,`~%]/.test(arg) && !arg.includes('"')) return arg;
  return `"${String(arg).replace(/"/g, '\\"')}"`;
}

function stampPath(bundlesKey) {
  return path.join(BUILD_DIR, `.tauri-stamp-${bundlesKey}`);
}

function loadSigningEnv(baseEnv) {
  const env = { ...baseEnv };
  if (env.TAURI_SIGNING_PRIVATE_KEY) {
    if (env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) {
      env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "";
    }
    return env;
  }

  const keyPath = path.join(TAURI_DIR, "yx-updater.key");
  if (fs.existsSync(keyPath)) {
    // Prefer path form (Tauri accepts path or contents). Avoid interactive password hangs
    // unless the caller set TAURI_SIGNING_PRIVATE_KEY_PASSWORD.
    env.TAURI_SIGNING_PRIVATE_KEY = keyPath;
    if (env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) {
      env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "";
    }
    console.log("[yx-dist] Using local yx-updater.key for updater signatures");
  }
  return env;
}

function canSignUpdater(env) {
  return Boolean(env.TAURI_SIGNING_PRIVATE_KEY);
}

function artifactsReady(bundlesKey) {
  if (bundlesKey.includes("nsis") && !nsisExists()) return false;
  if (bundlesKey.includes("appimage") && !appImageExists()) return false;
  if (!exeExists()) return false;
  return true;
}

function exeExists() {
  const rel = releaseDir();
  const names = ["yx-desktop.exe", "yx-desktop", "Project YX.exe", "project-yx.exe"];
  for (const name of names) {
    if (fs.existsSync(path.join(rel, name))) return true;
  }
  // any main binary that isn't a setup installer
  if (!fs.existsSync(rel)) return false;
  return fs.readdirSync(rel).some((f) => {
    const lower = f.toLowerCase();
    return (lower.endsWith(".exe") || (!lower.includes(".") && process.platform !== "win32"))
      && !lower.includes("setup")
      && !lower.endsWith(".pdb");
  });
}

function nsisExists() {
  const dir = bundleDir("nsis");
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((f) => f.toLowerCase().endsWith(".exe"));
}

function appImageExists() {
  const dir = bundleDir("appimage");
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((f) => f.toLowerCase().endsWith(".appimage"));
}

function stampValid(bundlesKey, force) {
  if (force) return false;
  const stamp = stampPath(bundlesKey);
  if (!fs.existsSync(stamp)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(stamp, "utf8"));
    if (data.version !== getVersion()) return false;
    if (data.bundlesKey !== bundlesKey) return false;
    if (bundlesKey.includes("nsis") && !nsisExists()) return false;
    if (bundlesKey.includes("appimage") && !appImageExists()) return false;
    if (!exeExists()) return false;
    return true;
  } catch {
    return false;
  }
}

function writeStamp(bundlesKey) {
  ensureBuild();
  fs.writeFileSync(
    stampPath(bundlesKey),
    JSON.stringify(
      {
        version: getVersion(),
        bundlesKey,
        builtAt: new Date().toISOString(),
        releaseDir: releaseDir(),
      },
      null,
      2,
    ),
  );
}

function isUnreliableReleaseDir(dir) {
  return isUnreliablePath(dir);
}

function npmCmd() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * Build Tauri once for the given bundle list. Reuses prior build when stamp is valid.
 * @param {{ bundles?: string[], force?: boolean, updaterSign?: boolean, requireUpdaterSign?: boolean }} opts
 */
export function ensureTauriBuild(opts = {}) {
  // Root package.json is the version source — sync mirrors BEFORE cargo runs,
  // so the built binary/bundles always carry the version being released.
  syncVersions();
  const bundles = opts.bundles ?? ["nsis"];
  const force = Boolean(opts.force || process.env.YX_FORCE_BUILD === "1");
  const updaterSign = Boolean(
    opts.updaterSign || process.env.YX_FORCE_UPDATER_SIGN === "1",
  );
  const requireUpdaterSign = Boolean(opts.requireUpdaterSign);
  const bundlesKey = bundles.slice().sort().join("+") || "none";

  if (!force && stampValid(bundlesKey, force)) {
    const rel = releaseDir();
    if (!isUnreliableReleaseDir(rel)) {
      console.log(`[yx-dist] Reusing Tauri build (${bundlesKey}) at ${rel}`);
      return { reused: true, releaseDir: rel, signed: false };
    }
    console.warn(`[yx-dist] Ignoring sandbox/cache build at ${rel} — rebuilding`);
  }

  // Reuse unstamped artifacts only if they look like a real workspace build
  if (!force && artifactsReady(bundlesKey) && !isUnreliableReleaseDir(releaseDir())) {
    console.log(`[yx-dist] Found existing artifacts at ${releaseDir()} — skipping rebuild`);
    writeStamp(bundlesKey);
    return { reused: true, releaseDir: releaseDir(), signed: false };
  }

  const args = ["run", "tauri", "build"];
  if (bundles.length) {
    args.push("--", "--bundles", bundles.join(","));
  }

  // Prefer the workspace target dir (not Cursor sandbox cache)
  const env = loadSigningEnv({
    ...process.env,
    CARGO_TARGET_DIR: path.join(ROOT, "target"),
  });

  let signed = false;
  if (updaterSign) {
    if (!canSignUpdater(env)) {
      const msg = [
        "ERROR: Updater signing was requested but no private key was found.",
        "",
        "Place apps/desktop/src-tauri/yx-updater.key (gitignored),",
        "or set TAURI_SIGNING_PRIVATE_KEY to the key path/contents.",
        "",
        "Optional: TAURI_SIGNING_PRIVATE_KEY_PASSWORD (defaults to empty).",
        "",
        "For an unsigned local test only: YX_ALLOW_UNSIGNED_RELEASE=1",
      ].join("\n");
      if (requireUpdaterSign && process.env.YX_ALLOW_UNSIGNED_RELEASE !== "1") {
        throw new Error(msg);
      }
      console.warn(`[yx-dist] WARN: ${msg.split("\n")[0]} — building without .sig`);
    } else if (canSignUpdater(env)) {
      // Password defaults to "" in loadSigningEnv so `npm run dist:release` works
      // without manual env setup. Override TAURI_SIGNING_PRIVATE_KEY_PASSWORD if encrypted.
      if (!("TAURI_SIGNING_PRIVATE_KEY_PASSWORD" in process.env)) {
        console.log(
          "[yx-dist] TAURI_SIGNING_PRIVATE_KEY_PASSWORD not set — using empty (unencrypted key)",
        );
      }
      if (!args.includes("--")) args.push("--");
      // Write under %TEMP% — workspace path has a space ("Project YX") which breaks
      // `npm.cmd` / cmd.exe when shell:true unless carefully quoted.
      const overridePath = path.join(os.tmpdir(), "yx-tauri-updater-on.json");
      fs.writeFileSync(
        overridePath,
        JSON.stringify({ bundle: { createUpdaterArtifacts: true } }, null, 2),
      );
      args.push("--config", overridePath);
      signed = true;
      console.log("[yx-dist] Updater signatures ENABLED");
      console.log(`[yx-dist] --config ${overridePath}`);
    }
  }

  console.log(`[yx-dist] Building Tauri (${bundlesKey})…`);
  console.log(`[yx-dist] CARGO_TARGET_DIR=${env.CARGO_TARGET_DIR}`);
  // On Windows, npm.cmd requires shell so PATH / PATHEXT resolve correctly.
  // Quote args that contain spaces so "Project YX" paths do not split.
  const spawnArgs =
    process.platform === "win32" ? args.map(winShellArg) : args;
  const result = spawnSync(npmCmd(), spawnArgs, {
    cwd: DESKTOP_DIR,
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });
  console.log(`[yx-dist] tauri build exit=${result.status} error=${result.error || ""}`);

  if (result.status !== 0) {
    // Never package stale binaries on a forced production rebuild.
    if (!force && artifactsReady(bundlesKey) && !isUnreliableReleaseDir(releaseDir())) {
      console.warn(
        `[yx-dist] WARN: tauri build exited ${result.status}, but release artifacts exist — continuing`,
      );
      console.warn(
        `[yx-dist] releaseDir=${releaseDir()} (updater signing may need TAURI_SIGNING_PRIVATE_KEY)`,
      );
    } else {
      const hint = signed
        ? [
            "",
            "Hint: updater signing failed. If your key is password-protected, set:",
            "  TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<password>",
            "Or for an unsigned local test: YX_ALLOW_UNSIGNED_RELEASE=1",
          ].join("\n")
        : "";
      throw new Error(`Tauri build failed with exit code ${result.status ?? 1}${hint}`);
    }
  }

  writeStamp(bundlesKey);
  return { reused: false, releaseDir: releaseDir(), signed };
}

export function findMainExecutable() {
  const rel = releaseDir();
  const preferred = ["yx-desktop.exe", "yx-desktop", "Project YX.exe", "Project-YX.exe"];
  for (const name of preferred) {
    const p = path.join(rel, name);
    if (fs.existsSync(p)) return p;
  }
  if (!fs.existsSync(rel)) {
    throw new Error(`Release directory not found: ${rel}`);
  }
  const found = fs.readdirSync(rel).find((f) => {
    const lower = f.toLowerCase();
    return (lower.endsWith(".exe") || process.platform !== "win32")
      && !lower.includes("setup")
      && !lower.endsWith(".pdb")
      && !lower.endsWith(".dll");
  });
  if (!found) throw new Error(`Could not find main executable in ${rel}`);
  return path.join(rel, found);
}

export function findNsisInstaller() {
  const dir = bundleDir("nsis");
  if (isUnreliablePath(dir)) {
    throw new Error(
      `Refusing to package NSIS from sandbox cache:\n  ${dir}\nRun: npm run dist -- --force`,
    );
  }
  if (!fs.existsSync(dir)) {
    throw new Error(`NSIS bundle directory not found: ${dir}`);
  }
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".exe"));
  if (!files.length) throw new Error(`No NSIS installer found in ${dir}`);
  // The bundle dir accumulates installers from previous version bumps (Tauri
  // never cleans it). Only an installer built for the CURRENT version is
  // valid — alphabetical order would otherwise ship the oldest one renamed
  // to the new version's filename.
  const version = getVersion();
  const current = files.filter((f) => f.includes(version));
  if (!current.length) {
    throw new Error(
      `No NSIS installer for version ${version} in ${dir}\n  Found: ${files.join(", ")}\n  Re-run: npm run dist:release`,
    );
  }
  // Prefer *-setup.exe
  current.sort((a, b) => {
    const as = a.toLowerCase().includes("setup") ? 0 : 1;
    const bs = b.toLowerCase().includes("setup") ? 0 : 1;
    return as - bs;
  });
  return path.join(dir, current[0]);
}

export function findAppImage() {
  const dir = bundleDir("appimage");
  if (!fs.existsSync(dir)) {
    throw new Error(`AppImage bundle directory not found: ${dir}`);
  }
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".appimage"));
  if (!files.length) throw new Error(`No AppImage found in ${dir}`);
  return path.join(dir, files[0]);
}
