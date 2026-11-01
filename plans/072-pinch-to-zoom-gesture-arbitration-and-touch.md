# Plan 072: Touch & Trackpad Pinch-to-Zoom, Gesture Arbitration & WebView2 Host Zoom

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c036ee8..HEAD -- inkwell-app/src/js/viewport.js inkwell-app/src/js/main.js inkwell-app/src/js/tools/pen.js inkwell-app/src-tauri/src/main.rs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: LOW
- **Depends on**: 071
- **Category**: bug | ux
- **Planned at**: commit `c036ee8`, 2026-10-30

## Why this matters

Pinch-to-zoom is broken across touchscreens, WebKit trackpads, and split-pane views:
1. **Two-finger touch pinch draws and commits unwanted ink strokes (`[BUG-VP-02]`)**:
   - When Finger 1 touches down on `#wet`, `main.js:1150` captures the pointer and calls `penTool.onPenDown()`.
   - When Finger 2 touches down, `viewport.js:475` calls `window.cancelPendingTouchStroke()`, which **does not exist anywhere in the codebase** (`typeof window.cancelPendingTouchStroke === 'function'` is always `false`).
   - Worse, `onPointerDownGlobal` does not stop event propagation when `activeTouches.size >= 2`, so Finger 2's `pointerdown` reaches `#wet` and starts a second stroke, and `pointerrawupdate` on `#wet` continues feeding points into `penTool.onPenMove()` until `pointerup` commits the accidental stroke to the PDF and WAL.
2. **WebKit / Linux trackpad gesture crashes with `ReferenceError: relY is not defined` (`[BUG-VP-03]`)**:
   - In `viewport.js:432-438`, `onGestureChange` defines `relX` but never defines `relY`, then calls `this.setZoom(newZoom, [relX, relY], pane)`, throwing an unhandled `ReferenceError` on every trackpad pinch frame.
3. **Split-pane pinch focal point jump (`[BUG-VP-16]`)**:
   - When pinching in the right split pane, `viewport.js:483` initializes `pinchStartZoom` and `pinchStartPan` from `pane`, which gets overwritten if a finger crosses the divider or if `this.activePane` changes mid-pinch.
4. **Windows WebView2 precision touchpad pinch (Plan 057 follow-up)**:
   - On Windows WebView2, native pinch zoom must be enabled on `ICoreWebView2Settings` (`SetIsPinchZoomEnabled(true)`) while intercepting browser page-scale or wheel events cleanly so precision touchpad pinch zooms the canvas viewport rather than scaling the entire app chrome.

## Current state

- `inkwell-app/src/js/viewport.js:424-440`:
  ```javascript
    const onGestureChange = e => {
      e.preventDefault();
      if (!this.stageRect) this.updateStageRect();
      const stageRect = this.stageRect || { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
      const relX = e.clientX - stageRect.left;
      const pane = (this.splitMode && relX > stageRect.width / 2) ? 'right' : 'left';
      const newZoom = Math.max(0.15, Math.min(10.0, gestureStartZoom * (e.scale || 1.0)));
      this.setZoom(newZoom, [relX, relY], pane);
    };
  ```
- `inkwell-app/src/js/viewport.js:470-486`:
  ```javascript
      if (e.pointerType === 'touch') {
        this.activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.activeTouches.size >= 2) {
          this.isPinching = true;
          this.gestureOccurred = true;
          if (typeof window !== 'undefined' && typeof window.cancelPendingTouchStroke === 'function') {
            window.cancelPendingTouchStroke();
          }
          const pts = Array.from(this.activeTouches.values());
          const dx = pts[1].x - pts[0].x;
          const dy = pts[1].y - pts[0].y;
          this.pinchStartDist = Math.hypot(dx, dy) || 1;
          this.pinchStartMid = [(pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2];
          this.pinchStartZoom = pane === 'right' ? this.rightZoom : this.zoom;
          this.pinchStartPan = pane === 'right' ? [this.rightPanX, this.rightPanY] : [this.panX, this.panY];
        }
      }
  ```
- `inkwell-app/src/js/main.js:1131-1141`:
  ```javascript
    if (e.pointerType === 'pen') {
      state.isStylusActive = true;
      state.lastStylusTime = Date.now();
    } else if (e.pointerType === 'touch') {
      const isPalm = state.isStylusActive || (Date.now() - (state.lastStylusTime || 0) < 1000);
      if (isPalm) {
        // Touch rejected while stylus is in active handwriting session
        e.preventDefault();
        return;
      }
    }
  ```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Rust Workspace Tests | `cd inkwell && cargo test --workspace -- --test-threads=1` | exit 0, all tests pass |
| Rust Clippy | `cd inkwell && cargo clippy --all-targets` | exit 0, 0 warnings |
| App Smoke Tests | `cd inkwell-app && python3 test_app_smoke.py` | exit 0, all checks pass |

## Scope

**In scope**:
- `inkwell-app/src/js/viewport.js`
- `inkwell-app/src/js/main.js`
- `inkwell-app/src/js/tools/pen.js`
- `inkwell-app/src-tauri/src/main.rs`
- `inkwell-app/test_app_smoke.py`

