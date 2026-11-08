"""Ink latency regression gate (Plan 094, SPEC §11).

Replays stylus input through the real pointer router in headless Chromium,
with the app's latency instrumentation on, and fails if the ink path got
slower than the checked-in baseline.

Scenarios:
  capture   the real pen capture in inkwell-capture.json (142 Hz Windows Ink)
  scribble  a 700-sample fast scribble at 240 Hz
  heavy     the same scribble on a page holding 2,000 strokes while panning

Gate, per scenario (budgets scale with this machine's speed, see below):
  p99 input->draw  <= baseline p99 x 1.3
  p99 draw cost    <= 8 ms (and <= baseline p99 x 1.3)
  ink stalls: no single input->draw over 50 ms, across every sample
Long tasks (> 50 ms, any cause) are reported but not gated: in headless
Chromium they come from GC and software compositing about once every 25 s of
inking, outside the ink handlers, and the long-task API can't say whose they
are. The ink-stall check measures the handlers themselves.

Known issues: `perf/baseline.json` may list, per scenario, checks that fail
today for a understood reason ("known"). They are reported on every run but
don't fail the gate; their baseline-relative budgets still apply. It is a
ratchet: when a fix makes a known check pass, the gate says to delete it.

Machine speed: a fixed canvas + JS workload is timed first. Budgets are
multiplied by (this machine's time / the baseline machine's time) when this
machine is slower, so a slower CI runner is not a regression. Headless numbers
are a proxy for real hardware; docs/latency.md has the camera method.

  python3 test_latency.py                    # run the gate
  python3 test_latency.py --update-baseline  # record perf/baseline.json (review the diff)
  python3 test_latency.py --self-test        # inject a 10 ms stall into the wet draw; the gate must fail

A check that fails is re-measured once; the gate fails only if it fails
again (the self-test does not retry). Results go to target/latency.json.
"""
import argparse, json, pathlib, shutil, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent
REPO = ROOT.parent
URL = (ROOT / "src" / "index.html").as_uri()
BASELINE = REPO / "perf" / "baseline.json"
OUT = REPO / "target" / "latency.json"
CAPTURE = REPO / "inkwell-capture.json"
HEADROOM = 1.3
DRAW_COST_CAP_MS = 8.0
INK_STALL_MS = 50.0
# Every budget allows at least this much above baseline: sub-millisecond
# p99 differences are timer noise, not regressions.
FLOOR_MS = 1.0

STUB = """
window.__inkwell_stub = {
  render_tile: async (args) => {
    const rect = (args && args.rect) || [0, 0, 256, 256];
    const px = (args && args.px) || 256;
    const rw = Math.max(1, rect[2] - rect[0]), rh = Math.max(1, rect[3] - rect[1]);
    const span = (rw <= 512 && rh <= 512) ? 512 : Math.max(rw, rh);
    const w = Math.round(rw * px / span) || 1, h = Math.round(rh * px / span) || 1;
    return new Array(w * h * 4).fill(255);
  },
  get_page_text_data: async (args) => ({ page_index: (args && args.pageIndex) || 0, text: '', lines: [], chars: [], spans: [] }),
  commit_stroke: async (args) => (args && args.clientId) ? String(args.clientId) : 's',
  create_blank_document: async () => ({ page_infos: [
    { page_index: 0, width_pt: 595.0, height_pt: 842.0 },
    { page_index: 1, width_pt: 595.0, height_pt: 842.0 }], outline: [] }),
  open_pdf: async () => ({ page_infos: [{ page_index: 0, width_pt: 595.0, height_pt: 842.0 }], outline: [] }),
  get_document_outline: async () => [],
  autosave_tick: async () => null,
  find_conflict_siblings: async () => [],
};
window.__TAURI_INTERNALS__ = { invoke: async (cmd, args) => {
  const f = window.__inkwell_stub[cmd];
  return typeof f === 'function' ? await f(args) : null;
} };
window.__TAURI__ = { core: { invoke: window.__TAURI_INTERNALS__.invoke } };
"""

