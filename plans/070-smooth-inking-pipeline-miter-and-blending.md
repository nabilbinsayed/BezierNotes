# Plan 070: Zero-Latency Smooth Inking Pipeline, One-Euro Restoration, Miter Geometry & Canvas Blending

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c036ee8..HEAD -- inkwell-app/src/js/ink.js inkwell-app/src/js/tools/pen.js inkwell-app/src/js/render/compositor.js inkwell-app/src/styles.css inkwell/crates/inkwell-core/src/ink.rs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: MED
- **Depends on**: 069
- **Category**: bug | perf | correctness
- **Planned at**: commit `c036ee8`, 2026-10-30

## Why this matters

Pen strokes currently suffer from seven compounding defects that make handwriting feel laggy, faceted, and visually unstable:
1. **`OneEuro` filter is dead code**: `pen.js:18` constructs `new window.Ink.Stroke(...)` (which initializes `OneEuro` filters `_fx` and `_fy`), but `consumeFilteredPoint` (`pen.js:139`) pushes directly to `state.cur.points` instead of calling `state.cur.push()`, completely bypassing `OneEuro`.
2. **Zoom-inverted `Streamline` stabilization**: `Streamline.filter` (`ink.js:89`) computes `dynamicLerp` using `dist` in page points instead of screen pixels (`dist * zoom`). At 400% zoom, `dist` is tiny so `Streamline` locks into heavy lag; at 25% zoom, `dist` is large so stabilization turns off.
3. **Needle-spike artifacts across page boundaries**: `renderActiveWetStroke` (`pen.js:186`) passes predicted pointer events through `viewport.worldToPage(wx[0], wx[1])`, which switches sheets and clamps `py` to `[0, pl.height]` when the pointer nears a page edge, shooting spikes across the page.
4. **$O(N^2)$ wet-canvas redraw & commit snap**: Every pointer move (`pen.js:204-224`) runs `smoothStrokePoints` over the entire point array and re-traces all Catmull-Rom cubics from point `0` to `N`. Then `onPenUp` (`pen.js:65-67`) mutates `stroke.points = window.Ink.smoothStrokePoints(stroke.points, 1)` a second time, causing the stroke to visibly shift/snap when lifting the pen.
5. **Corner pinching and hairpin loops in ribbon geometry**: In `ink.js:441-479` and `ink.rs:730-764`, vertex miter normals normalize `n0 + n1` to unit length `1.0` instead of miter length `1 / cos(half_angle)`, pinching 90° turns by 30%, and snap `norm = n0` when `dot < -0.2`, creating self-intersecting loops.
6. **Global `#dry { mix-blend-mode: multiply }` breaks white ink and embedded images**: `styles.css:1337` applies `mix-blend-mode: multiply` to the entire `#dry` canvas DOM element, making white/light pen ink invisible on dark backgrounds and muddying user-inserted images against template lines.
7. **Dead chisel highlighter geometry**: `getChiselPath2D` in `ink.js:281-326` is never called by `getPath2D` or `pen.js`.

## Current state

- `inkwell-app/src/js/tools/pen.js:64-73` and `112-145`:
  ```javascript
    if (stroke.points && stroke.points.length > 0) {
      if (stroke.points.length > 2 && window.Ink && typeof window.Ink.smoothStrokePoints === 'function') {
        stroke.points = window.Ink.smoothStrokePoints(stroke.points, 1);
      }
      if (window.Ink && typeof window.Ink.computeStrokeBbox === 'function') {
        stroke.bbox = window.Ink.computeStrokeBbox(stroke.points, stroke.base_width);
      }
      if (window.Ink && typeof window.Ink.getPath2D === 'function') {
        stroke._cachedPath2D = window.Ink.getPath2D(stroke);
      }
  ...
    if (state.streamline) {
      const smoothed = state.streamline.filter(px, py, p);
      consumeFilteredPoint(smoothed.x, smoothed.y, smoothed.p, t, pane, viewport, shouldRender, rawEvent);
    } else {
      consumeFilteredPoint(px, py, p, t, pane, viewport, shouldRender, rawEvent);
    }
  ```
