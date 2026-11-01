/* ============================================================================
 * tools/pen.js — Fountain Pen & Chisel Highlighter Interaction Adapter
 * Captures low-latency pointer input, applies One-Euro/Streamline filtering,
 * paints to the wet canvas, and commits vector strokes to the document.
 * ========================================================================== */

import { state, warnDurability } from '../core/state.js';
import * as documentOps from '../core/document.js';
import * as ipc from '../core/ipc.js';
import * as compositor from '../render/compositor.js';

export function onPenDown(e, ptWorld, pane, viewport) {
  const isHighlighter = state.activeTool === 'highlighter';
  const pageCoord = viewport.worldToPage(ptWorld[0], ptWorld[1]);
  const activeSheet = pageCoord.sheet;

  const baseW = state.baseWidth || (isHighlighter ? 16.0 : 1.6);
  if (window.Ink && typeof window.Ink.Stroke === 'function') {
    state.cur = new window.Ink.Stroke({
      kind: isHighlighter ? 'highlighter' : 'pen',
      rgb: state.color,
      baseWidth: baseW,
    });
  } else {
    state.cur = {
      id: 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      kind: isHighlighter ? 'highlighter' : 'pen',
      rgb: state.color,
      base_width: baseW,
      points: [],
    };
  }
  state.cur.base_width = baseW;
  state.cur.sheet = activeSheet;
  state.drawingPane = pane;
  state.penWarmup = 0;
  if (window.Ink && typeof window.Ink.Streamline === 'function') {
    state.streamline = new window.Ink.Streamline(0.72, 0.35);
  }
  if (typeof window !== 'undefined' && window.resetPressureDynamics) {
    window.resetPressureDynamics();
  }

  consumeSample(e, ptWorld, pane, viewport, true, e);
}

export function onPenMove(e, ptWorld, pane, viewport, options = {}) {
  if (!state.cur) return;
  if (e && e.buttons === 0) {
    onPenUp(e, viewport);
    return;
  }
  const shouldRender = options.render !== false;
  const rawEvent = options.rawEvent || e;
  consumeSample(e, ptWorld, pane, viewport, shouldRender, rawEvent);
}

export function onPenUp(e, viewport) {
  if (!state.cur) return;
  const stroke = state.cur;
  state.cur = null;
  state.streamline = null;
  state.penWarmup = 0;

  if (stroke.points && stroke.points.length > 0) {
    if (window.Ink && typeof window.Ink.computeStrokeBbox === 'function') {
      stroke.bbox = window.Ink.computeStrokeBbox(stroke.points, stroke.base_width);
    }
    if (window.Ink && typeof window.Ink.getPath2D === 'function') {
      stroke._cachedPath2D = window.Ink.getPath2D(stroke);
    }

    // Add to authoritative document state and record history transaction
    documentOps.addStroke(stroke, { recordHistory: true });

    // Asynchronous WAL journal commit
    ipc.commitStroke(stroke.sheet, stroke.kind, stroke.rgb, stroke.base_width, stroke.points, stroke.id)
      .then(serverId => { if (serverId) stroke.id = String(serverId); })
      .catch(err => {
        console.warn('[inkwell/pen] commitStroke WAL error:', err);
        warnDurability('Stroke may not persist: ' + err);
      });
    compositor.clearWet();
    compositor.drawCommittedStroke(stroke);
  } else {
    compositor.clearWet();
  }
}

export function onPenCancel() {
  state.cur = null;
  state.streamline = null;
  state.penWarmup = 0;
  compositor.clearWet();
}

function consumeSample(e, ptWorld, pane, viewport, shouldRender = true, rawEvent = e) {
  if (!state.cur || !viewport) return;
  const pl = viewport.getPageLayout(state.cur.sheet || 0);
  const px = pl ? (ptWorld[0] - pl.x) : ptWorld[0];
  const py = pl ? (ptWorld[1] - pl.y) : ptWorld[1];

  state.penWarmup = (state.penWarmup || 0) + 1;
  let p = typeof window.resolvePressure === 'function'
    ? window.resolvePressure(e)
    : (e.pressure !== undefined && e.pressure > 0 ? e.pressure : 0.5);
  // Clamping initial 2 samples suppresses pen-down hardware pressure spike blobs
  if (state.penWarmup <= 2) {
    p = Math.min(p, 0.35);
  }
  const t = e.timeStamp || performance.now();
  const z = pane === 'right' && viewport.splitMode ? viewport.rightZoom : viewport.zoom;

  let sx = px;
  let sy = py;
  if (state.cur && state.cur._fx && state.cur._fy) {
    sx = state.cur._fx.filter(px, t);
    sy = state.cur._fy.filter(py, t);
  }

  if (state.streamline) {
    const smoothed = state.streamline.filter(sx, sy, p, z);
    consumeFilteredPoint(smoothed.x, smoothed.y, smoothed.p, t, pane, viewport, shouldRender, rawEvent);
  } else {
    consumeFilteredPoint(sx, sy, p, t, pane, viewport, shouldRender, rawEvent);
  }
}

