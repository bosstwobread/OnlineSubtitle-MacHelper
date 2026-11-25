#!/bin/bash
set -euo pipefail

if [[ $# -ne 1 || "$(/usr/bin/uname -s)" != Darwin ]]; then
    echo 'Usage on macOS: scripts/build-worker.sh OUTPUT' >&2
    exit 2
fi

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
source_folder="$project_root/MacHelperExtension"
output_folder="$(cd -- "$(dirname -- "$1")" && pwd -P)"
if [[ "$output_folder/" == "$source_folder/"* ]]; then
    echo 'Choose an output path outside MacHelperExtension.' >&2
    exit 2
fi
output="$output_folder/$(basename -- "$1")"

sdk="${MACHELPER_NATIVE_SDK:-}"
if [[ -z "$sdk" ]]; then
    for app in "$HOME/Applications/LocalAIBaseTools/MacHelper.app" "$HOME/Applications/MacHelper.app" \
        "/Applications/LocalAIBaseTools/MacHelper.app" "/Applications/MacHelper.app"; do
        candidate="$app/Contents/Resources/NativeExtensionSDK/MacHelperNativeSDK.swift"
        if [[ -f "$candidate" && -r "$candidate" ]]; then
            sdk="$candidate"
            break
        fi
    done
fi
if [[ ! -f "$sdk" || ! -r "$sdk" ]]; then
    echo 'Install MacHelper or set MACHELPER_NATIVE_SDK to its shipped MacHelperNativeSDK.swift.' >&2
    exit 1
fi

cache="$(/usr/bin/mktemp -d /tmp/online-subtitle-swift.XXXXXXXX)"
trap '/bin/rm -rf -- "$cache"' EXIT
/usr/bin/xcrun swiftc -parse-as-library -swift-version 5 \
    -target "$(/usr/bin/uname -m)-apple-macosx14.0" -module-cache-path "$cache" \
    "$sdk" "$source_folder/Main.swift" -o "$output"
