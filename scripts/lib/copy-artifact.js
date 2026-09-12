import fs from "node:fs";
import path from "node:path";
import { DIST_DIR, ensureDist } from "./paths.js";

export function copyToDist(srcPath, destName) {
  ensureDist();
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Source artifact missing: ${srcPath}`);
  }
  const dest = path.join(DIST_DIR, destName);
  fs.copyFileSync(srcPath, dest);
  console.log(`[yx-dist] → dist/${destName}`);
  return dest;
}

export function writeToDist(destName, contents) {
  ensureDist();
  const dest = path.join(DIST_DIR, destName);
  fs.writeFileSync(dest, contents);
  console.log(`[yx-dist] → dist/${destName}`);
  return dest;
}