function consumeFilteredPoint(px, py, p, t, pane, viewport, shouldRender = true, rawEvent = null) {
  if (!state.cur) return;

  const pts = state.cur.points;
  const lastPt = pts && pts.length > 0 ? pts[pts.length - 1] : null;
  // Deduplicate redundant events within 0.05pt to match inkwell-core precision while eliminating identical jitter
  if (lastPt && Math.hypot(px - lastPt.x, py - lastPt.y) < 0.05) {
    return;
  }

  const isHighlighter = state.cur.kind === 'highlighter';
  const baseW = state.cur.base_width || state.cur.baseWidth || state.baseWidth || 1.6;
  const c = Math.pow(Math.max(0, Math.min(1, p)), 1.0);
  const w = isHighlighter ? baseW : baseW * (0.22 + 0.78 * c);
  const pt = { x: px, y: py, p, w, t };
  if (!state.cur.points) state.cur.points = [];
  state.cur.points.push(pt);

  // Incremental online tail smoothing: smooth pts[pts.length - 2] in-place
  // so live wet stroke and final committed stroke are identical with zero commit snap
  if (state.cur.points.length >= 3) {
    const curPts = state.cur.points;
    const p0 = curPts[curPts.length - 3];
    const p1 = curPts[curPts.length - 2];
    const p2 = pt;
    const v0x = p1.x - p0.x, v0y = p1.y - p0.y;
    const v1x = p2.x - p1.x, v1y = p2.y - p1.y;
    const l0 = Math.hypot(v0x, v0y), l1 = Math.hypot(v1x, v1y);
    const isCorner = (l0 > 0.1 && l1 > 0.1) && ((v0x * v1x + v0y * v1y) / (l0 * l1) < 0.25);
    if (!isCorner) {
      p1.x = 0.25 * p0.x + 0.5 * p1.x + 0.25 * p2.x;
      p1.y = 0.25 * p0.y + 0.5 * p1.y + 0.25 * p2.y;
      const w0 = p0.w || 2.0, w1 = p1.w || 2.0, w2 = p2.w || 2.0;
      p1.w = 0.25 * w0 + 0.5 * w1 + 0.25 * w2;
    }
  }

  if (state.cur.samples) {
    state.cur.samples.push([+pt.x.toFixed(3), +pt.y.toFixed(3), +p.toFixed(4), +t.toFixed(1)]);
  }
  const r = w / 2;
  if (!state.cur.bbox) {
    state.cur.bbox = [px - r, py - r, px + r, py + r];
  } else {
    if (px - r < state.cur.bbox[0]) state.cur.bbox[0] = px - r;
    if (py - r < state.cur.bbox[1]) state.cur.bbox[1] = py - r;
    if (px + r > state.cur.bbox[2]) state.cur.bbox[2] = px + r;
    if (py + r > state.cur.bbox[3]) state.cur.bbox[3] = py + r;
  }

  if (shouldRender) {
    renderActiveWetStroke(pane, viewport, rawEvent);
  }
}

export function renderActiveWetStroke(pane, viewport, rawEvent = null) {
  const { wctx } = compositor.getContexts();
  if (!wctx || !state.cur || !viewport) return;

  const rawPts = state.cur.points;
  if (!rawPts || rawPts.length === 0) return;

  const isHighlighter = state.cur.kind === 'highlighter';
  const baseW = state.cur.base_width || state.cur.baseWidth || state.baseWidth || 1.6;
  const pl = viewport.getPageLayout(state.cur.sheet || 0);
  const [psx, psy] = viewport.worldToScreen(pl.x, pl.y, pane);
  const z = pane === 'right' && viewport.splitMode ? viewport.rightZoom : viewport.zoom;

  // 1. Gather predicted points for zero-latency stylus tracking
  let displayPts = rawPts;
  if (rawEvent && typeof rawEvent.getPredictedEvents === 'function') {
    try {
      const preds = rawEvent.getPredictedEvents();
      if (preds && preds.length > 0) {
        const stageEl = (typeof document !== 'undefined') ? document.getElementById('stage') : null;
        const r = compositor.getStageRect() || (stageEl ? stageEl.getBoundingClientRect() : null);
        if (r) {
          const predicted = [];
          const lastPt = rawPts[rawPts.length - 1];
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
          if (predicted.length > 0) {
            displayPts = rawPts.concat(predicted);
          }
        }
      }
    } catch (_) {}
  }

  // 2. Real-time online curve smoothing for silky fluidity during active drawing
  const renderPts = displayPts;

  // 3. Render to wet canvas
  compositor.clearWet();
  wctx.save();
  compositor.clipToPane(wctx, pane);
  wctx.translate(psx, psy);
  wctx.scale(z, z);

  if (isHighlighter) {
    wctx.globalCompositeOperation = 'multiply';
    wctx.globalAlpha = 0.42;
  }
  wctx.fillStyle = state.cur.cssColor || `rgb(${state.cur.rgb.map(v => Math.round(v * 255)).join(',')})`;
  wctx.beginPath();
  if (window.Ink && typeof window.Ink.traceRibbonContour === 'function') {
    window.Ink.traceRibbonContour(wctx, renderPts, baseW);
  } else if (renderPts.length === 1) {
    wctx.arc(renderPts[0].x, renderPts[0].y, (renderPts[0].w || baseW) / 2, 0, Math.PI * 2);
  }
  wctx.fill();
  wctx.restore();
}
