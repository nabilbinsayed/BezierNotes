/* ============================================================================
 * tools/pen.js — Fountain Pen & Chisel Highlighter Interaction Adapter
 * Captures low-latency pointer input, applies One-Euro/Streamline filtering,
 * paints to the wet canvas, and commits vector strokes to the document.
 * ========================================================================== */

import { state, warnDurability, emit } from '../core/state.js';
import * as documentOps from '../core/document.js';
import * as ipc from '../core/ipc.js';
import * as compositor from '../render/compositor.js';
import { latency, recordDraw } from '../dev/latency.js';

// ---- Incremental wet-stroke geometry -------------------------------------
// Freezing the completed prefix of a long stroke into Path2D chunks means each
// pointer sample only re-tessellates the live tail instead of the whole stroke.
const WET_CHUNK_POINTS = 32;
// Trailing points that the online tail smoother still mutates; never freeze
// into this window or the wet preview would diverge from the committed stroke.
const WET_TAIL_KEEP = 3;

let _wetLayer = null; // { canvas, ctx, key, covered }

// ---- Hold-to-Snap (smart shape recognition) ------------------------------
const HOLD_SNAP_MS = 380;
const HOLD_SNAP_STILL_PX = 2.8;
const HOLD_SNAP_ESCAPE_PX = 14;
const HOLD_SNAP_LABELS = {
  line: 'line',
  rect: 'rectangle',
  ellipse: 'ellipse',
  triangle: 'triangle',
};

let _holdTimer = null;
let _holdAnchor = null;
let _holdContext = null; // { pane, viewport, baseW }

function clearHoldSnapTimer() {
  if (_holdTimer) {
    clearTimeout(_holdTimer);
    _holdTimer = null;
  }
}

export function cancelHoldSnapTimer() {
  clearHoldSnapTimer();
}

function canHoldSnap() {
  return state.smartShapeHoldEnabled !== false &&
    (state.activeTool === 'pen' || state.activeTool === 'highlighter') &&
    !!state.cur && !state.holdSnappedShape;
}

function resetHoldSnapState() {
  clearHoldSnapTimer();
  _holdAnchor = null;
  _holdContext = null;
  state.holdSnappedShape = null;
  state.preSnapRawPts = null;
}

/**
 * Arm the dwell timer: it only fires after the pen has been stationary at the
 * same spot for HOLD_SNAP_MS, so fast writing and cursive can never snap.
 */
function updateHoldAnchor(px, py, pane, viewport, baseW) {
  if (!canHoldSnap()) return;
  if (_holdAnchor && Math.hypot(px - _holdAnchor.x, py - _holdAnchor.y) <= HOLD_SNAP_STILL_PX) {
    return;
  }
  _holdAnchor = { x: px, y: py };
  _holdContext = { pane, viewport, baseW };
  clearHoldSnapTimer();
  _holdTimer = setTimeout(() => {
    _holdTimer = null;
    tryHoldSnap();
  }, HOLD_SNAP_MS);
}

function tryHoldSnap() {
  const ctx = _holdContext;
  if (!ctx || !ctx.viewport || !state.cur || state.holdSnappedShape) return;
  const rawPts = state.cur.points;
  if (!rawPts || rawPts.length < 6) return;
  if (!window.Ink || typeof window.Ink.recognizeFreehandShape !== 'function') return;

  const recognized = window.Ink.recognizeFreehandShape(rawPts, ctx.baseW);
  if (!recognized || !recognized.points || recognized.points.length < 2) return;

  const lastRaw = rawPts[rawPts.length - 1];
  state.preSnapRawPts = rawPts.map(p => ({ ...p }));
  state.cur.points = recognized.points.map(p => ({ ...p }));
  state.cur.bbox = window.Ink.computeStrokeBbox(state.cur.points, ctx.baseW);
  state.cur._wetChunks = [];
  state.cur._wetChunkedIndex = 0;
  resetWetChunkLayer();
  state.holdSnappedShape = {
    kind: recognized.kind,
    corners: recognized.corners || null,
    anchor: { x: lastRaw.x, y: lastRaw.y },
  };
  const label = HOLD_SNAP_LABELS[recognized.kind] || recognized.kind;
  emit('toast', { message: `Snapped to ${label} — lift to keep, Esc to undo`, type: 'success' });
  renderActiveWetStroke(ctx.pane, ctx.viewport);
}

