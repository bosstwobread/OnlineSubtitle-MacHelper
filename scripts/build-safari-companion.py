#!/usr/bin/env python3
"""Generate the macOS Safari containing-app project from OnlineSubtitle sources."""

import argparse
import json
import plistlib
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SAFARI_SOURCE = ROOT / "BrowserCompanions/Safari"
APP_NAME = "OnlineSubtitle"
APP_TARGET = Path(APP_NAME)
EXTENSION_TARGET = Path(f"{APP_NAME} Extension")
APP_ID = "com.nelson007.online-subtitle"
EXTENSION_ID = APP_ID + ".safari"
DEFAULT_APP_GROUP = "group.com.nelson007.online-subtitle"
APP_GROUP_SETTING = "OnlineSubtitleRelayGroup"
RELAY_SOURCES = ("CompanionBrokerClient.swift", "SafariCompanionRelay.swift")


def project_settings(project):
    for name in ("project.xcproj", "project.pbxproj"):
        candidate = project / name
        if candidate.is_file():
            return candidate
    raise ValueError("Safari's packager did not create a supported Xcode project")


def configure_targets(settings, version):
    text = settings.read_text(encoding="utf-8")
    # The converter can capitalize the containing-app ID. Set the
    # exact container and extension identifiers used by MacHelper.
    bundle_pattern = (
        r'(?m)^(?P<indent>\s*)"?PRODUCT_BUNDLE_IDENTIFIER"?(?P<separator>\s*[:=]\s*)'
        r'"?com\.nelson007\.(?:online-subtitle|OnlineSubtitle)(?P<extension>\.Extension)?'
        r'"?(?P<ending>[;,])'
    )
    counts = {"app": 0, "extension": 0}

    def bundle_settings(match):
        extension = bool(match["extension"])
        counts["extension" if extension else "app"] += 1
        separator, indent, ending = match["separator"], match["indent"], match["ending"]
        target = EXTENSION_TARGET if extension else APP_TARGET
        identifier = EXTENSION_ID if extension else APP_ID
        quote = '"' if ":" in separator else ""
        fields = {
            "PRODUCT_BUNDLE_IDENTIFIER": identifier,
            "CODE_SIGN_ENTITLEMENTS": str(target / "SafariRelay.entitlements"),
        }
        return "\n".join(f'{indent}{quote}{key}{quote}{separator}"{value}"{ending}'
                         for key, value in fields.items())

    text = re.sub(bundle_pattern, bundle_settings, text)
    if not all(counts.values()):
        raise ValueError("Safari's containing-app and extension identifiers could not be set")

    # Separate build-configuration objects in both Xcode project formats.
    # The Safari extension stays sandboxed. Its Developer ID containing app
    # needs the normal app-to-app Unix connection to MacHelper.
    has_app_target = re.compile(r'(?<![.\w])' + re.escape(APP_ID) + r'(?![.\w])')
    settings_block = r'((?:"build-settings"\s*:|buildSettings\s*=)\s*\{[^{}]*\})'
    configurations = 0

    def set_relay_sandbox(match):
        nonlocal configurations
        block = match[1]
        if not has_app_target.search(block):
            return block
        block, count = re.subn(r'(ENABLE_APP_SANDBOX"?\s*[:=]\s*"?)YES(?=[";\s])', r'\g<1>NO', block)
        configurations += count
        return block

    text = re.sub(settings_block, set_relay_sandbox, text)
    if configurations != counts["app"]:
        raise ValueError("Safari's containing-app App Group relay setup could not be configured")
    text = re.sub(r'(MACOSX_DEPLOYMENT_TARGET"?\s*[:=]\s*"?)\d+(?:\.\d+)+', r'\g<1>14.0', text)
    text = re.sub(r'(MARKETING_VERSION"?\s*[:=]\s*"?)\d+(?:\.\d+)+', lambda match: match[1] + version, text)
    text = re.sub(r'(?m)^\s*"?SWIFT_DEFAULT_ACTOR_ISOLATION"?\s*[:=][^\n]*\n', "\n", text)
    settings.write_text(text, encoding="utf-8")


