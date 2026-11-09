#!/usr/bin/env python3
"""Write latest.json for tauri-plugin-updater from a release's signed bundles
(Plan 098). Each updater bundle has a `.sig` next to it (built with
TAURI_SIGNING_PRIVATE_KEY and createUpdaterArtifacts).

  make_latest_json.py <assets dir> <version> <download base URL>
"""
import datetime, json, pathlib, sys

assets, version, base = pathlib.Path(sys.argv[1]), sys.argv[2].lstrip("v"), sys.argv[3].rstrip("/")
PLATFORMS = {".exe": "windows-x86_64", ".AppImage": "linux-x86_64"}
platforms = {}
for sig in sorted(assets.glob("*.sig")):
    bundle = sig.with_suffix("")
    plat = next((p for ext, p in PLATFORMS.items() if bundle.name.endswith(ext)), None)
    if plat and bundle.exists():
        platforms[plat] = {"signature": sig.read_text().strip(), "url": f"{base}/{bundle.name}"}
if not platforms:
    sys.exit("no signed updater bundles (*.sig) found")
manifest = {
    "version": version,
    "notes": f"BezierNotes {version}: see CHANGELOG.md",
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": platforms,
}
(assets / "latest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print("latest.json for", ", ".join(platforms))
