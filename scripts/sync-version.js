#!/usr/bin/env node
/**
 * Sync the release version from root package.json (the single version source)
 * to Cargo.toml, apps/desktop/package.json and tauri.conf.json.
 *
 * Runs automatically before every build (getVersion / ensureTauriBuild);
 * this wrapper is for manual use: npm run version:sync
 */
import { syncVersions } from "./lib/version.js";

const version = syncVersions();
console.log(
  `[yx-dist] Version ${version} in sync: package.json → Cargo.toml, apps/desktop/package.json, tauri.conf.json`,
);
