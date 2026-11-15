#!/bin/bash
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
source_dir="$repo_dir/integrations/pi-web/macos"
app_dir="${1:-$repo_dir/dist/Pi Web.app}"
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'The launcher build requires macOS and Xcode Command Line Tools.' >&2
  exit 1
fi
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
mkdir -p "$app_dir/Contents/MacOS" "$app_dir/Contents/Resources"
xcrun swiftc -O "$source_dir/PiWeb.swift" -o "$app_dir/Contents/MacOS/PiWeb"
xcrun swift "$source_dir/icon.swift" "$temp_dir/PiWeb.iconset"
iconutil -c icns "$temp_dir/PiWeb.iconset" -o "$app_dir/Contents/Resources/PiWeb.icns"
cp "$source_dir/Info.plist" "$app_dir/Contents/Info.plist"
cp "$source_dir/PiWeb.swift" "$app_dir/Contents/Resources/PiWeb.swift"
codesign --force --deep --sign - "$app_dir"
printf 'Built %s\n' "$app_dir"
