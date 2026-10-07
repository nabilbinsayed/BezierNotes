# Plan 066: Security Hardening, CI & Repository Workspace Unification

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 3bf08b7..HEAD -- Cargo.toml inkwell-app/src-tauri/tauri.conf.json inkwell-app/src-tauri/src/commands.rs .github/workflows/build.yml`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: security | dx | ci
- **Planned at**: commit `3bf08b7`, 2026-10-07

## Why this matters

Clean engineering ergonomics and secure release configurations keep development reliable:
1. `csp` in `tauri.conf.json` is currently `null`, leaving the Webview without defense-in-depth against script injection. Production configs also enable `devtools: true` and `withGlobalTauri: true`.
2. `open_pdf` accepts raw path strings without traversal validation, unlike `save_pdf`.
3. The repo is split into two disjoint Cargo workspaces (`inkwell` and `inkwell-app/src-tauri`). Running `cargo test` or `cargo clippy` from repo root fails because there is no root `Cargo.toml`.
4. Continuous Integration (`build.yml`) runs tests and Clippy exclusively on `windows-latest`. Linux builds are packaged without executing automated tests or Clippy.

Landing this plan hardens production builds with CSP, unifies the root Cargo workspace, validates open paths, and runs full Linux CI verification.

## Current state

- `inkwell-app/src-tauri/tauri.conf.json:22,26`:
  `"devtools": true` and `"csp": null`.
- `inkwell-app/src-tauri/src/commands.rs:379-385`:
  `open_pdf` reads `std::fs::read(&path)` without validating `..` traversal or file existence.
- Root directory has no `Cargo.toml`.
- `.github/workflows/build.yml:11-68`:
  `verify` job runs on `windows-latest` only.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Root Cargo Check | `cargo check --workspace` | exit 0, all workspace packages check clean |
| Root Cargo Test | `cargo test --workspace -- --test-threads=1` | exit 0, all tests pass |
| Root Cargo Clippy | `cargo clippy --workspace --all-targets` | exit 0, zero warnings |
| Desktop Smoke Test | `cd inkwell-app; py -3 test_app_smoke.py` | exit 0, all 75+ checks pass |

## Scope

**In scope**:
- Root `Cargo.toml` (create)
- `inkwell-app/src-tauri/tauri.conf.json`
- `inkwell-app/src-tauri/Cargo.toml`
- `inkwell-app/src-tauri/src/commands.rs`
- `.github/workflows/build.yml`

**Out of scope**:
- PDF document model (`inkwell-core`).

## Steps

### Step 1: Unify repository into a single root Cargo workspace

In repo root `/mnt/Work/Own Programs/InkWell`:
1. Create root `Cargo.toml`:
   ```toml
   [workspace]
   members = [
       "inkwell/crates/inkwell-core",
       "inkwell/crates/inkwell-pdf",
       "inkwell-app/src-tauri",
   ]
   resolver = "2"
   ```
2. Verify that running `cargo test --workspace -- --test-threads=1` and `cargo clippy --workspace --all-targets` works directly from the repo root.

**Verify**: `cargo check --workspace` from root exits 0.

### Step 2: Validate file paths in `open_pdf`

In `inkwell-app/src-tauri/src/commands.rs:375-390` (`open_pdf`):
1. Add path validation matching `save_pdf`:
   ```rust
   if path_str.contains("..") || path.components().any(|c| c == std::path::Component::ParentDir) {
       return Err("Path traversal components (..) are not permitted".to_string());
   }
   if !path.exists() || !path.is_file() {
       return Err(format!("File does not exist: {path:?}"));
   }
   ```

**Verify**: Verify invalid paths error with a clear message.

### Step 3: Configure strict CSP and gate devtools in production

In `inkwell-app/src-tauri/tauri.conf.json`:
1. Configure strict Content Security Policy:
   ```json
   "security": {
     "csp": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self' data:;"
   }
   ```
2. In production builds, ensure `devtools` is disabled or gated behind debug features.

**Verify**: Build app and verify console reports zero CSP violations.

### Step 4: Add Linux test verification to GitHub Actions CI

In `.github/workflows/build.yml`:
1. In `build-linux` job, add verification steps before packaging:
   - Run `cargo test -p inkwell-core -p inkwell-pdf -- --test-threads=1`.
   - Run `cargo clippy -p inkwell-core -p inkwell-pdf --all-targets`.
   - Run `python test_app_smoke.py`.

**Verify**: Inspect `build.yml` syntax.

## Done criteria

- [ ] Root `Cargo.toml` exists and `cargo test --workspace` executes all tests from root.
- [ ] `open_pdf` rejects path traversal and non-existent files cleanly.
- [ ] Strict CSP is enforced in `tauri.conf.json` with zero console violations.
- [ ] Linux CI runs automated tests before building release artifacts.
- [ ] All smoke tests and workspace tests pass.
