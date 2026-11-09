/**
 * First run (Plan 098): three short cards on the start screen (open a PDF,
 * where notes are stored, pen setup with a pressure test and the latency
 * HUD). Shown until the first document opens or "Got it"; never a modal, so
 * nothing is blocked.
 */

import { $ } from '../core/state.js';
import { toggleLatencyHud } from '../dev/hud.js';

const KEY = 'beziernotes_first_run_done';

export function isFirstRun() {
  try {
    return localStorage.getItem(KEY) !== '1';
  } catch (_) {
    return false;
  }
}

export function finishFirstRun() {
  try {
    localStorage.setItem(KEY, '1');
  } catch (_) {
    // blocked storage: the cards just show again next time
  }
  const el = $('firstRunCards');
  if (el) el.classList.add('hidden');
}

function bindPressureTest(canvas) {
  const ctx = canvas.getContext('2d');
  let last = null;
  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    last = null;
  });
  canvas.addEventListener('pointermove', e => {
    if (!e.buttons) { last = null; return; }
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) * (canvas.width / r.width);
    const y = (e.clientY - r.top) * (canvas.height / r.height);
    const p = e.pressure > 0 ? e.pressure : 0.5;
    if (last) {
      ctx.strokeStyle = '#141724';
      ctx.lineCap = 'round';
      ctx.lineWidth = 0.5 + p * 6;
      ctx.beginPath();
      ctx.moveTo(last[0], last[1]);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    last = [x, y];
  });
}

export function initFirstRun() {
  const el = $('firstRunCards');
  if (!el) return;
  el.classList.toggle('hidden', !isFirstRun());
  const pressure = $('firstRunPressure');
  if (pressure) bindPressureTest(pressure);
  const hud = $('btnFirstRunLatency');
  if (hud) hud.addEventListener('click', () => toggleLatencyHud(true));
  const done = $('btnFirstRunDone');
  if (done) done.addEventListener('click', finishFirstRun);
}
