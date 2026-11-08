# Measuring ink latency

Requirement #1 is ink that feels attached to the pen. This page says how
BezierNotes measures that, and holds the only latency numbers the README may
quote: a number that isn't in the **Real devices** table below doesn't go in
the README.

## Real devices: the camera method (SPEC §2.5)

The only honest end-to-end number is photographic.

1. Open a blank notebook at 100 % zoom. Put the window on the display the pen
   is mapped to; close other apps.
2. Film the pen tip and the screen together with a phone at **240 fps** (4.17 ms
   per frame), the phone close and steady, both in focus.
3. Draw ten quick straight strokes, each starting from rest.
4. In a frame-by-frame player, for each stroke count the frames from the pen
   tip starting to move to the ink's leading edge starting to move. Multiply by
   4.17 ms.
5. Report the median and the worst of the ten, with the device, OS, display
   refresh rate, app version and whether the native Linux stylus thread was
   active (HUD: an "evdev → IPC" row appears).

Leave the latency HUD open while filming (**Ctrl+Shift+L**): its numbers go
in the table too, so the in-app measurement can be compared with the camera.

### Results

| Device | OS / display | Version | Camera median | Camera worst | HUD p99 input→present | Measured by, date |
|---|---|---|---|---|---|---|
| *none measured yet* | | | | | | |

Wanted: Huion H640P on Windows and Linux, a Wacom tablet, a touchscreen
laptop with an active pen.

## In the app: the latency HUD

**Ctrl+Shift+L** (or "Ink Latency HUD" in the command palette) shows, for
the ink drawn since it opened:

- **input → draw**: from the pointer event's timestamp to the end of the wet-ink
  draw it caused, i.e. the app's own share;
- **input → present**: to the next animation frame, the best estimate of when
  the pixels reach the screen that a web page can get;
- **draw cost**: time inside the wet draw;
- **frame**: frame intervals, also as a sparkline against the 60 Hz budget;
- **evdev → IPC** (Linux, native stylus thread): from the kernel's event
  timestamp to the backend emitting it, separating kernel → app from
  app → screen;
- whether `pointerrawupdate` is available (it is in Chromium/WebView2) and how
  many raw samples the browser coalesces into each event.

Instrumentation is off until the HUD opens; the ink path then pays one
boolean check per drawn sample. Asking a user who reports lag "what does the
HUD say?" separates a slow machine from a slow tablet driver.

## In CI: the regression gate

`inkwell-app/test_latency.py` replays pen input through the real pointer
router in headless Chromium (`window.__bezierReplay`, `js/dev/replay.js`):

- **capture**: the real 142 Hz Windows Ink recording in `inkwell-capture.json`
  (5 strokes, 11,901 samples), at twice its rate, pen-up gaps shortened;
- **scribble**: 700 samples at 240 Hz;
- **heavy**: the scribble on a page holding 2,000 strokes while it pans.

It fails when p99 input→draw or p99 draw cost exceeds the baseline by 30 % (and
at least 1 ms), p99 draw cost exceeds 8 ms, or any single ink handler takes over
50 ms. Budgets scale with the runner's speed, measured by a fixed canvas
workload. A failing check is re-measured once and must fail again. Results:
`target/latency.json` (a CI artifact).

`--self-test` injects a 10 ms stall into every wet-canvas fill and passes only
if the gate catches it. `--update-baseline` records `perf/baseline.json`
(worst of three runs): commit it deliberately, with the reason.

Known issues are listed per scenario in `perf/baseline.json` under `known`:
reported, not failed, until fixed (a ratchet like the PDF conformance suite's
`KNOWN_FAILURES`). Today: drawing while the page pans re-rasterises the wet
stroke every sample, so the heavy scenario's draw cost sits around the 8 ms cap.

Headless numbers are a **proxy**: software rendering, no display, no driver.
They catch regressions in BezierNotes' own code; they say nothing about the
latency a user sees. Baseline machine (Linux, headless Chromium):

| Scenario | Samples | p50 input→draw (ms) | p99 input→draw (ms) | p99 draw cost (ms) |
|---|---|---|---|---|
| capture | 11,901 | 0.2 | 1.4 | 1.1 |
| scribble | 700 | 0.3 | 1.6 | 1.3 |
| heavy | 700 | 0.1 | 7.0 | 6.7 |

Also measured while building the gate, and worth a follow-up:

- A page with any ink outside its edges can't use the page bitmap cache, so
  every pan or zoom frame redraws all of its strokes as vectors (2,000 strokes:
  long frames throughout a pan).
