/* ============================================================================
 * render/tiles.js — Level-of-Detail (LOD) Tile Cache & Rasterizer for Inkwell
 * Calculates tile grids, manages LRU memory cache, and draws PDFium bitmaps.
 * ========================================================================== */

import * as ipc from '../core/ipc.js';

export const TILE_PT = 512;
export const TILE_CACHE_MAX = 200;

const tileCache = new Map();
const tilesPending = new Map();
let tileRenderError = null;

export function getTileCacheSize() {
  return tileCache.size;
}

export function getLastTileError() {
  return tileRenderError;
}

export function evictTileCache() {
  if (tileCache.size <= TILE_CACHE_MAX) return;
  let count = tileCache.size - TILE_CACHE_MAX;
  for (const [key, val] of tileCache.entries()) {
    if (count-- <= 0) break;
    if (val && val._bitmap && typeof val._bitmap.close === 'function') {
      val._bitmap.close();
    } else if (val && typeof val.close === 'function') {
      val.close();
    }
    tileCache.delete(key);
  }
}

export function clearTileCache() {
  for (const val of tileCache.values()) {
    if (val && val._bitmap && typeof val._bitmap.close === 'function') {
      val._bitmap.close();
    } else if (val && typeof val.close === 'function') {
      val.close();
    }
  }
  tileCache.clear();
  tilesPending.clear();
}

export function tileGridForRect(rx0, ry0, rx1, ry1) {
  const tiles = [];
  const tx0 = Math.floor(rx0 / TILE_PT);
  const ty0 = Math.floor(ry0 / TILE_PT);
  const tx1 = Math.ceil(rx1 / TILE_PT);
  const ty1 = Math.ceil(ry1 / TILE_PT);
  for (let ty = ty0; ty < ty1; ty++) {
    for (let tx = tx0; tx < tx1; tx++) {
      tiles.push({
        tx, ty,
        rect: [tx * TILE_PT, ty * TILE_PT, (tx + 1) * TILE_PT, (ty + 1) * TILE_PT],
      });
    }
  }
  return tiles;
}

export function quantizeTilePx(zoom, dpr) {
  const targetPx = TILE_PT * zoom * dpr;
  if (targetPx <= 384) return 256;
  if (targetPx <= 640) return 512;
  if (targetPx <= 896) return 768;
  if (targetPx <= 1280) return 1024;
  if (targetPx <= 1792) return 1536;
  return 2048;
}

export function findCachedTileFallback(sheetIdx, tr) {
  const lodSteps = [512, 768, 256, 1024, 1536, 2048];
  for (const altPx of lodSteps) {
    const altKey = `${sheetIdx}:${tr.join(',')}:${altPx}`;
    if (tileCache.has(altKey)) {
      return tileCache.get(altKey);
    }
  }
  return null;
}

export async function fetchTile(page, rect, px) {
  const key = `${page}:${rect.join(',')}:${px}`;
  if (tileCache.has(key)) {
    const val = tileCache.get(key);
    tileCache.delete(key);
    tileCache.set(key, val);
    return { key, data: val };
  }
  if (tilesPending.has(key)) return tilesPending.get(key);

  const task = (async () => {
    try {
      const raw = await ipc.fetchTile(page, rect, px);
      if (!raw) return null;

      const rw = Math.max(1.0, rect[2] - rect[0]);
      const rh = Math.max(1.0, rect[3] - rect[1]);
      const baseSpan = (rw <= 512.0 && rh <= 512.0) ? 512.0 : Math.max(rw, rh);
      const scale = px / baseSpan;
      const tileW = Math.round(rw * scale) || 1;
      const tileH = Math.round(rh * scale) || 1;
      const expectedBytes = tileW * tileH * 4;

      let rgbaData = raw;
      if (rgbaData instanceof ArrayBuffer) {
        rgbaData = new Uint8ClampedArray(rgbaData);
      } else if (ArrayBuffer.isView(rgbaData)) {
        rgbaData = new Uint8ClampedArray(rgbaData.buffer, rgbaData.byteOffset, rgbaData.byteLength);
      } else if (Array.isArray(rgbaData)) {
        rgbaData = Uint8ClampedArray.from(rgbaData);
      } else if (rgbaData && typeof rgbaData === 'object' && rgbaData.buffer) {
        rgbaData = new Uint8ClampedArray(rgbaData.buffer, rgbaData.byteOffset || 0, rgbaData.byteLength);
      }

      const byteLen = rgbaData ? rgbaData.byteLength : 0;
      if (!rgbaData || byteLen !== expectedBytes) {
        throw new Error(`Invalid tile buffer: expected ${expectedBytes} RGBA bytes (${tileW}x${tileH}), got ${byteLen}`);
      }

      const imgData = new ImageData(rgbaData, tileW, tileH);
      let bitmap = null;
      if (typeof createImageBitmap === 'function') {
        try {
          bitmap = await createImageBitmap(imgData);
        } catch (e) {
          console.warn('[inkwell/tiles] createImageBitmap failed, falling back to canvas:', e);
        }
      }
      if (!bitmap) {
        const off = document.createElement('canvas');
        off.width = tileW;
        off.height = tileH;
        const offCtx = off.getContext('2d');
        if (offCtx) {
          offCtx.putImageData(imgData, 0, 0);
          bitmap = off;
        }
      }
      tileCache.set(key, bitmap);
      tileRenderError = null;
      return { key, data: bitmap };
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error('[inkwell/tiles] fetchTile error:', msg);
      tileRenderError = msg;
      return null;
    } finally {
      tilesPending.delete(key);
    }
  })();

  tilesPending.set(key, task);
  return task;
}

