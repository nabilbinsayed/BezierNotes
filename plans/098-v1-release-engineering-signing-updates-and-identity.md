# Plan 098: v1.0 Release Engineering: Signed Installers, Auto-Update, Identity Migration & First Run

| Field | Value |
|---|---|
| **Priority** | P1 (ship gate) |
| **Effort** | M |
| **Category** | Distribution / Product |
| **Depends on** | 087–092 (the format and sync work defines v1.0) |
| **Status** | DONE (2026-11-09; see Outcome) |

## Why

The product was renamed to BezierNotes (commit `88600be`), but several things still need a decision or wiring before a public v1.0:
- **App identifier.** `tauri.conf.json` still has `"identifier": "dev.inkwell.app"`. Changing it moves the config/localStorage directory, so users would silently lose settings, custom colours, saved signatures and shortcuts. Decide once: keep it forever (simplest, invisible to users) **or** migrate with an explicit copy on first launch. Recommendation: **keep `dev.inkwell.app`**, documented as a legacy internal ID.
- **Launcher and desktop file names.** `Launch Inkwell.sh/.bat` and `dev.inkwell.app.desktop` still carry the old name; the binary is `inkwell-app`. Rename user-facing artefacts (`beziernotes` binary name via `mainBinaryName`), keeping a compatibility symlink for one release.
- **Unsigned Windows installers** trigger SmartScreen "unrecognized app" warnings, which is the #1 reason a student won't install an app. **No auto-update**, so fixes to file-format bugs (exactly the kind this wave addresses) don't reach users.
- **No crash reporting.** Errors surface only as toasts and `eprintln!`.
- **Release discipline.** The version has been `0.2.0` across ~30 plans. Format changes (sidecar v2, Plan 091) need a version boundary users can see.

## Steps
1. **Versioning**: SemVer. Sidecar v2 ships as **0.3.0**, and v1.0 = this wave complete. A single `VERSION` file drives `Cargo.toml` workspace version, `tauri.conf.json` and `package.json` (the script exists or add `scripts/bump_version.sh`). Generate `CHANGELOG.md` from conventional commits (`git-cliff`).
2. **Windows signing**: Azure Trusted Signing or an OV certificate via `signCommand` in `tauri.conf.json`. Fall back to SignPath's free OSS programme if cost is a blocker. Document the choice in `docs/release.md`.
3. **Auto-update**: `tauri-plugin-updater` with a static `latest.json` on GitHub Releases, signed with an updater key stored as a GitHub secret. UX: check daily, show a non-modal "Update available, restart to install" toast; never auto-restart with a dirty document.
4. **Linux**: AppImage (exists), plus an AUR `PKGBUILD` (`beziernotes-bin`) generated in `release.yml`. Keep `build_omarchy.sh` for source installs. Add a Flatpak manifest only if there's demand.
5. **Local crash log**: a Rust panic hook + `window.onerror`/`unhandledrejection` write to `$STATE/beziernotes/logs/` (rotating, 5 × 1 MB). "Help → Open logs folder" and "Copy diagnostic info" (version, OS, PDFium version, GPU) for bug reports. No network telemetry.
6. **First run**: a 3-card welcome sheet (open a PDF, where your notes are stored, i.e. in the PDF itself, and pen setup with pressure test + the latency HUD from Plan 094). Shown once.
7. **Release checklist** (`docs/release.md`): all verification commands green; `qpdf --check` over the fixture corpus; torture 200/200; a manual pass on Windows + Huion; Acrobat/Chrome open check of a saved file; update `README.md` download table.

## Verification
- A release dry-run on a fork: tag `v0.3.0-rc.1` → signed Windows installer, AppImage, AUR PKGBUILD, `latest.json` produced; installing 0.3.0-rc.1 over 0.2.0 keeps settings and signatures; the updater upgrades rc.1 → rc.2.

## STOP Conditions
- STOP if changing the identifier is chosen without the migration step. Losing users' saved signatures and shortcuts on update is not acceptable.

## Outcome (2026-11-09)

**Identifier.** Kept as `dev.inkwell.app`, as recommended: it is a legacy internal ID, documented in `docs/release.md`. Users keep their settings, colours, signatures and shortcuts, and there is nothing to migrate. User-facing names are now BezierNotes:
- `mainBinaryName: beziernotes`;
- `Launch BezierNotes.sh/.bat`, with the old `Launch Inkwell` names kept as wrappers until 0.4.0;
- the portable archives ship `beziernotes` plus a compatibility `inkwell-app`;
- the desktop file, README and `build_omarchy.sh` point at the new launcher.

**Versioning.**
- `VERSION` is now `0.3.0`. It used to hold a stray PDFium build number that nothing read.
- `scripts/bump_version.sh` syncs all five manifests (keeping `tauri.conf.json`'s CRLF line endings), and `--check` runs in CI.
- `scripts/changelog.py` writes `CHANGELOG.md` from conventional commits between `v*` tags. `git-cliff` isn't available here, and the script needs nothing.

**Auto-update** (`src-tauri/src/updates.rs`, `js/app/updates.js`).
- **Plugin.** `tauri-plugin-updater` is registered only when `tauri.conf.json` carries an updater public key, so an unconfigured build can never fail at startup.
- **Commands.** `check_for_update` and `install_update`; install refuses while the document is dirty.
- **UX.** The frontend checks once a day and shows a non-modal "Restart to install" toast. Installing saves first, and the app never restarts on its own. Help → Check for Updates.

**Signing and packaging** (`release.yml`).
- `scripts/release_overrides.py` turns on, per build, only what that build has secrets for: updater artifacts plus the plugin config, and Azure Trusted Signing (`trusted-signing-cli` as `signCommand`). Without secrets the build still runs and warns that it is unsigned or has no updater.
- `scripts/make_latest_json.py` writes `latest.json` from the `.sig` files.
- `packaging/aur/PKGBUILD.in` becomes a `beziernotes-bin` PKGBUILD with the AppImage's checksum.
- The release notes are rebranded.

**Crash log** (`src-tauri/src/diagnostics.rs`).
- A panic hook (with backtrace) and `window.onerror`/`unhandledrejection` write to a rotating local log (5 × 1 MB) in the per-user state directory. The frontend has a budget per session.
- Help → Open Logs Folder and Help → Copy Diagnostic Info (version, OS, PDFium, log location, WebView). Nothing goes over the network.

**First run** (`js/ui/first-run.js`). Three cards on the start screen: open a PDF; your notes live in the PDF; pen setup with a pressure-test pad and the latency HUD. They are not a modal and block nothing, and they're shown until the first document opens or "Got it".

**Verification.**
- **App tests.** 28/28, adding log rotation keeping five files. Clippy clean.
- **Smoke.** 196/196. T36, 3 checks: first-run cards, Help commands, the unconfigured updater saying so, an update offered rather than forced, and installing saving first.
- **Scripts.** The version check passes. `latest.json` and the release overrides were checked with stand-in signatures and secrets. Both workflow files parse.

**Not done (needs the maintainer).**
- Creating the updater key and the Azure/SignPath account, and adding the secrets: both are one-time steps in `docs/release.md`.
- The release dry run on a fork (tag `v0.3.0-rc.1`, then installing over 0.2.0 and updating rc.1 → rc.2) has not been run. That needs those secrets and a GitHub runner.
- The manual Windows + Huion pass and the Acrobat check from the checklist.
- Publishing to the AUR itself.
- No Flatpak, as the plan says: only on demand.
