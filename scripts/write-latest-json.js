#!/usr/bin/env node
/**
 * Write dist/latest.json for Tauri updater from NSIS signature + GitHub release URL.
 * Usage: node scripts/write-latest-json.js [tag]
 * Env: GITHUB_REPOSITORY (owner/repo), optional GITHUB_REF_NAME
 */
import fs from "node:fs";
import path from "node:path";
import { DIST_DIR, ensureDist, bundleDir } from "./lib/paths.js";
import { artifactBase, getVersion } from "./lib/version.js";

const version = getVersion();
const names = artifactBase(version);
// Match existing GitHub tag style (V0.1.0). Override with YX_RELEASE_TAG / GITHUB_REF_NAME.
const tag =
  process.argv[2] ||
  process.env.YX_RELEASE_TAG ||
  process.env.GITHUB_REF_NAME ||
  `V${version}`;
const repo = process.env.GITHUB_REPOSITORY || "needyamin/project-yx";
const baseUrl = `https://github.com/${repo}/releases/download/${tag}`;

function findSig() {
  const candidates = [
    path.join(DIST_DIR, `${names.setup}.sig`),
    path.join(bundleDir("nsis"), `${names.setup}.sig`),
  ];
  const nsisDir = bundleDir("nsis");
  if (fs.existsSync(nsisDir)) {
    for (const f of fs.readdirSync(nsisDir)) {
      if (f.endsWith(".sig")) candidates.push(path.join(nsisDir, f));
    }
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const sigPath = findSig();
if (!sigPath) {
  console.warn("[yx-dist] No .sig found — skipping latest.json (signing key missing?)");
  process.exit(0);
}

const signature = fs.readFileSync(sigPath, "utf8").trim();
const setupUrl = `${baseUrl}/${names.setup}`;

const latest = {
  version,
  notes: `Project YX ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: setupUrl,
    },
  },
};

ensureDist();
const out = path.join(DIST_DIR, "latest.json");
fs.writeFileSync(out, JSON.stringify(latest, null, 2));
console.log(`[yx-dist] → dist/latest.json (${setupUrl})`);
