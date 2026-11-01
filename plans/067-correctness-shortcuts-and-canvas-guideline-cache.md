# Plan 067: Correctness, Shortcuts Wiring & Canvas Guideline Cache

**Status**: `DONE`  
**Priority**: `P0`  
**Scope**: `inkwell-app/src/js/ui/drawers.js`, `inkwell-app/src/js/main.js`, `inkwell-app/src/js/render/templates.js`

## Context & Motivation

A Chrome DevTools Protocol (`CDP`) runtime diagnostic audit identified three high-leverage issues in the desktop frontend:
1. **[BUG-01] Document Details Drawer Failure**: Clicking `#btnRailDocInfo` failed to display the drawer content due to targeting non-existent `.drawer-view` instead of `.drawer-content` and a case mismatch on `drawerDocInfo`.
2. **[BUG-02] Unwired Navigation Shortcuts**: Advertised shortcuts `Ctrl+G` (Go to Page) and `Ctrl+Shift+N` (Insert Blank Page) were documented in the UI but missing from the central command registry.
3. **[PERF-01] $O(N)$ Uncached Canvas Guideline Draw Calls**: Page dot grid stationery executed up to 1,260 individual path and fill operations per page per frame during `redrawAll()`.

## Changes Made

- **`inkwell-app/src/js/ui/drawers.js`**:
  - Fixed drawer panel switching to target `.drawer-content`.
  - Added direct mapping for `docinfo` -> `drawerDocInfo`.
  - Implemented `renderDocInfo()` to compute document statistics (page count, stroke count, dimensions) and display live hardware diagnostics.
- **`inkwell-app/src/js/main.js`**:
  - Registered `file.insertBlankPage` with shortcut `Ctrl+Shift+N`.
  - Registered `nav.goToPage` with shortcut `Ctrl+G`.
  - Wired quick action buttons `#btnDocInfoExport`, `#btnDocInfoInsertPage`, and `#btnDocInfoNewWhiteboard`.
  - Moved `openInsertPageModal()` and `closeInsertPageModal()` to module scope.
  - Added Escape key dismissal for `zoomMenuPopover`.
- **`inkwell-app/src/js/render/templates.js`**:
  - Implemented cached offscreen 20x20px tile pattern (`CanvasPattern`) for dot grid rendering, reducing draw calls from 3,780 to a single hardware-accelerated `fillRect`.

## Verification

- `cd inkwell-app && py -3 test_app_smoke.py`: 82/82 checks pass.
- `cd inkwell && cargo test --workspace -- --test-threads=1`: 72/72 tests pass.
- `cargo clippy --all-targets`: 0 warnings across workspaces.
- CDP diagnostic audit verified `docInfo` opening, `goto_page` opening on `Ctrl+G`, and `insert_page` opening on `Ctrl+Shift+N`.
