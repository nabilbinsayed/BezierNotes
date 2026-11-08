# AGENTS.md — AI Agent Guidance for InkWell Repository

Product name: BezierNotes (crate/folder names keep the `inkwell` prefix)

Read this before making changes to the InkWell codebase.

## Subsystem Directory Map

- `inkwell/`: Core Rust workspace (`inkwell-core`, `inkwell-pdf`; there is no separate WAL crate)
  - `crates/inkwell-core/`: Document model (`doc.rs`), ink mathematics (One-Euro filter, RDP, ribbon outline generation, `ink.rs`), sidecar codec (`codec.rs`), the PDF writer (`pdf.rs`) with its byte-level reader (`pdfobj.rs`) and xref/object-stream index (`xref.rs`), text-note glyph shaping (`text_shape.rs`, fonts in `fonts/`), Write-Ahead Log engine (`wal.rs`), tile cache (`tiles.rs`).
  - `crates/inkwell-pdf/`: PDFium integration: tile rasteriser (`rasterizer.rs`), text extraction and search (`text.rs`), outline (`outline.rs`), repair of damaged files (`normalise.rs`).
- `inkwell-app/`: Desktop application host (Tauri v2 + frontend UI)
  - `src-tauri/`: Tauri IPC commands in `commands/` (one module per area: `open`, `render`, `ink`, `save`, `export`, `pages`, `text`, `session`, `window`; shared DTOs and helpers in `mod.rs`), application state (`state.rs`), Linux stylus thread (`stylus_linux.rs`), and entry point (`main.rs`, the single command registration list).
  - `src/`: Web frontend UI (`index.html`, `styles.css`). `js/main.js` is startup only; `js/app/` holds command registration, UI bindings, document loading and the viewport reference; `js/input/` holds pointer and keyboard routing; plus `js/core/`, `js/tools/`, `js/render/`, `js/ui/`, `js/workspace/`. `tools/lint_boundaries.js` enforces that `core/` imports nothing from the other layers.
- `inkwell-m0/`: M0 latency spike prototype and Playwright smoke tests (`test_smoke.py`).
- `plans/`: Implementation plans and execution tracking (`README.md`).

## Non-Negotiable Rules

1. **Strict PDF Standards Compliance**: All output must be valid, standard PDF files. Ink layers are appended as vector filled ribbon outlines (`ribbon_outline`), never simple stroked lines or binary sidecar files.
2. **Append-Only Incremental Save**: Original PDF bytes must never be corrupted or overwritten in-place. `atomic_write` and append-only incremental PDF structures preserve base document integrity.
3. **No Underlay Rasterisation at Import**: PDFs are vector-rendered on demand per LOD tile. Never rasterise the base PDF into bitmaps on document load.
4. **WAL Journal Durability**: Write-Ahead Log (`inkwell-core/src/wal.rs`) entries are fsynced immediately upon stroke commit. WAL journals reside in local per-user directories (`$XDG_STATE_HOME` on Linux, `%LOCALAPPDATA%\BezierNotes\wal` on Windows), staying out of cloud sync folders to prevent sync thrashing. A save trims only the journal records its snapshot covers (frontend sequence numbers, Plan 090); never truncate the whole journal after a save.
5. **No Synthetic Delay or Swallowed Errors**: Always trace error root causes. Do not wrap critical failures in empty try/catch blocks or return silent dummy fallbacks.
6. **Maintain Touch Target & Accessibility Guidelines**: Minimum interactive target dimensions must satisfy touch guidelines (44x44px), with clear focus indicators and glassmorphic toast notifications for user feedback.

## Verification Commands

| Scope / Target | Command | Expected Outcome |
|---|---|---|
| Desktop App Smoke Test | `cd inkwell-app; py -3 test_app_smoke.py` | exit 0, all 175 checks pass |
| Rust Workspace Tests | `cd inkwell; cargo test --workspace -- --test-threads=1` | exit 0, all 153 tests pass (incl. Plan 087 conformance, golden, round-trip property and render-diff suites, Plan 091 `sync_meta` with the pre-091 fixtures in `inkwell/fixtures/v1/`, and Plan 092 `merge_prop`: CRDT laws and two-device file merges) |
| Rust Clippy | `cd inkwell; cargo clippy --all-targets` | zero warnings |
| App Crate Tests & Clippy | `cargo test -p inkwell-app; cargo clippy -p inkwell-app --all-targets -- -D warnings` (repo root) | 24 tests pass; zero warnings |
| PDF Conformance (strict) | `cd inkwell; BEZIER_CONFORMANCE_STRICT=1 cargo test -p inkwell-pdf --test conformance --test render_diff` | exit 0; needs `qpdf`, `gs`, PDFium. Known defects live in `KNOWN_FAILURES` (a ratchet: delete an entry when its fix lands; empty since Plan 088) |
| Golden Snapshots | `cd inkwell; cargo test -p inkwell-core --test golden` | exit 0; after an intentional format change run with `UPDATE_GOLDEN=1` and review the diff |
| Crash Torture | `scripts/torture_save.sh 200` | `0 failures` (no unopenable file, and no orphaned save temp survives the sweep) |
| Focused Regression Suites | `cd inkwell-app; for t in test_lasso_selection test_insert_page_dialog test_palette_dismissal test_resize_no_black_hole test_viewport_and_pressure; do py -3 $t.py; done` | each exits 0. The other standalone `test_*.py` scripts have known failing checks, listed in `plans/093-…`; they are not run in CI |
| Ink Latency Gate | `cd inkwell-app; py -3 test_latency.py --self-test; py -3 test_latency.py` | self-test catches an injected 10 ms stall; gate passes against `perf/baseline.json` (re-record with `--update-baseline` only deliberately). See `docs/latency.md` |
| Merge CLI | `cd inkwell; cargo run -p inkwell-core --bin beziernotes -- merge a.pdf b.pdf -o out.pdf` | merges two copies of one notebook; refuses copies of different PDFs (exit 1) |
| Module Boundaries | `node tools/lint_boundaries.js` | zero violations |
| M0 Prototype Smoke Test | `cd inkwell-m0; py -3 test_smoke.py` | exit 0, 18/18 checks pass (prototype only) |
