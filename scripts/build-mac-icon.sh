#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_ICON="$ROOT_DIR/src/renderer/img/lempicka-icon.png"
BUILD_DIR="$ROOT_DIR/build"
TMP_DIR="$BUILD_DIR/tmp"
WORK_DIR="$BUILD_DIR/icon.iconset"
SQUARE_PNG="$BUILD_DIR/lempicka-icon-square.png"
OUT_ICNS="$BUILD_DIR/icon.icns"

if [[ ! -f "$SRC_ICON" ]]; then
  echo "Missing source icon: $SRC_ICON" >&2
  exit 1
fi

mkdir -p "$BUILD_DIR"
mkdir -p "$TMP_DIR"
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

# Crop to a centered square, then generate macOS iconset and ICNS.
sips -c 369 369 "$SRC_ICON" --out "$SQUARE_PNG" >/dev/null

for size in 16 32 128 256 512; do
  sips -s format png -z "$size" "$size" "$SQUARE_PNG" --out "$WORK_DIR/icon_${size}x${size}.png" >/dev/null
  double_size=$((size * 2))
  sips -s format png -z "$double_size" "$double_size" "$SQUARE_PNG" --out "$WORK_DIR/icon_${size}x${size}@2x.png" >/dev/null
done

TMPDIR="$TMP_DIR" iconutil -c icns "$WORK_DIR" -o "$OUT_ICNS"
echo "Generated $OUT_ICNS"