# A deliberate regression for --self-test: every fill on the wet canvas stalls.
SELF_TEST_DELAY = """
(() => {
  const fill = CanvasRenderingContext2D.prototype.fill;
  CanvasRenderingContext2D.prototype.fill = function (...a) {
    if (this.canvas && this.canvas.id === 'wet') {
      const until = performance.now() + 10;
      while (performance.now() < until) {}
    }
    return fill.apply(this, a);
  };
})();
"""

CALIBRATE = """(() => {
  // Fixed work resembling the ink path: path building + fills on a canvas.
  const c = document.createElement('canvas'); c.width = 800; c.height = 600;
  const ctx = c.getContext('2d');
  const runs = [];
  for (let r = 0; r < 7; r++) {
    const t0 = performance.now();
    for (let k = 0; k < 400; k++) {
      ctx.beginPath();
      for (let i = 0; i < 60; i++) ctx.lineTo((i * 13 + k) % 800, 300 + Math.sin(i / 5 + k) * 200);
      ctx.closePath(); ctx.fill();
    }
    ctx.getImageData(0, 0, 1, 1);
    runs.push(performance.now() - t0);
  }
  runs.sort((a, b) => a - b);
  return runs[3];
})()"""

SCENARIO = """async ([name, capture]) => {
  const replay = await import('./js/dev/replay.js');
  window.toolManager.setTool('pen');
  if (name === 'heavy') {
    // 2,000 committed strokes on the page being drawn on
    const strokes = [];
    for (let i = 0; i < 2000; i++) {
      const pts = [];
      // all inside the 595 x 842 pt page (ink past the edge disables the page
      // bitmap cache: a separate, known cost)
      for (let k = 0; k < 24; k++) pts.push({ x: 40 + (i % 50) * 9 + k * 2, y: 40 + Math.floor(i / 50) * 18 + Math.sin(k / 3) * 4, p: 0.5, w: 1.6, t: k * 4 });
      const s = { id: 'seed' + i, kind: 'pen', rgb: [0.1, 0.1, 0.2], base_width: 1.6, sheet: 0, points: pts };
      // as the app's load path warms them (handlePdfLoadResult): the page
      // bitmap cache needs every stroke's bounds
      s.bbox = window.Ink.computeStrokeBbox(s.points, s.base_width);
      strokes.push(s);
    }
    window.__heavySeeded = true;
    window.documentOps.setDocument({ pageInfos: window.state.pageInfos, strokes, images: [], textObjects: [], bookmarks: [] });
  } else {
    window.documentOps.setDocument({ pageInfos: window.state.pageInfos, strokes: [], images: [], textObjects: [], bookmarks: [] });
  }
  // Let the page's first render (the 2,000-stroke bitmap) finish first.
  for (let i = 0; i < 3; i++) await new Promise(r => requestAnimationFrame(r));
  await new Promise(r => setTimeout(r, 700));
  const input = capture || replay.scribble(700, { hz: 240 });
  let dir = 1, moved = 0;
  const v = (await import('./js/app/viewport-ref.js')).getViewport();
  let panned = 0;
  const onFrame = name === 'heavy' ? () => {
    if (!v || typeof v.setPan !== 'function') return;
    panned++;
    moved += dir; if (Math.abs(moved) > 40) dir = -dir;
    v.setPan(v.panX + dir * 0.75, v.panY, 'left');
  } : null;
  // The capture is ~88 s of pen-down time at its own 142 Hz; twice that
  // rate (still a real pen's range) keeps CI time sane.
  const s = await replay.replay(input, { speed: name === 'capture' ? 2 : 1, onFrame });
  s.panFrames = panned;
  return s;
}"""


