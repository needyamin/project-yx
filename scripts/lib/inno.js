import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const COMMON_ISCC = [
  process.env.ISCC,
  process.env.INNO_SETUP_ISCC,
  "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
  "C:\\Program Files\\Inno Setup 6\\ISCC.exe",
  "C:\\Program Files (x86)\\Inno Setup 5\\ISCC.exe",
  "C:\\Program Files\\Inno Setup 5\\ISCC.exe",
  path.join(process.env.LOCALAPPDATA || "", "Programs", "Inno Setup 6", "ISCC.exe"),
  path.join(process.env.LOCALAPPDATA || "", "Programs", "Inno Setup 5", "ISCC.exe"),
].filter(Boolean);

export function findIscc() {
  for (const candidate of COMMON_ISCC) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const where = spawnSync("where.exe", ["ISCC.exe"], { encoding: "utf8" });
  if (where.status === 0) {
    const line = (where.stdout || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    if (line && fs.existsSync(line)) return line;
  }
  return null;
}

export function requireIscc() {
  const iscc = findIscc();
  if (!iscc) {
    throw new Error(
      [
        "ERROR: Inno Setup was not found.",
        "",
        "Install Inno Setup 6 and make sure ISCC.exe is available.",
        "",
        "Download:",
        "https://jrsoftware.org/isinfo.php",
      ].join("\n"),
    );
  }
  return iscc;
}

export function runIscc(iscc, issPath, defines = {}) {
  const args = [];
  for (const [k, v] of Object.entries(defines)) {
    args.push(`/D${k}=${v}`);
  }
  args.push(issPath);
  console.log(`[yx-dist] Running ${iscc} ${args.join(" ")}`);
  const r = spawnSync(iscc, args, { stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error(`Inno Setup compiler failed (exit ${r.status ?? 1})`);
  }
}
