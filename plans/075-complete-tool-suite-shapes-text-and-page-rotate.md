# Plan 075: Complete Tool Suite: Editable Text Notes, Arrow & Polygon Shapes, Interactive Ruler, Partial Eraser & Image Insertion

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c036ee8..HEAD -- inkwell-app/src/index.html inkwell-app/src/js/tools/text.js inkwell-app/src/js/tools/lasso.js inkwell-app/src/js/tools/shapes.js inkwell-app/src/js/tools/eraser.js inkwell-app/src/js/tools/tool-manager.js inkwell-app/src/js/render/overlays.js inkwell-app/src/js/ui/toolbar.js inkwell-app/src/js/ui/drawers.js inkwell-app/src/js/core/ipc.js inkwell-app/src-tauri/src/commands.rs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: 070, 074
- **Category**: bug | feature | direction
- **Planned at**: commit `c036ee8`, 2026-10-30

## Why this matters

To function as a complete note-taking and moderate PDF editing product, every tool in the dock must work without gaps:
1. **Text notes cannot be edited after placement and vanish during Lasso transform (`[CORRECTNESS-07]`)**:
   - `onTextToolClick` (`text.js:14-36`) always creates a new text object even when clicking directly on an existing text note.
   - `renderWetTransform` (`lasso.js:629-644`) only renders `selectedStrokes` and `selectedImages` on the wet canvas during drag/resize, causing `selectedTextObjects` to disappear while moving and fail to scale `fontSize` on resize.
2. **Shape wet preview ignores viewport zoom (`[CORRECTNESS-09]`)**:
   - `drawShapeOverlay` (`overlays.js:237`) sets `ctx.lineWidth = state.baseWidth || 1.6` in screen pixels without multiplying by zoom `z`, so shapes jump in thickness on commit.
3. **Missing Arrow and Triangle/Polygon shapes (`[DIR-01]`)**:
   - `SPEC.md:377` specifies `rectangle/ellipse/arrow` shapes, but `shapes.js` only implements `rect`, `ellipse`, and `line`.
4. **No interactive Ruler / straightedge with angle readout (`[DIR-02]`)**:
   - `ruler` in `shapes.js` is just a plain `line` alias with no angle readout (`0°..360°`) or Shift-key angle snapping (`0°, 15°, 30°, 45°, 90°`).
5. **No UI button to insert images from disk (`[DIR-03]`)**:
   - Image paste/drop works in `clipboard.js`, but there is no "Insert Image" button in `#floatingDock` or `#moreOptionsMenu`.
6. **Page rotation (`rotate_page`) is unwired in UI and doesn't rotate sheet annotations (`[BUG-BACKEND-14]` / `[DIR-04]`)**:
   - `rotate_page` exists in `commands.rs:1669` but has no `ipc.js` wrapper, no thumbnail button in `drawers.js`, and does not rotate stroke/image/text coordinates on that sheet by 90°.

## Current state

- `inkwell-app/src/js/tools/text.js:14-36`:
  ```javascript
  export function onTextToolClick(e, ptWorld, pane, viewport) {
    const pageCoord = viewport.worldToPage(ptWorld[0], ptWorld[1]);
    const activeSheet = pageCoord.sheet;
    const pl = viewport.getPageLayout(activeSheet);

    const newTextObj = {
      id: 'txt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      sheet: activeSheet,
      x: ptWorld[0] - pl.x,
      y: ptWorld[1] - pl.y,
  ```
- `inkwell-app/src/js/render/overlays.js:235-242`:
  ```javascript
    ctx.save();
    ctx.strokeStyle = state.color ? `rgb(${state.color.map(v => Math.round(v * 255)).join(',')})` : '#141724';
    ctx.lineWidth = state.baseWidth || 1.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  ```
- `inkwell-app/src/js/tools/shapes.js:52-60`:
  ```javascript
    const kind = state.shapeKind || 'rect';
    const pts = [];
    const baseW = state.baseWidth || 2.0;
    const now = performance.now();

    if (kind === 'line' || kind === 'ruler') {
  ```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Rust Workspace Tests | `cd inkwell && cargo test --workspace -- --test-threads=1` | exit 0, all tests pass |
| Rust Clippy | `cd inkwell && cargo clippy --all-targets` | exit 0, 0 warnings |
| App Smoke Tests | `cd inkwell-app && python3 test_app_smoke.py` | exit 0, all checks pass |

## Scope

**In scope**:
- `inkwell-app/src/index.html`
- `inkwell-app/src/js/tools/text.js`
- `inkwell-app/src/js/tools/lasso.js`
- `inkwell-app/src/js/tools/shapes.js`
- `inkwell-app/src/js/tools/tool-manager.js`
- `inkwell-app/src/js/render/overlays.js`
- `inkwell-app/src/js/ui/toolbar.js`
- `inkwell-app/src/js/ui/drawers.js`
- `inkwell-app/src/js/core/document.js`
- `inkwell-app/src/js/core/ipc.js`
- `inkwell-app/src-tauri/src/commands.rs`
- `inkwell-app/test_app_smoke.py`

**Out of scope**:
- Customizable keyboard shortcuts and reading mode (Plan 076).

## Steps

### Step 1: Make existing text objects click-to-edit and render/scale text objects during Lasso transforms

1. In `inkwell-app/src/js/tools/text.js`:
   - In `onTextToolClick(e, ptWorld, pane, viewport)` (line 14), first check if any non-deleted `t` in `state.textObjects` on `activeSheet` contains `(px, py)` within `[t.x - 6, t.y - 6, t.x + (t.width || 140) + 6, t.y + (t.height || 32) + 6]`.
   - If an existing `t` is hit, set `_isNewNote = false;` and call `startEditing(t, viewport, pane); return;` instead of creating a duplicate!
