#!/usr/bin/env node
/**
 * Build Tauri once, then produce NSIS .exe + MSIX (and Inno if installed).
 * Prefer `npm run dist:release` for exe + msix + Linux AppImage.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTauriBuild, findNsisInstaller } from "./lib/tauri-build.js";
import { artifactBase } from "./lib/version.js";
import { ensureBuild } from "./lib/paths.js";
import { copyToDist } from "./lib/copy-artifact.js";
import { findIscc } from "./lib/inno.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const force = process.argv.includes("--force");

ensureBuild();
ensureTauriBuild({ bundles: ["nsis"], force });

const names = artifactBase();
copyToDist(findNsisInstaller(), names.setup);

function run(script) {
  const r = spawnSync(process.execPath, [path.join(__dirname, script), "--reuse"], {
    stdio: "inherit",
    env: process.env,
  });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

if (findIscc()) {
  console.log("[yx-dist] Inno Setup found — also building Inno installer");
  run("build-inno.js");
} else {
  console.log("[yx-dist] Inno Setup not found — NSIS setup exe already in dist/");
}

run("build-msix.js");
console.log("[yx-dist] Windows packages finished (exe + msix)");
