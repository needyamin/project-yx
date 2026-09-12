#!/usr/bin/env node
import path from "node:path";
import { ensureTauriBuild } from "./lib/tauri-build.js";
import { artifactBase } from "./lib/version.js";
import { DIST_DIR, ensureDist, ensureBuild } from "./lib/paths.js";
import { copyToDist } from "./lib/copy-artifact.js";
import {
  stagePortableApp,
  zipDirectory,
  createPortableExe,
  portableStagingPath,
} from "./lib/portable.js";

const force = process.argv.includes("--force");

ensureBuild();
ensureTauriBuild({ bundles: ["nsis"], force });

const names = artifactBase();
const staging = portableStagingPath();
stagePortableApp(staging);

ensureDist();
const zipOut = path.join(DIST_DIR, names.portableZip);
zipDirectory(staging, zipOut);
console.log(`[yx-dist] → dist/${names.portableZip}`);

const exeOut = path.join(DIST_DIR, names.portableExe);
try {
  createPortableExe(staging, exeOut);
  console.log(`[yx-dist] → dist/${names.portableExe}`);
} catch (err) {
  console.error(String(err.message || err));
  console.error(
    `\nPortable ZIP is available at dist/${names.portableZip}\n` +
      `Fix the EXE tooling and re-run: npm run dist:portable`,
  );
  process.exitCode = 1;
}
