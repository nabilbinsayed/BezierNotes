# Plan 094: Measured Ink Latency Harness, In-App HUD & CI Regression Gate

| Field | Value |
|---|---|
| **Priority** | P1 |
| **Effort** | M (~400 lines) |
| **Category** | Performance / Requirement 1 |
| **Depends on** | 093 (pointer router module) |
| **Status** | TODO |

## Why

"Zero perceived lag" is requirement #1, and plans 014, 016, 070, 079, 080 and 082 all optimised the ink path. But every number in the plans is a one-off manual measurement, and nothing stops a regression. `SPEC.md` §11 asks for "a synthetic input injector that replays a recorded stroke and logs input-timestamp → present-timestamp deltas. Fail CI if p99 regresses." It does not exist. The README's "ultra-low latency" headline is currently unverified.

There is a recorded capture in the repo root (`inkwell-capture.json`, 390 KB) that can seed the replay.

## Design

1. **Instrumentation (always compiled, off by default).** In the pointer router, record `event.timeStamp` for each sample. In the wet-layer RAF, record `performance.now()` after the draw, and use `requestVideoFrameCallback`-style `presentationTime` where available (fall back to the next RAF's timestamp as the "present" estimate). Keep a 2,048-entry ring buffer. Collect per-frame: input→draw, draw cost, samples coalesced, and dry-cache hits.
2. **HUD.** `Ctrl+Shift+L` toggles a small overlay with p50/p95/p99 input→present and frame-time sparkline. This is a dev tool, but also useful to ask users "what does the HUD say?" when they report lag.
3. **Replay injector.** `window.__bezierReplay(captureJson, { speed })` dispatches synthetic `PointerEvent`s (pressure, tilt, `pointerType: 'pen'`) at the recorded cadence through the same router. Playwright test `test_latency.py` replays (a) the real capture, (b) a 700-point fast scribble, (c) a scribble on a page with 2,000 existing strokes while panning.
4. **Budgets, checked in CI** (headless Chromium numbers are a proxy; set budgets from a baseline run + 30 % headroom):
   - p99 input→draw ≤ budget, p99 frame cost ≤ 8 ms, zero long tasks > 50 ms during replay.
   - Results written to `target/latency.json`; CI uploads them as an artifact and compares against `perf/baseline.json` (updated deliberately in a PR).
5. **Real-device protocol.** A `docs/latency.md` with the `SPEC.md` §2.5 240 fps camera method, plus a results table per device (Huion H640P on Windows/Linux, Wacom, touchscreen). Only publish README latency numbers that appear in that table.
6. **Native-path checks.** Linux evdev stylus thread (`stylus_linux.rs`): timestamp at read and at IPC emit, reported in the HUD, to separate kernel→app from app→screen latency. On Windows, record whether `pointerrawupdate` is available in WebView2 and show its coalescing factor.

## Scope
- `inkwell-app/src/js/input/pointer-router.js` (from Plan 093), `js/render/compositor.js`, new `js/dev/latency.js`, `js/dev/replay.js`.
- `inkwell-app/test_latency.py`, `perf/baseline.json`, `.github/workflows/build.yml`.
- `inkwell-app/src-tauri/src/stylus_linux.rs` (timestamps only).

## Verification
```bash
cd inkwell-app && python3 test_latency.py     # prints p50/p95/p99, exits non-zero over budget
```
And a deliberate regression check: temporarily insert a 10 ms busy-loop into the wet draw. The gate must fail.

## STOP Conditions
- STOP if instrumentation itself adds > 0.2 ms per frame when disabled. It must be a single boolean check on the hot path.
