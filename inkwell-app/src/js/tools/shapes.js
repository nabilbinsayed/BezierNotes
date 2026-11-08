/* ============================================================================
 * tools/shapes.js — Geometric Shapes Tool Adapter for Inkwell
 * Generates exact vector rectangles, ellipses, and ruler lines without curve distortion.
 * ========================================================================== */

import { state, warnDurability } from '../core/state.js';
import * as documentOps from '../core/document.js';
import * as ipc from '../core/ipc.js';
import * as compositor from '../render/compositor.js';
import * as overlays from '../render/overlays.js';
import * as shapesModel from '../core/shapes-model.js';

export function onShapeDown(e, ptWorld, pane, viewport) {
  state.shapeStart = [ptWorld[0], ptWorld[1]];
  state.shapeEnd = [ptWorld[0], ptWorld[1]];
  state.drawingPane = pane;
}

export function onShapeMove(e, ptWorld, pane, viewport) {
  if (!state.shapeStart) return;
  let endX = ptWorld[0];
  let endY = ptWorld[1];

  if (e && e.shiftKey) {
    const startX = state.shapeStart[0];
    const startY = state.shapeStart[1];
    const dx = endX - startX;
    const dy = endY - startY;
    const kind = state.shapeKind || 'rect';

    if (kind === 'line' || kind === 'ruler' || kind === 'arrow') {
      const dist = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      // Snap to nearest 15° increment (Math.PI / 12)
      const snapped = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
      endX = startX + dist * Math.cos(snapped);
      endY = startY + dist * Math.sin(snapped);
    } else {
      // rect, ellipse, triangle: constrain |dx| === |dy|
      const size = Math.max(Math.abs(dx), Math.abs(dy));
      endX = startX + (dx >= 0 ? size : -size);
      endY = startY + (dy >= 0 ? size : -size);
    }
  }

  state.shapeEnd = [endX, endY];
  
  compositor.clearWet();
  const { wctx } = compositor.getContexts();
  if (wctx) {
    overlays.drawShapeOverlay(wctx, state, viewport, state.dpr, pane, compositor.clipToPane);
  }
}

export function onShapeUp(e, viewport) {
  if (!state.shapeStart || !state.shapeEnd) return;
  const start = state.shapeStart;
  const end = state.shapeEnd;
  state.shapeStart = null;
  state.shapeEnd = null;

  const pageCoord = viewport.worldToPage(start[0], start[1]);
  const activeSheet = pageCoord.sheet;
  const pl = viewport.getPageLayout(activeSheet);

  const px0 = start[0] - pl.x;
  const py0 = start[1] - pl.y;
  const px1 = end[0] - pl.x;
  const py1 = end[1] - pl.y;

  const dx = px1 - px0;
  const dy = py1 - py0;
  if (Math.hypot(dx, dy) < 4) {
    compositor.clearWet();
    return;
  }

  const kind = state.shapeKind || 'rect';
  // Plan 095: a parametric shape (control points, see ink.js), not a
  // densely sampled stroke, so it stays editable as a shape and is saved as
  // the matching native PDF annotation.
  let shapeKind;
  let pts;
  if (kind === 'rect' || kind === 'ellipse') {
    const cx = (px0 + px1) / 2;
    const cy = (py0 + py1) / 2;
    shapeKind = kind;
    pts = [[cx, cy], [cx + Math.abs(dx) / 2, cy], [cx, cy + Math.abs(dy) / 2]];
  } else if (kind === 'triangle') {
    shapeKind = 'polygon';
    pts = [[(px0 + px1) / 2, py0], [px1, py1], [px0, py1]];
  } else if (kind === 'arrow') {
    shapeKind = 'arrow';
    pts = [[px0, py0], [px1, py1]];
  } else {
    shapeKind = 'line';
    pts = [[px0, py0], [px1, py1]];
  }
  const stroke = shapesModel.makeShapeStroke({
    kind: shapeKind,
    sheet: activeSheet,
    points: pts,
    rgb: state.color || [0.08, 0.09, 0.14],
    width: state.baseWidth || 1.6,
    arrowEnd: shapeKind === 'arrow',
  });

  documentOps.addStroke(stroke, { recordHistory: true });
  ipc.journalShapeMutation('upsert', shapesModel.toBackendShape(stroke)).catch(err => {
    console.warn('[inkwell/shapes] shape journal error:', err);
    warnDurability('Shape may not persist: ' + err);
  });

  compositor.clearWet();
  compositor.redrawAll();
}
