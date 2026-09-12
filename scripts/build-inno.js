#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { ensureTauriBuild, findMainExecutable } from "./lib/tauri-build.js";
import { artifactBase } from "./lib/version.js";
import { ROOT, DIST_DIR, ensureDist, ensureBuild } from "./lib/paths.js";
import { stagePortableApp, portableStagingPath, iconIcoPath } from "./lib/portable.js";
import { requireIscc, runIscc } from "./lib/inno.js";

const force = process.argv.includes("--force");
const skipBuild = process.argv.includes("--reuse");

ensureBuild();
if (!skipBuild) {
  ensureTauriBuild({ bundles: ["nsis"], force });
}

const names = artifactBase();
const staging = portableStagingPath();
stagePortableApp(staging);

const mainExe = path.basename(findMainExecutable());
const iscc = requireIscc();
const iss = path.join(ROOT, "installer", "project-yx.iss");
ensureDist();

const outputBase = names.setup.replace(/\.exe$/i, "");

runIscc(iscc, iss, {
  MyAppVersion: names.version,
  MyAppSourceDir: staging,
  MyAppOutputDir: DIST_DIR,
  MyAppOutputBase: outputBase,
  MyAppExeName: mainExe,
  MyAppIcon: iconIcoPath(),
});

const out = path.join(DIST_DIR, names.setup);
if (!fs.existsSync(out)) {
  throw new Error(`Expected Inno output missing: ${out}`);
}
console.log(`[yx-dist] → dist/${names.setup}`);
console.log("[yx-dist] Inno Setup packaging finished");
