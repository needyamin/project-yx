#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureTauriBuild, findMainExecutable } from "./lib/tauri-build.js";
import { artifactBase } from "./lib/version.js";
import {
  ROOT,
  DIST_DIR,
  BUILD_DIR,
  TAURI_DIR,
  ensureDist,
  ensureBuild,
} from "./lib/paths.js";
import { stagePortableApp, portableStagingPath } from "./lib/portable.js";
import { requireMakeAppx, findSignTool } from "./lib/msix.js";
import { prepareBundledBinaries } from "./prepare-binaries.js";

const force = process.argv.includes("--force");
const skipBuild = process.argv.includes("--reuse");

function toVersionQuad(version) {
  const parts = String(version).split(".").map((p) => parseInt(p, 10));
  while (parts.length < 4) parts.push(0);
  if (parts.some((n) => Number.isNaN(n))) {
    throw new Error(`Invalid version for MSIX: ${version}`);
  }
  return parts.slice(0, 4).join(".");
}

ensureBuild();
prepareBundledBinaries();
if (!skipBuild) {
  ensureTauriBuild({ bundles: ["nsis"], force });
}

const names = artifactBase();
const staging = portableStagingPath();
stagePortableApp(staging);
const mainExe = path.basename(findMainExecutable());

const layout = path.join(BUILD_DIR, "msix-layout");
fs.rmSync(layout, { recursive: true, force: true });
fs.mkdirSync(layout, { recursive: true });

// Copy app payload
for (const entry of fs.readdirSync(staging, { withFileTypes: true })) {
  const from = path.join(staging, entry.name);
  const to = path.join(layout, entry.name);
  if (entry.isDirectory()) {
    fs.cpSync(from, to, { recursive: true });
  } else {
    fs.copyFileSync(from, to);
  }
}

const assetsDir = path.join(layout, "Assets");
fs.mkdirSync(assetsDir, { recursive: true });
const iconDir = path.join(TAURI_DIR, "icons");
const assetMap = [
  ["StoreLogo.png", "StoreLogo.png"],
  ["Square44x44Logo.png", "Square44x44Logo.png"],
  ["Square71x71Logo.png", "Square71x71Logo.png"],
  ["Square150x150Logo.png", "Square150x150Logo.png"],
  ["Square310x310Logo.png", "Square310x310Logo.png"],
];
for (const [srcName, destName] of assetMap) {
  const src = path.join(iconDir, srcName);
  if (!fs.existsSync(src)) {
    throw new Error(`MSIX asset missing: ${src}`);
  }
  fs.copyFileSync(src, path.join(assetsDir, destName));
}

function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return null;
}

// Check for store-identity.json or msix.config.json in ROOT
let fileConfig = {};
const configCandidates = [
  path.join(ROOT, "store-identity.json"),
  path.join(ROOT, "msix.config.json"),
];
for (const cfgPath of configCandidates) {
  if (fs.existsSync(cfgPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      console.log(`[yx-dist] Loaded Store identity config from ${path.basename(cfgPath)}`);
      break;
    } catch (e) {
      console.warn(`[yx-dist] WARN: Failed to parse ${cfgPath}:`, e.message);
    }
  }
}

const templatePath = path.join(ROOT, "installer", "msix", "AppxManifest.xml.template");
const displayName =
  getArg("--display-name") ||
  process.env.YX_MSIX_DISPLAY_NAME ||
  fileConfig.displayName ||
  "Project YX - Pro Video Editing for Every Machine";

const description =
  getArg("--description") ||
  process.env.YX_MSIX_DESCRIPTION ||
  fileConfig.description ||
  "Project YX - Pro Video Editing for Every Machine";

const identityName =
  getArg("--identity-name") ||
  process.env.YX_MSIX_IDENTITY_NAME ||
  fileConfig.identityName ||
  fileConfig.name ||
  "ANSNEWTECH.ProjectYX-ProVideoEditingforEveryMachin";

const publisher =
  getArg("--publisher") ||
  process.env.YX_MSIX_PUBLISHER ||
  fileConfig.publisher ||
  "CN=087A9974-75CB-44FC-B893-8D3999E5E5E5";

const publisherDisplay =
  getArg("--publisher-display") ||
  process.env.YX_MSIX_PUBLISHER_DISPLAY ||
  fileConfig.publisherDisplayName ||
  fileConfig.publisherDisplay ||
  "ANSNEW TECH.";

