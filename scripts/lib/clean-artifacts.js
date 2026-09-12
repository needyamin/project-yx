/**
 * Shared clean helper for dist scripts (never deletes source).
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT, DIST_DIR, BUILD_DIR } from "./paths.js";

function rmrf(dir) {
  if (!fs.existsSync(dir)) {
    console.log(`[yx-dist] skip (missing): ${path.relative(ROOT, dir)}`);
    return;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`[yx-dist] removed ${path.relative(ROOT, dir)}`);
}

/** Wipe dist/, build/, and Vite apps/desktop/dist only. */
export function cleanReleaseArtifacts() {
  const safe = [
    path.resolve(DIST_DIR),
    path.resolve(BUILD_DIR),
    path.resolve(ROOT, "apps", "desktop", "dist"),
  ];
  for (const target of safe) {
    if (target === path.resolve(ROOT)) {
      throw new Error("Refusing to delete repository root");
    }
    rmrf(target);
  }
}
