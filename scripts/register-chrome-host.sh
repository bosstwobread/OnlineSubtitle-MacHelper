#!/bin/bash
set -euo pipefail
umask 077

if [[ $# -ne 0 || "$(/usr/bin/uname -s)" != Darwin ]]; then
    echo 'Usage on macOS: scripts/register-chrome-host.sh' >&2
    exit 2
fi

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
host_name='com.nelson007.online_subtitle'
extension_origin='chrome-extension://ndmbmmhddeibbojclldpaabmkcielfmj/'
support_directory="$HOME/Library/Application Support/OnlineSubtitle-MacHelper"
manifest_directory="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
binary="$support_directory/OnlineSubtitleChromeHost"

if [[ -L "$support_directory" || -e "$support_directory" && ! -O "$support_directory" ]]; then
    echo 'The OnlineSubtitle support directory must be owned by the current user.' >&2
    exit 1
fi
/bin/mkdir -p "$support_directory" "$manifest_directory"
/bin/chmod 700 "$support_directory"
binary_temporary="$(/usr/bin/mktemp "$support_directory/.host.XXXXXXXX")"
manifest_temporary=''
trap '/bin/rm -f -- "$binary_temporary" ${manifest_temporary:+"$manifest_temporary"}' EXIT

target="$(/usr/bin/uname -m)-apple-macosx14.0"
/usr/bin/xcrun swiftc -O -target "$target" "$project_root/NativeHost/main.swift" -o "$binary_temporary"
/bin/chmod 700 "$binary_temporary"
manifest_temporary="$(/usr/bin/mktemp "$manifest_directory/.online-subtitle.XXXXXXXX")"
/usr/bin/plutil -create xml1 "$manifest_temporary"
/usr/bin/plutil -insert name -string "$host_name" "$manifest_temporary"
/usr/bin/plutil -insert description -string 'OnlineSubtitle MacHelper caption bridge' "$manifest_temporary"
/usr/bin/plutil -insert path -string "$binary" "$manifest_temporary"
/usr/bin/plutil -insert type -string stdio "$manifest_temporary"
/usr/bin/plutil -insert allowed_origins -json "[\"$extension_origin\"]" "$manifest_temporary"
/usr/bin/plutil -convert json "$manifest_temporary"

/bin/mv -f -h -- "$binary_temporary" "$binary"
/bin/mv -f -h -- "$manifest_temporary" "$manifest_directory/$host_name.json"
echo 'Registered the OnlineSubtitle native host for Google Chrome.'