/**
 * Restore the raw freehand samples for the live stroke (Esc before lifting, or
 * continuing to draw after a closed shape snapped).
 */
export function revertHoldSnap(viewport) {
  if (!state.cur || !state.holdSnappedShape) return false;
  const vp = viewport || (_holdContext && _holdContext.viewport);
  if (state.preSnapRawPts && state.preSnapRawPts.length) {
    state.cur.points = state.preSnapRawPts.map(p => ({ ...p }));
  }
  state.cur._wetChunks = [];
  state.cur._wetChunkedIndex = 0;
  resetWetChunkLayer();
  state.holdSnappedShape = null;
  state.preSnapRawPts = null;
  _holdAnchor = null;
  if (window.Ink && typeof window.Ink.computeStrokeBbox === 'function') {
    state.cur.bbox = window.Ink.computeStrokeBbox(state.cur.points, state.cur.base_width);
  }
  if (vp) renderActiveWetStroke(state.drawingPane || 'left', vp);
  return true;
}

/**
 * Feed a new sample into a live snapped preview.
 * @returns {boolean} true when the sample was consumed by the snap preview
 */
function handleSnappedMove(px, py, baseW, pane, viewport) {
  const snapped = state.holdSnappedShape;
  if (!snapped || !state.cur) return false;

  if (snapped.kind === 'line' && window.Ink && typeof window.Ink.shapeLinePoints === 'function') {
    const start = (snapped.corners && snapped.corners[0]) || snapped.anchor;
    if (start) {
      state.cur.points = window.Ink.shapeLinePoints(start, { x: px, y: py }, baseW);
      state.cur._wetChunks = [];
      state.cur._wetChunkedIndex = 0;
      resetWetChunkLayer();
      state.cur.bbox = window.Ink.computeStrokeBbox(state.cur.points, baseW);
      renderActiveWetStroke(pane, viewport);
      return true;
    }
  }

  const anchor = snapped.anchor;
  if (anchor && Math.hypot(px - anchor.x, py - anchor.y) > HOLD_SNAP_ESCAPE_PX) {
    // The user kept drawing: hand the raw stroke back and keep going freehand.
    revertHoldSnap(viewport);
    return false;
  }
  return true;
}

/**
 * Drop the frozen-prefix raster layer. Called on every stroke start/end so a
 * new stroke can never inherit the previous stroke's accumulated chunks.
 */
export function resetWetChunkLayer() {
  if (_wetLayer) {
    _wetLayer.key = null;
    _wetLayer.covered = 0;
  }
}

function wetLayerFor(wctx) {
  if (!wctx || !wctx.canvas) return null;
  const w = wctx.canvas.width;
  const h = wctx.canvas.height;
  if (!(w > 0 && h > 0)) return null;
  let layer = _wetLayer;
  if (!layer || layer.canvas.width !== w || layer.canvas.height !== h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return null;
    layer = _wetLayer = { canvas, ctx, key: null, covered: 0 };
  }
  return layer;
}

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
  state.cur._wetChunks = [];
  state.cur._wetChunkedIndex = 0;
  resetWetChunkLayer();
  resetHoldSnapState();
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
  stroke._wetChunks = [];
  stroke._wetChunkedIndex = 0;
  resetWetChunkLayer();
  resetHoldSnapState();

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
  resetWetChunkLayer();
  resetHoldSnapState();
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

  const activeBaseW = state.cur.base_width || state.cur.baseWidth || state.baseWidth || 1.6;
  if (state.holdSnappedShape && handleSnappedMove(px, py, activeBaseW, pane, viewport)) {
    return;
  }

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

  // Arm (or re-arm) the Hold-to-Snap dwell timer at the latest resting point.
  updateHoldAnchor(px, py, pane, viewport, activeBaseW);
}

