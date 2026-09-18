import fs from "node:fs";
import path from "node:path";
import { ROOT, DESKTOP_DIR, TAURI_DIR } from "./paths.js";

const CARGO_TOML = path.join(ROOT, "Cargo.toml");
const DESKTOP_PKG = path.join(DESKTOP_DIR, "package.json");
const TAURI_CONF = path.join(TAURI_DIR, "tauri.conf.json");
const ROOT_PKG = path.join(ROOT, "package.json");

function readRootVersion() {
  const pkg = JSON.parse(fs.readFileSync(ROOT_PKG, "utf8"));
  if (!pkg.version) {
    throw new Error(
      `Missing version in ${path.relative(ROOT, ROOT_PKG)} — it is the single version source.`,
    );
  }
  return String(pkg.version);
}

/** Rewrite the version inside [workspace.package], preserving all other formatting. */
function writeCargoVersion(text, version) {
  const section = text.match(/\[workspace\.package\]([\s\S]*?)(\n\[|$)/);
  if (!section) {
    throw new Error("Could not find [workspace.package] in Cargo.toml");
  }
  const re = /^(\s*version\s*=\s*")[^"]+(")/m;
  if (!re.test(section[0])) {
    throw new Error("Could not find version in [workspace.package]");
  }
  // NB: when versions already match this returns `text` unchanged — never
  // use string inequality to detect "no match" here.
  const updated = section[0].replace(re, `$1${version}$2`);
  const start = section.index;
  return text.slice(0, start) + updated + text.slice(start + section[0].length);
}

/** Rewrite the single top-level "version" key, preserving all other formatting. */
function writeJsonVersion(text, version, label) {
  let hits = 0;
  const updated = text.replace(
    /^(\s*"version"\s*:\s*")[^"]+(")/m,
    (m, a, b) => {
      hits += 1;
      return `${a}${version}${b}`;
    },
  );
  if (hits !== 1) {
    throw new Error(`Expected exactly one "version" key in ${label}, found ${hits}`);
  }
  return updated;
}

function syncFile(file, transform, version, label) {
  const before = fs.readFileSync(file, "utf8");
  const after = transform(before, version, label);
  if (after !== before) {
    fs.writeFileSync(file, after);
    console.log(`[yx-dist] version ${version} → ${label}`);
  }
}

/**
 * Root package.json is the SINGLE version source. Rewrites Cargo.toml,
 * apps/desktop/package.json and tauri.conf.json when they disagree.
 * Idempotent — run freely at any time.
 */
export function syncVersions() {
  const version = readRootVersion();
  syncFile(CARGO_TOML, writeCargoVersion, version, "Cargo.toml");
  syncFile(DESKTOP_PKG, writeJsonVersion, version, "apps/desktop/package.json");
  syncFile(TAURI_CONF, writeJsonVersion, version, "tauri.conf.json");
  return version;
}

/**
 * Authoritative version (root package.json), after syncing all mirrors.
 * Syncing here means every build script that reads the version — and the
 * tauri-build stamp checks — can never see a stale mirror.
 */
export function getVersion() {
  return syncVersions();
}

export function artifactBase(version = getVersion()) {
  return {
    version,
    setup: `Project-YX-Setup-${version}.exe`,
    portableExe: `Project-YX-${version}-Portable.exe`,
    portableZip: `Project-YX-${version}-Portable.zip`,
    msix: `Project-YX-${version}.msix`,
    appImage: `Project-YX-${version}.AppImage`,
  };
}
