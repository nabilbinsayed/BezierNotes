/* ============================================================================
 * render/compositor.js — Multi-Canvas Pipeline Compositor for Inkwell
 * Coordinates the triple-canvas pipeline: Tiles (LOD) -> Dry (Committed) -> Wet (Active Inking).
 * Reads document state; never mutates document state.
 * ========================================================================== */

import { state, on } from '../core/state.js';
import * as documentOps from '../core/document.js';
import * as templates from './templates.js';
import * as tiles from './tiles.js';
import * as overlays from './overlays.js';
import * as ipc from '../core/ipc.js';

let _tilesCanvas, _dryCanvas, _wetCanvas;
let _tctx, _dctx, _wctx;
let _viewport = null;
let _stageRect = null;

let _redrawTilesPending = false;
let _redrawTilesQueued = false;
let _redrawAllPending = false;
let _redrawTilesEpoch = 0;
let _prefetchTimer = null;
let _prefetchSeq = 0;
const _prefetchedAt = new Map();

export function initCompositor({ tilesCanvas, dryCanvas, wetCanvas, viewport }) {
  _tilesCanvas = tilesCanvas;
  _dryCanvas = dryCanvas;
  _wetCanvas = wetCanvas;
  _viewport = viewport;

  _tctx = makeCtx(_tilesCanvas);
  _dctx = makeCtx(_dryCanvas);
  _wctx = makeCtx(_wetCanvas);

  on('documentLoaded', () => {
    tiles.clearTileCache();
    invalidateDryPageCache();
  });

  on('documentChanged', ({ type } = {}) => {
    // Every stroke/image/text/page mutation invalidates the cached #dry page
    // bitmaps; pure pan/scroll/pinch frames reuse them untouched.
    invalidateDryPageCache();
    if (type && type.includes('page')) {
      tiles.clearTileCache();
    }
  });
}

export function getCanvases() {
  return { tilesCanvas: _tilesCanvas, dryCanvas: _dryCanvas, wetCanvas: _wetCanvas };
}

export function getContexts() {
  return { tctx: _tctx, dctx: _dctx, wctx: _wctx };
}

export function makeCtx(canvas) {
  if (!canvas) return null;
  return canvas.getContext('2d', { desynchronized: true, alpha: true });
}

export function updateStageRect() {
  const stageEl = (typeof document !== 'undefined') ? document.getElementById('stage') : null;
  if (stageEl) {
    _stageRect = stageEl.getBoundingClientRect();
  } else if (_wetCanvas) {
    _stageRect = _wetCanvas.getBoundingClientRect();
  }
  if (_viewport && _viewport.updateStageRect) {
    _viewport.updateStageRect();
  }
}

export function getStageRect() {
  return _stageRect;
}

export function paneBounds(pane = 'left') {
  if (_viewport && typeof _viewport.getPaneBounds === 'function') {
    return _viewport.getPaneBounds(pane);
  }
  const stageEl = (typeof document !== 'undefined') ? document.getElementById('stage') : null;
  const r = stageEl ? stageEl.getBoundingClientRect() : (_stageRect || { width: 800, height: 600 });
  const width = r.width > 0 ? r.width : 800;
  const height = r.height > 0 ? r.height : 600;
  if (!_viewport || !_viewport.splitMode) return { x: 0, y: 0, width, height };
  const ratio = _viewport.splitRatio || 0.5;
  const splitX = Math.round(width * ratio);
  return pane === 'right' ? { x: splitX, y: 0, width: Math.max(100, width - splitX), height } : { x: 0, y: 0, width: Math.max(100, splitX), height };
}

export function visiblePanes() {
  return _viewport && _viewport.splitMode ? ['left', 'right'] : ['left'];
}

export function paneForEvent(e) {
  const stageEl = (typeof document !== 'undefined') ? document.getElementById('stage') : null;
  const r = _stageRect || (stageEl ? stageEl.getBoundingClientRect() : { left: 0, width: window.innerWidth });
  if (_viewport && typeof _viewport.paneAtScreenX === 'function') {
    return _viewport.paneAtScreenX(e.clientX - r.left);
  }
  const ratio = (_viewport && _viewport.splitRatio) || 0.5;
  return _viewport && _viewport.splitMode && (e.clientX - r.left > r.width * ratio) ? 'right' : 'left';
}

