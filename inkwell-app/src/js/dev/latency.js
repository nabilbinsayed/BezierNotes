/**
 * Ink latency instrumentation (Plan 094).
 *
 * Always loaded, off by default. The ink hot path calls `recordDraw` only
 * behind `if (latency.enabled)`, so a disabled build pays one boolean check
 * per drawn sample and nothing else.
 *
 * Per drawn wet-ink update it records:
 *   input→draw   event.timeStamp → end of the wet draw (both performance.now())
 *   input→present event.timeStamp → the next animation frame's timestamp, the
 *                 best estimate of when that pixel reaches the screen that a
 *                 page can get without a presentation-feedback API
 *   draw cost    time spent in the wet draw itself
 *   coalesced    raw samples the browser folded into the event
 * plus frame intervals while ink is moving, long tasks (> 50 ms), and, on
 * Linux, the native stylus thread's evdev → IPC emit delay.
 *
 * Numbers live in fixed ring buffers (2,048 entries each).
 */

const RING = 2048;

class Ring {
  constructor() {
    this.buf = new Float64Array(RING);
    this.n = 0;
    this.max = 0;   // over every value, not just the ring
  }
  push(v) {
    this.buf[this.n % RING] = v;
    this.n++;
    if (v > this.max) this.max = v;
  }
  values() {
    return Array.from(this.buf.subarray(0, Math.min(this.n, RING)));
  }
  clear() {
    this.n = 0;
    this.max = 0;
  }
}

export const latency = {
  /** The one flag the hot path checks. */
  enabled: false,
};

const rings = {
  inputToDraw: new Ring(),
  inputToPresent: new Ring(),
  drawCost: new Ring(),
  coalesced: new Ring(),
  frameInterval: new Ring(),
  nativeKernelToEmit: new Ring(),
};
let longTasks = 0;
let longTaskMax = 0;
let longTaskList = [];   // [startTime, duration], capped
let longTaskObserver = null;
let pendingPresent = [];   // event timestamps awaiting their frame
let rafScheduled = false;
let lastFrameTs = 0;

function onFrame(ts) {
  rafScheduled = false;
  // The frame's vsync timestamp can precede an input handled just before the
  // frame paints; the callback's own time can't.
  const presented = Math.max(ts, performance.now());
  for (const t of pendingPresent) rings.inputToPresent.push(presented - t);
  pendingPresent = [];
  if (lastFrameTs && ts - lastFrameTs < 250) rings.frameInterval.push(ts - lastFrameTs);
  lastFrameTs = ts;
}

/**
 * Called after a wet-ink draw. `rawEvent` is the pointer event that drove
 * it, `drawStart` the performance.now() taken before drawing.
 */
export function recordDraw(rawEvent, drawStart) {
  const now = performance.now();
  const t = rawEvent && rawEvent.timeStamp;
  if (t > 0 && t <= now) {
    rings.inputToDraw.push(now - t);
    pendingPresent.push(t);
  }
  rings.drawCost.push(now - drawStart);
  if (rawEvent && typeof rawEvent.getCoalescedEvents === 'function') {
    const c = rawEvent.getCoalescedEvents();
    rings.coalesced.push(c && c.length ? c.length : 1);
  } else {
    rings.coalesced.push(1);
  }
  if (!rafScheduled) {
    rafScheduled = true;
    requestAnimationFrame(onFrame);
  }
}

/** Linux native stylus: the backend's evdev event → IPC emit delay (µs). */
export function recordNative(kernelToEmitUs) {
  if (kernelToEmitUs > 0) rings.nativeKernelToEmit.push(kernelToEmitUs / 1000);
}

export function setEnabled(on) {
  latency.enabled = !!on;
  if (latency.enabled && !longTaskObserver && typeof PerformanceObserver !== 'undefined') {
    try {
      longTaskObserver = new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          longTasks++;
          longTaskMax = Math.max(longTaskMax, e.duration);
          if (longTaskList.length < 256) longTaskList.push([e.startTime, e.duration]);
        }
      });
      longTaskObserver.observe({ type: 'longtask', buffered: false });
    } catch (err) {
      // Not every engine reports long tasks; the count then stays 0 and
      // stats() says so.
      console.info('[inkwell/latency] long task reporting unavailable:', err && err.message);
      longTaskObserver = null;
    }
  }
}

export function reset() {
  for (const r of Object.values(rings)) r.clear();
  longTasks = 0;
  longTaskMax = 0;
  longTaskList = [];
  pendingPresent = [];
  lastFrameTs = 0;
}

function pct(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

/** Percentiles over the ring (the latest 2,048 values); `count` is every value seen. */
function summary(ring) {
  const s = ring.values().sort((a, b) => a - b);
  const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
  return { n: s.length, count: ring.n, p50: pct(s, 0.5), p95: pct(s, 0.95), p99: pct(s, 0.99), max: ring.n ? ring.max : null, mean };
}

/** Percentiles of everything recorded since the last reset. */
export function stats() {
  return {
    inputToDraw: summary(rings.inputToDraw),
    inputToPresent: summary(rings.inputToPresent),
    drawCost: summary(rings.drawCost),
    frameInterval: summary(rings.frameInterval),
    coalesced: summary(rings.coalesced),
    nativeKernelToEmit: summary(rings.nativeKernelToEmit),
    longTasks,
    longTaskMax,
    longTaskList: longTaskList.slice(),
    longTasksObserved: !!longTaskObserver,
    rawUpdate: typeof window !== 'undefined' && 'onpointerrawupdate' in window,
  };
}

/** Recent frame intervals, oldest first, for the HUD sparkline. */
export function recentFrames(count = 120) {
  const v = rings.frameInterval.values();
  const n = rings.frameInterval.n;
  if (n <= RING) return v.slice(-count);
  const start = n % RING; // ring wrapped: reorder oldest → newest
  return v.slice(start).concat(v.slice(0, start)).slice(-count);
}
