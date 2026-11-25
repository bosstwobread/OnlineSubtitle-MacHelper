#!/usr/bin/env python3
"""Build unpacked OnlineSubtitle browser companions and MacHelper verification inventories."""

import argparse
import base64
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FEATURE_SOURCE = ROOT / "Chrome"
MANAGED_SOURCE = ROOT / "BrowserCompanions"
YOUTUBE = "https://www.youtube.com/*"
FIREFOX_ID = "online-subtitle@nelson007.com"


def json_bytes(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def feature_files(manifest):
    paths = {
        name
        for entry in manifest["content_scripts"]
        for key in ("js", "css")
        for name in entry.get(key, ())
    }
    paths.update(manifest["icons"].values())
    paths.update(f"_locales/{path.parent.name}/messages.json" for path in FEATURE_SOURCE.glob("_locales/*/messages.json"))
    paths.add("background.js")
    return {name: (FEATURE_SOURCE / name).read_bytes() for name in sorted(paths)}


def build(browser, files, base_manifest, version):
    manifest = dict(base_manifest, version=version)
    files = dict(files)
    files["managed-transport.js"] = (MANAGED_SOURCE / "managed-transport.js").read_bytes()
    if browser in ("chrome", "edge"):
        manifest["background"] = {"service_worker": "managed-background.js"}
        files["managed-background.js"] = (MANAGED_SOURCE / "managed-background.js").read_bytes()
    else:
        manifest.pop("key")
        manifest.pop("minimum_chrome_version")
        manifest["host_permissions"] = [YOUTUBE]
        manifest["background"] = {"scripts": ["managed-transport.js", "background.js"]}
        if browser == "firefox":
            manifest["browser_specific_settings"] = {
                "gecko": {
                    "id": FIREFOX_ID,
                    "strict_min_version": "140.0",
                    "data_collection_permissions": {"required": ["websiteContent"]},
                },
            }
        else:
            manifest["browser_specific_settings"] = {"safari": {"strict_min_version": "18.0"}}
            manifest["background"]["scripts"].insert(0, "browser-flags.js")
            files["browser-flags.js"] = (MANAGED_SOURCE / "Safari/browser-flags.js").read_bytes()
    return dict(files, **{"manifest.json": json_bytes(manifest)})


def write_browser(folder, files):
    folder.mkdir()
    for name, data in files.items():
        path = folder / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


def write_inventory(path, files):
    package = {"schemaVersion": 1, "files": {name: base64.b64encode(files[name]).decode("ascii") for name in sorted(files)}}
    path.write_bytes(json_bytes(package))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="new or empty output directory")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        parser.error("the output directory must be empty")
    base_manifest = json.loads((FEATURE_SOURCE / "manifest.json").read_bytes())
    version = json.loads((ROOT / "MacHelperExtension/extension.json").read_bytes())["version"]
    features = feature_files(base_manifest)
    for browser in ("chrome", "edge", "firefox", "safari"):
        files = build(browser, features, base_manifest, version)
        write_browser(output / browser, files)
        if browser == "chrome":
            write_inventory(output / "chromium-companion.json", files)
        if browser == "firefox":
            write_inventory(output / "firefox-companion.json", files)
    print(f"Built browser companions in {output}")


if __name__ == "__main__":
    main()
