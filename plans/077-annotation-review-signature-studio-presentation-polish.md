# Plan 077: Annotation Review, Signature Studio, Presentation Mode & Interaction Polish

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: 071, 073, 075, 076
- **Category**: ux | feature | perf | accessibility | tests
- **Executed**: 2026-11-01 against `c036ee8` (working tree)
- **Result**: DONE — 126/126 desktop checks, Rust workspace tests and Clippy green

## Why this mattered

The app could create marks but could not **review** them. A professional PDF
annotator needs a single place to audit every mark on every page, jump back to
it, filter by type, and hand the result to another tool. Drawboard, Acrobat and
LiquidText all treat the annotation list as a first-class surface; InkWell did
not. Three other daily-driver gaps surfaced during the audit:

1. **No review surface** for strokes, highlights, text notes, images and stamps.
2. **No signature / stamp workflow** — a table-stakes PDF capability.
3. **No presentation mode** for teaching, review meetings and screen shares.
4. **Thumbnail rendering was fully synchronous** for every page, so large
   notebooks blocked the UI when the drawer opened. Thumbnails also silently
   dropped images (`im.element` was never set; the loader stores `_el`), and
   per-page annotation counts were only the static badge "1".
5. **Shape selection was broken for triangle and arrow** — the selector called
   `setTool('shapes')`, a tool the pointer pipeline does not understand.
6. Custom colour slots were decorative "+" buttons with no behaviour; the
   property popover showed the shape selector for the pen; the settings Engine
   panel had malformed card nesting.
7. Canvas right-click opened the object menu on top of floating UI chrome.

## What shipped

### 1. Annotation Review drawer (`workspace/annotations.js`)

- Aggregates ink, highlighter/markup, text notes, images, signatures and stamps.
- Page-grouped list with type icons, colour chips, snippet, point count, width
  and optional creation time.
- Filter chips (All / Ink / Markup / Text / Images), debounced full-text search,
  live rail badge, footer count.
- Click jumps to the page, centres the annotation in the viewport and selects
  the underlying object with the lasso transform handles.
- Per-item delete is undoable through the existing document transaction layer; text notes also expose an inline **Edit** action.
- Progressive 200-item rendering for very large documents, with scroll preservation across live refreshes.
- **Copy summary** exports a page-grouped Markdown digest (title, page headings,
  annotation lines) for Obsidian, Notion or email.
- Replaces the hidden "Vector Layers" placeholder; wired to `Ctrl+Shift+A`.

### 2. Signature & Stamp Studio (`ui/signature.js`)

- **Draw** pad with quadratic smoothing, colour choice, thickness, stroke undo
  and clear. Output is trimmed to the actual ink bounds.
- **Type** signatures in three hands (signature in the bundled OFL Caveat face,
  classic, modern) with live preview.
- **Eight stamp presets** (Approved, Reviewed, Draft, Confidential, Paid, Void,
  Received, Date) rendered as transparent, slightly rotated, double-bordered
  marks with today's date for the date stamp.
- Recent signatures persist in `localStorage` (max 6, deduplicated, clearable).
- Insertion reuses the image pipeline, so marks become native PDF image objects,
  are immediately selected for repositioning, participate in undo/redo and are
  journaled to the WAL. Shortcut `I`; dock and More-menu entry.

### 3. Presentation mode (`ui/presentation.js`)

- `F5` hides the rail, header, dock, zoom dock, scrollbar, selection popovers and
  canvas edge paging; fits and centres the active page on a black stage.
- Arrow keys / Space / Enter page; `B` or `.` toggles the blank-screen cut;
  `L`/`K` returns to the laser; `Esc` exits.
- Auto-dimming HUD with previous/next, page counter, blank and exit.
- Captures and restores zoom, pan, split state and active tool on exit.
- The canvas zoom watermark is suppressed while presenting.

### 4. Thumbnail performance and fidelity (`ui/drawers.js`)

- Canvas painting is deferred via `IntersectionObserver` and a 3-per-frame
  animation-frame budget; the first three pages paint immediately.
- Uses the spatial stroke map (`_strokesBySheet`) instead of scanning all strokes
  for every page.
- Fixes image thumbnails by reading `_el || element`.
- Adds a per-page annotation-count badge and updates the rail badge from the real
  page count.
- Scrolls the active page into view when the drawer opens.
- Viewport keeps the world point at the pane centre stable through window/sidebar resizes.

### 5. Interaction polish

- Fixed triangle/arrow shape routing (`setTool` first, then `setShapeKind`) so
  every shape kind draws.
- Custom colour slots persist (`inkwell.customColors.v1`), apply on click and
  clear on right-click; hand-picked colours auto-fill the first free slot.
- Shape selector only appears for geometry tools; the title follows the selected
  shape; the stroke preview is drawn on a paper-white strip so black ink is
  visible on the dark inspector.
- Fixed malformed settings-card nesting and made the reading-mode selector
  reachable.
- Canvas context menu ignores floating chrome and text inputs.
- Toast system: max 4 visible, duplicate coalescing, click-to-dismiss, type
  icons, life bar and `prefers-reduced-motion` support.
- Outline empty state now exposes the previously hidden "Bookmark Current Page"
  action.
- Page-count badge stays current on every document mutation.
- Expanded hit areas for the new dense review/signature controls.

## Files changed

- `inkwell-app/src/index.html`
- `inkwell-app/src/styles.css`
- `inkwell-app/src/js/main.js`
- `inkwell-app/src/js/core/state.js`
- `inkwell-app/src/js/core/clipboard.js`
- `inkwell-app/src/js/render/compositor.js`
- `inkwell-app/src/js/ui/drawers.js`
- `inkwell-app/src/js/ui/toolbar.js`
- `inkwell-app/src/js/ui/toast.js`
- `inkwell-app/src/js/ui/signature.js` (new)
- `inkwell-app/src/js/ui/presentation.js` (new)
- `inkwell-app/src/js/workspace/annotations.js` (new)
- `inkwell-app/test_app_smoke.py` (T17–T22, 18 new checks)

No Rust changes were required; all new marks go through the existing vector,
image, WAL and incremental-save pipelines.

## Verification

Large-document spot check (Chromium harness, 300 pages / 3000 strokes): annotation badge count
1.5 ms (was 208 ms), review first page 46 ms for 200 cards (was 489 ms for 3000 cards),
thumbnail DOM 105 ms with canvases painted lazily three per frame.

| Command | Result |
|---|---|
| `cd inkwell-app && py -3 test_app_smoke.py` | 126/126 checks pass, zero console errors |
| `cd inkwell && cargo test --workspace -- --test-threads=1` | all workspace tests pass |
| `cd inkwell && cargo clippy --all-targets` | zero warnings |

## Deliberately not included

- Semantic PDF `/Highlight` annotations with `/QuadPoints` (current markup is
  vector ink; visual fidelity and re-editing are preserved, semantic markup is a
  separate interoperability project).
- Per-annotation author/date persistence in the sidecar (requires a schema bump).
- True thumbnail virtualization (DOM recycling for 1000+ pages); lazy painting
  removes the dominant cost without changing navigation semantics.
