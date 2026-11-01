# Plan 073: Precision Text Selection Engine, Cross-Page Ranges, Multi-Line Search & Text Markup Annotations

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c036ee8..HEAD -- inkwell-app/src/index.html inkwell-app/src/js/workspace/text-selection.js inkwell-app/src/js/ui/drawers.js inkwell-app/src/js/render/overlays.js inkwell-app/src/js/main.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: M–L
- **Risk**: LOW
- **Depends on**: 071
- **Category**: bug | feature
- **Planned at**: commit `c036ee8`, 2026-10-30

## Why this matters

PDF text selection, search highlights, and text-markup annotations currently fail in five ways:
1. **Inverted distance weighting in hit-testing (`[BUG-VP-10]`)**: `findCharAndOffsetAtPageCoord` (`text-selection.js:170`) uses `totalDist = distY * 8.0 + distX` with `maxDist = 80`. Clicking 11pt above/below a line fails (`11 * 8 = 88 > 80`), while clicking 75pt out in the blank page margin snaps to the line's first/last character (`distY = 0, distX = 75 < 80`).
2. **Broken cross-page text selection (`[BUG-VP-11]`)**: In `main.js:1290-1294`, dragging a text selection across page boundaries computes `pageCoord = _viewport.worldToPage(...)` (which returns `pageCoord.sheet = 1, py = 15`), but passes `anchor.sheet` (`0`) to `findCharAndOffsetAtPageCoord(anchor.sheet, pageCoord.px, pageCoord.py)`, snapping the selection backward to the top of page 0!
3. **Dead text markup buttons (`[BUG-VP-12]` / `[DIR-05]`)**: `#btnTextHighlight`, `#btnTextUnderline`, and `#btnTextStrikethrough` in `#textSelectionPopover` (`index.html:418-428`) have `class="sel-action-btn hidden"` and zero event listeners in `main.js`. Users cannot highlight, underline, or strike through selected PDF text.
4. **Distorted multi-line search highlight boxes (`[BUG-VP-13]`)**: `buildSearchRects` (`drawers.js:635-653`) merges `minX, minY, maxX, maxY` across all matched characters without partitioning by `line_index`. Any search match wrapping across two lines draws a giant rectangle covering the entire width of the page.
5. **Duplicate dead `drawSearchHighlights` (`[ARCH-02]`)**: `text-selection.js:364-389` defines an unused duplicate of `overlays.drawSearchHighlights`.

## Current state

- `inkwell-app/src/js/workspace/text-selection.js:162-179`:
  ```javascript
      let distY = 0;
      if (py < ly0) distY = ly0 - py;
      else if (py > ly1) distY = py - ly1;

      let distX = 0;
      if (px < lx0) distX = lx0 - px;
      else if (px > lx1) distX = px - lx1;

      const totalDist = distY * 8.0 + distX;
      if (totalDist < bestLineDist) {
        bestLineDist = totalDist;
        bestLine = line;
      }
    }

    if (!bestLine || (Number.isFinite(maxDist) && bestLineDist > maxDist)) {
      return null;
    }
  ```
- `inkwell-app/src/js/main.js:1289-1297`:
  ```javascript
          if (state.isSelectingText && state.textSelectAnchor) {
            const pageCoord = _viewport.worldToPage(ptWorld[0], ptWorld[1]);
            const anchor = state.textSelectAnchor;
            const hit = textSelection.findCharAndOffsetAtPageCoord(anchor.sheet, pageCoord.px, pageCoord.py);
            if (hit) {
              state.textSelection = textSelection.computeTextSelectionRanges(anchor.sheet, anchor.charIndex, hit.charIndex);
              if (state.textSelection) state.selectedTextString = state.textSelection.text;
              compositor.redrawAll();
            }
          }
  ```
- `inkwell-app/src/js/ui/drawers.js:635-653`:
  ```javascript
        const matchedChars = chars.slice(pos, pos + qLower.length);
        if (matchedChars.length > 0) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const ch of matchedChars) {
            if (ch.rect) {
              minX = Math.min(minX, ch.rect[0]);
              minY = Math.min(minY, ch.rect[1]);
              maxX = Math.max(maxX, ch.rect[2]);
              maxY = Math.max(maxY, ch.rect[3]);
            }
          }
          if (minX !== Infinity) {
            searchRects.push({
              pageIndex,
              rect: [minX, minY, maxX, maxY],
              snippet: item.snippet,
            });
          }
        }
  ```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| App Smoke Tests | `cd inkwell-app && python3 test_app_smoke.py` | exit 0, all checks pass |
| Rust Workspace Tests | `cd inkwell && cargo test --workspace -- --test-threads=1` | exit 0, all tests pass |

## Scope

**In scope**:
- `inkwell-app/src/index.html`
- `inkwell-app/src/js/workspace/text-selection.js`
- `inkwell-app/src/js/ui/drawers.js`
- `inkwell-app/src/js/render/overlays.js`
- `inkwell-app/src/js/main.js`
- `inkwell-app/test_app_smoke.py`

**Out of scope**:
- Rust backend changes.

## Steps

### Step 1: Fix hit-testing bounds, multi-page selection ranges, and Unicode word segmentation in `text-selection.js`

