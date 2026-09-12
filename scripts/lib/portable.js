import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { BUILD_DIR, ROOT, ensureBuild, releaseDir, TAURI_DIR } from "./paths.js";
import { findIscc, runIscc } from "./inno.js";
import { getVersion } from "./version.js";

/**
 * Collect runnable app files into a staging folder (no installer).
 */
export function stagePortableApp(stagingDir) {
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  const rel = releaseDir();
  if (!fs.existsSync(rel)) {
    throw new Error(`Release directory not found: ${rel}`);
  }

  const skip = new Set([
    "build",
    "deps",
    "examples",
    "incremental",
    ".fingerprint",
    "bundle",
    "wix",
  ]);

  const copyFile = (src, dest) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  };

  const copyDir = (src, dest) => {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const from = path.join(src, entry.name);
      const to = path.join(dest, entry.name);
      if (entry.isDirectory()) copyDir(from, to);
      else copyFile(from, to);
    }
  };

  // Main binary + adjacent runtime files (exclude bulky cargo intermediates)
  for (const entry of fs.readdirSync(rel, { withFileTypes: true })) {
    const name = entry.name;
    const lower = name.toLowerCase();
    if (skip.has(name)) continue;
    if (entry.isDirectory()) {
      if (name === "resources") {
        copyDir(path.join(rel, name), path.join(stagingDir, name));
      }
      continue;
    }
    if (lower.endsWith(".pdb")) continue;
    if (lower.endsWith(".d") || lower.endsWith(".rlib") || lower.endsWith(".rmeta")) continue;
    if (lower.includes("setup")) continue;
    // Keep exe, dll, json resources that sit beside the binary
    if (
      lower.endsWith(".exe")
      || lower.endsWith(".dll")
      || lower.endsWith(".json")
      || lower.endsWith(".pak")
      || lower.endsWith(".dat")
      || lower.endsWith(".bin")
    ) {
      copyFile(path.join(rel, name), path.join(stagingDir, name));
    }
  }

  // README for portable users
  const readme = `Project YX — Portable

Extract all files and run yx-desktop.exe (or Project YX.exe).

Requirements:
- Windows 10/11 with WebView2 (usually preinstalled)
- FFmpeg and ffprobe available on PATH for import/export

This build does not install to Program Files and does not require an installer.
`;
  fs.writeFileSync(path.join(stagingDir, "README-PORTABLE.txt"), readme);

  const files = fs.readdirSync(stagingDir);
  if (!files.some((f) => f.toLowerCase().endsWith(".exe"))) {
    throw new Error(`Portable staging has no .exe under ${stagingDir}`);
  }
  return stagingDir;
}

/** Create a zip using PowerShell Compress-Archive (Windows) or `tar` elsewhere. */
export function zipDirectory(sourceDir, zipPath) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  if (process.platform === "win32") {
    // Compress-Archive needs the path without trailing slash; use -Path contents
    const ps = `
$ErrorActionPreference = 'Stop'
Compress-Archive -Path (Join-Path '${sourceDir.replace(/'/g, "''")}' '*') -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force
`;
    const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], {
      stdio: "inherit",
    });
    if (r.status !== 0) throw new Error("Compress-Archive failed");
    return zipPath;
  }

  const r = spawnSync("tar", ["-a", "-cf", zipPath, "-C", sourceDir, "."], {
    stdio: "inherit",
  });
  if (r.status !== 0) {
    throw new Error("tar zip failed — install tar or run on Windows");
  }
  return zipPath;
}

