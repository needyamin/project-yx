#!/usr/bin/env bash
# Runs inside the Linux builder container.
set -euo pipefail

cd /workspace

echo "[yx-dist] Installing desktop npm dependencies…"
npm --prefix apps/desktop ci

echo "[yx-dist] Building Tauri AppImage…"
npm --prefix apps/desktop run tauri build -- --bundles appimage

VERSION="${YX_VERSION:-}"
if [[ -z "$VERSION" ]]; then
  VERSION="$(node -e "const fs=require('fs');const t=fs.readFileSync('Cargo.toml','utf8');const m=t.match(/\\[workspace\\.package\\][\\s\\S]*?version\\s*=\\s*\\\"([^\\\"]+)\\\"/);if(!m)process.exit(1);process.stdout.write(m[1])")"
fi

OUT_NAME="Project-YX-${VERSION}.AppImage"
mkdir -p /workspace/dist

# Prefer workspace target, then src-tauri target
CANDIDATES=(
  /workspace/target/release/bundle/appimage
  /workspace/apps/desktop/src-tauri/target/release/bundle/appimage
)

FOUND=""
for dir in "${CANDIDATES[@]}"; do
  if [[ -d "$dir" ]]; then
    FOUND="$(find "$dir" -maxdepth 1 -type f -iname '*.AppImage' | head -n 1 || true)"
    if [[ -n "$FOUND" ]]; then
      break
    fi
  fi
done

if [[ -z "$FOUND" ]]; then
  echo "ERROR: AppImage not found after build."
  exit 1
fi

cp -f "$FOUND" "/workspace/dist/${OUT_NAME}"
chmod +x "/workspace/dist/${OUT_NAME}"
echo "[yx-dist] Wrote dist/${OUT_NAME}"
