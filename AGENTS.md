# AGENTS.md — AI Agent Guidance for InkWell Repository

Product name: BezierNotes (crate/folder names keep the `inkwell` prefix)

Read this before making changes to the InkWell codebase.

## Subsystem Directory Map

- `inkwell/`: Core Rust workspace (`inkwell-core`, `inkwell-pdf`, `inkwell-wal`)
  - `crates/inkwell-core/`: Document model, ink mathematics (One-Euro filter, RDP, ribbon outline generation), Write-Ahead Log engine (`wal.rs`), tile cache (`tiles.rs`).
  - `crates/inkwell-pdf/`: Low-level PDF parser (`pdf.rs`), object structure (`pdfobj.rs`), PDFium bindings and normalisation engine (`pdfium.rs`).
- `inkwell-app/`: Desktop application host (Tauri v2 + frontend UI)
  - `src-tauri/`: Tauri backend IPC commands (`commands.rs`), application state (`state.rs`), and entry point (`main.rs`).
  - `src/`: Web frontend UI (`index.html`, `styles.css`, `js/core/`, `js/tools/`, `js/render/`, `js/ui/`, `js/workspace/`, `js/main.js`).
- `inkwell-m0/`: M0 latency spike prototype and Playwright smoke tests (`test_smoke.py`).
- `plans/`: Implementation plans and execution tracking (`README.md`).

## Non-Negotiable Rules

1. **Strict PDF Standards Compliance**: All output must be valid, standard PDF files. Ink layers are appended as vector filled ribbon outlines (`ribbon_outline`), never simple stroked lines or binary sidecar files.
2. **Append-Only Incremental Save**: Original PDF bytes must never be corrupted or overwritten in-place. `atomic_write` and append-only incremental PDF structures preserve base document integrity.
3. **No Underlay Rasterisation at Import**: PDFs are vector-rendered on demand per LOD tile. Never rasterise the base PDF into bitmaps on document load.
4. **WAL Journal Durability**: Write-Ahead Log (`inkwell-wal`) entries are fsynced immediately upon stroke commit. WAL journals reside in system temporary directories, staying out of cloud sync folders to prevent sync thrashing.
5. **No Synthetic Delay or Swallowed Errors**: Always trace error root causes. Do not wrap critical failures in empty try/catch blocks or return silent dummy fallbacks.
6. **Maintain Touch Target & Accessibility Guidelines**: Minimum interactive target dimensions must satisfy touch guidelines (44x44px), with clear focus indicators and glassmorphic toast notifications for user feedback.

## Verification Commands

| Scope / Target | Command | Expected Outcome |
|---|---|---|
| Desktop App Smoke Test | `cd inkwell-app; py -3 test_app_smoke.py` | exit 0, all 150 checks pass |
| Rust Workspace Tests | `cd inkwell; cargo test --workspace -- --test-threads=1` | exit 0, all 101 tests pass (incl. Plan 087 conformance, golden, round-trip property and render-diff suites) |
| Rust Clippy | `cd inkwell; cargo clippy --all-targets` | zero warnings |
| PDF Conformance (strict) | `cd inkwell; BEZIER_CONFORMANCE_STRICT=1 cargo test -p inkwell-pdf --test conformance --test render_diff` | exit 0; needs `qpdf`, `gs`, PDFium. Known defects live in `KNOWN_FAILURES` (a ratchet: delete an entry when its fix lands) |
| Golden Snapshots | `cd inkwell; cargo test -p inkwell-core --test golden` | exit 0; after an intentional format change run with `UPDATE_GOLDEN=1` and review the diff |
| Crash Torture | `scripts/torture_save.sh 200` | `0 unopenable` |
| M0 Prototype Smoke Test | `cd inkwell-m0; py -3 test_smoke.py` | exit 0, 18/18 checks pass (prototype only) |
