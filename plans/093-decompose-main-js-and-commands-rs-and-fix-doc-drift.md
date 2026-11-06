# Plan 093: Decompose `main.js` & `commands.rs`, Retire Dead Code, Fix Documentation Drift

| Field | Value |
|---|---|
| **Priority** | P1 |
| **Effort** | M (mechanical; large diff, low logic change) |
| **Category** | Maintainability / Tech Debt |
| **Depends on** | 087 (safety net); schedule **before** 090/092 touch these files further |
| **Status** | TODO |

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
