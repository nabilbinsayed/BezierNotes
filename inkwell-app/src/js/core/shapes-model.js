/**
 * Parametric shapes in the frontend (Plan 095).
 *
 * A shape lives in `state.strokes` as a stroke-like object with a `shape`
 * descriptor, so selection, lasso transforms, undo, delete and copy treat it
 * like ink. Its `points` are control points (see `ink.js`, "Parametric
 * shapes"), tagged `sk: kind`, which every affine edit maps exactly. The
 * backend stores it as an `inkwell_core::shape::ShapeObject`; these helpers
 * convert between the two.
 */

export const SHAPE_KINDS = ['line', 'arrow', 'rect', 'ellipse', 'polygon', 'polyline'];

export function isShape(s) {
  return !!(s && s.shape && SHAPE_KINDS.includes(s.shape.kind));
}

function newId() {
  return 'shp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/** A new shape stroke. `points` are `[x, y]` pairs in page space. */
export function makeShapeStroke({
  id = newId(), kind, sheet = 0, points, rgb = [0.08, 0.09, 0.14], width = 1.6,
  fill = null, opacity = 1, dash = null, cornerRadius = 0, arrowStart = false, arrowEnd = false,
}) {
  const s = {
    id,
    kind: 'pen',
    rgb: [...rgb],
    base_width: width,
    sheet,
    points: points.map(([x, y]) => ({ x, y, p: 1, w: width, sk: kind })),
    deleted: false,
    shape: { kind, fill: fill ? [...fill] : null, opacity, dash: dash ? [...dash] : null, cornerRadius, arrowStart, arrowEnd },
  };
  refreshShapeGeometry(s);
  return s;
}

/** Recompute cached bounds after the points or style changed. */
export function refreshShapeGeometry(s) {
  for (const p of s.points) {
    p.sk = s.shape.kind;
    p.w = s.base_width;
  }
  if (typeof window !== 'undefined' && window.Ink && typeof window.Ink.computeStrokeBbox === 'function') {
    s.bbox = window.Ink.computeStrokeBbox(s.points, s.base_width);
  }
  s._cachedPath2D = null;
  return s;
}

/** The backend's `ShapeObject` for a shape stroke. */
export function toBackendShape(s) {
  const d = s.shape;
  return {
    id: String(s.id),
    sheet: s.sheet || 0,
    kind: d.kind,
    points: (s.points || []).map(p => [p.x, p.y]),
    stroke_rgb: s.rgb || [0.08, 0.09, 0.14],
    stroke_width: s.base_width || 1.6,
    fill_rgb: Array.isArray(d.fill) ? d.fill : null,
    opacity: d.opacity === undefined ? 1 : d.opacity,
    dash: Array.isArray(d.dash) && d.dash.length ? d.dash : null,
    corner_radius: d.cornerRadius || 0,
    arrow_start: !!d.arrowStart,
    arrow_end: !!d.arrowEnd,
  };
}

/** A shape stroke from the backend's `ShapeObject`. */
export function fromBackendShape(o) {
  return makeShapeStroke({
    id: o.id,
    kind: o.kind,
    sheet: o.sheet || 0,
    points: o.points || [],
    rgb: o.stroke_rgb,
    width: o.stroke_width,
    fill: o.fill_rgb || null,
    opacity: o.opacity === undefined ? 1 : o.opacity,
    dash: o.dash || null,
    cornerRadius: o.corner_radius || 0,
    arrowStart: !!o.arrow_start,
    arrowEnd: !!o.arrow_end,
  });
}

/** A deep copy of a shape descriptor. */
export function cloneShape(d) {
  return d ? JSON.parse(JSON.stringify(d)) : d;
}
