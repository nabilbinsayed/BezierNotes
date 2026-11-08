/**
 * Floating popovers for text selection and lasso selection.
 * (Split out of main.js by Plan 093; behaviour unchanged.)
 */

import { state, $ } from '../core/state.js';
import * as commandsModule from '../core/commands.js';
import * as overlays from '../render/overlays.js';
import { getViewport } from '../app/viewport-ref.js';
import * as documentOps from '../core/document.js';
import * as compositor from '../render/compositor.js';

export function updateTextSelectionPopover() {
  const pop = $('textSelectionPopover');
  if (!pop) return;
  const sel = state.textSelection;
  if (sel && sel.text && sel.text.trim() && (state.activeTool === 'textSelect' || state.activeTool === 'textselect') && sel.rects && sel.rects.length > 0) {
    if (getViewport()) {
      const pl = getViewport().getPageLayout(sel.sheet);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const r of sel.rects) {
        if (r.rect) {
          if (r.rect[0] < minX) minX = r.rect[0];
          if (r.rect[1] < minY) minY = r.rect[1];
          if (r.rect[2] > maxX) maxX = r.rect[2];
          if (r.rect[3] > maxY) maxY = r.rect[3];
        }
      }
      if (!Number.isFinite(minX)) {
        pop.classList.add('hidden');
        return;
      }
      const midX = (minX + maxX) / 2;
      const pane = state.activePane || state.drawingPane || 'left';
      const [sx, syTop] = getViewport().worldToScreen(pl.x + midX, pl.y + minY, pane);
      const [, syBottom] = getViewport().worldToScreen(pl.x + midX, pl.y + maxY, pane);

      if (syBottom < 30 || syTop > window.innerHeight - 30) {
        pop.classList.add('hidden');
        return;
      }

      const clampedX = Math.max(120, Math.min(window.innerWidth - 120, sx));
      if (syTop > 110) {
        pop.style.left = clampedX + 'px';
        pop.style.top = (syTop - 10) + 'px';
        pop.style.transform = 'translate(-50%, -100%)';
      } else {
        pop.style.left = clampedX + 'px';
        pop.style.top = (syBottom + 10) + 'px';
        pop.style.transform = 'translate(-50%, 0)';
      }
    }
    pop.classList.remove('hidden');
  } else {
    pop.classList.add('hidden');
  }
}

export function updateLassoSelectionPopover() {
  const pop = $('lassoSelectionPopover');
  if (!pop) return;
  const hasSelection = (state.selectedStrokes && state.selectedStrokes.some(s => !s.deleted)) ||
                       (state.selectedImages && state.selectedImages.some(img => !img.deleted)) ||
                       (state.selectedTextObjects && state.selectedTextObjects.some(t => !t.deleted));
  if (state.activeTool === 'lasso' && hasSelection && getViewport()) {
    const bounds = overlays.getSelectionBounds(state, getViewport());
    if (!bounds || !Number.isFinite(bounds.x0)) {
      pop.classList.add('hidden');
      return;
    }
    const midX = (bounds.x0 + bounds.x1) / 2;
    const pane = state.activePane || state.drawingPane || 'left';
    const [sx, syTop] = getViewport().worldToScreen(midX, bounds.y0, pane);
    const [, syBottom] = getViewport().worldToScreen(midX, bounds.y1, pane);

    if (syBottom < 30 || syTop > window.innerHeight - 30) {
      pop.classList.add('hidden');
      return;
    }

    const clampedX = Math.max(160, Math.min(window.innerWidth - 160, sx));
    if (syTop > 110) {
      pop.style.left = clampedX + 'px';
      pop.style.top = (syTop - 10) + 'px';
      pop.style.transform = 'translate(-50%, -100%)';
    } else {
      pop.style.left = clampedX + 'px';
      pop.style.top = (syBottom + 10) + 'px';
      pop.style.transform = 'translate(-50%, 0)';
    }
    updateShapeStyleControls();
    pop.classList.remove('hidden');
  } else {
    pop.classList.add('hidden');
  }
}

// ---- Shape style (Plan 095) ----

const CLOSED = ['rect', 'ellipse', 'polygon'];

function selectedShapes() {
  return (state.selectedStrokes || []).filter(s => s && s.shape && !s.deleted);
}

