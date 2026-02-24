#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Lempicka Smart Sync"
BUNDLE_ID="com.lempicka.smartsync"
VERSION="$(node -p "require('$ROOT_DIR/package.json').version")"
DIST_DIR="$ROOT_DIR/dist"
BUILD_DIR="$ROOT_DIR/build"
SRC_ELECTRON_APP="$ROOT_DIR/node_modules/electron/dist/Electron.app"
TARGET_APP="$DIST_DIR/$APP_NAME.app"
ICON_ICNS="$BUILD_DIR/icon.icns"

if [[ ! -d "$SRC_ELECTRON_APP" ]]; then
  echo "Electron runtime not found at $SRC_ELECTRON_APP. Run npm install first." >&2
  exit 1
fi

if [[ ! -f "$ICON_ICNS" ]]; then
  bash "$ROOT_DIR/scripts/build-mac-icon.sh"
fi

if [[ ! -f "$ICON_ICNS" ]]; then
  echo "Missing icon file: $ICON_ICNS" >&2
  exit 1
fi

mkdir -p "$DIST_DIR"
rm -rf "$TARGET_APP"
cp -R "$SRC_ELECTRON_APP" "$TARGET_APP"

EXEC_DIR="$TARGET_APP/Contents/MacOS"
RES_DIR="$TARGET_APP/Contents/Resources"
INFO_PLIST="$TARGET_APP/Contents/Info.plist"

set_or_add_plist_value() {
  local key="$1"
  local type="$2"
  local value="$3"
  if ! /usr/libexec/PlistBuddy -c "Set :$key $value" "$INFO_PLIST" >/dev/null 2>&1; then
    /usr/libexec/PlistBuddy -c "Add :$key $type $value" "$INFO_PLIST"
  fi
}

mv "$EXEC_DIR/Electron" "$EXEC_DIR/$APP_NAME"
cp "$ICON_ICNS" "$RES_DIR/icon.icns"

set_or_add_plist_value "CFBundleDisplayName" "string" "$APP_NAME"
set_or_add_plist_value "CFBundleName" "string" "$APP_NAME"
set_or_add_plist_value "CFBundleExecutable" "string" "$APP_NAME"
set_or_add_plist_value "CFBundleIdentifier" "string" "$BUNDLE_ID"
set_or_add_plist_value "CFBundleIconFile" "string" "icon.icns"
set_or_add_plist_value "CFBundleIconName" "string" "icon"
set_or_add_plist_value "CFBundleShortVersionString" "string" "$VERSION"
set_or_add_plist_value "CFBundleVersion" "string" "$VERSION"

APP_CONTENT_DIR="$RES_DIR/app"
rm -rf "$APP_CONTENT_DIR"
mkdir -p "$APP_CONTENT_DIR"

cp -R "$ROOT_DIR/src" "$APP_CONTENT_DIR/src"

cat > "$APP_CONTENT_DIR/package.json" <<EOF
{
  "name": "lempicka-smart-sync",
  "productName": "$APP_NAME",
  "version": "$VERSION",
  "main": "src/main.js"
}
EOF

echo "Built standalone app:"
echo "  $TARGET_APP"

if [[ "${1:-}" == "--zip" ]]; then
  ZIP_PATH="$DIST_DIR/$APP_NAME-$VERSION-mac.zip"
  rm -f "$ZIP_PATH"
  ditto -c -k --sequesterRsrc --keepParent "$TARGET_APP" "$ZIP_PATH"
  echo "Built zip:"
  echo "  $ZIP_PATH"
fi
