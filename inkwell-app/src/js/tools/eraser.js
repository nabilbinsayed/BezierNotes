/* ============================================================================
 * tools/eraser.js — Precision Stroke Eraser Adapter for Inkwell
 * Supports Whole-Stroke erase (default) and Partial split erase, which
 * partitions a stroke into surviving true-vector ribbon fragments around the
 * eraser disc (never a raster mask).
 * ========================================================================== */

import { state, warnDurability } from '../core/state.js';
import * as documentOps from '../core/document.js';
import * as ipc from '../core/ipc.js';
import * as compositor from '../render/compositor.js';

let erasedInGesture = new Set();
let erasedStrokesInGesture = new Set();
// Snapshot of every live stroke at gesture start. Used to consolidate a whole
// erase gesture (including repeated fragment splits) into ONE undo entry.
let _gestureSnapshot = null;

export function onEraserDown(e, ptWorld, pane, viewport) {
  state.isErasing = true;
  erasedInGesture.clear();
  erasedStrokesInGesture.clear();
  _gestureSnapshot = new Map();
  for (const s of (state.strokes || [])) {
    if (!s.deleted) _gestureSnapshot.set(String(s.id), s);
  }
  eraseStrokesAt(ptWorld, pane, viewport);
}

export function onEraserMove(e, ptWorld, pane, viewport) {
  if (!state.isErasing) return;
  eraseStrokesAt(ptWorld, pane, viewport);
}

export function onEraserUp() {
  state.isErasing = false;
  commitErasedStrokes();
}

/**
 * Consolidate everything the gesture changed into a single undoable
 * transaction plus matching WAL journal calls.
 */
function commitErasedStrokes() {
  const snapshot = _gestureSnapshot;
  _gestureSnapshot = null;
  erasedInGesture.clear();
  erasedStrokesInGesture.clear();
  if (!snapshot) return;

  const removed = [];
  for (const [id, s] of snapshot) {
    if (s.deleted) removed.push(s);
  }

  // Surviving fragments are strokes created during the gesture.
  const added = [];
  for (const s of (state.strokes || [])) {
    const id = String(s.id);
    if (!s.deleted && !snapshot.has(id)) added.push(s);
  }
  if (!removed.length && !added.length) return;

  // Intermediate fragments (created and then erased again inside the same
  // gesture) are not part of the transaction: drop them entirely.
  state.strokes = state.strokes.filter(s => {
    if (snapshot.has(String(s.id))) return true;
    return !s.deleted;
  });

  // Restore the pre-gesture state so the document transaction records the true
  // "before" and "after" geometry.
  for (const s of removed) s.deleted = false;

  documentOps.replaceStrokesWithFragments(removed, added, { recordHistory: true });

  for (const s of removed) {
    ipc.deleteStroke(s.id).catch(err => {
      console.warn('[inkwell/eraser] deleteStroke error:', err);
      warnDurability('Erase may not persist: ' + err);
    });
  }
  for (const f of added) {
    ipc.commitStroke(f.sheet, f.kind || 'pen', f.rgb, f.base_width || 1.6, f.points, f.id)
      .then(serverId => { if (serverId) f.id = String(serverId); })
      .catch(err => {
        console.warn('[inkwell/eraser] commitStroke (fragment) error:', err);
        warnDurability('Erase fragment may not persist: ' + err);
      });
  }
  compositor.scheduleRedrawAll();
}