function shapeControlState(shapes) {
  const closed = shapes.filter(s => CLOSED.includes(s.shape.kind));
  const rects = shapes.filter(s => s.shape.kind === 'rect');
  const lines = shapes.filter(s => s.shape.kind === 'line' || s.shape.kind === 'arrow');
  const all = (list, f) => list.length > 0 && list.every(f);
  return {
    fill: { show: closed.length > 0, on: all(closed, s => Array.isArray(s.shape.fill)) },
    dash: { show: shapes.length > 0, on: all(shapes, s => Array.isArray(s.shape.dash) && s.shape.dash.length > 0) },
    round: { show: rects.length > 0, on: all(rects, s => (s.shape.cornerRadius || 0) > 0) },
    arrow: { show: lines.length > 0, on: all(lines, s => !!s.shape.arrowEnd) },
    closed, rects, lines,
  };
}

function updateShapeStyleControls() {
  const group = $('lassoShapeStyle');
  if (!group) return;
  const shapes = selectedShapes();
  group.classList.toggle('hidden', shapes.length === 0);
  if (!shapes.length) return;
  const st = shapeControlState(shapes);
  for (const [id, key] of [['btnShapeFill', 'fill'], ['btnShapeDash', 'dash'], ['btnShapeRound', 'round'], ['btnShapeArrow', 'arrow']]) {
    const b = $(id);
    if (!b) continue;
    b.classList.toggle('hidden', !st[key].show);
    b.setAttribute('aria-pressed', st[key].on ? 'true' : 'false');
  }
}

function restyle(targets, change) {
  if (documentOps.restyleShapes(targets, change)) {
    compositor.scheduleRedrawAll();
    updateShapeStyleControls();
  }
}

/** Toggle a style across the selected shapes (on for all unless all have it). */
export function toggleShapeStyle(key) {
  const shapes = selectedShapes();
  const st = shapeControlState(shapes);
  if (key === 'fill') {
    const on = !st.fill.on;
    restyle(st.closed, style => {
      // a light tint of the outline colour keeps the outline readable
      style.shape.fill = on ? style.rgb.map(c => +(c * 0.25 + 0.75).toFixed(3)) : null;
    });
  } else if (key === 'dash') {
    const on = !st.dash.on;
    restyle(shapes, style => {
      const w = Math.max(1, style.base_width || 1.6);
      style.shape.dash = on ? [+(w * 3).toFixed(2), +(w * 2).toFixed(2)] : null;
    });
  } else if (key === 'round') {
    const on = !st.round.on;
    restyle(st.rects, (style, s) => {
      const [c, a, b] = s.points;
      const half = Math.min(Math.hypot(a.x - c.x, a.y - c.y), Math.hypot(b.x - c.x, b.y - c.y));
      style.shape.cornerRadius = on ? +Math.min(12, half * 0.35).toFixed(2) : 0;
    });
  } else if (key === 'arrow') {
    const on = !st.arrow.on;
    restyle(st.lines, style => {
      style.shape.arrowEnd = on;
      style.shape.kind = on ? 'arrow' : 'line';
    });
  } else if (key === 'pen') {
    restyle(shapes, style => {
      style.rgb = [...(state.color || style.rgb)];
      style.base_width = state.baseWidth || style.base_width;
    });
  }
}

export function initLassoSelectionPopover() {
  for (const [id, key] of [['btnShapeFill', 'fill'], ['btnShapeDash', 'dash'], ['btnShapeRound', 'round'], ['btnShapeArrow', 'arrow'], ['btnShapePenStyle', 'pen']]) {
    const b = $(id);
    if (b) b.addEventListener('click', () => toggleShapeStyle(key));
  }
  $('btnLassoCopy') && $('btnLassoCopy').addEventListener('click', () => {
    commandsModule.commands.execute('edit.copy');
  });
  $('btnLassoCopySvg') && $('btnLassoCopySvg').addEventListener('click', () => {
    commandsModule.commands.execute('edit.copySvg');
  });
  $('btnLassoDuplicate') && $('btnLassoDuplicate').addEventListener('click', () => {
    commandsModule.commands.execute('edit.duplicate');
  });
  $('btnLassoDelete') && $('btnLassoDelete').addEventListener('click', () => {
    commandsModule.commands.execute('edit.delete');
  });
}
