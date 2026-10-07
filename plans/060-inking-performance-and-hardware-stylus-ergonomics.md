# Plan 060: Inking Performance & Hardware Stylus Ergonomics

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 3bf08b7..HEAD -- inkwell-app/src/js/tools/pen.js inkwell-app/src/js/main.js inkwell-app/src/styles.css inkwell-app/src/js/viewport.js inkwell-app/src/js/ui/radial-menu.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf | ux
- **Planned at**: commit `3bf08b7`, 2026-10-07

## Why this matters

Writing with a stylus is the core physical interaction in InkWell. Currently, four paper-cuts degrade this experience:
1. Every pen stroke release triggers an $O(N)$ full repaint of all strokes and images (`compositor.redrawAll()`) instead of an $O(1)$ single-stroke blit (`compositor.drawCommittedStroke(stroke)`), creating latency hitches on note pages with hundreds of strokes.
2. Palm rejection is absent: resting a palm while drawing creates stray marks and corrupts in-flight pen strokes.
3. Highlighters composite with source-over alpha blending instead of true optical multiply, casting a milky haze over black PDF text.
4. Stylus hardware barrel button is blocked by an unwanted context menu instead of momentarily switching to eraser or opening the existing radial quick menu.

Landing this plan eliminates wet-to-dry inking lag, enables seamless palm-rest handwriting, renders vivid optical highlighter blending, and activates the pen barrel button.

## Current state

- `inkwell-app/src/js/tools/pen.js:88-90`:
  ```javascript
  compositor.clearWet();
  compositor.redrawAll();
  ```
  `onPenUp` clears the wet canvas and forces a full repaint of all elements across all visible pages.
- `inkwell-app/src/js/render/compositor.js:292-309`:
  ```javascript
  export function drawCommittedStroke(stroke) {
    if (!_dctx || !_viewport || !stroke) return;
    const pl = _viewport.getPageLayout(stroke.sheet || 0);
    // ... draws single stroke with DPR scale, transform, and pane clipping
  }
  ```
  `drawCommittedStroke(stroke)` is fully implemented and correct, but has 0 call sites across the codebase.
- `inkwell-app/src/js/viewport.js:475-476`:
  ```javascript
  if (typeof window !== 'undefined' && typeof window.cancelPendingTouchStroke === 'function') {
    window.cancelPendingTouchStroke();
  }
  ```
  `cancelPendingTouchStroke` is called when a pinch gesture begins, but is never defined anywhere.
- `inkwell-app/src/js/main.js:1035-1070`:
  `wetCanvas.addEventListener('pointerdown', e => ...)` does not inspect `e.pointerType`. When a user rests their palm while writing, `e.pointerType === 'touch'` enters `penTool.onPenDown(e, ...)` and creates stray marks.
- `inkwell-app/src/styles.css:1323-1325`:
  `#dry { z-index: 2; }` lacks `mix-blend-mode: multiply;`, so highlighter strokes composite over the underlying `#tiles` layer using default source-over alpha blending.
- `inkwell-app/src/js/ui/radial-menu.js:11-30`:
  `showRadialMenu(screenX, screenY)` exists with SVG icons and 6 tool slots, but has zero call sites in the application.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Desktop Smoke Test | `cd inkwell-app; py -3 test_app_smoke.py` | exit 0, all 75+ checks pass |
| Prototype Smoke Test | `cd inkwell-m0; py -3 test_smoke.py` | exit 0, all 18 checks pass |

## Scope

**In scope**:
- `inkwell-app/src/js/tools/pen.js`
- `inkwell-app/src/js/render/compositor.js`
- `inkwell-app/src/js/main.js`
- `inkwell-app/src/styles.css`
- `inkwell-app/src/js/viewport.js`
- `inkwell-app/src/js/ui/radial-menu.js`
- `inkwell-app/test_app_smoke.py`

**Out of scope**:
- DirectManipulation touch pinch zoom on Windows WebView2 (tracked under Plan 057).
- Rust backend modifications (`inkwell-core`, `inkwell-pdf`).

## Steps

### Step 1: Use `drawCommittedStroke` in `onPenUp` for $O(1)$ stroke commit

In `inkwell-app/src/js/tools/pen.js:88-90`:
1. When `stroke.points && stroke.points.length > 0`, clear wet canvas with `compositor.clearWet()`.
2. Draw the committed stroke directly onto the dry canvas with `compositor.drawCommittedStroke(stroke)`.
3. Do NOT call `compositor.redrawAll()`. Full repaints remain reserved for undo, redo, erase, and viewport transforms.

**Verify**: `cd inkwell-app; py -3 test_app_smoke.py` → passes without console errors.

### Step 2: Implement palm rejection and touch isolation on drawing canvas

1. In `inkwell-app/src/js/main.js`, track stylus active state:
   - When a pointer event with `e.pointerType === 'pen'` occurs, set `state.isStylusActive = true` and update a timestamp `state.lastStylusTime = Date.now()`.
   - In `wetCanvas.addEventListener('pointerdown', e => ...)`, if `e.pointerType === 'touch'`:
     - If `state.isStylusActive` is true or `Date.now() - (state.lastStylusTime || 0) < 800` (stylus cooldown), ignore the touch event (`e.preventDefault()`, do not start a pen/eraser/lasso stroke).
     - Otherwise, if two or more touches are detected, allow viewport gestures.
2. Define `window.cancelPendingTouchStroke`:
   - If a touch stroke is in-flight when `viewport` initiates pinch/pan, call `penTool.onPenCancel()`, clear the wet canvas, and remove any partial stroke.

**Verify**: Test in browser / smoke suite that pen drawing works and touch during pen input is safely ignored.

### Step 3: Implement true optical multiply blending for highlighters

1. In `inkwell-app/src/styles.css`, update canvas layering or give the dry canvas (or a dedicated highlighter canvas) `mix-blend-mode: multiply;` against the `#tiles` underlay:
   ```css
   #dry {
     z-index: 2;
     mix-blend-mode: multiply;
   }
   ```
2. In `compositor.js:240-255`, ensure text objects and embedded images are drawn before ink strokes, or isolate highlighters so black PDF text on `#tiles` remains jet black beneath translucent yellow highlighters.

**Verify**: In browser, verify highlighter strokes drawn over PDF text do not create milky grey text.

### Step 4: Wire stylus barrel button and radial quick menu

1. In `inkwell-app/src/js/main.js:1036-1040`:
   - Inspect `e.pointerType === 'pen' && (e.button === 2 || e.buttons === 2 || e.buttons === 32)`.
   - When the stylus barrel button is pressed, call `e.preventDefault()`, do not open the default context menu, and either:
     - Activate momentary eraser or lasso mode while the button is held down, or
     - Open `radialMenu.showRadialMenu(e.clientX, e.clientY)`.
2. Add a global keyboard shortcut (key `'q'` or `'Q'`) to toggle `radialMenu.showRadialMenu(window.innerWidth / 2, window.innerHeight / 2)` or current pointer position.

**Verify**: `py -3 test_app_smoke.py` passes all checks, verifying radial menu and barrel button interactions.

## Done criteria

- [ ] Pen-up commits strokes to the dry canvas via `drawCommittedStroke` without executing full document repaints.
- [ ] Palm touch during stylus input is rejected with zero stray strokes.
- [ ] Highlighter strokes optically multiply against underlying PDF tiles without milky opacity over text.
- [ ] Stylus barrel button does not trigger unwanted context menus.
- [ ] Radial menu is triggerable via hotkey and stylus button.
- [ ] `cd inkwell-app; py -3 test_app_smoke.py` exits 0 with all checks passing.