1. In `inkwell-app/src/js/workspace/text-selection.js`:
   - In `findCharAndOffsetAtPageCoord(sheet, px, py, { maxDist = 28 } = {})` (lines 149–180):
     - Reject clicks where `distY > maxDist` or `distX > maxDist * 1.2` so clicking far in blank page margins returns `null` instead of snapping to the nearest line edge, while clicking within `28pt` vertically of a line reliably hits it.
     - Rank candidate lines by `distY * 2.5 + distX * 0.5`.
   - Extend `computeTextSelectionRanges(startSheet, startCharIdx, endCharIdx, endSheet = startSheet)`:
     - Support cross-page selection from `(startSheet, startCharIdx)` to `(endSheet, endCharIdx)`:
       - When `startSheet === endSheet`, behave identically to today (`sheet: startSheet`).
       - When `startSheet !== endSheet`, normalize ordering `(s0, c0)` to `(s1, c1)` so `s0 < s1`, collect `rects` and `text` from `s0` (`char_index >= c0`), any intermediate sheets `s0 < s < s1` (all chars), and `s1` (`char_index <= c1`), joining sheets with `'\n\n'` and tagging each rect with its `sheet`.
   - In `expandSelectionToWord(sheet, charIndex)` (line 298), use `Intl.Segmenter` (when available) over the line text so complex scripts (such as Bangla/Devanagari conjuncts) and punctuation boundaries segment cleanly.
   - Delete the unused duplicate `drawSearchHighlights` function at lines 364–389 of `text-selection.js`.

**Verify**: `cd inkwell-app && python3 test_app_smoke.py` → exit 0.

### Step 2: Wire cross-page drag selection and `#btnTextHighlight`, `#btnTextUnderline`, `#btnTextStrikethrough` in `main.js` and `index.html`

1. In `inkwell-app/src/index.html:418-428`:
   - Remove the `hidden` class from `#btnTextHighlight`, `#btnTextUnderline`, and `#btnTextStrikethrough` so all three text-markup action buttons are visible inside `#textSelectionPopover`.
2. In `inkwell-app/src/js/main.js`:
   - In `wetCanvas` `moveEvt` (`textSelect` branch, lines 1289–1298):
     - Ensure text data for `pageCoord.sheet` is loaded (`textSelection.ensurePageTextData(pageCoord.sheet)`), hit-test against `pageCoord.sheet` (`textSelection.findCharAndOffsetAtPageCoord(pageCoord.sheet, pageCoord.px, pageCoord.py, { maxDist: 48 })`), and call `textSelection.computeTextSelectionRanges(anchor.sheet, anchor.charIndex, hit.charIndex, pageCoord.sheet)`.
   - Attach click listeners to `#btnTextHighlight`, `#btnTextUnderline`, and `#btnTextStrikethrough` (around line 845):
     - Helper `applyTextSelectionMarkup(mode)` (`'highlight' | 'underline' | 'strikethrough'`):
       - For each line rect `r` in `state.textSelection.rects`:
         - `[x0, y0, x1, y1] = r.rect`, `lineH = Math.max(8, y1 - y0)`.
         - For `'highlight'`: create a stroke with `kind: 'highlighter'`, `rgb: state.highlighterColor || [0.98, 0.88, 0.15]`, `base_width: lineH * 0.95`, and points along `y = (y0 + y1) / 2` from `x0` to `x1`.
         - For `'underline'`: create a stroke with `kind: 'pen'`, `rgb: state.penColor || [0.94, 0.27, 0.27]`, `base_width: Math.max(1.2, lineH * 0.08)`, and points along `y = y1 - 1` from `x0` to `x1`.
         - For `'strikethrough'`: create a stroke with `kind: 'pen'`, `rgb: state.penColor || [0.94, 0.27, 0.27]`, `base_width: Math.max(1.2, lineH * 0.08)`, and points along `y = (y0 + y1) / 2` from `x0` to `x1`.
       - Commit all generated strokes as a single undoable batch (`documentOps.addObjectsBatch({ strokes: createdStrokes })` + `ipc.commitStroke` for each), clear text selection, hide `#textSelectionPopover`, and call `compositor.redrawAll()`.

**Verify**: `cd inkwell-app && python3 test_app_smoke.py` → exit 0.

### Step 3: Partition multi-line search matches by `line_index` in `drawers.js`

1. In `inkwell-app/src/js/ui/drawers.js` (`buildSearchRects`, lines 635–653):
   - Group `matchedChars` by `ch.line_index` and emit one search highlight rect per line (instead of a single bounding box across all lines) so multi-line search hits highlight cleanly line-by-line.

**Verify**: `cd inkwell-app && python3 test_app_smoke.py` → exit 0.

## Test plan

- Add automated checks in `inkwell-app/test_app_smoke.py`:
  1. Clicking 70pt outside a text line margin returns `null` from `findCharAndOffsetAtPageCoord` (does not false-snap).
  2. Cross-page `computeTextSelectionRanges(0, 0, 5, 1)` returns rects spanning both sheet `0` and sheet `1`.
  3. Clicking `#btnTextHighlight`, `#btnTextUnderline`, and `#btnTextStrikethrough` on an active text selection creates persistent strokes matching the selection line rects and supports `Ctrl+Z` undo.
  4. `buildSearchRects` for a match spanning two lines produces 2 per-line rects instead of 1 giant rect.

## Done criteria

- [ ] `cd inkwell-app && python3 test_app_smoke.py` exits 0 with new text selection, markup, and search rect checks passing
- [ ] `#btnTextHighlight`, `#btnTextUnderline`, and `#btnTextStrikethrough` are visible and functional in `#textSelectionPopover`
- [ ] `grep -n "export function drawSearchHighlights" inkwell-app/src/js/workspace/text-selection.js` returns no matches
- [ ] `plans/README.md` status row updated to `DONE`

## STOP conditions

- Any existing test in `test_app_smoke.py` fails.
- The code at the locations in "Current state" doesn't match the excerpts.

## Maintenance notes

- Because text markups (`highlight`, `underline`, `strikethrough`) are committed as standard InkWell vector strokes, they automatically serialize into Layer 1 (filled vector appearance), Layer 2 (`/Ink` annotation), and Layer 3 (lossless sidecar) and work with existing Eraser and Lasso tools.
