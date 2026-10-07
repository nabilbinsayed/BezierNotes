# Plan 065: Vector Clipping to Obsidian & LaTeX

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 3bf08b7..HEAD -- inkwell-app/src/js/core/clipboard.js inkwell-app/src/js/tools/lasso.js inkwell-app/src/js/ui/context-menu.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction | ux
- **Planned at**: commit `3bf08b7`, 2026-10-07

## Why this matters

InkWell is committed to the "file over app" philosophy. Researchers, engineers, and students taking math and science notes in Obsidian, Overleaf/LaTeX, or Anki frequently need to extract handwritten math derivations, diagrams, and sketches directly into their Markdown notes without taking pixelated bitmap screenshots.

Because InkWell already models handwriting as mathematical cubic Bézier ribbon outlines, strokes can be converted losslessly into clean, infinitely scalable SVG `<path d="...">` strings and copied to the system clipboard alongside rendered transparent PNGs.

Landing this plan adds a "Copy as SVG" / "Copy for Obsidian" action to the Lasso selection popover and context menu.

## Current state

- `inkwell-app/src/js/tools/lasso.js:11-100`:
  Lasso tool isolates selected strokes, images, and text objects with an exact bounding box (`[minX, minY, maxX, maxY]`).
- `inkwell-app/src/js/ink.js:362-531`:
  `traceRibbonContour(ctx, pts, baseWidth)` computes exact cubic Bézier curves and sharp corner vertices for all ink ribbons.
- `inkwell-app/src/js/core/clipboard.js:77-110`:
  `copySelectionToClipboard()` writes an internal JSON payload to clipboard for copy-pasting within InkWell, but does not emit standard vector SVG or image MIME types to the OS clipboard.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Desktop Smoke Test | `cd inkwell-app; py -3 test_app_smoke.py` | exit 0, all 75+ checks pass |

## Scope

**In scope**:
- `inkwell-app/src/js/core/clipboard.js`
- `inkwell-app/src/js/tools/lasso.js`
- `inkwell-app/src/js/ui/context-menu.js`
- `inkwell-app/src/index.html`

**Out of scope**:
- PDF rendering engine (`inkwell-core`).

## Steps

### Step 1: Implement SVG serializer for lasso selections

In `inkwell-app/src/js/core/clipboard.js`:
1. Implement `serializeSelectionToSvg({ strokes, images, textObjects, bbox })`:
   - Compute width and height: `w = bbox[2] - bbox[0] + 16`, `h = bbox[3] - bbox[1] + 16`.
   - Offset origin by `(bbox[0] - 8, bbox[1] - 8)`.
   - Construct `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`.
   - For each stroke:
     - If highlighter: `<path d="..." fill="${cssColor}" opacity="0.45" />`.
     - If pen: generate SVG path data `d="M x y C ... Z"` using `window.Ink.openPolylineToCubics` or contour points, with `fill="${cssColor}"`.
   - For each text object:
     - Emit `<text x="${t.x - minX}" y="${t.y - minY}" font-size="${t.fontSize}" font-family="Inter, sans-serif" fill="${t.color}">${escapeXml(t.text)}</text>`.
   - Close `</svg>`.

**Verify**: Verify generated SVG string validates with `DOMParser`.

### Step 2: Implement "Copy as SVG" to System Clipboard

In `inkwell-app/src/js/core/clipboard.js`:
1. Implement `copySelectionAsSvg()`:
   - Generate SVG string from `serializeSelectionToSvg`.
   - Also rasterize selection to an offscreen canvas at 2x scale and export as PNG blob.
   - Write to clipboard via `navigator.clipboard.write([ new ClipboardItem({ 'text/plain': new Blob([svgString], { type: 'text/plain' }), 'image/svg+xml': new Blob([svgString], { type: 'image/svg+xml' }), 'image/png': pngBlob }) ])`.
   - Show toast "Copied selection as SVG / Vector graphic".

**Verify**: Verify pasting into Obsidian or a text editor pastes clean SVG code, while pasting into Discord or Slack pastes the transparent PNG image.

### Step 3: Add "Copy as SVG" button to Lasso toolbar & Context Menu

1. In `inkwell-app/src/index.html:430-460` (Lasso floating popover):
   - Add button `#btnLassoCopySvg` with an SVG code icon and label "Copy as SVG".
2. In `inkwell-app/src/js/tools/lasso.js`:
   - Wire click listener on `#btnLassoCopySvg` to call `clipboard.copySelectionAsSvg()`.
3. In `inkwell-app/src/js/ui/context-menu.js`:
   - When lasso selection is active, show "Copy as SVG (Vector)" action item.

**Verify**: `cd inkwell-app; py -3 test_app_smoke.py` passes all checks.

## Done criteria

- [ ] Selecting handwritten notes or diagrams with the Lasso allows "Copy as SVG".
- [ ] Output SVG uses standard vector `<path d="...">` elements and scales losslessly.
- [ ] Clipboard payload contains both `image/svg+xml` and high-DPI `image/png`.
- [ ] Directly pasteable into Obsidian Markdown notes and LaTeX documents.
- [ ] All smoke tests pass.
