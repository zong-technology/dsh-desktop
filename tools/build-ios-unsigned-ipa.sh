#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="${1:-$ROOT/dist/DeskBoxMobile-unsigned.ipa}"
if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "A macOS machine with Xcode and the iPhoneOS SDK is required." >&2
  exit 1
fi
if [ -e "$OUTPUT" ]; then
  echo "Output already exists; choose another output path: $OUTPUT" >&2
  exit 1
fi
WORK="$(mktemp -d "${TMPDIR:-/tmp}/deskbox-ipa.XXXXXX")"
xcodebuild -project "$ROOT/mobile/DeskBoxMobile/DeskBoxMobile.xcodeproj" \
  -scheme DeskBoxMobile -configuration Release -sdk iphoneos \
  -destination 'generic/platform=iOS' -derivedDataPath "$WORK/derived" \
  ARCHS=arm64 ONLY_ACTIVE_ARCH=NO CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY= build
APP="$WORK/derived/Build/Products/Release-iphoneos/DeskBoxMobile.app"
test -d "$APP"
PLATFORM="$(/usr/libexec/PlistBuddy -c 'Print :DTPlatformName' "$APP/Info.plist")"
if [ "$PLATFORM" != "iphoneos" ]; then
  echo "Refusing to package a non-device application: $PLATFORM" >&2
  exit 1
fi
BINARY="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Info.plist")"
test -f "$APP/$BINARY"
xcrun lipo "$APP/$BINARY" -verify_arch arm64
mkdir -p "$WORK/package/Payload" "$(dirname "$OUTPUT")"
ditto "$APP" "$WORK/package/Payload/DeskBoxMobile.app"
ditto -c -k --keepParent "$WORK/package/Payload" "$OUTPUT"
unzip -Z1 "$OUTPUT" | grep -Fx "Payload/DeskBoxMobile.app/$BINARY"
shasum -a 256 "$OUTPUT"
echo "Unsigned iPhoneOS IPA: $OUTPUT"
echo "Build working directory: $WORK"