function findSevenZip() {
  const candidates = [
    process.env.SEVEN_ZIP,
    "C:\\Program Files\\7-Zip\\7z.exe",
    "C:\\Program Files (x86)\\7-Zip\\7z.exe",
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Build a portable EXE (self-extractor).
 * Prefers Inno Setup (installed on this machine), then 7-Zip SFX, then IExpress.
 */
export function createPortableExe(stagingDir, exePath) {
  ensureBuild();
  if (fs.existsSync(exePath)) fs.unlinkSync(exePath);

  const iscc = findIscc();
  if (iscc) {
    const mainExe =
      fs.readdirSync(stagingDir).find((f) => {
        const lower = f.toLowerCase();
        return lower.endsWith(".exe") && !lower.includes("setup");
      }) || "yx-desktop.exe";
    const outputBase = path.basename(exePath, path.extname(exePath));
    const iss = path.join(ROOT, "installer", "portable.iss");
    runIscc(iscc, iss, {
      MyAppVersion: getVersion(),
      MyAppSourceDir: stagingDir,
      MyAppOutputDir: path.dirname(exePath),
      MyAppOutputBase: outputBase,
      MyAppExeName: mainExe,
      MyAppIcon: iconIcoPath(),
    });
    if (!fs.existsSync(exePath)) {
      throw new Error(`Inno portable output missing: ${exePath}`);
    }
    console.log(`[yx-dist] Portable EXE via Inno Setup → ${exePath}`);
    return exePath;
  }

  const seven = findSevenZip();
  if (seven) {
    const archive = path.join(BUILD_DIR, "portable-payload.7z");
    if (fs.existsSync(archive)) fs.unlinkSync(archive);
    const r = spawnSync(seven, ["a", "-t7z", archive, `${stagingDir}${path.sep}*`], {
      stdio: "inherit",
    });
    if (r.status !== 0) throw new Error("7-Zip archive creation failed");

    const sfxModule = [
      path.join(path.dirname(seven), "7z.sfx"),
      path.join(path.dirname(seven), "7zSD.sfx"),
    ].find((p) => fs.existsSync(p));

    if (sfxModule) {
      const config = path.join(BUILD_DIR, "portable-sfx.txt");
      fs.writeFileSync(
        config,
        `;!@Install@!UTF-8!\nTitle="Project YX Portable"\nBeginPrompt="Extract Project YX portable files?"\nExtractDialogText="Extracting…"\nGUIMode="1"\n;!@InstallEnd@!\n`,
      );
      const out = fs.openSync(exePath, "w");
      for (const part of [sfxModule, config, archive]) {
        fs.writeSync(out, fs.readFileSync(part));
      }
      fs.closeSync(out);
      console.log(`[yx-dist] Portable SFX via 7-Zip → ${exePath}`);
      return exePath;
    }
  }

  if (process.platform === "win32") {
    return createIExpressSfx(stagingDir, exePath);
  }

  throw new Error(
    [
      "ERROR: Could not create Project-YX-*-Portable.exe",
      "",
      "Install Inno Setup 6 (ISCC.exe) or 7-Zip (with 7z.sfx).",
      "",
      "The portable ZIP artifact can still be used: extract and run the app EXE.",
    ].join("\n"),
  );
}

function createIExpressSfx(stagingDir, exePath) {
  const sedPath = path.join(BUILD_DIR, "portable.sed");
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  }
  walk(stagingDir);
  if (!files.length) throw new Error("No files to pack for IExpress");

  // Flatten to avoid nested-path SED issues
  const flat = path.join(BUILD_DIR, "portable-flat");
  fs.rmSync(flat, { recursive: true, force: true });
  fs.mkdirSync(flat, { recursive: true });
  for (const f of files) {
    const base = path.basename(f);
    let destName = base;
    let n = 1;
    while (fs.existsSync(path.join(flat, destName))) {
      destName = `${path.parse(base).name}_${n}${path.parse(base).ext}`;
      n += 1;
    }
    fs.copyFileSync(f, path.join(flat, destName));
  }

  const flatFiles = fs.readdirSync(flat);
  const sed2 = `[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=ExtractOnly
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
TargetName=${exePath}
FriendlyName=Project YX Portable
AppLaunched=
PostInstallCmd=<None>
SourceFiles=SourceFiles
[SourceFiles]
SourceFiles0=${flat}
[SourceFiles0]
${flatFiles.map((f) => `%${f}%=${f}`).join("\r\n")}
`;
  fs.writeFileSync(sedPath, sed2);

  const r = spawnSync("iexpress.exe", ["/N", "/Q", sedPath], {
    stdio: "inherit",
  });
  if (r.status !== 0 || !fs.existsSync(exePath)) {
    throw new Error(
      [
        "ERROR: IExpress failed to create the portable EXE.",
        "",
        "Install Inno Setup 6 or 7-Zip (https://www.7-zip.org/).",
        "",
        "The portable ZIP artifact can still be used: extract and run the app EXE.",
      ].join("\n"),
    );
  }
  console.log(`[yx-dist] Portable SFX via IExpress → ${exePath}`);
  return exePath;
}

export function portableStagingPath() {
  return path.join(BUILD_DIR, "portable-staging");
}

export function iconIcoPath() {
  return path.join(TAURI_DIR, "icons", "icon.ico");
}