def launch(pw):
    exe = shutil.which("chromium") or shutil.which("google-chrome-stable") or shutil.which("chrome")
    opts = {"headless": True, "args": ["--allow-file-access-from-files", "--no-sandbox", "--disable-gpu",
                                       "--disable-dev-shm-usage"]}
    if exe:
        opts["executable_path"] = exe
    return pw.chromium.launch(**opts)


def measure(self_test):
    capture = json.loads(CAPTURE.read_text()) if CAPTURE.exists() else None
    errors = []
    with sync_playwright() as pw:
        b = launch(pw)
        pg = b.new_context(viewport={"width": 1360, "height": 860}).new_page()
        pg.add_init_script(STUB)
        if self_test:
            pg.add_init_script(SELF_TEST_DELAY)
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(URL)
        pg.wait_for_timeout(500)
        btn = pg.locator("#btnWelcomeNewNote")
        if btn.count() > 0 and btn.is_visible():
            btn.click()
            pg.wait_for_timeout(400)
        calib = pg.evaluate(CALIBRATE)
        results = {}
        for name in ("capture", "scribble", "heavy"):
            if name == "capture" and capture is None:
                print("  (no inkwell-capture.json: capture scenario skipped)")
                continue
            results[name] = pg.evaluate(SCENARIO, [name, capture if name == "capture" else None])
        b.close()
    if errors:
        raise SystemExit(f"page errors during replay: {errors[:3]}")
    return calib, results


def summarise(results):
    out = {}
    for name, s in results.items():
        out[name] = {
            "samples": s["samplesSent"],
            "draws": s["inputToDraw"]["count"],
            "p50_input_to_draw_ms": s["inputToDraw"]["p50"],
            "p99_input_to_draw_ms": s["inputToDraw"]["p99"],
            "p99_input_to_present_ms": s["inputToPresent"]["p99"],
            "p99_draw_cost_ms": s["drawCost"]["p99"],
            "p99_frame_ms": s["frameInterval"]["p99"],
            "long_tasks": s["longTasks"],
            "long_tasks_while_inking": s["longTasksWhileInking"],
            "max_input_to_draw_ms": s["inputToDraw"]["max"],
            "long_task_max_ms": s["longTaskMax"],
            "long_tasks_observed": s["longTasksObserved"],
            "pan_frames": s.get("panFrames", 0),
        }
    return out


def worst(a, b):
    """Per metric, the slower of two runs."""
    out = {}
    for name in a:
        out[name] = {k: (max(a[name][k], b[name][k]) if isinstance(a[name][k], (int, float)) and not isinstance(a[name][k], bool)
                         and k not in ("samples",) and a[name][k] is not None and b[name][k] is not None else a[name][k])
                     for k in a[name]}
        out[name]["draws"] = min(a[name]["draws"], b[name]["draws"])
    return out