export function renderActiveWetStroke(pane, viewport, rawEvent = null) {
  // Plan 094: the only cost of latency instrumentation when it is off.
  if (!latency.enabled) {
    drawActiveWetStroke(pane, viewport, rawEvent);
    return;
  }
  const drawStart = performance.now();
  drawActiveWetStroke(pane, viewport, rawEvent);
  recordDraw(rawEvent, drawStart);
}

function drawActiveWetStroke(pane, viewport, rawEvent) {
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

  const hasTracer = !!(window.Ink && typeof window.Ink.traceRibbonContour === 'function');
  // Highlighters are excluded: their 0.42-alpha multiply fills would double-
  // darken wherever consecutive chunks overlap.
  const useChunking = hasTracer && typeof Path2D !== 'undefined' && !isHighlighter;

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
  const fillStyle = state.cur.cssColor || `rgb(${state.cur.rgb.map(v => Math.round(v * 255)).join(',')})`;
  wctx.fillStyle = fillStyle;

  if (useChunking) {
    const chunks = state.cur._wetChunks || (state.cur._wetChunks = []);
    let chunkedIndex = state.cur._wetChunkedIndex || 0;

    // Freeze every fully-settled 32-point prefix segment into a reusable Path2D.
    while (rawPts.length - WET_TAIL_KEEP - chunkedIndex >= WET_CHUNK_POINTS) {
      const end = chunkedIndex + WET_CHUNK_POINTS;
      // One point of back-overlap keeps the tangent continuous across the seam.
      const chunkPts = rawPts.slice(Math.max(0, chunkedIndex - 1), end);
      try {
        const p2d = new Path2D();
        window.Ink.traceRibbonContour(p2d, chunkPts, baseW);
        chunks.push(p2d);
      } catch (err) {
        console.warn('[inkwell/pen] wet chunk tessellation failed, falling back to full trace:', err);
        chunks.length = 0;
        chunkedIndex = 0;
        break;
      }
      chunkedIndex = end;
    }
    state.cur._wetChunkedIndex = chunkedIndex;

    if (chunks.length) {
      const layer = wetLayerFor(wctx);
      const layerKey = layer
        ? `${pane}|${psx.toFixed(2)}|${psy.toFixed(2)}|${z.toFixed(4)}|${state.dpr}|${wctx.canvas.width}x${wctx.canvas.height}`
        : null;

      if (layer && layer.key !== layerKey) {
        layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
        layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
        layer.key = layerKey;
        layer.covered = 0;
      }

      if (layer) {
        // Only the chunks frozen since the last frame are rasterized.
        if (layer.covered < chunks.length) {
          const lctx = layer.ctx;
          lctx.setTransform(1, 0, 0, 1, 0, 0);
          lctx.scale(state.dpr, state.dpr);
          lctx.translate(psx, psy);
          lctx.scale(z, z);
          lctx.fillStyle = fillStyle;
          lctx.globalCompositeOperation = 'source-over';
          lctx.globalAlpha = 1.0;
          for (let i = layer.covered; i < chunks.length; i++) {
            try { lctx.fill(chunks[i]); } catch (_) { /* keep the stroke live */ }
          }
          layer.covered = chunks.length;
        }
        // Single device-space blit → per-frame cost independent of stroke length.
        wctx.save();
        wctx.setTransform(1, 0, 0, 1, 0, 0);
        wctx.drawImage(layer.canvas, 0, 0);
        wctx.restore();
      } else {
        for (const chunk of chunks) {
          try { wctx.fill(chunk); } catch (_) { /* keep the stroke live */ }
        }
      }
    }

    // Live tail only: the last frozen point plus every unfrozen/predicted point.
    const tailStart = Math.max(0, chunkedIndex - 1);
    const tailPts = renderPts.slice(tailStart);
    if (tailPts.length) {
      wctx.beginPath();
      window.Ink.traceRibbonContour(wctx, tailPts, baseW);
      wctx.fill();
    }
    wctx.restore();
    return;
  }

  wctx.beginPath();
  if (hasTracer) {
    window.Ink.traceRibbonContour(wctx, renderPts, baseW);
  } else if (renderPts.length === 1) {
    wctx.arc(renderPts[0].x, renderPts[0].y, (renderPts[0].w || baseW) / 2, 0, Math.PI * 2);
  }
  wctx.fill();
  wctx.restore();
}