let manifest = fs.readFileSync(templatePath, "utf8");
manifest = manifest
  .replaceAll("__VERSION_QUAD__", toVersionQuad(names.version))
  .replaceAll("__EXE_NAME__", mainExe)
  .replaceAll("__DISPLAY_NAME__", displayName)
  .replaceAll("__DESCRIPTION__", description)
  .replaceAll("__IDENTITY_NAME__", identityName)
  .replaceAll("__PUBLISHER__", publisher)
  .replaceAll("__PUBLISHER_DISPLAY__", publisherDisplay);
fs.writeFileSync(path.join(layout, "AppxManifest.xml"), manifest);
console.log(`[yx-dist] MSIX package identity:
  Display Name:     ${displayName}
  Identity Name:    ${identityName}
  Publisher:        ${publisher}
  PublisherDisplay: ${publisherDisplay}`);

const makeappx = requireMakeAppx();
ensureDist();
const msixPath = path.join(DIST_DIR, names.msix);
if (fs.existsSync(msixPath)) fs.unlinkSync(msixPath);

console.log(`[yx-dist] Packing MSIX with ${makeappx}`);
const pack = spawnSync(
  makeappx,
  ["pack", "/d", layout, "/p", msixPath, "/o"],
  { stdio: "inherit" },
);
if (pack.status !== 0 || !fs.existsSync(msixPath)) {
  throw new Error("MakeAppx pack failed");
}

// Sign: use YX_MSIX_PFX, or auto-create a local sideload cert when YX_MSIX_AUTO_SIGN=1
let pfx = process.env.YX_MSIX_PFX;
let pfxPass = process.env.YX_MSIX_PFX_PASSWORD || "";

if ((!pfx || !fs.existsSync(pfx)) && process.env.YX_MSIX_AUTO_SIGN === "1") {
  const autoDir = path.join(BUILD_DIR, "msix-cert");
  fs.mkdirSync(autoDir, { recursive: true });
  pfx = path.join(autoDir, "project-yx-dev.pfx");
  pfxPass = pfxPass || "project-yx-dev";
  if (!fs.existsSync(pfx)) {
    console.log("[yx-dist] Creating local self-signed cert for MSIX sideload…");
    const ps = `
$ErrorActionPreference = 'Stop'
$cert = New-SelfSignedCertificate -Type Custom -Subject '${publisher.replace(/'/g, "''")}' -KeyUsage DigitalSignature -FriendlyName 'Project YX Dev' -CertStoreLocation 'Cert:\\CurrentUser\\My' -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3','2.5.29.19={text}')
$pwd = ConvertTo-SecureString -String '${pfxPass.replace(/'/g, "''")}' -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath '${pfx.replace(/'/g, "''")}' -Password $pwd | Out-Null
`;
    const c = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], {
      stdio: "inherit",
    });
    if (c.status !== 0 || !fs.existsSync(pfx)) {
      console.warn("[yx-dist] WARN: auto cert creation failed; MSIX left unsigned");
      pfx = null;
    }
  }
}

if (pfx && fs.existsSync(pfx)) {
  const signtool = findSignTool();
  if (!signtool) {
    console.warn("[yx-dist] WARN: signtool.exe not found; MSIX left unsigned");
  } else {
    const args = ["sign", "/fd", "SHA256", "/a", "/f", pfx];
    if (pfxPass) args.push("/p", pfxPass);
    args.push(msixPath);
    const s = spawnSync(signtool, args, { stdio: "inherit" });
    if (s.status !== 0) {
      console.warn("[yx-dist] WARN: MSIX signing failed; package remains unsigned");
    } else {
      console.log("[yx-dist] MSIX signed");
    }
  }
} else {
  console.log(
    "[yx-dist] MSIX unsigned. For sideload: YX_MSIX_AUTO_SIGN=1. For Store: set YX_MSIX_PUBLISHER + YX_MSIX_PFX from Partner Center.",
  );
}

if (!fs.existsSync(msixPath)) {
  throw new Error(`MSIX output missing: ${msixPath}`);
}
console.log(`[yx-dist] → dist/${names.msix}`);
console.log("[yx-dist] MSIX packaging finished");