def gate(summary, calib, baseline):
    failures, notes = [], []
    scale = max(1.0, calib / baseline["calibration_ms"])
    known_all = baseline.get("known", {})
    for name, m in summary.items():
        known = known_all.get(name, {})
        base = baseline["scenarios"].get(name)
        if base is None:
            failures.append((name, "baseline", f"{name}: no baseline (run --update-baseline)"))
            continue
        if name == "heavy" and m["pan_frames"] < 10:
            failures.append((name, "pan", f"heavy: the page did not pan during the replay ({m['pan_frames']} frames)"))
        if m["draws"] < 0.5 * m["samples"]:
            failures.append((name, "draws", f"{name}: only {m['draws']} of {m['samples']} samples were drawn"))
        for key in ("p99_input_to_draw_ms", "p99_draw_cost_ms"):
            budget = max(base[key] * HEADROOM, base[key] + FLOOR_MS) * scale
            if m[key] is None or m[key] > budget:
                failures.append((name, key, f"{name}: {key} {m[key]} > budget {budget:.2f} (baseline {base[key]:.2f}, x{HEADROOM} or +{FLOOR_MS} ms, x speed {scale:.2f})"))
        cap = DRAW_COST_CAP_MS * scale
        checks = {
            "draw_cost_cap": (m["p99_draw_cost_ms"] is not None and m["p99_draw_cost_ms"] > cap,
                              f"p99 draw cost {m['p99_draw_cost_ms']:.2f} ms > {cap:.2f} ms"),
            "ink_stall": ((m["max_input_to_draw_ms"] or 0) > INK_STALL_MS,
                          f"an ink handler took {m['max_input_to_draw_ms']:.0f} ms (> {INK_STALL_MS:.0f} ms)"),
        }
        for key, (failed, msg) in checks.items():
            if key in known:
                if failed:
                    notes.append(f"{name}: known: {msg} ({known[key]})")
                else:
                    notes.append(f"{name}: known issue '{key}' did not reproduce this run; once it stops for good, delete it from perf/baseline.json")
            elif failed:
                failures.append((name, key, f"{name}: {msg}"))
    return failures, notes, scale


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--update-baseline", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--runs", type=int, default=None,
                    help="repeat and keep each metric's worst run (default 3 for --update-baseline, else 1)")
    args = ap.parse_args()
    runs = args.runs or (3 if args.update_baseline else 1)

    calib, summary = None, None
    for _ in range(runs):
        c, results = measure(args.self_test)
        s = summarise(results)
        calib = c if calib is None else max(calib, c)
        summary = s if summary is None else worst(summary, s)
    print(f"calibration workload: {calib:.1f} ms")
    for name, m in summary.items():
        print(f"  {name:9s} p50 {m['p50_input_to_draw_ms']:.2f} / p99 {m['p99_input_to_draw_ms']:.2f} ms input->draw, "
              f"p99 present {m['p99_input_to_present_ms'] or 0:.1f} ms, p99 draw {m['p99_draw_cost_ms']:.2f} ms, "
              f"max {m['max_input_to_draw_ms']:.1f} ms, long tasks {m['long_tasks']}, {m['draws']}/{m['samples']} drawn")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    report = {"calibration_ms": calib, "scenarios": summary, "self_test": args.self_test}

    if args.update_baseline:
        if args.self_test:
            raise SystemExit("refusing to record a baseline with the injected stall")
        BASELINE.parent.mkdir(parents=True, exist_ok=True)
        known = json.loads(BASELINE.read_text()).get("known", {}) if BASELINE.exists() else {}
        BASELINE.write_text(json.dumps({"calibration_ms": calib, "scenarios": summary, "known": known}, indent=2) + "\n")
        OUT.write_text(json.dumps(report, indent=2) + "\n")
        print(f"baseline written to {BASELINE.relative_to(REPO)}")
        return 0

    baseline = json.loads(BASELINE.read_text())
    failures, notes, scale = gate(summary, calib, baseline)
    if failures and not args.self_test:
        # Headless timing has rare outliers (GC, software raster). A real
        # regression reproduces: fail only on checks that fail twice.
        print("re-running to confirm: " + "; ".join(f[2] for f in failures))
        calib2, results2 = measure(False)
        summary2 = summarise(results2)
        failures2, notes, scale = gate(summary2, max(calib, calib2), baseline)
        failures = [f for f in failures2 if (f[0], f[1]) in {(g[0], g[1]) for g in failures}]
        report["confirm_run"] = summary2
        if not failures:
            print("  not reproduced: treated as noise")
    report.update({"speed_scale": scale, "failures": [f[2] for f in failures], "notes": notes})
    for n in notes:
        print("  note: " + n)
    OUT.write_text(json.dumps(report, indent=2) + "\n")
    if args.self_test:
        if failures:
            print(f"self-test OK: the injected 10 ms stall was caught ({len(failures)} budget failures)")
            return 0
        print("self-test FAILED: a 10 ms stall in the wet draw went unnoticed")
        return 1
    if failures:
        print("latency gate FAILED:")
        for f in failures:
            print("  - " + f[2])
        return 1
    print(f"latency gate passed (speed scale {scale:.2f})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
