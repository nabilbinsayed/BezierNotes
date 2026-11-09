# Releasing BezierNotes

How a version gets from `main` to users (Plan 098).

## Version

One version for everything, in `VERSION` (SemVer). Never edit a manifest by hand:

```bash
scripts/bump_version.sh 0.4.0
```

That rewrites the workspace `Cargo.toml`s, `inkwell-app/src-tauri/Cargo.toml`, `tauri.conf.json` and `package.json`. CI runs `scripts/bump_version.sh --check`.

- `0.3.0` is the first release with sidecar schema 2 (Plan 091).
- `1.0.0` is this plan wave (087–098) complete and released.

Then regenerate the changelog from the conventional commits since the last `v*` tag, and review it:

```bash
python3 scripts/changelog.py
```

## App identifier: kept as `dev.inkwell.app` (decided)

The identifier names the config and WebView storage directory: settings, custom colours, saved signatures and shortcuts. Changing it would silently reset all of them for every user. It stays `dev.inkwell.app` permanently, as a legacy internal ID that users never see. Everything user-facing is BezierNotes:
- the product name and the `beziernotes` binary (`mainBinaryName`);
- the `Launch BezierNotes` launchers. The old `Launch Inkwell` names are kept as wrappers for 0.3.x and removed in 0.4.0.

If this is ever revisited, the change must ship with a first-launch copy of the old directory. Without it the change is refused (the Plan 098 STOP condition).

## One-time setup (needs the maintainer's accounts)

The release workflow switches each of these on as soon as its secrets exist. Until then it builds anyway and warns.

### Auto-update signing key

```bash
cd inkwell-app && npx @tauri-apps/cli signer generate -w ~/.tauri/beziernotes.key
```

Add repository secrets:
- `TAURI_SIGNING_PRIVATE_KEY`: the private key file's contents;
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: its password;
- `TAURI_UPDATER_PUBKEY`: the `.pub` file's contents.

Keep the private key out of the repository and back it up. Losing it means no installed copy can ever be updated again.

With those set, `scripts/release_overrides.py` turns on `createUpdaterArtifacts` and configures the updater (public key, plus `releases/latest/download/latest.json` as the endpoint). `scripts/make_latest_json.py` then writes `latest.json` from the signed bundles.

The app checks once a day and offers "Restart to install" in a toast. It never restarts by itself, and saves unsaved work first. Without a public key the updater isn't started at all, and Help → Check for Updates says so.

### Windows code signing

Unsigned installers trigger SmartScreen's "unrecognized app" warning. The workflow signs with **Azure Trusted Signing** through `trusted-signing-cli` (`bundle.windows.signCommand`). Add these secrets:
- `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`;
- `TRUSTED_SIGNING_ACCOUNT`, `TRUSTED_SIGNING_PROFILE`, `TRUSTED_SIGNING_ENDPOINT`.

If the cost is a blocker, SignPath's free programme for open-source projects is the fallback (replace the sign command).

### AUR

Each release attaches a `PKGBUILD` for `beziernotes-bin`, generated from `packaging/aur/PKGBUILD.in` with the AppImage's checksum. Publish it to the AUR repository by hand (or add an AUR deploy key and automate it later).

## Release checklist

1. Every row of `AGENTS.md` → Verification Commands passes, including:
   - strict PDF conformance;
   - `scripts/torture_save.sh 200` → 0 failures;
   - `inkwell-app/test_latency.py`.
2. `qpdf --check` passes on every file in `inkwell/fixtures/` after a save.
3. Manual pass on Windows with a Huion tablet (pressure, latency HUD, save, reopen).
4. Open a saved file in Acrobat Reader and in Chrome's viewer: ink, notes, shapes and filled forms all visible.
5. Run `scripts/bump_version.sh X.Y.Z` and `python3 scripts/changelog.py`, then commit.
6. Tag `vX.Y.Z` and push the tag. `release.yml` builds and publishes:
   - the installers and portable archives;
   - `PKGBUILD`;
   - `latest.json`, if the updater is set up.
7. Update the README download table if the file names changed.

## Logs and bug reports

Panics and uncaught frontend errors go to a local, rotating log (5 × 1 MB). Nothing is sent anywhere. The log lives in:
- `$XDG_STATE_HOME/beziernotes/logs` on Linux;
- `%LOCALAPPDATA%\BezierNotes\logs` on Windows;
- `~/Library/Logs/BezierNotes` on macOS.

Help → Open Logs Folder opens it. Help → Copy Diagnostic Info copies the version, OS, PDFium status and log location for pasting into an issue.
