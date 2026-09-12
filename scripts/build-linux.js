#!/usr/bin/env node
import { ensureTauriBuild, findAppImage } from "./lib/tauri-build.js";
import { artifactBase } from "./lib/version.js";
import { copyToDist } from "./lib/copy-artifact.js";
import { ensureBuild } from "./lib/paths.js";

if (process.platform === "win32") {
  console.error(
    [
      "ERROR: Native Linux AppImage builds cannot run on Windows.",
      "",
      "Use Docker instead:",
      "",
      "  npm run dist:linux:docker",
    ].join("\n"),
  );
  process.exit(1);
}

const force = process.argv.includes("--force");
ensureBuild();
ensureTauriBuild({ bundles: ["appimage"], force });
const names = artifactBase();
copyToDist(findAppImage(), names.appImage);
console.log("[yx-dist] Linux AppImage packaging finished");
