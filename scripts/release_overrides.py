#!/usr/bin/env python3
"""Print a tauri.conf.json override (JSON) for a release build (Plan 098),
switching on only what this build has secrets for:

  * updater: TAURI_UPDATER_PUBKEY (+ TAURI_SIGNING_PRIVATE_KEY for the build)
    -> createUpdaterArtifacts and plugins.updater {pubkey, endpoint}
  * Windows signing: AZURE_CLIENT_ID etc. -> bundle.windows.signCommand
    (Azure Trusted Signing via trusted-signing-cli)

Usage: release_overrides.py windows|linux
"""
import json, os, sys

target = sys.argv[1] if len(sys.argv) > 1 else "linux"
cfg = {}
pubkey = os.environ.get("TAURI_UPDATER_PUBKEY", "").strip()
if pubkey and os.environ.get("TAURI_SIGNING_PRIVATE_KEY", "").strip():
    repo = os.environ.get("GITHUB_REPOSITORY", "nabilbinsayed/BezierNotes")
    cfg["bundle"] = {"createUpdaterArtifacts": True}
    cfg["plugins"] = {"updater": {
        "pubkey": pubkey,
        "endpoints": [f"https://github.com/{repo}/releases/latest/download/latest.json"],
    }}
if target == "windows" and os.environ.get("AZURE_CLIENT_ID", "").strip():
    cmd = ("trusted-signing-cli -e {e} -a {a} -c {c} -d BezierNotes %1").format(
        e=os.environ["TRUSTED_SIGNING_ENDPOINT"], a=os.environ["TRUSTED_SIGNING_ACCOUNT"], c=os.environ["TRUSTED_SIGNING_PROFILE"])
    cfg.setdefault("bundle", {})["windows"] = {"signCommand": cmd}
print(json.dumps(cfg))
