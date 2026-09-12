#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT, DIST_DIR, ensureDist } from "./lib/paths.js";
import { artifactBase, getVersion } from "./lib/version.js";

function requireDocker() {
  const r = spawnSync("docker", ["info"], { encoding: "utf8", shell: false });
  if (r.status !== 0) {
    throw new Error(
      [
        "ERROR: Docker is not available.",
        "",
        "Docker CLI is installed, but the engine is not running.",
        "Please start Docker Desktop, wait until it says Running, then:",
        "",
        "  npm run dist:linux:docker",
        "",
        "Windows packages are already in dist/ and do not need Docker.",
      ].join("\n"),
    );
  }
}

requireDocker();
getVersion(); // assert sync early
const names = artifactBase();
ensureDist();

const image = "project-yx-linux-builder";
const dockerfile = path.join(ROOT, "docker", "Dockerfile");

console.log("[yx-dist] Building Docker image…");
// shell:false so paths with spaces (e.g. "Project YX") stay as one argument.
let r = spawnSync("docker", ["build", "-t", image, "-f", dockerfile, ROOT], {
  stdio: "inherit",
  shell: false,
});
if (r.status !== 0) process.exit(r.status ?? 1);

const mount = `${ROOT}:/workspace`;
console.log("[yx-dist] Running Linux AppImage build in Docker…");
r = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "-v",
    mount,
    "-e",
    `YX_VERSION=${names.version}`,
    image,
    "/bin/bash",
    "/workspace/docker/build-linux.sh",
  ],
  { stdio: "inherit", shell: false },
);
if (r.status !== 0) process.exit(r.status ?? 1);

const out = path.join(DIST_DIR, names.appImage);
if (!fs.existsSync(out)) {
  throw new Error(
    `Expected AppImage missing after Docker build: dist/${names.appImage}`,
  );
}
console.log(`[yx-dist] → dist/${names.appImage}`);
console.log("[yx-dist] Docker Linux packaging finished");