def write_native_source(app, app_group):
    for target, sandboxed, entry in (
        (APP_TARGET, False, "AppDelegate.swift"),
        (EXTENSION_TARGET, True, "SafariWebExtensionHandler.swift"),
    ):
        folder = app / target
        info_path = folder / "Info.plist"
        with info_path.open("rb") as info_file:
            info = plistlib.load(info_file)
        info[APP_GROUP_SETTING] = app_group
        with info_path.open("wb") as info_file:
            plistlib.dump(info, info_file)
        entitlements = {"com.apple.security.application-groups": [app_group]}
        if sandboxed:
            entitlements["com.apple.security.app-sandbox"] = True
        with (folder / "SafariRelay.entitlements").open("wb") as entitlements_file:
            plistlib.dump(entitlements, entitlements_file)
        adapter = "SafariWebExtensionHandler.swift" if sandboxed else "SafariRelayContainer.swift"
        # Replace the converter's credited sample entry in the existing
        # target. Keeping its membership works with both project formats.
        sources = RELAY_SOURCES + (adapter,)
        destination = folder / entry
        if not destination.is_file():
            raise ValueError(f"Safari's generated source file {entry} could not be found")
        destination.write_text("\n".join((SAFARI_SOURCE / name).read_text(encoding="utf-8") for name in sources),
                               encoding="utf-8")


def generate(output, app_group):
    if sys.platform != "darwin":
        raise ValueError("Safari's packager requires macOS and Xcode")
    if output.exists() and any(output.iterdir()):
        raise ValueError("the output directory must be empty")
    if not re.fullmatch(r"(?:group|[A-Z0-9]{10})\.[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)+", app_group) or len(app_group) > 128:
        raise ValueError("the App Group must use the group. or macOS team identifier prefix")
    output.mkdir(parents=True, exist_ok=True)
    packager = "safari-web-extension-packager"
    result = subprocess.run(["xcrun", "--find", packager], capture_output=True)
    if result.returncode != 0:
        packager = "safari-web-extension-converter"
    with tempfile.TemporaryDirectory(prefix="online-subtitle-webextension-") as temp:
        web_extensions = Path(temp)
        subprocess.run([sys.executable, str(ROOT / "scripts/build-browser-companions.py"), "--output", str(web_extensions)],
                       check=True)
        subprocess.run(["xcrun", packager, "--macos-only", "--app-name", APP_NAME,
                        "--bundle-identifier", APP_ID, "--swift", "--copy-resources", "--no-open",
                        "--no-prompt", "--project-location", str(output), str(web_extensions / "safari")], check=True)
    app = output / APP_NAME
    project = app / f"{APP_NAME}.xcodeproj"
    version = json.loads((ROOT / "MacHelperExtension/extension.json").read_bytes())["version"]
    configure_targets(project_settings(project), version)
    write_native_source(app, app_group)
    view_controller = app / APP_TARGET / "ViewController.swift"
    if view_controller.is_file():
        # The template normally quits its setup-only app when opening Safari
        # Settings. Keep the relay alive after handing the user to Safari.
        text = view_controller.read_text(encoding="utf-8")
        text = text.replace(f'"{APP_ID}.Extension"', f'"{EXTENSION_ID}"')
        text = text.replace('NSApplication.shared.terminate(nil)', 'if error == nil { NSApplication.shared.hide(nil) }')
        view_controller.write_text(text, encoding="utf-8")
    for name in ("Script.js", "Base.lproj/Main.html"):
        resource = app / APP_TARGET / "Resources" / name
        if resource.is_file():
            text = resource.read_text(encoding="utf-8")
            resource.write_text(text.replace("Quit and Open Safari", "Open Safari"), encoding="utf-8")
    icon = app / APP_TARGET / "Resources/Icon.png"
    if icon.is_file():
        icon.write_bytes((ROOT / "Chrome/icons/icon-128.png").read_bytes())
    return project


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="new or empty project directory")
    parser.add_argument("--app-group", default=DEFAULT_APP_GROUP, help="App Group identifier registered for your signing team")
    args = parser.parse_args()
    try:
        project = generate(args.output.resolve(), args.app_group)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Safari companion project build failed: {error}\n")
    print(f"Generated Safari companion project at {project}")


if __name__ == "__main__":
    main()