- `inkwell-app/src/js/tools/pen.js:184-194`:
  ```javascript
            for (let k = 0; k < preds.length; k++) {
              const predEvt = preds[k];
              const wx = viewport.screenToWorld(predEvt.clientX - r.left, predEvt.clientY - r.top, pane);
              const pc = viewport.worldToPage(wx[0], wx[1]);
              predicted.push({
                x: pc.px,
                y: pc.py,
                p: lastPt.p,
                w: lastPt.w,
                t: predEvt.timeStamp || performance.now(),
              });
            }
  ```
- `inkwell-app/src/js/ink.js:460-478`:
  ```javascript
      const n0 = segNormals[i - 1];
      const n1 = segNormals[i];
      const dot = n0.nx * n1.nx + n0.ny * n1.ny;
      const nx = n0.nx + n1.nx;
      const ny = n0.ny + n1.ny;
      const l = Math.hypot(nx, ny);
      if (l < 1e-4 || dot < -0.2) {
        norm = n0;
      } else {
        norm = { nx: nx / l, ny: ny / l };
      }
  ```
- `inkwell-app/src/styles.css:1336-1338`:
  ```css
  #tiles { z-index: 1; }
  #dry   { z-index: 2; mix-blend-mode: multiply; }
  #wet   { z-index: 3; }
  ```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Rust Workspace Tests | `cd inkwell && cargo test --workspace -- --test-threads=1` | exit 0, all tests pass |
| Rust Clippy | `cd inkwell && cargo clippy --all-targets` | exit 0, 0 warnings |
| App Smoke Tests | `cd inkwell-app && python3 test_app_smoke.py` | exit 0, all checks pass |

## Scope

**In scope**:
- `inkwell-app/src/js/ink.js`
- `inkwell-app/src/js/tools/pen.js`
- `inkwell-app/src/js/render/compositor.js`
- `inkwell-app/src/styles.css`
- `inkwell/crates/inkwell-core/src/ink.rs`
- `inkwell-app/test_app_smoke.py`

**Out of scope**:
- Other tools (`eraser.js`, `lasso.js`, `shapes.js`, `text.js` — covered in Plan 075).

## Steps

### Step 1: Unify One-Euro + zoom-aware Streamline filtering and fix predicted point sheet anchoring

1. In `inkwell-app/src/js/ink.js`:
   - Update `Streamline.prototype.filter(x, y, p, zoom = 1.0)` (line 57):
     - Scale distance into screen pixels: `const screenDist = dist * Math.max(0.25, zoom);`.
     - Remove the abrupt `cosAngle < 0.25` jump-snap inside `Streamline.filter` (lines 73–84) that causes staircase vertices on fast curves; instead let `dynamicLerp` smoothly open up to `1.0` when turning or moving fast:
       ```javascript
       const turnBoost = (dist > 0.3 && lastDist > 0.3)
         ? Math.max(0, (0.5 - ((dx * this.lastVx + dy * this.lastVy) / (dist * lastDist))) * 0.35)
         : 0;
       const dynamicLerp = Math.min(1.0, Math.max(this.positionLerp, this.positionLerp + screenDist * 0.08 + turnBoost));
       ```
2. In `inkwell-app/src/js/tools/pen.js`:
   - In `consumeSample` (lines 95–119), pass the active pane zoom `z` to `state.streamline.filter(px, py, p, z)`, and if `state.cur && typeof state.cur.push === 'function'`, route the point through `OneEuro` (`state.cur._fx.filter( sx, t )`, `state.cur._fy.filter( sy, t )`) before calling `consumeFilteredPoint`.
   - In `consumeFilteredPoint`, apply incremental tail smoothing on the newly added point (`pts[n - 2]`) in-place as points arrive so live `state.cur.points` and committed `stroke.points` are **identical** — eliminating both the $O(N)$ full-array `smoothStrokePoints` in `renderActiveWetStroke` and the second `smoothStrokePoints` pass in `onPenUp` (removing commit snap!).
   - In `renderActiveWetStroke` (lines 184–194), compute predicted points strictly relative to `state.cur.sheet`'s layout `pl`:
     ```javascript
     for (let k = 0; k < preds.length; k++) {
       const predEvt = preds[k];
       const wx = viewport.screenToWorld(predEvt.clientX - r.left, predEvt.clientY - r.top, pane);
       predicted.push({
         x: pl ? (wx[0] - pl.x) : wx[0],
         y: pl ? (wx[1] - pl.y) : wx[1],
         p: lastPt.p,
         w: lastPt.w,
         t: predEvt.timeStamp || performance.now(),
       });
     }
     ```

