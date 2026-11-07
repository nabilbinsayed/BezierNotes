# Plan 093: Decompose `main.js` & `commands.rs`, Retire Dead Code, Fix Documentation Drift

| Field | Value |
|---|---|
| **Priority** | P1 |
| **Effort** | M (mechanical; large diff, low logic change) |
| **Category** | Maintainability / Tech Debt |
| **Depends on** | 087 (safety net); schedule **before** 090/092 touch these files further |
| **Status** | DONE (2026-11-08; see Outcome) |

## Why

The two orchestration files are where every recent plan landed, and they have become the main obstacle to safe change:
- `inkwell-app/src/js/main.js` is **2,974 lines**. Its biggest functions are `registerCoreCommands` (~475 lines, `:444-919`), `bindAllUIEvents` (~730 lines, `:1043-1770`) and `attachPointerHandlers` (~420 lines, `:1893-2310`). Pointer routing, keyboard shortcuts, settings, export UI, the external-change banner, reading mode and the shortcut editor all share one module scope.
- `inkwell-app/src-tauri/src/commands.rs` is **2,791 lines** holding all 38 Tauri commands. Open, save, export, WAL replay, page ops, text and window chrome are interleaved. `save_pdf` and `export_pdf_custom` duplicate the normalise-fallback block (`:1438-1452` vs `:1668-1682`).

Plans 090 and 092 add autosave, close-modal, merge-banner and merge-IPC code to exactly these files. Splitting first keeps those diffs reviewable.

Documentation has also drifted from reality, which misleads both humans and agents:
- `AGENTS.md` and `README.md:127` describe an `inkwell-wal` crate that **does not exist**; the WAL lives in `inkwell-core/src/wal.rs`.
- `README.md:256` says "126 desktop checks" (actual: 150).
- `HANDOFF.md` describes a two-milestone project with M2 "not started", which is long obsolete. `CODEX_HANDOFF.md` is similar.
- `PROJECT.md` title still says "InkWell Full Optimization, Tool Repair…".
- `inkwell-pdf/src/text_embed.rs` (`embed_texts_in_pdf`) is referenced only by one test. It is dead production code.
- 13 ad-hoc `inkwell-app/test_m1_*.py` / `test_*_stress.py` scripts are not run in CI. They are either valuable regression tests or noise; nobody knows which.

## Steps

### Frontend (`main.js` → modules; behaviour-neutral)
1. `js/app/commands-registry.js`: `registerCoreCommands` body, split by domain (`file`, `edit`, `view`, `page`, `tools`).
2. `js/input/pointer-router.js`: `attachPointerHandlers`, `cancelPendingTouchStroke`.
3. `js/input/keyboard.js`: `attachKeyboardShortcuts`.
4. `js/ui/settings.js`, `js/ui/export-modal.js` (with `parsePageRangeSpec`), `js/ui/reading-mode.js`, `js/ui/shortcuts-editor.js`, `js/ui/popovers.js`, `js/ui/external-change.js`, `js/ui/focus-trap.js`.
5. `main.js` keeps startup sequencing only (target < 400 lines).
6. Move one module per commit; run the smoke suite after each. Keep every `window.*` hook the smoke tests use.

### Backend (`commands.rs` → `commands/` module tree)
`commands/{open.rs, save.rs, export.rs, wal_journal.rs, pages.rs, text.rs, render.rs, window.rs, mod.rs}`. Extract one shared `open_writable_base(state, bytes) -> (Option<Vec<u8>>, PdfFile)` to remove the duplicated normalise block (Plan 088 then changes it in one place). The `invoke_handler!` list in `main.rs` stays the single registration point.