export function eraseStrokesAt(ptWorld, pane, viewport) {
  if (!viewport) return;
  if (!_gestureSnapshot) {
    _gestureSnapshot = new Map();
    for (const s of (state.strokes || [])) {
      if (!s.deleted) _gestureSnapshot.set(String(s.id), s);
    }
  }

  const wx = ptWorld[0];
  const wy = ptWorld[1];

  const pageCoord = viewport.worldToPage(wx, wy);
  const activeSheet = pageCoord ? pageCoord.sheet : 0;
  const sheetStrokes = documentOps.getStrokesForSheet(activeSheet);
  if (!sheetStrokes || !sheetStrokes.length) return;

  const z = (pane === 'right' && viewport.splitMode) ? viewport.rightZoom : viewport.zoom;
  const radius = Math.max(8, 14 / z);
  const partial = state.eraserMode === 'partial';
  const discRadius = Math.max(2, (state.eraserRadius || 12) / z);
  let hitAny = false;
  let splitAny = false;

  for (const s of sheetStrokes.slice()) {
    if (s.deleted) continue;
    const pl = viewport.getPageLayout(s.sheet || 0);

    // Fast AABB bounding box rejection
    if (s.bbox) {
      const sWorldMinX = pl.x + s.bbox[0];
      const sWorldMinY = pl.y + s.bbox[1];
      const sWorldMaxX = pl.x + s.bbox[2];
      const sWorldMaxY = pl.y + s.bbox[3];
      if (sWorldMaxX < wx - radius || sWorldMinX > wx + radius ||
          sWorldMaxY < wy - radius || sWorldMinY > wy + radius) {
        continue;
      }
    }

    // Precise segment proximity test (a shape is tested along its outline)
    const pts = window.Ink && window.Ink.hitPoints ? window.Ink.hitPoints(s) : (s.points || []);
    let hit = false;
    for (let i = 0; i < pts.length; i++) {
      const pt = pts[i];
      const sx = pl.x + (pt.x !== undefined ? pt.x : pt[0]);
      const sy = pl.y + (pt.y !== undefined ? pt.y : pt[1]);
      const effectiveR = radius + ((pt.w !== undefined ? pt.w : s.base_width || 1.6) / 2);

      if (Math.hypot(wx - sx, wy - sy) <= effectiveR) {
        hit = true;
        break;
      }

      if (i > 0) {
        const prev = pts[i - 1];
        const px = pl.x + (prev.x !== undefined ? prev.x : prev[0]);
        const py = pl.y + (prev.y !== undefined ? prev.y : prev[1]);
        if (distToSegment(wx, wy, px, py, sx, sy) <= effectiveR) {
          hit = true;
          break;
        }
      }
    }

    if (!hit) continue;

    // A shape is erased whole: splitting its control points would not split
    // the shape (Plan 095).
    if (partial && !s.shape) {
      // The eraser works in page-local coordinates.
      const fragments = splitStrokeByCircle(s, wx - pl.x, wy - pl.y, discRadius);
      if (fragments && fragments.length) {
        s.deleted = true;
        for (const f of fragments) state.strokes.push(f);
        documentOps.rebuildStrokesBySheet();
        erasedInGesture.add(s.id);
        erasedStrokesInGesture.add(s);
        hitAny = true;
        splitAny = true;
        continue;
      }
      if (fragments && fragments.length === 0) {
        // Disc covers the whole stroke: behave like a whole-stroke erase.
        s.deleted = true;
        erasedInGesture.add(s.id);
        erasedStrokesInGesture.add(s);
        hitAny = true;
        continue;
      }
    }

    s.deleted = true;
    erasedInGesture.add(s.id);
    erasedStrokesInGesture.add(s);
    hitAny = true;
  }

  if (hitAny) {
    if (!state.isErasing) {
      commitErasedStrokes();
    } else {
      compositor.scheduleRedrawAll();
      if (splitAny) compositor.scheduleRedrawTiles();
    }
  }
}

/**
 * Split a stroke into the vector fragments that survive an eraser disc.
 *
 * Long segments are first subdivided so the split lands exactly on the disc
 * boundary, then the dense polyline is partitioned into runs that stay outside
 * the disc. Each crossing gets an exact circle/segment intersection so the
 * fragment caps sit precisely on the eraser edge.
 *
 * @param {object} stroke stroke record with page-local `points`
 * @param {number} cx eraser centre X (page-local)
 * @param {number} cy eraser centre Y (page-local)
 * @param {number} r  eraser radius (page-local)
 * @returns {Array|null} surviving stroke records (empty when fully erased),
 *          or null when the stroke has no usable geometry
 */
