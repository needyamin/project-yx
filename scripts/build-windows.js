#!/usr/bin/env node
/**
 * Default Windows distribution: NSIS setup + portable package.
 * Builds Tauri once, then packages both artifacts into dist/.
 */
import path from "node:path";
import { ensureTauriBuild, findNsisInstaller } from "./lib/tauri-build.js";
import { artifactBase } from "./lib/version.js";
import { DIST_DIR, ensureDist, ensureBuild } from "./lib/paths.js";
import { copyToDist } from "./lib/copy-artifact.js";
import {
  stagePortableApp,
  zipDirectory,
  createPortableExe,
  portableStagingPath,
} from "./lib/portable.js";
import { prepareBundledBinaries } from "./prepare-binaries.js";

const mode = process.argv.includes("--nsis-only")
  ? "nsis"
  : process.argv.includes("--portable-only")
    ? "portable"
    : "all";
const force = process.argv.includes("--force");

ensureBuild();
prepareBundledBinaries();
ensureTauriBuild({ bundles: ["nsis"], force });
const names = artifactBase();
ensureDist();

if (mode === "all" || mode === "nsis") {
  const nsis = findNsisInstaller();
  copyToDist(nsis, names.setup);
}

if (mode === "all" || mode === "portable") {
  const staging = portableStagingPath();
  stagePortableApp(staging);
  const zipOut = path.join(DIST_DIR, names.portableZip);
  zipDirectory(staging, zipOut);
  console.log(`[yx-dist] → dist/${names.portableZip}`);

  const exeOut = path.join(DIST_DIR, names.portableExe);
  try {
    createPortableExe(staging, exeOut);
    console.log(`[yx-dist] → dist/${names.portableExe}`);
  } catch (err) {
    console.error(String(err.message || err));
    if (mode === "portable") process.exitCode = 1;
    else {
      console.warn(
        `[yx-dist] WARN: portable EXE skipped; ZIP written as dist/${names.portableZip}`,
      );
    }
  }
}

console.log("[yx-dist] Windows packaging finished");
