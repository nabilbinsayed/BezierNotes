# Plan 098: v1.0 Release Engineering: Signed Installers, Auto-Update, Identity Migration & First Run

| Field | Value |
|---|---|
| **Priority** | P1 (ship gate) |
| **Effort** | M |
| **Category** | Distribution / Product |
| **Depends on** | 087–092 (the format and sync work defines v1.0) |
| **Status** | TODO |

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