export function splitStrokeByCircle(stroke, cx, cy, r) {
  const pts = stroke && (stroke.points || stroke._pts);
  if (!pts || pts.length < 2) return null;

  const radius = Math.max(0.5, r || 0);
  const step = Math.max(2.5, radius * 0.45);
  const baseW = stroke.base_width || stroke.baseWidth || 1.6;
  const defaultW = baseW;
  const widthAt = (p, fallback) => (p && p.w !== undefined && !isNaN(p.w)) ? p.w : fallback;

  // 1. Densify so long straight segments cannot skip over the disc.
  const dense = [];
  dense.push({ x: pts[0].x, y: pts[0].y, w: widthAt(pts[0], defaultW), p: pts[0].p });
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const pieces = len > step ? Math.ceil(len / step) : 1;
    const wa = widthAt(a, defaultW);
    const wb = widthAt(b, defaultW);
    for (let k = 1; k <= pieces; k++) {
      const t = k / pieces;
      dense.push({
        x: a.x + dx * t,
        y: a.y + dy * t,
        w: wa + (wb - wa) * t,
        p: a.p !== undefined && b.p !== undefined ? a.p + (b.p - a.p) * t : a.p,
      });
    }
  }

  // 2. Exact circle/segment intersection (null when the segment misses the disc).
  const crossing = (a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const fx = a.x - cx;
    const fy = a.y - cy;
    const qa = dx * dx + dy * dy;
    if (qa < 1e-9) return null;
    const qb = 2 * (fx * dx + fy * dy);
    const qc = fx * fx + fy * fy - radius * radius;
    const disc = qb * qb - 4 * qa * qc;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    const roots = [(-qb - sq) / (2 * qa), (-qb + sq) / (2 * qa)];
    for (const t of roots) {
      if (t >= 0 && t <= 1) {
        return {
          x: a.x + dx * t,
          y: a.y + dy * t,
          w: widthAt(a, defaultW) + (widthAt(b, defaultW) - widthAt(a, defaultW)) * t,
          p: a.p,
        };
      }
    }
    return null;
  };

  const inside = (p) => Math.hypot(p.x - cx, p.y - cy) <= radius;

  // 3. Partition into outside runs.
  const runs = [];
  let current = null;
  let prevWasInside = null;
  for (let i = 0; i < dense.length; i++) {
    const p = dense[i];
    const isInside = inside(p);
    if (!isInside) {
      if (current === null) {
        current = [];
        if (prevWasInside === true) {
          const cap = crossing(dense[i - 1], p);
          if (cap) current.push(cap);
        }
      }
      current.push(p);
    } else if (current !== null) {
      const cap = crossing(dense[i - 1], p);
      if (cap) current.push(cap);
      runs.push(current);
      current = null;
    }
    prevWasInside = isInside;
  }
  if (current !== null) runs.push(current);

  // 4. Drop degenerate slivers and build real vector stroke records.
  const fragments = [];
  for (const runPts of runs) {
    if (runPts.length < 2) continue;
    let arc = 0;
    for (let i = 1; i < runPts.length; i++) {
      arc += Math.hypot(runPts[i].x - runPts[i - 1].x, runPts[i].y - runPts[i - 1].y);
    }
    if (arc < 1.5) continue;
    const record = (window.Ink && typeof window.Ink.buildStrokeRecord === 'function')
      ? window.Ink.buildStrokeRecord(runPts, stroke.rgb, baseW, stroke.sheet || 0, stroke.kind || 'pen')
      : null;
    if (record) fragments.push(record);
  }
  return fragments;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const l2 = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
  if (l2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
}
