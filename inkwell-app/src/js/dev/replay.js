/**
 * Synthetic stylus replay (Plan 094, SPEC §11): dispatches recorded strokes
 * as pen PointerEvents at their recorded cadence through the real pointer
 * router, with latency instrumentation on, and returns the measurements.
 *
 * `capture` is an `inkwell-m0-capture/1` JSON (`strokes[].samples` =
 * [x, y, pressure, t_ms]) or `{ strokes: [{ samples }] }`. Strokes are
 * placed so their bounding box is centred on the stage.
 */

import * as latency from './latency.js';

function wetCanvas() {
  return document.getElementById('wet') || document.querySelector('#stage canvas:last-of-type');
}

function moveEventType() {
  return ('onpointerrawupdate' in window) ? 'pointerrawupdate' : 'pointermove';
}

function pointerEvent(type, x, y, p, buttons) {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: 7,
    pointerType: 'pen',
    isPrimary: true,
    clientX: x,
    clientY: y,
    pressure: p,
    tiltX: 0,
    tiltY: 0,
    button: type === 'pointerdown' ? 0 : -1,
    buttons,
  });
}

const yieldNow = () => new Promise(r => {
  const ch = new MessageChannel();
  ch.port1.onmessage = () => r();
  ch.port2.postMessage(0);
});

/** Wait until `due`: sleep through long waits, yield-spin only the last 2 ms. */
async function waitUntil(due) {
  let left = due - performance.now();
  if (left > 4) await new Promise(r => setTimeout(r, left - 2));
  while (performance.now() < due) await yieldNow();
}

/** Pen-up gaps longer than this are shortened: they say nothing about ink latency. */
const MAX_GAP_MS = 500;

/**
 * Replay `capture` at `speed` (1 = recorded cadence). `onFrame` runs once per
 * animation frame during the replay (e.g. to pan). Resolves to `latency.stats()`.
 */
export async function replay(capture, { speed = 1, onFrame = null, reset = true } = {}) {
  const canvas = wetCanvas();
  if (!canvas) throw new Error('no wet canvas to draw on');
  const strokes = (capture && capture.strokes) || [];
  const all = strokes.flatMap(s => s.samples || []);
  if (!all.length) throw new Error('capture has no samples');
  const rect = canvas.getBoundingClientRect();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of all) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  const fit = Math.min(1, (rect.width * 0.8) / Math.max(1, x1 - x0), (rect.height * 0.8) / Math.max(1, y1 - y0));
  const ox = rect.left + rect.width / 2 - ((x0 + x1) / 2) * fit;
  const oy = rect.top + rect.height / 2 - ((y0 + y1) / 2) * fit;
  const at = (x, y) => [ox + x * fit, oy + y * fit];

  const wasEnabled = latency.latency.enabled;
  latency.setEnabled(true);
  if (reset) latency.reset();
  let frameLoop = true;
  if (typeof onFrame === 'function') {
    const tick = () => { if (!frameLoop) return; onFrame(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }

  const move = moveEventType();
  const t0 = performance.now();
  // Recorded time → replay time, with pen-up gaps capped at MAX_GAP_MS.
  let shift = all[0][3];
  let prevEnd = null;
  const penDown = [];   // [down, up] in performance.now() time
  try {
    for (const s of strokes) {
      const samples = s.samples || [];
      if (!samples.length) continue;
      if (prevEnd !== null && samples[0][3] - prevEnd > MAX_GAP_MS) shift += samples[0][3] - prevEnd - MAX_GAP_MS;
      for (let i = 0; i < samples.length; i++) {
        const [x, y, p, t] = samples[i];
        await waitUntil(t0 + (t - shift) / speed);
        const [cx, cy] = at(x, y);
        if (i === 0) penDown.push([performance.now(), Infinity]);
        canvas.dispatchEvent(pointerEvent(i === 0 ? 'pointerdown' : move, cx, cy, p, 1));
      }
      const last = samples[samples.length - 1];
      prevEnd = last[3];
      const [cx, cy] = at(last[0], last[1]);
      penDown[penDown.length - 1][1] = performance.now();
      canvas.dispatchEvent(pointerEvent('pointerup', cx, cy, 0, 0));
    }
    // let the last frame land
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  } finally {
    frameLoop = false;
  }
  // the long-task observer reports with a delay
  await new Promise(r => setTimeout(r, 100));
  const out = latency.stats();
  // Long tasks wholly inside pen-down: the ink path itself stalled. A task
  // that also handles the pen-up (committing the stroke) is not counted here.
  out.longTasksWhileInking = out.longTaskList.filter(([s, d]) =>
    penDown.some(([down, up]) => s >= down && s + d <= up)).length;
  out.durationMs = performance.now() - t0;
  out.samplesSent = all.length;
  if (!wasEnabled) latency.setEnabled(false);
  return out;
}

/** A fast scribble: `n` samples at `hz`, zig-zagging across `w` × `h` px. */
export function scribble(n = 700, { hz = 240, w = 500, h = 300 } = {}) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t = i * (1000 / hz);
    const x = (i * 7) % w;
    const y = (h / 2) + Math.sin(i / 6) * (h / 2.5) + ((Math.floor((i * 7) / w)) % 2) * 12;
    samples.push([x, y, 0.4 + 0.3 * Math.sin(i / 20), t]);
  }
  return { strokes: [{ samples }] };
}