**Verify**: `cd inkwell-app && python3 test_app_smoke.py` → exit 0.

### Step 2: Implement O(1) incremental wet stroke segment caching and miter-clamped ribbon normals in JS & Rust

1. In `inkwell-app/src/js/ink.js` (`traceRibbonContour`, lines 441–479) and `inkwell/crates/inkwell-core/src/ink.rs` (`ribbon_edges`, lines 730–764):
   - Compute proper miter scale `miter = Math.min(1.6, 1.0 / Math.max(0.5, l * 0.5))` where `l = Math.hypot(n0.nx + n1.nx, n0.ny + n1.ny)` (`l = 2 * cos(half_angle)`), so 90° corners preserve full stroke thickness instead of pinching by 30%, while sharp hairpin turns (`dot < -0.35`) clamp smoothly without self-intersecting loops.
2. In `inkwell-app/src/js/tools/pen.js` and `inkwell-app/src/js/ink.js`:
   - Maintain an incremental `Path2D` cache on `state.cur` (`_wetCommittedPath` up to `rawPts.length - 4`) so `renderActiveWetStroke` only retraces the active tail (last 4 points + predicted points) on each pointer move instead of retracing all `0..N` points from scratch.

**Verify**: `cd inkwell && cargo test --workspace -- --test-threads=1 && cargo clippy --all-targets` → exit 0, 0 warnings.

### Step 3: Fix `#dry` canvas blend mode so opaque ink and images render accurately while highlighters multiply

1. In `inkwell-app/src/styles.css:1337`:
   - Remove `mix-blend-mode: multiply;` from `#dry` so `#dry { z-index: 2; }`.
2. In `inkwell-app/src/js/render/compositor.js`:
   - In `redrawAll()` (lines 265–285), render highlighter strokes (`s.kind === 'highlighter'`) first (below opaque pen strokes and text) with ` _dctx.globalCompositeOperation = 'multiply'; _dctx.globalAlpha = 0.42;`, and then render opaque pen strokes (`s.kind !== 'highlighter'`) on top with `source-over` and `globalAlpha = 1.0`.
   - Ensure embedded images (`lines 220-242`) render with `source-over` and `globalAlpha = 1.0` so they are never darkened or muddied by page template lines, while highlighters drawn over PDF tiles or images blend optically.

**Verify**: `cd inkwell-app && python3 test_app_smoke.py` → exit 0.

## Test plan

- Add a smoke test check in `inkwell-app/test_app_smoke.py` verifying:
  1. `#dry` computed style `mixBlendMode` is `normal` (not `multiply`).
  2. Drawing a 200-point stroke via pointer events produces zero commit-snap (point coordinates before and after `pointerup` match) and completes in `< 50ms`.
- Existing Rust geometry tests in `inkwell/crates/inkwell-core/tests/geometry.rs` continue to pass with miter clamping.

## Done criteria

- [ ] `cd inkwell && cargo test --workspace -- --test-threads=1` exits 0
- [ ] `cd inkwell && cargo clippy --all-targets` exits 0 with 0 warnings
- [ ] `cd inkwell-app && python3 test_app_smoke.py` exits 0
- [ ] `#dry` in `styles.css` no longer has `mix-blend-mode: multiply`
- [ ] `plans/README.md` status row updated to `DONE`

## STOP conditions

- Any test in `inkwell/crates/inkwell-core/tests/geometry.rs` or `integration.rs` fails after updating `ribbon_edges` in `ink.rs`.
- `test_app_smoke.py` fails on stroke creation or rendering checks.

## Maintenance notes

- `ink.js` (`traceRibbonContour`) and `inkwell-core/src/ink.rs` (`ribbon_edges`) are mathematical twins; any future change to normal miter scaling must be applied to both files in lockstep.
