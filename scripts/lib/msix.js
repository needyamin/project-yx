import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function sdkRoots() {
  const roots = [];
  const envRoot = process.env.WindowsSdkDir || process.env.WINDOWSSDKDIR;
  if (envRoot) roots.push(envRoot);

  const kitRoot = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
  if (fs.existsSync(kitRoot)) {
    const versions = fs
      .readdirSync(kitRoot)
      .filter((d) => /^\d+\./.test(d))
      .sort()
      .reverse();
    for (const ver of versions) {
      roots.push(path.join(kitRoot, ver, "x64"));
      roots.push(path.join(kitRoot, ver, "x86"));
    }
  }
  return roots;
}

export function findMakeAppx() {
  if (process.env.MAKEAPPX && fs.existsSync(process.env.MAKEAPPX)) {
    return process.env.MAKEAPPX;
  }
  for (const root of sdkRoots()) {
    const candidate = path.join(root, "makeappx.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  const where = spawnSync("where.exe", ["makeappx.exe"], {
    encoding: "utf8",
    shell: true,
  });
  if (where.status === 0) {
    const line = (where.stdout || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (line && fs.existsSync(line)) return line;
  }
  return null;
}

export function findSignTool() {
  for (const root of sdkRoots()) {
    const candidate = path.join(root, "signtool.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function requireMakeAppx() {
  const tool = findMakeAppx();
  if (!tool) {
    throw new Error(
      [
        "ERROR: Required MSIX packaging tools were not found.",
        "",
        "Install the Windows SDK with MSIX packaging support",
        "(MakeAppx.exe).",
        "",
        "https://developer.microsoft.com/windows/downloads/windows-sdk/",
      ].join("\n"),
    );
  }
  return tool;
}