### Dead code and docs
- Delete `text_embed.rs` and its test (or move the test's intent onto the core FreeText writer).
- Triage each `inkwell-app/test_*.py`: run it. If it passes and covers something unique, fold its checks into `test_app_smoke.py` (or a second suite run in CI). Otherwise delete it. Record the decision per file in this plan's notes.
- Fix `AGENTS.md` (directory map: remove `inkwell-wal`, add `inkwell-pdf` module list and the new module trees), `README.md` (structure tree, check count, latency claims only if measured; see Plan 094), `PROJECT.md` title/milestones (add M7+ from this wave).
- Move `HANDOFF.md` and `CODEX_HANDOFF.md` to `docs/archive/` with a one-line "historical" header.
- Remove stray repo-root artefacts from the working tree docs (`uihi.pdf`, `inkwell-capture.json`, `args.gn`, `PDFiumConfig.cmake` if unused). Check the gitignore and `build.rs` before deleting anything tracked.

## Verification
```bash
cd inkwell && cargo test --workspace -- --test-threads=1 && cargo clippy --all-targets -- -D warnings
cd inkwell-app && python3 test_app_smoke.py   # identical pass count before and after
wc -l inkwell-app/src/js/main.js inkwell-app/src-tauri/src/commands/*.rs
```

## STOP Conditions
- STOP if any smoke check changes from pass to fail during a "move only" commit. Revert that commit, don't patch forward.
- No behaviour changes in this plan. Bugs found along the way get written down, not fixed here.

## Outcome (2026-11-08)

**Backend.** `src-tauri/src/commands.rs` (2,832 lines) became `commands/` with `mod.rs` (346 lines: shared imports, DTOs and helpers) plus `open`, `render`, `ink`, `save`, `export`, `pages`, `text`, `session` and `window` (64–494 lines each). Children `use super::*`, so shared helpers stay private. The three cross-module helpers (`apply_frontend_payload`, `open_writable_base`, `rebased_original`) are `pub(super)`. `main.rs` registers each command by its full path (`commands::save::save_pdf`), because Tauri's generated `__cmd__*` macros do not travel through glob re-exports. The duplicated normalise block was already merged into `open_writable_base` by Plan 088.

**Frontend.** `js/main.js` went from 2,988 to 480 lines (startup only). New modules:
- `app/`: `commands-registry`, `ui-bindings`, `document-loading`, `viewport-ref`
- `input/`: `pointer-router`, `keyboard`
- `ui/`: `external-change`, `export-modal`, `insert-page-modal`, `reading-mode`, `shortcuts-editor`, `popovers`, `focus-trap`

The module-level `_viewport` is replaced by `app/viewport-ref.js` (`getViewport`/`setViewport`), set right after the ViewportManager is built and before `attachListeners`, since its callback calls the popovers. Every `window.*` hook the tests use is unchanged.

*Not done as specified:* `registerCoreCommands` (~475 lines) and `bindAllUIEvents` (~730 lines) moved whole rather than split by domain, and `main.js` is 480 lines, not under 400 (the startup block alone is ~440). Splitting them further is a mechanical follow-up with no behaviour risk; it wasn't needed for 090/092.

**Proof of behaviour-neutrality.**
- A line-multiset diff of old vs new for both files shows only module headers, imports, `export`/`pub(super)` keywords, and the viewport swap.
- All 13 standalone scripts were run on the pre-split commit and on the split tree. Run sequentially, the results are identical. Two scripts differed only under parallel CPU load and match when rerun alone.

**Dead code.** Deleted `inkwell-pdf/src/text_embed.rs` and `images.rs` (PDFium embedding paths unused by the app). The one test that used `embed_texts_in_pdf` is replaced by `saved_sticky_note_text_is_readable_by_pdfium`: a note saved through the real writer, read back from `/Contents` by PDFium's annotation API.

**Stray test scripts (triage).** With the system Chromium:
- **Pass and are now in Linux CI:** `test_lasso_selection` (16/16), `test_insert_page_dialog`, `test_palette_dismissal`, `test_resize_no_black_hole`, `test_viewport_and_pressure`. Three of them wrote screenshots to a hard-coded `~/.gemini/antigravity/brain/...` path and would have crashed in CI. Those debug screenshots are removed.
- **Fail before and after the split** (not run in CI; triage is a follow-up):
  - `test_adversarial_m3` 21/25: mid-stroke tool change, space jitter quick-toggle, ±20 px touch-target hit-testing, console errors.
  - `test_app_adversarial_stress` 17/19: 10-tap space burst, console errors.
  - `test_image_copypaste` 17/18 **(runs in Windows CI)**: console error `fetchTile … Invalid tile buffer: expected 247500 RGBA bytes (495x125), got 592896`.
  - `test_m1_adversarial` 34/37: out-of-bounds text-selection clamping left/right, page errors.
  - `test_m1_challenger_stress` 32/36: spring key `e` restore, space hold without pan, empty search query, console errors.
  - `test_m1_interactive` 20/24: three space-toggle expectations, console errors.
  - `test_m2_touch_a11y` 31/39: seven buttons reported missing `:focus-visible` ring rules, tile-buffer console error.
  - `test_m1_iter2_challenger_deep`: text-selection drag/double/triple-click checks fail, then a 30 s click timeout.
  - The recurring tile-buffer error (fixed-size mock tile vs requested size), the space-toggle expectations (spring-key logic changed in Plan 076) and the `:focus-visible` reports (AGENTS.md rule 6) need a decision each: real bug, or stale test.

**Docs.**
- AGENTS.md directory map rewritten: no `inkwell-wal` crate; core/pdf module lists; `commands/` and the `js/app` / `js/input` layout. Rule 4 now names the real WAL location. New verification rows for the focused suites and the boundary linter.
- README architecture tree, WAL bullet and check count (126 → 154) fixed.
- PROJECT.md title, paths and an M7 row for this wave.
- `HANDOFF.md` and `CODEX_HANDOFF.md` moved to `docs/archive/` with a "historical" header.
- Repo-root artefacts (`uihi.pdf`, `args.gn`, `PDFiumConfig.cmake`, `pdfium.tgz`, the Bangla textbook) are untracked local files, so there was nothing to remove. `inkwell-capture.json` is tracked and used by M0 and Plan 094.

**Verification.** Rust 118/118, strict conformance + render diff, app crate 15/15, clippy clean on both workspaces, module boundaries clean, smoke 154/154, the five focused suites pass.