2. In `inkwell-app/src/js/tools/lasso.js`:
   - In `renderWetTransform` (lines 629–680), include `state.selectedTextObjects` in `allSheets` and draw them on `wctx` under the active transform matrix; in `compositor.js:246`, skip drawing `t` on `_dctx` while `state.transformMode` is active for `selectedTextObjects` (matching `selectedImages` on line 224).
   - When committing a scale transform in `lasso.js` (around line 325), scale `t.fontSize = Math.max(8, Math.min(72, Math.round((t.fontSize || 16) * (( Math.abs(scaleX) + Math.abs(scaleY) ) / 2))))`, `t.width`, and `t.height`.

**Verify**: `cd inkwell-app && python3 test_app_smoke.py` → exit 0.

### Step 2: Add `arrow` and `triangle` shapes, Shift-key angle/aspect snapping, zoom-scaled shape preview, and Ruler angle HUD

1. In `inkwell-app/src/js/tools/shapes.js` and `inkwell-app/src/js/render/overlays.js`:
   - In `onShapeMove(e, ptWorld, pane, viewport)`: when `e.shiftKey` is held:
     - For `rect`, `ellipse`, `triangle`: constrain `|dx| === |dy|` (perfect square, circle, equilateral triangle).
     - For `line`, `ruler`, `arrow`: snap angle to nearest `15°` increment (`Math.round(angle / (Math.PI / 12)) * (Math.PI / 12)`).
   - Add `kind === 'arrow'` (shaft + filled vector arrowhead wings at `±28°` scaled by `Math.max(10, baseW * 4.5)`) and `kind === 'triangle'` (closed 3-vertex polygon) in both `overlays.drawShapeOverlay` (wet preview) and `shapes.onShapeUp` (committed vector stroke).
   - In `overlays.drawShapeOverlay` (line 237), multiply `ctx.lineWidth = (state.baseWidth || 1.6) * z;` by active pane zoom `z`, and when `kind === 'ruler' || kind === 'line' || kind === 'arrow'`, draw a crisp pill readout showing length (in `pt`/`mm`) and angle (in `°`, e.g., `45.0° • 120pt`) at the segment midpoint.
2. In `inkwell-app/src/index.html` and `inkwell-app/src/js/ui/toolbar.js`:
   - Add Arrow (`data-shape="arrow"`) and Triangle (`data-shape="triangle"`) buttons to the shape selector in `#propPopover` and wire them to `toolManager.setShapeKind`.

**Verify**: `cd inkwell-app && python3 test_app_smoke.py` → exit 0.

### Step 3: Add "Insert Image" UI button and wire 90° Page Rotation across backend and thumbnail rail

1. In `inkwell-app/src/index.html` and `inkwell-app/src/js/main.js`:
   - Add `<button id="btnMoreInsertImage" class="more-menu-item">Insert Image...</button>` to `#moreOptionsMenu` and a hidden `<input type="file" id="imageFileInput" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none">` (or reuse file reader) that reads the selected image as a Data URL and calls `clipboard.pasteImageDataUrl(dataUrl, _viewport)`.
2. In `inkwell-app/src-tauri/src/commands.rs` (`rotate_page`, lines 1669–1723), `inkwell-app/src/js/core/ipc.js`, `inkwell-app/src/js/core/document.js`, and `inkwell-app/src/js/ui/drawers.js`:
   - In `commands.rs:rotate_page`, after rotating the PDFium page from `(orig_w, orig_h)` to `(out_w, out_h)`, rotate all strokes, images, and text objects on `doc.sheets[index]` (`(x, y) -> (orig_h - y, x)` for clockwise, `(y, orig_w - x)` for counter-clockwise).
   - Expose `ipc.rotatePage(index, clockwise = true)` in `ipc.js` and `documentOps.rotatePageAtIndex(index, clockwise = true)` in `document.js` (with undo/redo transaction support).
   - Add a Rotate Page (`90° CW`) action button `.btn-thumb-rotate` on each thumbnail card in `drawers.js:renderThumbnails()`.

**Verify**: `cd inkwell && cargo test --workspace -- --test-threads=1 && cargo clippy --all-targets && cd ../inkwell-app && python3 test_app_smoke.py` → exit 0.

## Test plan

- Add Playwright checks in `inkwell-app/test_app_smoke.py` verifying:
  1. Clicking an existing text note with the Text tool opens `inlineTextEditor` for that note instead of creating a second note.
  2. Drawing with `shapeKind = 'arrow'` and `shapeKind = 'triangle'` commits valid vector strokes.
  3. Calling `documentOps.rotatePageAtIndex(0, true)` swaps `width_pt` and `height_pt` and rotates stroke coordinates on sheet 0.

## Done criteria

- [ ] `cd inkwell && cargo test --workspace -- --test-threads=1` exits 0
- [ ] `cd inkwell && cargo clippy --all-targets` exits 0 with 0 warnings
- [ ] `cd inkwell-app && python3 test_app_smoke.py` exits 0
- [ ] `plans/README.md` status row updated to `DONE`

## STOP conditions

- Any existing Rust or Playwright smoke test fails.
- The code at the locations in "Current state" doesn't match the excerpts.

## Maintenance notes

- When adding new shape kinds to `shapes.js`, always add the matching preview path in `overlays.drawShapeOverlay` so wet preview and dry commit stay identical.
