/**
 * Latency HUD (Plan 094): Ctrl+Shift+L shows input→draw / input→present
 * percentiles and a frame-time sparkline. Opening it turns instrumentation
 * on; closing it turns it off again. Also what to ask a user who reports lag:
 * "what does the HUD say?".
 */

import * as latency from './latency.js';

let _el = null;
let _timer = null;

function fmt(v) {
  return v === null || v === undefined ? '–' : v.toFixed(1);
}

function row(label, s, unit = 'ms') {
  return `<tr><th>${label}</th><td>${fmt(s.p50)}</td><td>${fmt(s.p95)}</td><td>${fmt(s.p99)}</td><td>${unit}</td></tr>`;
}

function render() {
  if (!_el) return;
  const s = latency.stats();
  const native = s.nativeKernelToEmit.n ? row('evdev → IPC', s.nativeKernelToEmit) : '';
  _el.querySelector('.latency-hud-table').innerHTML =
    '<tr><th></th><td>p50</td><td>p95</td><td>p99</td><td></td></tr>' +
    row('input → draw', s.inputToDraw) +
    row('input → present', s.inputToPresent) +
    row('draw cost', s.drawCost) +
    row('frame', s.frameInterval) +
    native;
  const coalesce = s.coalesced.mean ? s.coalesced.mean.toFixed(1) : '–';
  _el.querySelector('.latency-hud-meta').textContent =
    `${s.inputToDraw.n} samples · ${s.rawUpdate ? 'pointerrawupdate' : 'pointermove'} · ` +
    `${coalesce} events/coalesced · long tasks ${s.longTasksObserved ? s.longTasks : 'n/a'}`;
  drawSparkline(_el.querySelector('canvas'), latency.recentFrames(120));
}

function drawSparkline(canvas, frames) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const budget = 1000 / 60;
  const max = Math.max(budget * 2, ...frames);
  const y = v => h - (v / max) * h;
  ctx.strokeStyle = 'rgba(248, 113, 113, 0.6)';
  ctx.beginPath();
  ctx.moveTo(0, y(budget));
  ctx.lineTo(w, y(budget));
  ctx.stroke();
  ctx.strokeStyle = '#5eead4';
  ctx.beginPath();
  frames.forEach((v, i) => {
    const x = (i / Math.max(1, frames.length - 1)) * w;
    if (i === 0) ctx.moveTo(x, y(v));
    else ctx.lineTo(x, y(v));
  });
  ctx.stroke();
}

export function isHudVisible() {
  return !!_el && !_el.classList.contains('hidden');
}

export function toggleLatencyHud(force) {
  const show = force === undefined ? !isHudVisible() : !!force;
  if (!_el) {
    _el = document.createElement('div');
    _el.id = 'latencyHud';
    _el.className = 'latency-hud hidden';
    _el.setAttribute('role', 'status');
    _el.innerHTML = '<div class="latency-hud-title">Ink latency <button type="button" class="latency-hud-reset" title="Clear the numbers">Reset</button></div>' +
      '<table class="latency-hud-table"></table><canvas width="220" height="40" aria-hidden="true"></canvas>' +
      '<div class="latency-hud-meta"></div>';
    _el.querySelector('.latency-hud-reset').addEventListener('click', () => { latency.reset(); render(); });
    document.body.appendChild(_el);
  }
  _el.classList.toggle('hidden', !show);
  latency.setEnabled(show);
  clearInterval(_timer);
  _timer = null;
  if (show) {
    render();
    _timer = setInterval(render, 250);
  }
  return show;
}
