# Plan 064: Page Management Suite & Thumbnail Rail Navigation

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 3bf08b7..HEAD -- inkwell-app/src/js/ui/drawers.js inkwell-app/src/index.html inkwell-app/src/js/workspace/navigation.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/061-state-and-transaction-integrity.md
- **Category**: ux | direction
- **Planned at**: commit `3bf08b7`, 2026-10-07

## Why this matters

In digital notebook workflows, reorganizing lecture notes, duplicating template pages, deleting scratch sheets, and bookmarking key reference points are essential operations:
1. Currently, InkWell only exposes blank page insertion. Page deletion, duplication, and reordering exist in backend IPC commands (`commands.rs:1363-1460`), but have zero UI controls.
2. The thumbnail drawer renders solid blank rectangles (`ctx.fillRect`) rather than visual page previews.
3. The Bookmarks drawer has a "#btnAddBookmark" button and "#bookmarksList" in HTML, but no event listener is attached and clicking the button produces no response.

Landing this plan equips users with a full visual page management rail: visual thumbnails, hover page actions (delete, duplicate), drag-and-drop page reordering, and a working bookmarking workflow.

## Current state

- `inkwell-app/src/js/ui/drawers.js:185-195`:
  `renderThumbnails()` creates `<canvas>` elements and fills them with solid white or dark slate rectangles. No actual PDF or ink rendering occurs.
- `inkwell-app/src-tauri/src/commands.rs:1363, 1385, 1453`:
  `delete_page`, `duplicate_page`, and `reorder_page` are implemented, registered with Tauri, and exported via `ipc.js:208-218`.
- `inkwell-app/src/index.html:171-177`:
  `#btnAddBookmark` ("Bookmark Current Page") and `#bookmarksList` exist in the DOM, but have zero click listeners in `drawers.js`.
- `inkwell-app/src/js/core/state.js:86`:
  `state.bookmarks = []` already exists in state.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Desktop Smoke Test | `cd inkwell-app; py -3 test_app_smoke.py` | exit 0, all 75+ checks pass |
| Tauri Clippy | `cd inkwell-app/src-tauri; cargo clippy --all-targets` | exit 0, zero warnings |

## Scope

**In scope**:
- `inkwell-app/src/js/ui/drawers.js`
- `inkwell-app/src/index.html`
- `inkwell-app/src/styles.css`
- `inkwell-app/src/js/workspace/navigation.js`
- `inkwell-app/test_app_smoke.py`

**Out of scope**:
- DirectManipulation touch pinch zoom on Windows (Plan 057).

## Steps

### Step 1: Wire working Bookmarks workflow

In `inkwell-app/src/js/ui/drawers.js`:
1. Attach click listener to `$('btnAddBookmark')`:
   - When clicked, check if `state.leftSheet` is already bookmarked. If not, push `{ id: 'bm_' + Date.now(), page: state.leftSheet, label: 'Page ' + (state.leftSheet + 1), createdAt: Date.now() }` to `state.bookmarks`.
   - Update `state.isDirty = true`.
   - Call `renderBookmarks()`.
2. Implement `renderBookmarks()`:
   - Render bookmark cards into `$('bookmarksList')` displaying page number, custom title, and a delete button.
   - Clicking a card calls `navigation.goToPage(bm.page, 'left', getViewport())`.
   - Clicking the delete button removes the bookmark from `state.bookmarks` and re-renders.

**Verify**: In browser, clicking "Bookmark Current Page" creates a clickable card that jumps to the page.

### Step 2: Render visual page previews on thumbnail cards

In `inkwell-app/src/js/ui/drawers.js:175-212` (`renderThumbnails`):
1. In each `thumb-card`:
   - Request or draw low-resolution page preview on the thumbnail canvas:
     - Render template background (plain, lined, grid, dot).
     - Scale and draw the sheet's committed vector strokes using `window.Ink.drawStroke` with scaled transform.
     - Optionally fetch low-res base PDF thumbnail via `ipc.renderTile`.
2. Add hover action bar on each card:
   - "Duplicate Page" icon button (`btn-thumb-duplicate`).
   - "Delete Page" icon button (`btn-thumb-delete`) (disabled if `state.pageInfos.length <= 1`).

**Verify**: Opening the thumbnail rail displays visible ink strokes on thumbnail cards.

### Step 3: Wire Page Duplicate and Delete actions

In `inkwell-app/src/js/ui/drawers.js`:
1. On "Duplicate Page" click:
   - Call `await ipc.duplicatePage(pageIdx)`.
   - Update `state.pageInfos`, copy strokes/images/text to the new page, and invoke `renderThumbnails()`.
   - Show toast "Page duplicated".
2. On "Delete Page" click:
   - Prompt user confirmation: "Delete Page X?".
   - On confirm: call `await ipc.deletePage(pageIdx)`.
   - Adjust active page index if needed, update `state.pageInfos`, and call `navigation.goToPage`.
   - Show toast "Page deleted".

**Verify**: Test duplicating and deleting a page; verify total page count updates in toolbar dropdown.

### Step 4: Implement drag-and-drop page reordering

1. In `inkwell-app/src/js/ui/drawers.js`:
   - Add HTML5 drag attributes to `.thumb-card`: `draggable="true"`.
   - On `dragstart`: store source page index in `e.dataTransfer`.
   - On `dragover`: add visual drop indicator border.
   - On `drop`: read target index, call `await ipc.reorderPage(sourceIdx, targetIdx)`.
   - Update `state.pageInfos`, update sheet indices on strokes/images/text, and re-render thumbnails.

**Verify**: `cd inkwell-app; py -3 test_app_smoke.py` passes all checks.

## Done criteria

- [ ] Bookmarks drawer allows adding, viewing, jumping to, and deleting page bookmarks.
- [ ] Thumbnail cards render page template and vector ink strokes instead of blank solid color boxes.
- [ ] Users can duplicate pages directly from the thumbnail rail.
- [ ] Users can delete pages (with confirmation) from the thumbnail rail.
- [ ] Users can drag and drop thumbnail cards to reorder pages.
- [ ] Smoke tests pass with zero console errors.
