#!/usr/bin/env node
/**
 * Production release packaging:
 *   1. Clean dist/ + build/ cache
 *   2. Force-build Tauri NSIS (workspace target only)
 *   3. Package Setup.exe + portable + MSIX (+ AppImage via Docker when available)
 *   4. Write latest.json when updater signatures exist
 *
 * Usage:
 *   npm run dist:release
 *   npm run dist:release -- --windows-only
 *
 * Signing (automatic when yx-updater.key exists):
 *   Uses apps/desktop/src-tauri/yx-updater.key with empty password by default.
 *   Override: TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD
 *
 * Unsigned test only:
 *   YX_ALLOW_UNSIGNED_RELEASE=1
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTauriBuild, findNsisInstaller } from "./lib/tauri-build.js";
import { artifactBase } from "./lib/version.js";
import {
  DIST_DIR,
  ensureBuild,
  ensureDist,
  bundleDir,
  isUnreliablePath,
} from "./lib/paths.js";
import { copyToDist } from "./lib/copy-artifact.js";
import { cleanReleaseArtifacts } from "./lib/clean-artifacts.js";
import {
  stagePortableApp,
  zipDirectory,
  createPortableExe,
  portableStagingPath,
} from "./lib/portable.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const forceWindowsOnly = process.argv.includes("--windows-only");
const forceSkipLinux =
  process.argv.includes("--skip-linux") || forceWindowsOnly;

function dockerDaemonReady() {
  const r = spawnSync("docker", ["info"], {
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  return r.status === 0;
}

const skipDocker = forceSkipLinux || !dockerDaemonReady();
if (!forceSkipLinux && skipDocker) {
  console.log(
    "[yx-dist] Docker daemon not available — packaging Windows only (AppImage skipped)",
  );
}

console.log("[yx-dist] === Clean previous release artifacts ===");
cleanReleaseArtifacts();
ensureBuild();
ensureDist();

console.log("[yx-dist] === Force Tauri production build (NSIS) ===");
const buildResult = ensureTauriBuild({
  bundles: ["nsis"],
  force: true,
  updaterSign: true,
  requireUpdaterSign: true,
});

if (isUnreliablePath(buildResult.releaseDir)) {
  throw new Error(`Refusing to package sandbox build: ${buildResult.releaseDir}`);
}

const names = artifactBase();

console.log("[yx-dist] === Windows setup .exe (NSIS) ===");
const nsisSrc = findNsisInstaller();
copyToDist(nsisSrc, names.setup);

// Copy updater .sig next to the renamed setup if present
const nsisDir = bundleDir("nsis");
if (fs.existsSync(nsisDir)) {
  for (const f of fs.readdirSync(nsisDir)) {
    if (!f.endsWith(".sig")) continue;
    const src = path.join(nsisDir, f);
    const destName = `${names.setup}.sig`;
    fs.copyFileSync(src, path.join(DIST_DIR, destName));
    console.log(`[yx-dist] → dist/${destName}`);
  }
}

console.log("[yx-dist] === Portable ZIP / EXE ===");
const staging = portableStagingPath();
stagePortableApp(staging);
const zipOut = path.join(DIST_DIR, names.portableZip);
zipDirectory(staging, zipOut);
console.log(`[yx-dist] → dist/${names.portableZip}`);
const portableExe = path.join(DIST_DIR, names.portableExe);
try {
  createPortableExe(staging, portableExe);
  console.log(`[yx-dist] → dist/${names.portableExe}`);
} catch (err) {
  console.warn(`[yx-dist] WARN: portable EXE failed: ${err.message || err}`);
  console.warn(`[yx-dist] ZIP is still available: dist/${names.portableZip}`);
}

function run(script, extraArgs = []) {
  const r = spawnSync(
    process.execPath,
    [path.join(__dirname, script), "--reuse", ...extraArgs],
    { stdio: "inherit", env: process.env },
  );
  if (r.status !== 0) process.exit(r.status ?? 1);
}

console.log("[yx-dist] === Windows MSIX ===");
run("build-msix.js");

console.log("[yx-dist] === Updater latest.json ===");
{
  const r = spawnSync(process.execPath, [path.join(__dirname, "write-latest-json.js")], {
    stdio: "inherit",
    env: process.env,
  });
  if (r.status !== 0) {
    console.warn("[yx-dist] WARN: write-latest-json exited non-zero");
  }
}

if (!skipDocker) {
  console.log("[yx-dist] === Linux AppImage (Docker) ===");
  const r = spawnSync(process.execPath, [path.join(__dirname, "build-linux-docker.js")], {
    stdio: "inherit",
    env: process.env,
  });
  if (r.status !== 0) {
    console.error(
      [
        "",
        "[yx-dist] Linux AppImage failed.",
        "Windows packages are still in dist/.",
        "Fix Docker, then run: npm run dist:linux:docker",
        "Or re-run: npm run dist:release -- --windows-only",
      ].join("\n"),
    );
    process.exit(r.status ?? 1);
  }
} else if (forceSkipLinux) {
  console.log("[yx-dist] Skipping Linux (use npm run dist:linux:docker separately)");
}

// Fail if required Windows artifacts are missing
const required = [names.setup, names.msix, names.portableZip];
const missing = required.filter((f) => !fs.existsSync(path.join(DIST_DIR, f)));
if (missing.length) {
  throw new Error(`Release incomplete — missing: ${missing.join(", ")}`);
}

console.log("");
console.log("[yx-dist] Production artifacts in dist/:");
for (const f of fs.readdirSync(DIST_DIR).sort()) {
  const st = fs.statSync(path.join(DIST_DIR, f));
  console.log(`  - ${f} (${Math.round(st.size / 1024)} KB)`);
}
console.log("");
console.log("Upload:");
console.log(`  GitHub Release : ${names.setup} + ${names.appImage} + latest.json`);
console.log(`  Microsoft Store: ${names.msix}`);
if (!buildResult.signed && process.env.YX_ALLOW_UNSIGNED_RELEASE === "1") {
  console.warn("[yx-dist] WARNING: this release is UNSIGNED for updater — not for production users.");
}