/**
 * Blit one tile bitmap. The caller is responsible for having applied the DPR
 * transform, the pane clip and the page-rectangle clip, so this is a single
 * `drawImage` with a sub-pixel seam fudge — no per-tile save/clip/restore.
 */
export function blitTileBitmap(ctx, data, tr, pl, pane, viewport) {
  const [sx0, sy0] = viewport.worldToScreen(pl.x + tr[0], pl.y + tr[1], pane);
  const [sx1, sy1] = viewport.worldToScreen(pl.x + tr[2], pl.y + tr[3], pane);
  const dw = (sx1 - sx0) + 0.6;
  const dh = (sy1 - sy0) + 0.6;
  if (!(dw > 0) || !(dh > 0)) return;
  try {
    ctx.drawImage(data, sx0, sy0, dw, dh);
  } catch (_) { /* tainted/closed bitmap — next redraw retries */ }
}

/**
 * Standalone tile draw (kept for external callers): applies its own pane and
 * page clips. Per-frame paths should use `redrawTilesForPage`, which hoists
 * both clips once per page.
 */
export function drawTileData(ctx, data, tr, pl, pane, pi, viewport, dpr, clipPaneFn) {
  if (!ctx || !data || !viewport || !pl) return;
  if (pi && pi.template === 'dark') return;

  const [pageX0, pageY0] = viewport.worldToScreen(pl.x, pl.y, pane);
  const [pageX1, pageY1] = viewport.worldToScreen(
    pl.x + (pi ? pi.width_pt : pl.width),
    pl.y + (pi ? pi.height_pt : pl.height),
    pane,
  );

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  if (typeof clipPaneFn === 'function') clipPaneFn(ctx, pane);
  ctx.beginPath();
  ctx.rect(pageX0, pageY0, pageX1 - pageX0, pageY1 - pageY0);
  ctx.clip();
  blitTileBitmap(ctx, data, tr, pl, pane, viewport);
  ctx.restore();
}

/**
 * Synchronously blit every cached tile visible on `pl` and collect the misses
 * into `missingOut` for a background fetch. Returns immediately: no IPC, no
 * awaiting, so a pan/scroll frame can never be stalled by PDFium.
 */
export function redrawTilesForPage(ctx, pane, pi, pl, viewport, dpr, bounds, clipPaneFn, isCurrentEpoch = () => true, missingOut = null) {
  if (!ctx || !viewport || !pl || !pi) return;
  if (pi.template === 'dark') return;

  const [wx0, wy0] = viewport.screenToWorld(bounds.x, bounds.y, pane);
  const [wx1, wy1] = viewport.screenToWorld(bounds.x + bounds.width, bounds.y + bounds.height, pane);
  const rx0 = Math.max(0, wx0 - pl.x);
  const ry0 = Math.max(0, wy0 - pl.y);
  const rx1 = Math.min(pi.width_pt, wx1 - pl.x);
  const ry1 = Math.min(pi.height_pt, wy1 - pl.y);
  if (rx1 <= rx0 || ry1 <= ry0) return;

  const zoom = pane === 'right' && viewport.splitMode ? viewport.rightZoom : viewport.zoom;
  const gridTiles = tileGridForRect(rx0, ry0, rx1, ry1);
  if (!gridTiles.length) return;
  const px = quantizeTilePx(zoom, dpr);

  const [pageX0, pageY0] = viewport.worldToScreen(pl.x, pl.y, pane);
  const [pageX1, pageY1] = viewport.worldToScreen(pl.x + pi.width_pt, pl.y + pi.height_pt, pane);

  // Hoisted clipping: pane bounds + page rectangle, applied once per page
  // instead of once per 256–512px tile (12–24x fewer clip operations/frame).
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  if (typeof clipPaneFn === 'function') clipPaneFn(ctx, pane);
  ctx.beginPath();
  ctx.rect(pageX0, pageY0, pageX1 - pageX0, pageY1 - pageY0);
  ctx.clip();

  for (const gt of gridTiles) {
    const tr = [
      Math.max(0, gt.rect[0]),
      Math.max(0, gt.rect[1]),
      Math.min(pi.width_pt, gt.rect[2]),
      Math.min(pi.height_pt, gt.rect[3]),
    ];
    if (tr[2] <= tr[0] || tr[3] <= tr[1]) continue;

    const trKey = `${pl.sheet}:${tr.join(',')}:${px}`;
    const cached = tileCache.get(trKey);
    if (cached) {
      // Refresh LRU recency without re-inserting the key.
      tileCache.delete(trKey);
      tileCache.set(trKey, cached);
      if (isCurrentEpoch()) blitTileBitmap(ctx, cached, tr, pl, pane, viewport);
      continue;
    }

    const fallback = findCachedTileFallback(pl.sheet, tr);
    if (fallback && isCurrentEpoch()) blitTileBitmap(ctx, fallback, tr, pl, pane, viewport);

    if (missingOut) missingOut.push({ sheet: pl.sheet, rect: tr, px, drewFallback: !!fallback });
  }

  ctx.restore();
}

/**
 * Fire-and-forget tile fetches for the misses reported by `redrawTilesForPage`.
 * `onTileReady` is invoked once per arriving bitmap so the compositor can
 * schedule a cached redraw; the waiting itself never blocks a frame.
 */
export function fetchMissingTiles(missing, onTileReady) {
  if (!missing || !missing.length) return;
  const seen = new Set();
  for (const m of missing) {
    const key = `${m.sheet}:${m.rect.join(',')}:${m.px}`;
    if (seen.has(key) || tileCache.has(key)) continue;
    seen.add(key);
    fetchTile(m.sheet, m.rect, m.px).then(result => {
      if (result && result.data && typeof onTileReady === 'function') onTileReady(result);
    });
  }
}
