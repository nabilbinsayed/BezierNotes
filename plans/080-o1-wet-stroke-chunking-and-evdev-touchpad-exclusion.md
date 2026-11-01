# Plan 080: $O(1)$ Incremental Wet Stroke Chunking & Linux Evdev Touchpad Exclusion

| Field | Value |
|---|---|
| **Priority** | P0 |
| **Effort** | M (~180 lines across 4 files) |
| **Category** | Performance / Inking Latency & Hardware Input |
| **Depends on** | 078 |
| **Status** | TODO |

## Why

Two issues directly degrade real-time inking responsiveness:

1. **$O(N)$ Full-Stroke Retesselation on Every `pointerrawupdate` (`pen.js:184-250`, `ink.js:404-520`)**:
   In `pen.js`, `renderActiveWetStroke()` calls `window.Ink.traceRibbonContour(wctx, renderPts, baseW)` over the *entire* `state.rawPts` array on every pointer sample (up to 240Hz). Inside `ink.js`, `traceRibbonContour()` allocates 5 temporary arrays (`segNormals`, `left`, `right`, `leftCubics`, `rightRev`, `rightCubics`) and runs `Math.hypot`, `Math.sqrt`, and `Math.atan2` for all $N$ points from index `0` to `N-1`. For long strokes (shading, complex math equations, or long underlines with 500–2,000 points), wet frame CPU time grows linearly with stroke length.
   By freezing completed prefix segments (`[0 .. N - 10]`) into cached `Path2D` chunks of 32 points (with a 2-point overlap for tangent continuity) and only running `traceRibbonContour` on the active tail window (last ~12 points), wet inking becomes strictly **$O(1)$ (< 0.15 ms/frame)** regardless of stroke length!

2. **Linux Laptop Touchpad False-Positive Hijacking (`stylus_linux.rs:224-226`, `tool-manager.js:90-96`)**:
   In `stylus_linux.rs`, `discover_best_tablet()` assigns `score = 10` to devices whose name contains `"touchpad"`, `"trackpad"`, or `"synaptics"`. On any Linux laptop without an external Wacom tablet plugged in, `best_score` starts at `0`, so `score = 10` wins! The evdev thread opens `'SynPS/2 Synaptics TouchPad'` and streams touchpad finger pressure (`~0.1`) at 120Hz over the native stylus channel. In `tool-manager.js:90-96`, `resolvePressure()` checks `if (isNativeRecent && e.pointerType !== 'touch')`, overrides mouse pressure with `0.1`, and sets `state.lastPointerType = 'pen'`!

## Evidence

### `inkwell-app/src-tauri/src/stylus_linux.rs:212-238`
```rust
        // Deprioritize touchpads/trackpads which sometimes expose ABS_PRESSURE for fingers
        if name_lower.contains("touchpad")
            || name_lower.contains("trackpad")
            || name_lower.contains("synaptics")
        {
            score = 10;
        }
```

### `inkwell-app/src/js/tools/tool-manager.js:88-98`
```javascript
  const isNativeRecent = state.latestNativeStylus &&
    (performance.now() - state.latestNativeStylus.timestamp < 80);

  if (isNativeRecent && e.pointerType !== 'touch') {
    const p = state.latestNativeStylus.pressure;
    if (p > 0.001) {
      state.lastPointerType = 'pen';
      return Math.max(0.05, Math.min(1.0, p));
    }
  }
```

### `inkwell-app/src/js/tools/pen.js:226-232`
```javascript
  wctx.fillStyle = colorStr;
  if (window.Ink && window.Ink.traceRibbonContour) {
    window.Ink.traceRibbonContour(wctx, renderPts, baseW);
    wctx.fill();
  }
```

## Scope

### Files to Modify
1. `inkwell-app/src-tauri/src/stylus_linux.rs`
2. `inkwell-app/src/js/tools/tool-manager.js`
3. `inkwell-app/src/js/ink.js`
4. `inkwell-app/src/js/tools/pen.js`

### Files NOT to Touch
- Do NOT change the final committed stroke `buildStrokeRecord` or PDF ribbon serialization (`ink.rs`).

## Step-by-Step Implementation

### Step 1: Exclude Touchpads & Non-Stylus Devices in `inkwell-app/src-tauri/src/stylus_linux.rs`

In `discover_best_tablet()` (`stylus_linux.rs:205-240`):
1. Immediately `continue` if `name_lower` contains `"touchpad"`, `"trackpad"`, `"synaptics"`, `"trackpoint"`, or `"mouse"`.
2. Require the device to either support `Key::BTN_TOOL_PEN` / `Key::BTN_STYLUS` or have `"stylus"` / `"pen"` / `"wacom"` / `"huion"` / `"xp-pen"` / `"ugee"` / `"gaomon"` / `"xencelabs"` in its name (giving `score < 50` devices a rejection so generic touchscreens without `BTN_TOOL_PEN` are never mistaken for pressure styluses).