export function paneTransform(ctx, pane = 'left') {
  if (!ctx || !_viewport) return;
  const isRight = pane === 'right' && _viewport.splitMode;
  ctx.translate(isRight ? _viewport.rightPanX : _viewport.panX, isRight ? _viewport.rightPanY : _viewport.panY);
  ctx.scale(isRight ? _viewport.rightZoom : _viewport.zoom, isRight ? _viewport.rightZoom : _viewport.zoom);
}

export function clipToPane(ctx, pane = 'left') {
  if (!ctx) return;
  const bounds = paneBounds(pane);
  ctx.beginPath();
  ctx.rect(bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.clip();
}

export function resize() {
  updateStageRect();
  const r = _stageRect;
  if (!r || r.width <= 0 || r.height <= 0) return;
  state.dpr = Math.max(1, window.devicePixelRatio || 1);

  for (const c of [_tilesCanvas, _dryCanvas, _wetCanvas]) {
    if (!c) continue;
    c.width = Math.round(r.width * state.dpr);
    c.height = Math.round(r.height * state.dpr);
    c.style.width = '100%';
    c.style.height = '100%';
  }

  _tctx = makeCtx(_tilesCanvas);
  _dctx = makeCtx(_dryCanvas);
  _wctx = makeCtx(_wetCanvas);

  for (const ctx of [_tctx, _dctx, _wctx]) {
    if (ctx) ctx.scale(state.dpr, state.dpr);
  }

  scheduleRedrawTiles();
  redrawAll();
}

export function scheduleRedrawTiles() {
  if (_redrawTilesPending) {
    _redrawTilesQueued = true;
    return;
  }
  _redrawTilesPending = true;
  requestAnimationFrame(() => {
    try {
      // Strictly synchronous: cached tiles are blitted immediately and any
      // misses are fetched in the background. Awaiting PDFium here used to
      // freeze the #tiles underlay for 30–100 ms behind every scroll frame.
      redrawTiles();
    } finally {
      _redrawTilesPending = false;
      if (_redrawTilesQueued) {
        _redrawTilesQueued = false;
        scheduleRedrawTiles();
      }
    }
  });
}

export function getTilesEpoch() {
  return _redrawTilesEpoch;
}

export function redrawTiles() {
  if (!_tctx || !_tilesCanvas || !_viewport) return;
  const drawEpoch = ++_redrawTilesEpoch;
  _tctx.setTransform(1, 0, 0, 1, 0, 0);
  _tctx.clearRect(0, 0, _tilesCanvas.width, _tilesCanvas.height);

  // Start the idle timer before tile IPC completes; waiting for every visible
  // tile crop made the next-page prefetch land more than a second late.
  scheduleAdjacentPrefetch();

  const panes = visiblePanes();
  for (const pane of panes) {
    const visiblePages = _viewport.getVisiblePages(pane);
    for (const pl of visiblePages) {
      const pi = state.pageInfos && state.pageInfos[pl.sheet];
      templates.drawPageBackground(_tctx, pl, _viewport, pi, state.dpr, pane);
    }
  }

  const isCurrentEpoch = () => drawEpoch === _redrawTilesEpoch;
  const missing = [];
  for (const pane of panes) {
    const visiblePages = _viewport.getVisiblePages(pane);
    if (!visiblePages.length) continue;
    const bounds = paneBounds(pane);
    for (const pl of visiblePages) {
      const pi = state.pageInfos && state.pageInfos[pl.sheet];
      if (!pi) continue;
      tiles.redrawTilesForPage(
        _tctx, pane, pi, pl, _viewport, state.dpr, bounds, clipToPane, isCurrentEpoch, missing,
      );
    }
    if (!isCurrentEpoch()) return;
  }

  if (!state.presentationMode) {
    overlays.drawZoomIndicator(_tctx, _viewport, state.dpr, visiblePanes(), paneBounds);
  }
  tiles.evictTileCache();

  if (missing.length) {
    tiles.fetchMissingTiles(missing, () => {
      if (_viewport) scheduleRedrawTiles();
    });
  }
}

/**
 * After the visible page settles, render the next page's bitmap in the backend
 * cache during idle time. The user-visible tile path never waits on this.
 */
function scheduleAdjacentPrefetch() {
  if (!_viewport || state.presentationMode || state.cur) return;
  const pageInfos = state.pageInfos || [];
  if (pageInfos.length < 2) return;

  const leftActive = _viewport.getActivePageInView('left');
  const targets = [];
  if (leftActive + 1 < pageInfos.length) targets.push(leftActive + 1);
  if (!_viewport.splitMode && leftActive + 2 < pageInfos.length) targets.push(leftActive + 2);
  if (_viewport.splitMode) {
    const rightActive = _viewport.getActivePageInView('right');
    if (rightActive + 1 < pageInfos.length && rightActive + 1 !== leftActive + 1) {
      targets.push(rightActive + 1);
    }
  }
  if (!targets.length) return;

  if (_prefetchTimer) clearTimeout(_prefetchTimer);
  const seq = ++_prefetchSeq;
  const zoom = _viewport.zoom;
  const px = tiles.quantizeTilePx(zoom, state.dpr);

  const run = () => {
    if (seq !== _prefetchSeq || !_viewport || state.presentationMode || state.cur) return;
    const current = _viewport.getActivePageInView('left');
    const now = Date.now();
    // Drop stale entries so the map cannot grow on long sessions.
    if (_prefetchedAt.size > 80) {
      for (const [key, at] of _prefetchedAt) {
        if (now - at > 30000) _prefetchedAt.delete(key);
      }
    }
    for (const target of targets) {
      if (target < current - 1 || target > current + 2) continue;
      const key = `${target}:${px}`;
      if (now - (_prefetchedAt.get(key) || 0) < 8000) continue;
      _prefetchedAt.set(key, now);
      ipc.prefetchPage(target, px).catch(() => {});
    }
  };

  _prefetchTimer = setTimeout(() => {
    _prefetchTimer = null;
    // A plain short delay is deliberate: WebKitGTK may take its full idle
    // timeout before running requestIdleCallback, which made the next page
    // ready only long after the user had already scrolled to it.
    run();
  }, 480);
}

export function scheduleRedrawAll() {
  if (_redrawAllPending) return;
  _redrawAllPending = true;
  requestAnimationFrame(() => {
    _redrawAllPending = false;
    redrawAll();
  });
}

// ---------------------------------------------------------------------------
// Offscreen per-page #dry bitmap cache
// ---------------------------------------------------------------------------
// Panning/scrolling with 300+ strokes per page previously re-rasterized every
// vector ribbon on every frame (5–18 ms/frame). A page rendered at the current
// quantized scale is cached offscreen, so a pure pan frame becomes N single
// `drawImage` blits (< 0.3 ms/page, effectively O(1) in annotation count).
const _dryPageCache = new Map(); // sheet -> { canvas, ctx, versionKey, scale, targetW, targetH, bytes, lastUsed }
const _drySheetVersions = new Map(); // sheet -> invalidation counter
let _dryGlobalVersion = 1;
let _dryRenderCount = 0;

const DRY_CACHE_MAX_PAGES = 12;
const DRY_CACHE_MAX_BYTES = 96 * 1024 * 1024;
const DRY_CACHE_MAX_SCALE = 2.25; // device pixels per layout point
const _lastPaneRenderScale = { left: 0, right: 0 };

/**
 * Invalidate the cached #dry page bitmap(s).
 * @param {number|null} sheet  specific page sheet, or null/undefined for all
 */
export function invalidateDryPageCache(sheet = null) {
  if (sheet === null || sheet === undefined) {
    _dryGlobalVersion++;
    for (const entry of _dryPageCache.values()) releaseDryEntry(entry);
    _dryPageCache.clear();
    return;
  }
  const prev = _drySheetVersions.get(sheet) || 0;
  _drySheetVersions.set(sheet, prev + 1);
  const prefix = `${sheet}:`;
  for (const key of Array.from(_dryPageCache.keys())) {
    if (!key.startsWith(prefix)) continue;
    releaseDryEntry(_dryPageCache.get(key));
    _dryPageCache.delete(key);
  }
}

export function getDryPageCacheSize() {
  return _dryPageCache.size;
}

/** Number of full page-bitmap rasterizations since load — a test/debug hook. */
export function getDryPageRenderCount() {
  return _dryRenderCount;
}

/** Diagnostics snapshot of the #dry page cache (test/debug aid). */
export function getDryPageCacheDebug() {
  const entries = [];
  for (const [key, entry] of _dryPageCache) {
    entries.push({ key, versionKey: entry.versionKey, bytes: entry.bytes, w: entry.targetW, h: entry.targetH });
  }
  return {
    globalVersion: _dryGlobalVersion,
    sheetVersions: Object.fromEntries(_drySheetVersions),
    renderCount: _dryRenderCount,
    entries,
  };
}

function releaseDryEntry(entry) {
  if (!entry || !entry.canvas) return;
  try {
    entry.canvas.width = 0;
    entry.canvas.height = 0;
  } catch (_) { /* canvas already disposed */ }
}

function evictDryPageCache() {
  let totalBytes = 0;
  for (const entry of _dryPageCache.values()) totalBytes += entry.bytes;
  while (_dryPageCache.size > 1 && (_dryPageCache.size > DRY_CACHE_MAX_PAGES || totalBytes > DRY_CACHE_MAX_BYTES)) {
    const oldestKey = _dryPageCache.keys().next().value;
    const oldest = _dryPageCache.get(oldestKey);
    _dryPageCache.delete(oldestKey);
    totalBytes -= oldest ? oldest.bytes : 0;
    releaseDryEntry(oldest);
  }
}

function dryCacheVersionKey(sheet, pi, targetW, targetH) {
  const template = (pi && pi.template) ? pi.template : 'blank';
  return `${_dryGlobalVersion}:${_drySheetVersions.get(sheet) || 0}:${template}:${targetW}x${targetH}`;
}

/**
 * Render one page's annotations (template guidelines, images, text, ink) in
 * page-local coordinates. The caller applies the page translate/scale.
 */
function drawPageContent(ctx, pl, pi) {
  // 0. Page template guidelines
  if (pi && pi.template && pi.template !== 'blank') {
    templates.drawPageTemplateGuidelines(ctx, pi.template, pl.width, pl.height);
  }

  // 1. Embedded images (rendered with clean source-over, never multiplied)
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1.0;
  if (state.images && state.images.length) {
    for (const img of state.images) {
      if (!img.deleted && img.sheet === pl.sheet) {
        if (state.transformMode && (state.selectedImages || []).some(si => String(si.id) === String(img.id))) {
          continue;
        }
        let el = img._el;
        const url = img.dataUrl || img.data_url;
        if (!el && url && typeof Image !== 'undefined') {
          el = new Image();
          el.onload = () => {
            // The bitmap only becomes drawable now: drop the stale page cache.
            invalidateDryPageCache(img.sheet);
            scheduleRedrawAll();
          };
          el.src = url;
          img._el = el;
        }
        if (el && el.complete && el.naturalWidth > 0) {
          try {
            ctx.drawImage(el, img.x, img.y, img.width, img.height);
          } catch (_) {}
        }
      }
    }
  }

  const sheetStrokes = (window.Ink && typeof window.Ink.drawStroke === 'function')
    ? documentOps.getStrokesForSheet(pl.sheet)
    : [];
  const pageW = pl.width;
  const pageH = pl.height;

  // 2. Optical highlighter strokes (drawn below text and opaque ink with multiply)
  for (const s of sheetStrokes) {
    if (s.deleted || s.kind !== 'highlighter') continue;
    if (s.bbox) {
      const margin = s.base_width || 16;
      if (
        s.bbox[2] < -margin ||
        s.bbox[0] > pageW + margin ||
        s.bbox[3] < -margin ||
        s.bbox[1] > pageH + margin
      ) {
        continue;
      }
    }
    window.Ink.drawStroke(ctx, s);
  }

  // 3. Direct in-place text objects (source-over, crisp and legible)
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1.0;
  if (state.textObjects && state.textObjects.length) {
    for (const t of state.textObjects) {
      if (!t.deleted && t.sheet === pl.sheet && t.text) {
        if (state.transformMode && (state.selectedTextObjects || []).some(st => String(st.id) === String(t.id))) {
          continue;
        }
        ctx.save();
        ctx.fillStyle = t.color || '#141724';
        const weight = t.bold ? 'bold ' : '';
        const slant = t.italic ? 'italic ' : '';
        const size = t.fontSize || t.font_size || 16;
        ctx.font = `${slant}${weight}${size}px Inter, system-ui, -apple-system, sans-serif`;
        ctx.textBaseline = 'top';
        const lines = (t.text || '').split('\n');
        const lineHeight = size * 1.35;
        lines.forEach((line, idx) => {
          ctx.fillText(line, t.x, t.y + idx * lineHeight);
        });
        ctx.restore();
      }
    }
  }

  // 4. Opaque vector ink strokes (source-over on top of text and highlighters)
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1.0;
  for (const s of sheetStrokes) {
    if (s.deleted || s.kind === 'highlighter') continue;
    if (s.bbox) {
      const margin = s.base_width || 4;
      if (
        s.bbox[2] < -margin ||
        s.bbox[0] > pageW + margin ||
        s.bbox[3] < -margin ||
        s.bbox[1] > pageH + margin
      ) {
        continue;
      }
    }
    window.Ink.drawStroke(ctx, s);
  }
}

/**
 * Whether every annotation on this page lies inside the page rectangle. The
 * offscreen page bitmap is page-sized, so anything that spills into the margin
 * (which the vector path renders and the PDF stores) must use the exact vector
 * path instead of the cached bitmap.
 */
function pageContentWithinBounds(pl) {
  const w = pl.width;
  const h = pl.height;
  const eps = 0.5;
  const inside = (x0, y0, x1, y1) => x0 >= -eps && y0 >= -eps && x1 <= w + eps && y1 <= h + eps;

  const strokeList = documentOps.getStrokesForSheet(pl.sheet);
  for (const s of strokeList) {
    if (s.deleted) continue;
    if (!s.bbox || !Number.isFinite(s.bbox[0])) return false;
    const margin = (s.base_width || 2) / 2;
    if (!inside(s.bbox[0] - margin, s.bbox[1] - margin, s.bbox[2] + margin, s.bbox[3] + margin)) return false;
  }

  for (const img of (state.images || [])) {
    if (img.deleted || (img.sheet || 0) !== pl.sheet) continue;
    if (!inside(img.x, img.y, img.x + img.width, img.y + img.height)) return false;
  }

  for (const t of (state.textObjects || [])) {
    if (t.deleted || (t.sheet || 0) !== pl.sheet) continue;
    const tw = t.width || Math.max(120, (t.text || '').length * 8);
    const th = t.height || 32;
    if (!inside(t.x, t.y, t.x + tw, t.y + th)) return false;
  }

  return true;
}

/**
 * Return a cached offscreen canvas for one page at `z`, rendering it on miss.
 * Component-space bitmap caching keeps pan frames pixel-identical to the vector
 * path at the same zoom because the canvas is rendered at exactly
 * `pl.width * z * dpr` device pixels and blitted 1:1.
 */
function getOrRenderDryPage(pl, pi, z) {
  if (typeof document === 'undefined' || !document.createElement) return null;
  const sheet = pl.sheet;
  const renderScale = z * state.dpr;
  if (!(renderScale > 0.01)) return null;
  const targetW = Math.max(1, Math.round(pl.width * renderScale));
  const targetH = Math.max(1, Math.round(pl.height * renderScale));
  const versionKey = dryCacheVersionKey(sheet, pi, targetW, targetH);
  // One entry per (page, scale): a split view with independent zooms keeps both
  // variants cached instead of re-rasterising one pane on every frame.
  const cacheKey = `${sheet}:${targetW}x${targetH}`;

  const existing = _dryPageCache.get(cacheKey);
  if (existing && existing.versionKey === versionKey && existing.canvas) {
    // Refresh LRU position.
    _dryPageCache.delete(cacheKey);
    _dryPageCache.set(cacheKey, existing);
    return existing;
  }

  const canvas = existing && existing.canvas ? existing.canvas : document.createElement('canvas');
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  const offCtx = canvas.getContext('2d', { alpha: true });
  if (!offCtx) return null;
  _dryRenderCount++;
  offCtx.setTransform(1, 0, 0, 1, 0, 0);
  offCtx.clearRect(0, 0, targetW, targetH);
  offCtx.save();
  offCtx.scale(renderScale, renderScale);
  drawPageContent(offCtx, pl, pi);
  offCtx.restore();

  const entry = {
    canvas,
    ctx: offCtx,
    versionKey,
    scale: renderScale,
    targetW,
    targetH,
    bytes: targetW * targetH * 4,
    lastUsed: performance.now(),
  };
  _dryPageCache.set(cacheKey, entry);
  evictDryPageCache();
  return entry;
}

/**
 * Test/debug hook: whether the page's annotations fit inside the page-sized
 * offscreen bitmap, i.e. whether the cached fast path can be used.
 */
export function isPageCacheable(sheetIndex) {
  if (!_viewport || typeof _viewport.getPageLayout !== 'function') return false;
  const pl = _viewport.getPageLayout(sheetIndex);
  if (!pl) return false;
  return pageContentWithinBounds(pl);
}

export function redrawAll() {
  if (!_dctx || !_dryCanvas || !_viewport) return;
  _dctx.setTransform(1, 0, 0, 1, 0, 0);
  _dctx.clearRect(0, 0, _dryCanvas.width, _dryCanvas.height);
  _dctx.scale(state.dpr, state.dpr);

  if (!state.cur) {
    clearWet();
  }

  if (!state.inkVisible) return;

  // Live lasso transforms must always use the exact vector path: the selected
  // objects are hidden from #dry while being dragged, which a page bitmap
  // cannot represent.
  const transformActive = !!state.transformMode;

  for (const pane of visiblePanes()) {
    const visiblePages = _viewport.getVisiblePages(pane);
    const z = pane === 'right' && _viewport.splitMode ? _viewport.rightZoom : _viewport.zoom;
    const renderScale = z * state.dpr;
    // A zoom gesture changes the bitmap scale every frame; allocating a fresh
    // full-page canvas per frame would churn tens of MB. Render vectors directly
    // while the scale is moving and start caching on the first settled frame.
    const zoomSettled = Math.abs(renderScale - _lastPaneRenderScale[pane]) < 1e-4;
    _lastPaneRenderScale[pane] = renderScale;
    const canUsePageCache = !transformActive && zoomSettled && renderScale <= DRY_CACHE_MAX_SCALE;

    _dctx.save();
    clipToPane(_dctx, pane);

    for (const pl of visiblePages) {
      const pi = state.pageInfos && state.pageInfos[pl.sheet];

      if (canUsePageCache && pageContentWithinBounds(pl)) {
        const entry = getOrRenderDryPage(pl, pi, z);
        if (entry) {
          const [psx, psy] = _viewport.worldToScreen(pl.x, pl.y, pane);
          _dctx.globalCompositeOperation = 'source-over';
          _dctx.globalAlpha = 1.0;
          try {
            _dctx.drawImage(entry.canvas, psx, psy, pl.width * z, pl.height * z);
          } catch (_) { /* disposed bitmap — next redraw re-renders */ }
          continue;
        }
      }

      _dctx.save();
      const [psx, psy] = _viewport.worldToScreen(pl.x, pl.y, pane);
      _dctx.translate(psx, psy);
      _dctx.scale(z, z);
      drawPageContent(_dctx, pl, pi);
      _dctx.restore();
    }
    _dctx.restore();
  }

  // 4. Persistent text selection and search highlights
  overlays.drawPersistentTextSelectionHighlights(_dctx, state, _viewport, state.dpr, visiblePanes(), clipToPane);
  overlays.drawSearchHighlights(_dctx, state, _viewport, state.dpr, visiblePanes(), clipToPane);

  // Draw selection / lasso overlay on wet layer
  overlays.drawSelectionOverlay(_wctx, state, _viewport, state.dpr, state.activePane || state.drawingPane || 'left');
}

export function drawCommittedStroke(stroke) {
  if (!_dctx || !_viewport || !stroke) return;
  // Incremental dry draw bypasses the page cache; drop it so the next full
  // redraw reflects the committed stroke exactly once.
  invalidateDryPageCache(stroke.sheet || 0);
  const pl = _viewport.getPageLayout(stroke.sheet || 0);
  for (const pane of visiblePanes()) {
    _dctx.save();
    _dctx.setTransform(1, 0, 0, 1, 0, 0);
    _dctx.scale(state.dpr, state.dpr);
    clipToPane(_dctx, pane);
    const [psx, psy] = _viewport.worldToScreen(pl.x, pl.y, pane);
    const z = pane === 'right' && _viewport.splitMode ? _viewport.rightZoom : _viewport.zoom;
    _dctx.translate(psx, psy);
    _dctx.scale(z, z);
    if (window.Ink && typeof window.Ink.drawStroke === 'function') {
      window.Ink.drawStroke(_dctx, stroke);
    }
    _dctx.restore();
  }
}

export function clearWet() {
  if (!_wctx || !_wetCanvas) return;
  _wctx.setTransform(1, 0, 0, 1, 0, 0);
  _wctx.clearRect(0, 0, _wetCanvas.width, _wetCanvas.height);
  _wctx.scale(state.dpr, state.dpr);
}