**Out of scope**:
- Text selection and markup annotations (Plan 073).

## Steps

### Step 1: Fix `relY` crash in `onGestureChange` and lock `pinchPane` across the pinch lifecycle in `viewport.js`

1. In `inkwell-app/src/js/viewport.js`:
   - In `onGestureStart` and `onGestureChange` (lines 414–440), compute both `const relX = e.clientX - stageRect.left;` and `const relY = e.clientY - stageRect.top;`, and use `this.paneAtScreenX(relX)` to resolve the pane.
   - In `onPointerDownGlobal` (lines 470–486), when `this.activeTouches.size >= 2`:
     - Compute `this.pinchStartMid = [(pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2];`.
     - Lock `this.pinchPane = this.paneAtScreenX(this.pinchStartMid[0] - stageRect.left);` for the entire pinch gesture so moving a finger across the split divider mid-pinch does not switch panes and jump coordinates.
     - Call `e.preventDefault(); e.stopImmediatePropagation();` when `this.activeTouches.size >= 2` so `#wet` never receives the second finger's `pointerdown`.
   - In `onPointerMoveGlobal` (lines 497–540), use `const pane = this.pinchPane || this.activePane || 'left';` and call `e.preventDefault(); e.stopImmediatePropagation();` while `this.isPinching` is true.
   - Support single-finger touch panning when `state.touchDrawing === false` (or when active tool is `pan`), and clean up `this.pinchPane = null;` when `this.activeTouches.size < 2`.

**Verify**: `cd inkwell-app && python3 test_app_smoke.py` → exit 0.

### Step 2: Implement `window.cancelPendingTouchStroke` and guard `#wet` pointer handlers against multi-touch pinch

1. In `inkwell-app/src/js/main.js`:
   - Define and expose `window.cancelPendingTouchStroke = () => { ... }` which:
     - Calls `penTool.onPenCancel()`,
     - Resets `state.isErasing = false; state.lassoPath = null; state.shapeStart = null; state.shapeEnd = null; _panState.isDown = false;`,
     - Calls `compositor.clearWet()`.
   - In `wetCanvas` `pointerdown` (line 1134), `moveEvt` (`pointerrawupdate` / `pointermove`, line 1246), and `pointerup` (line 1307):
     - If `e.pointerType === 'touch' && _viewport && (_viewport.isPinching || _viewport.gestureOccurred || (_viewport.activeTouches && _viewport.activeTouches.size >= 2))`, immediately call `window.cancelPendingTouchStroke()` and `return;` without invoking any tool handler!

**Verify**: `cd inkwell-app && python3 test_app_smoke.py` → exit 0.

### Step 3: Add `VisualViewport` / WebView2 pinch-zoom bridge for Windows precision touchpads

1. In `inkwell-app/src/js/viewport.js` (`attachListeners`):
   - Add a `window.visualViewport` `'resize'` / `'scroll'` listener fallback and ensure `wheel` events with `e.ctrlKey || e.metaKey` (or `Math.abs(e.deltaY) < 50 && e.deltaMode === 0 && e.ctrlKey`) smoothly zoom around `[relX, relY]`.
2. In `inkwell-app/src-tauri/src/main.rs`:
   - Update `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` so it does NOT pass `--disable-pinch` (which blocks Chromium/WebView2 from synthesizing `WheelEvent` with `ctrlKey: true` on precision touchpad two-finger pinch), while keeping `--disable-features=OverscrollHistoryNavigation,TouchpadOverscrollHistoryNavigation`.

**Verify**: `cd inkwell && cargo clippy --all-targets && cd ../inkwell-app && python3 test_app_smoke.py` → exit 0.

## Test plan

- Add automated Playwright tests in `inkwell-app/test_app_smoke.py`:
  1. Dispatching `gesturestart` and `gesturechange` with `scale: 1.5, clientX: 300, clientY: 300` updates `_viewport.zoom` without throwing `ReferenceError: relY is not defined`.
  2. Dispatching two concurrent `pointerdown` events with `pointerType: 'touch'`, moving them apart (`pointermove` / `pointerrawupdate`), and releasing them (`pointerup`) zooms the viewport and commits **zero** strokes to `state.strokes`.

## Done criteria

- [ ] `cd inkwell && cargo clippy --all-targets` exits 0 with 0 warnings
- [ ] `cd inkwell-app && python3 test_app_smoke.py` exits 0 with gesture and two-finger touch pinch checks passing
- [ ] `typeof window.cancelPendingTouchStroke === 'function'` is true at runtime
- [ ] `plans/README.md` status row updated to `DONE`

## STOP conditions

- Any existing test in `test_app_smoke.py` or `cargo test` fails.
- The code at the locations in "Current state" doesn't match the excerpts.

## Maintenance notes

- Keep `pointerrawupdate` on `wetCanvas` guarded by `_viewport.isPinching || _viewport.gestureOccurred` because `pointerrawupdate` fires before standard `pointermove` bubble handlers.