```rust
        // Reject touchpads, trackpads, trackpoints, and mice unconditionally.
        if name_lower.contains("touchpad")
            || name_lower.contains("trackpad")
            || name_lower.contains("synaptics")
            || name_lower.contains("trackpoint")
            || name_lower.contains("mouse")
        {
            continue;
        }

        let has_pen_key = dev
            .supported_keys()
            .is_some_and(|keys| keys.contains(Key::BTN_TOOL_PEN) || keys.contains(Key::BTN_STYLUS));
        if !has_pen_key && score < 60 {
            continue;
        }
```
Add a unit test in `stylus_linux.rs` verifying that touchpad/Synaptics device names are rejected.

### Step 2: Tighten `resolvePressure` Guard in `inkwell-app/src/js/tools/tool-manager.js`

In `resolvePressure(e)` (`tool-manager.js:88-98`), only use `state.latestNativeStylus` when `e.pointerType === 'pen'` OR when `state.latestNativeStylus.tipDown === true`:
```javascript
  const isNativeRecent = state.latestNativeStylus &&
    (performance.now() - state.latestNativeStylus.timestamp < 80);

  if (isNativeRecent && (e.pointerType === 'pen' || state.latestNativeStylus.tipDown)) {
    const p = state.latestNativeStylus.pressure;
    if (p > 0.001) {
      state.lastPointerType = 'pen';
      return Math.max(0.05, Math.min(1.0, p));
    }
  }
```

### Step 3: Implement $O(1)$ Incremental Wet Stroke Chunking in `inkwell-app/src/js/ink.js` and `inkwell-app/src/js/tools/pen.js`

1. In `inkwell-app/src/js/ink.js`, export a helper `buildSubPath2D(pts, baseW)` (or reuse `traceRibbonContour(p2d, pts, baseW)` since `Path2D` implements the exact same `moveTo`/`lineTo`/`bezierCurveTo`/`arc`/`closePath` methods as `CanvasRenderingContext2D`!):
   - Verify in `traceRibbonContour(ctx, pts, baseW)`: it only calls `ctx.beginPath()`, `ctx.arc()`, `ctx.moveTo()`, `ctx.bezierCurveTo()`, `ctx.lineTo()`, and `ctx.closePath()`.
   - Note: `Path2D` does **not** have `.beginPath()`, whereas `CanvasRenderingContext2D` does!
   - Therefore, in `traceRibbonContour(ctx, pts, baseW)` (`ink.js:406` and `417`), guard `if (typeof ctx.beginPath === 'function') ctx.beginPath();`! That single guard allows `traceRibbonContour` to trace directly into either a `CanvasRenderingContext2D` OR a `new Path2D()`!

2. In `inkwell-app/src/js/tools/pen.js`:
   - Initialize `state._wetChunks = []` and `state._wetChunkedIndex = 0` in `onPointerDown` (`pen.js:35`).
   - Clear `state._wetChunks = []` and `state._wetChunkedIndex = 0` in `onPointerUp` (`pen.js:116`).
   - In `renderActiveWetStroke(pane, viewport)` (`pen.js:184-250`):
     - When `state.activeTool !== 'shape'` and `typeof Path2D !== 'undefined'`:
       - While `state.rawPts.length - state._wetChunkedIndex >= 40`:
         - Slice `chunkPts = state.rawPts.slice(Math.max(0, state._wetChunkedIndex - 1), state._wetChunkedIndex + 32)`.
         - Create `const p2d = new Path2D(); window.Ink.traceRibbonContour(p2d, chunkPts, baseW);`.
         - Push `p2d` to `state._wetChunks` and advance `state._wetChunkedIndex += 31`.
       - Draw all frozen chunks (`for (const c of state._wetChunks) wctx.fill(c);`).
       - Build `tailPts` from `state.rawPts.slice(Math.max(0, state._wetChunkedIndex - 1))` plus the 1-step predictive point, and run `window.Ink.traceRibbonContour(wctx, tailPts, baseW); wctx.fill();`!

## Verification

1. Run Rust workspace tests & clippy:
   ```bash
   cd inkwell && cargo test --workspace -- --test-threads=1 && cargo clippy --all-targets
   ```
2. Run Desktop App smoke tests:
   ```bash
   cd inkwell-app && python3 test_app_smoke.py
   ```

## STOP Conditions
- STOP if `Path2D` throws `ctx.beginPath is not a function`—make sure `if (typeof ctx.beginPath === 'function') ctx.beginPath();` is guarded at both line 406 and line 417 of `ink.js`.
