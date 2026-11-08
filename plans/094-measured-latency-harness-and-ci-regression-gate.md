# Plan 094: Measured Ink Latency Harness, In-App HUD & CI Regression Gate

| Field | Value |
|---|---|
| **Priority** | P1 |
| **Effort** | M (~400 lines) |
| **Category** | Performance / Requirement 1 |
| **Depends on** | 093 (pointer router module) |
| **Status** | DONE (2026-11-08; see Outcome) |

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

## Outcome (2026-11-08)

**Instrumentation** (`js/dev/latency.js`). Off by default. `renderActiveWetStroke` in `tools/pen.js` now wraps the draw (the body moved to `drawActiveWetStroke`). When instrumentation is off, the only added cost is `if (!latency.enabled)`, which settles the STOP condition by construction.

When on, it records:
- input→draw: `event.timeStamp` to the end of the wet draw;
- input→present: to the next animation frame callback;
- draw cost;
- coalesced events per pointer event;
- frame intervals;
- long tasks (`PerformanceObserver`).

These go into 2,048-entry ring buffers, with a running max over every sample.

Two plan items were not possible as written:
- *Presentation time.* `requestVideoFrameCallback` applies to video elements only, so presentation is estimated from the next animation frame. That uses the callback's own time, not its vsync timestamp, which can precede an input handled just before paint.
- *Native timing.* Linux `stylus_linux.rs` samples now carry the evdev SYN_REPORT timestamp (`event_us`, CLOCK_MONOTONIC via EVIOCSCLOCKID) and `kernel_to_emit_us`, and the HUD shows "evdev → IPC". Windows exposes no native-path timestamps to the page, so the HUD only reports whether `pointerrawupdate` exists and the coalescing factor.

**HUD** (`js/dev/hud.js`). **Ctrl+Shift+L**, or "Ink Latency HUD" in the command palette. It shows p50/p95/p99 for each measure, a frame sparkline against 60 Hz, and the input path. Opening it turns instrumentation on; closing it turns it off.

**Replay** (`js/dev/replay.js`, `window.__bezierReplay(capture, {speed, onFrame})`). It dispatches pen `PointerEvent`s (`pointerrawupdate` where available) through the real router at the recorded cadence. Long waits sleep rather than spin: an early version busy-spun through 15 s pen-up gaps and produced its own "long tasks". Pen-up gaps are capped at 0.5 s.

**Gate** (`inkwell-app/test_latency.py`, `perf/baseline.json`, `target/latency.json`, CI artifact `latency-linux`). Three scenarios:
- the real capture (11,901 samples at 2× rate);
- a 700-sample 240 Hz scribble;
- the scribble on a page holding 2,000 strokes while it pans.

It fails if any of these holds:
- p99 input→draw or p99 draw cost exceeds the baseline by 30 % (and at least 1 ms);
- p99 draw cost exceeds 8 ms;
- any single ink handler takes over 50 ms;
- the heavy page did not pan.

It is made robust in three ways:
- **Speed scaling.** Budgets scale with runner speed, measured by a fixed canvas workload.
- **Confirmation.** A failing check is re-measured once and must fail again.
- **Known issues.** Per-scenario known issues in the baseline are reported, not failed (a ratchet).

`--update-baseline` records the worst of three runs. `--self-test` injects a 10 ms stall into wet-canvas fills and passes only if caught; CI runs it before the gate.

**Design changes forced by measurement.**
- **Long tasks.** Long tasks are reported but not gated. Investigated in the replays, they arrive about once per 25 s of inking. They are not inside any ink handler (none over 30 ms in repeated runs of the 6,555-sample stroke) and not tied to page re-renders (the dry render count is flat), so they are headless GC and software compositing. A zero-long-task rule failed about half the runs. The **ink-stall** check (worst single input→draw ≤ 50 ms) measures the handlers themselves instead.
- **Test seed data.** The heavy scenario's first numbers came from a bad seed, not the app: strokes without bounds and strokes past the page edge both disable the page bitmap cache. The seed now has both right, as the app's load path does.

**Findings for follow-ups** (in `docs/latency.md`):
- **Pan while drawing.** Drawing while the page pans changes the wet layer's key on every sample, so the stroke so far is re-rasterised per sample. The p99 draw is 5–9 ms on the heavy scenario, listed as a known `draw_cost_cap` issue. Fix: shift the layer on translation-only changes.
- **Ink past the page edge.** A page with ink outside its edge can't use the page bitmap cache, so every pan or zoom frame redraws all its strokes.

**Real-device protocol** (`docs/latency.md`). The 240 fps camera method, the HUD, and the CI proxy numbers labelled as headless. The device results table is empty: nothing has been filmed, so the README now states no latency number and links the page.

**Verification.**
- **Regression check.** A real 10 ms busy-loop added temporarily to `drawActiveWetStroke` fails the gate on every scenario (exit 1, confirmed on re-run), then was reverted.
- **Gate stability.** The gate passed three consecutive runs on the baseline machine, and the self-test passes.
- **Smoke.** 175/175: T32 checks the HUD toggle and instrumentation on/off, and that a replay is drawn, committed and measured.
- **Other suites.** Five focused suites pass; app crate 24/24 and clippy clean; Rust 153/153; boundaries clean.

**Not done / limits.**
- **No device numbers.** All numbers are headless proxies, with no display, GPU or driver.
- **Windows.** The Windows CI job doesn't run the gate; only Linux does.
- **CI timing unverified.** The gate takes about 1–2 minutes per run, and has not yet run on a GitHub runner, where speed scaling will be exercised for real.
