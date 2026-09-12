import fs from "node:fs";
import path from "node:path";
import { ROOT, DESKTOP_DIR, TAURI_DIR } from "./paths.js";

function parseWorkspaceVersion(cargoToml) {
  const text = fs.readFileSync(cargoToml, "utf8");
  const section = text.match(/\[workspace\.package\]([\s\S]*?)(\n\[|$)/);
  if (!section) {
    throw new Error("Could not find [workspace.package] in Cargo.toml");
  }
  const match = section[1].match(/^\s*version\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error("Could not find version in [workspace.package]");
  }
  return match[1];
}

function readJsonVersion(file) {
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!json.version) throw new Error(`Missing version in ${file}`);
  return String(json.version);
}

/**
 * Authoritative version from workspace Cargo.toml.
 * Fails if package.json / tauri.conf.json disagree.
 */
export function getVersion() {
  const version = parseWorkspaceVersion(path.join(ROOT, "Cargo.toml"));
  const pkg = readJsonVersion(path.join(DESKTOP_DIR, "package.json"));
  const tauri = readJsonVersion(path.join(TAURI_DIR, "tauri.conf.json"));
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const rootVer = rootPkg.version ? String(rootPkg.version) : version;

  const mismatches = [];
  if (pkg !== version) mismatches.push(`apps/desktop/package.json=${pkg}`);
  if (tauri !== version) mismatches.push(`tauri.conf.json=${tauri}`);
  if (rootVer !== version) mismatches.push(`package.json=${rootVer}`);

  if (mismatches.length) {
    throw new Error(
      `Version mismatch. Cargo workspace version is ${version}, but:\n  - ${mismatches.join("\n  - ")}\nKeep all versions in sync.`,
    );
  }

  return version;
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
