/* ============================================================================
 * ink.js — the ink engine.
 * Deliberately dependency-free and framework-free.
 * Ported verbatim from inkwell-m0 for complete latency & maths preservation.
 * ========================================================================== */

class LowPass {
  constructor() { this.y = null; this.s = null; }
  filter(x, a) {
    this.s = this.s === null ? x : a * x + (1 - a) * this.s;
    this.y = x;
    return this.s;
  }
  get hasLast() { return this.s !== null; }
}

class OneEuro {
  constructor(minCutoff = 1.1, beta = 0.006, dCutoff = 1.0) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = new LowPass(); this.dx = new LowPass(); this.tPrev = null;
  }
  _alpha(cutoff, dt) { const te = 1 / (2 * Math.PI * cutoff); return 1 / (1 + te / dt); }
  reset() { this.x = new LowPass(); this.dx = new LowPass(); this.tPrev = null; }
  filter(v, tMs) {
    const t = tMs / 1000;
    const dt = this.tPrev === null ? 1 / 233 : Math.max(1e-4, t - this.tPrev);
    this.tPrev = t;
    const dv = this.x.hasLast ? (v - this.x.s) / dt : 0;
    const edv = this.dx.filter(dv, this._alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edv);
    return this.x.filter(v, this._alpha(cutoff, dt));
  }
}

// Dynamic velocity-responsive streamline stabilizer:
// Damps low-speed digitizer tremor and staircase quantization while dynamically
// opening up for fast cursive handwriting and quick flicks with zero lag.
class Streamline {
  constructor(positionLerp = 0.72, pressureLerp = 0.35) {
    this.positionLerp = positionLerp;
    this.pressureLerp = pressureLerp;
    this.curX = null;
    this.curY = null;
    this.curP = null;
    this.lastVx = 0;
    this.lastVy = 0;
  }

  reset() {
    this.curX = null;
    this.curY = null;
    this.curP = null;
    this.lastVx = 0;
    this.lastVy = 0;
  }

  filter(x, y, p, zoom = 1.0) {
    if (this.curX === null) {
      this.curX = x;
      this.curY = y;
      this.curP = p;
      this.lastVx = 0;
      this.lastVy = 0;
      return { x: this.curX, y: this.curY, p: this.curP };
    }

    const dx = x - this.curX;
    const dy = y - this.curY;
    const dist = Math.hypot(dx, dy);
    const screenDist = dist * Math.max(0.25, zoom);

    const lastDist = Math.hypot(this.lastVx, this.lastVy);
    const turnBoost = (dist > 0.3 && lastDist > 0.3)
      ? Math.max(0, (0.5 - ((dx * this.lastVx + dy * this.lastVy) / (dist * lastDist))) * 0.35)
      : 0;
    const dynamicLerp = Math.min(1.0, Math.max(this.positionLerp, this.positionLerp + screenDist * 0.08 + turnBoost));
    this.curX += dx * dynamicLerp;
    this.curY += dy * dynamicLerp;
    this.curP += (p - this.curP) * this.pressureLerp;
    this.lastVx = dx;
    this.lastVy = dy;
    return { x: this.curX, y: this.curY, p: this.curP };
  }
}

function isClosedLoop(pts, baseWidth = 2.0) {
  if (!pts || pts.length < 8) return false;
  const n = pts.length;
  const dClose = Math.hypot(pts[0].x - pts[n - 1].x, pts[0].y - pts[n - 1].y);
  if (dClose >= 2.5) return false;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let pathLen = 0, area2 = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    if (i > 0) {
      pathLen += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
    }
    const nextP = pts[(i + 1) % n];
    area2 += p.x * nextP.y - nextP.x * p.y;
  }
  if (pathLen < 2 * Math.PI * Math.max(2.0, 1.5 * baseWidth)) return false;
  if ((maxX - minX) < 2.5 * baseWidth || (maxY - minY) < 2.5 * baseWidth) return false;
  const area = Math.abs(area2) * 0.5;
  if (area < Math.PI * Math.pow(baseWidth * 0.5, 2)) return false;
  return true;
}

function smoothStrokePoints(pts, passes = 1) {
  if (!pts || pts.length < 3) return pts ? pts.slice() : [];
  if (typeof isAxisAlignedRect === 'function' && isAxisAlignedRect(pts)) return pts.slice();
  let cur = pts.slice();
  const n = cur.length;
  const isClosed = isClosedLoop(cur, (cur[0].w || 2.0));

  for (let pass = 0; pass < passes; pass++) {
    const next = [];
    for (let i = 0; i < n; i++) {
      if (!isClosed && (i === 0 || i === n - 1)) {
        next.push(cur[i]);
        continue;
      }
      const p0 = isClosed ? cur[(i - 1 + n) % n] : cur[i - 1];
      const p1 = cur[i];
      const p2 = isClosed ? cur[(i + 1) % n] : cur[i + 1];

      // Corner preservation: if turn angle is sharp (>75 deg), preserve vertex p1 exactly!
      const v0x = p1.x - p0.x, v0y = p1.y - p0.y;
      const v1x = p2.x - p1.x, v1y = p2.y - p1.y;
      const l0 = Math.hypot(v0x, v0y), l1 = Math.hypot(v1x, v1y);
      let isCorner = false;
      if (l0 > 0.1 && l1 > 0.1) {
        const cosAngle = (v0x * v1x + v0y * v1y) / (l0 * l1);
        if (cosAngle < 0.25) {
          isCorner = true;
        }
      }

      if (isCorner) {
        next.push(p1);
      } else {
        const w0 = p0.w !== undefined ? p0.w : (p0.p !== undefined ? p0.p * 2.0 : 2.0);
        const w1 = p1.w !== undefined ? p1.w : (p1.p !== undefined ? p1.p * 2.0 : 2.0);
        const w2 = p2.w !== undefined ? p2.w : (p2.p !== undefined ? p2.p * 2.0 : 2.0);
        next.push({
          x: 0.25 * p0.x + 0.5 * p1.x + 0.25 * p2.x,
          y: 0.25 * p0.y + 0.5 * p1.y + 0.25 * p2.y,
          w: 0.25 * w0 + 0.5 * w1 + 0.25 * w2,
          p: p1.p,
          t: p1.t,
        });
      }
    }
    cur = next;
  }
  return cur;
}


function computeStrokeBbox(pts, baseWidth = 2.0) {
  if (!pts || !pts.length) return [0, 0, 0, 0];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const halfW = (baseWidth || 2.0) / 2;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const x = p.x !== undefined ? p.x : p[0];
    const y = p.y !== undefined ? p.y : p[1];
    const w = (p.w !== undefined ? p.w / 2 : halfW) || halfW;
    if (x - w < minX) minX = x - w;
    if (y - w < minY) minY = y - w;
    if (x + w > maxX) maxX = x + w;
    if (y + w > maxY) maxY = y + w;
  }
  return [minX, minY, maxX, maxY];
}

/* ============================================================================
 * Freehand Ink-to-Shape recognition (Hold-to-Snap)
 * Detects a deliberately-held freehand pen/highlighter stroke as a straight
 * line, rectangle, ellipse/circle or triangle, returning a clean vector point
 * list that can replace the raw samples before commit.
 * ========================================================================== */

function distToSegment(px, py, x1, y1, x2, y2) {
  const l2 = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
  if (l2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
}

/** Iterative Ramer–Douglas–Peucker polyline simplification. */
function rdpSimplify(pts, eps) {
  if (!pts || pts.length <= 2) return pts ? pts.slice() : [];
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    if (last <= first + 1) continue;
    const a = pts[first];
    const b = pts[last];
    let maxD = -1;
    let maxIdx = -1;
    for (let i = first + 1; i < last; i++) {
      const d = distToSegment(pts[i].x, pts[i].y, a.x, a.y, b.x, b.y);
      if (d > maxD) { maxD = d; maxIdx = i; }
    }
    if (maxD > eps && maxIdx > 0) {
      keep[maxIdx] = 1;
      stack.push([first, maxIdx], [maxIdx, last]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

function shapeLinePoints(a, b, baseW) {
  const points = [];
  const steps = 20;
  const w = baseW;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    points.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), p: 0.8, w });
  }
  return points;
}

/** Dense closed polygon; `verts` must repeat the first vertex at the end. */
function shapePolygonPoints(verts, baseW, samplesPerEdge = 16) {
  const points = [];
  const w = baseW * 0.68;
  for (let e = 0; e < verts.length - 1; e++) {
    const pA = verts[e];
    const pB = verts[e + 1];
    for (let i = (e === 0 ? 0 : 1); i <= samplesPerEdge; i++) {
      const t = i / samplesPerEdge;
      points.push({ x: pA[0] + t * (pB[0] - pA[0]), y: pA[1] + t * (pB[1] - pA[1]), p: 0.5, w });
    }
  }
  return points;
}

function shapeEllipsePoints(cx, cy, rx, ry, baseW, steps = 64) {
  const points = [];
  const w = baseW * 0.68;
  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * Math.PI * 2;
    points.push({ x: cx + rx * Math.cos(theta), y: cy + ry * Math.sin(theta), p: 0.5, w });
  }
  return points;
}

function dedupeConsecutive(corners, tol) {
  const out = [];
  for (const p of corners) {
    const prev = out[out.length - 1];
    if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) <= tol) continue;
    out.push(p);
  }
  return out;
}

function interiorAngles(corners) {
  const n = corners.length;
  const angles = [];
  for (let i = 0; i < n; i++) {
    const prev = corners[(i - 1 + n) % n];
    const cur = corners[i];
    const next = corners[(i + 1) % n];
    const v1x = prev.x - cur.x, v1y = prev.y - cur.y;
    const v2x = next.x - cur.x, v2y = next.y - cur.y;
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    if (l1 < 1e-6 || l2 < 1e-6) { angles.push(0); continue; }
    let cos = (v1x * v2x + v1y * v2y) / (l1 * l2);
    cos = Math.max(-1, Math.min(1, cos));
    angles.push((Math.acos(cos) * 180) / Math.PI);
  }
  return angles;
}

/**
 * Classify a freehand stroke as a geometric primitive.
 * @param {Array<{x:number,y:number}>} pts page-local stroke points
 * @param {number} baseW stroke base width
 * @returns {{kind:string, points:Array, corners?:Array}|null} null when the
 *          stroke is not confidently one of line/rect/ellipse/triangle
 */
function recognizeFreehandShape(pts, baseW = 2.5) {
  if (!Array.isArray(pts) || pts.length < 6) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let arcLen = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
    if (i > 0) arcLen += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
  }
  if (arcLen < 28) return null;

  const width = maxX - minX;
  const height = maxY - minY;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const endDist = Math.hypot(last.x - first.x, last.y - first.y);

  // ---- 1. Straight line -------------------------------------------------
  const lineTol = Math.max(8, 0.055 * arcLen);
  let maxDev = 0;
  for (let i = 0; i < pts.length; i++) {
    const d = distToSegment(pts[i].x, pts[i].y, first.x, first.y, last.x, last.y);
    if (d > maxDev) maxDev = d;
  }
  if (endDist > 0 && endDist / arcLen >= 0.90 && maxDev <= lineTol) {
    let angle = Math.atan2(last.y - first.y, last.x - first.x);
    const step = Math.PI / 4;
    const snapped = Math.round(angle / step) * step;
    let diff = Math.abs(angle - snapped);
    if (diff > Math.PI) diff = Math.PI * 2 - diff;
    if (diff <= (4 * Math.PI) / 180) angle = snapped;
    const end = { x: first.x + endDist * Math.cos(angle), y: first.y + endDist * Math.sin(angle) };
    return { kind: 'line', points: shapeLinePoints(first, end, baseW), corners: [{ x: first.x, y: first.y }, end] };
  }

  // ---- 2. Closed loop: triangle / rectangle / ellipse -------------------
  const closed = endDist <= Math.max(32, 0.24 * arcLen) && width >= 16 && height >= 16;
  if (closed) {
    const diag = Math.hypot(width, height);
    const tol = Math.max(4, 0.045 * diag);
    let corners = dedupeConsecutive(rdpSimplify(pts, tol), tol);
    if (corners.length > 1) {
      const tip = corners[corners.length - 1];
      if (Math.hypot(tip.x - corners[0].x, tip.y - corners[0].y) < 0.20 * diag) {
        corners = corners.slice(0, -1);
      }
    }

    if (corners.length === 3) {
      const verts = [
        [corners[0].x, corners[0].y],
        [corners[1].x, corners[1].y],
        [corners[2].x, corners[2].y],
        [corners[0].x, corners[0].y],
      ];
      return { kind: 'triangle', points: shapePolygonPoints(verts, baseW), corners };
    }

    if (corners.length === 4) {
      const angles = interiorAngles(corners);
      const rectLike = angles.every((a) => a >= 62 && a <= 118);
      if (rectLike) {
        const verts = [
          [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY],
        ];
        return { kind: 'rect', points: shapePolygonPoints(verts, baseW, 10), corners };
      }
    }

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    let rx = width / 2;
    let ry = height / 2;
    if (rx < 1e-6 || ry < 1e-6) return null;
    let deviation = 0;
    for (let i = 0; i < pts.length; i++) {
      const nx = (pts[i].x - cx) / rx;
      const ny = (pts[i].y - cy) / ry;
      deviation += Math.abs(Math.hypot(nx, ny) - 1);
    }
    const eps = deviation / pts.length;
    if (eps <= 0.17) {
      // Snap near-circular loops to a true circle.
      if (Math.abs(width - height) / Math.max(width, height) <= 0.14) {
        const r = (width + height) / 4;
        rx = r;
        ry = r;
      }
      return { kind: 'ellipse', points: shapeEllipsePoints(cx, cy, rx, ry, baseW) };
    }
  }

  return null;
}


class Stroke {
  constructor(opts = {}) {
    this.id = crypto.randomUUID ? crypto.randomUUID()
                                : String(Math.random()).slice(2);
    this.kind = opts.kind || 'pen';
    this.rgb = opts.rgb || [0.08, 0.09, 0.14];
    this.base_width = opts.baseWidth || 3.0;
    this.cssColor = `rgb(${this.rgb.map(v => Math.round(v * 255)).join(',')})`;
    this.samples = [];
    this._pts = [];            // {x, y, w} in CSS px, post-filter
    const minCut = opts.minCutoff !== undefined ? opts.minCutoff : 1.1;
    const bCut = opts.beta !== undefined ? opts.beta : 0.006;
    this._fx = new OneEuro(minCut, bCut);
    this._fy = new OneEuro(minCut, bCut);
    this._p = null;
    this._gamma = opts.gamma || 1.0;
    this._smoothing = opts.smoothing !== false;
    this._warmup = 0;          // Huion reports garbage pressure on entry
    this._cachedPath2D = null;
    this.bbox = [Infinity, Infinity, -Infinity, -Infinity];
  }

  widthFor(p) {
    const c = Math.pow(Math.max(0, Math.min(1, p)), this._gamma);
    return this.base_width * (0.22 + 0.78 * c);
  }

  push(x, y, pressure, tMs) {
    this._warmup++;
    let p = pressure;
    if (this._warmup <= 2) p = Math.min(p, 0.35);

    const fx = this._smoothing ? this._fx.filter(x, tMs) : x;
    const fy = this._smoothing ? this._fy.filter(y, tMs) : y;
    this._p = this._p === null ? p : this._p + 0.35 * (p - this._p);   // EMA on pressure

    const last = this._pts[this._pts.length - 1];
    if (last && Math.hypot(fx - last.x, fy - last.y) < 0.05) return null; // dedup

    const w = this.widthFor(this._p);
    const pt = { x: fx, y: fy, w, p: this._p, t: tMs };
    this._pts.push(pt);
    this.samples.push([fx, fy, this._p, tMs]);

    const r = w / 2;
    if (fx - r < this.bbox[0]) this.bbox[0] = fx - r;
    if (fy - r < this.bbox[1]) this.bbox[1] = fy - r;
    if (fx + r > this.bbox[2]) this.bbox[2] = fx + r;
    if (fy + r > this.bbox[3]) this.bbox[3] = fy + r;

    return pt;
  }

  getPath2D() {
    if (!this._cachedPath2D) {
      this._cachedPath2D = getPath2D(this);
    }
    return this._cachedPath2D;
  }

  get points() { return this._pts; }
  set points(val) { this._pts = val; }
  get last() { return this._pts[this._pts.length - 1]; }
}

function addDotToPath(path, p) {
  const w = (p && p.w !== undefined && !isNaN(p.w)) ? p.w : ((p && p.p !== undefined) ? p.p * 2.0 : 2.0);
  const r = Math.max(0.1, w / 2);
  path.moveTo(p.x + r, p.y);
  path.arc(p.x, p.y, r, 0, Math.PI * 2);
}

function addSegmentToPath(path, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1e-6;
  const nx = -dy / L, ny = dx / L;
  const wa = (a && a.w !== undefined && !isNaN(a.w)) ? a.w : ((a && a.p !== undefined) ? a.p * 2.0 : 2.0);
  const wb = (b && b.w !== undefined && !isNaN(b.w)) ? b.w : ((b && b.p !== undefined) ? b.p * 2.0 : 2.0);
  const ha = Math.max(0.05, wa / 2), hb = Math.max(0.05, wb / 2);
  path.moveTo(a.x + nx * ha, a.y + ny * ha);
  path.lineTo(b.x + nx * hb, b.y + ny * hb);
  path.lineTo(b.x - nx * hb, b.y - ny * hb);
  path.lineTo(a.x - nx * ha, a.y - ny * ha);
  path.closePath();
  path.moveTo(b.x + hb, b.y);
  path.arc(b.x, b.y, hb, 0, Math.PI * 2);
}

function getChiselPath2D(rawPts, baseH = 16.0) {
  if (typeof Path2D === 'undefined' || !rawPts || !rawPts.length) return null;
  const path = new Path2D();
  const halfH = (baseH || 16.0) / 2;
  // 45-degree chisel normal vector
  const nx = 0.70710678 * halfH;
  const ny = 0.70710678 * halfH;

  if (rawPts.length === 1) {
    const p = rawPts[0];
    path.moveTo(p.x - nx, p.y - ny);
    path.lineTo(p.x + nx, p.y + ny);
    path.lineTo(p.x + nx + 2, p.y + ny);
    path.lineTo(p.x - nx + 2, p.y - ny);
    path.closePath();
    return path;
  }

  const pts = chaikinSubdivide(rawPts, 1);
  if (pts.length < 2) return null;

  // Upper chisel contour
  path.moveTo(pts[0].x - nx, pts[0].y - ny);
  for (let i = 1; i < pts.length; i++) {
    const mx = (pts[i - 1].x + pts[i].x) / 2 - nx;
    const my = (pts[i - 1].y + pts[i].y) / 2 - ny;
    path.quadraticCurveTo(pts[i - 1].x - nx, pts[i - 1].y - ny, mx, my);
  }
  const last = pts[pts.length - 1];
  path.lineTo(last.x - nx, last.y - ny);

  // Chisel end cap
  path.lineTo(last.x + nx, last.y + ny);

  // Lower chisel contour
  for (let i = pts.length - 1; i > 0; i--) {
    const mx = (pts[i].x + pts[i - 1].x) / 2 + nx;
    const my = (pts[i].y + pts[i - 1].y) / 2 + ny;
    path.quadraticCurveTo(pts[i].x + nx, pts[i].y + ny, mx, my);
  }
  path.lineTo(pts[0].x + nx, pts[0].y + ny);

  // Chisel start cap
  path.closePath();
  return path;
}

function isAxisAlignedRect(pts) {
  if (!pts || pts.length < 4) return null;
  const n = pts.length;
  const isClosed = Math.hypot(pts[0].x - pts[n - 1].x, pts[0].y - pts[n - 1].y) < 2.0;
  if (!isClosed) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if ((maxX - minX) < 4 || (maxY - minY) < 4) return null;
  const eps = 2.0;
  let hasLeft = false, hasRight = false, hasTop = false, hasBottom = false;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const onLeft = Math.abs(p.x - minX) < eps;
    const onRight = Math.abs(p.x - maxX) < eps;
    const onTop = Math.abs(p.y - minY) < eps;
    const onBottom = Math.abs(p.y - maxY) < eps;
    if (!onLeft && !onRight && !onTop && !onBottom) return null;
    if (onLeft) hasLeft = true;
    if (onRight) hasRight = true;
    if (onTop) hasTop = true;
    if (onBottom) hasBottom = true;
  }
  if (hasLeft && hasRight && hasTop && hasBottom) {
    return [minX, minY, maxX, maxY];
  }
  return null;
}

function traceRibbonContour(target, rawPts, baseWidth = 2.0, isHighlighter = false) {
  if (!rawPts || !rawPts.length) return;

  if (rawPts.length === 1) {
    const p = rawPts[0];
    const w = (p && p.w !== undefined && !isNaN(p.w)) ? p.w : ((p && p.p !== undefined) ? (isHighlighter ? baseWidth : p.p * 2.0) : baseWidth);
    const r = Math.max(0.1, w / 2);
    target.moveTo(p.x + r, p.y);
    target.arc(p.x, p.y, r, 0, Math.PI * 2);
    return;
  }

  if (rawPts.length === 2) {
    const a = rawPts[0], b = rawPts[1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1e-6;
    const nx = -dy / l, ny = dx / l;
    const wa = (a && a.w !== undefined && !isNaN(a.w)) ? a.w : ((a && a.p !== undefined) ? (isHighlighter ? baseWidth : a.p * 2.0) : baseWidth);
    const wb = (b && b.w !== undefined && !isNaN(b.w)) ? b.w : ((b && b.p !== undefined) ? (isHighlighter ? baseWidth : b.p * 2.0) : baseWidth);
    const ha = Math.max(0.05, wa / 2), hb = Math.max(0.05, wb / 2);
    target.moveTo(a.x + nx * ha, a.y + ny * ha);
    target.lineTo(b.x + nx * hb, b.y + ny * hb);
    if (isHighlighter || wa >= 6) {
      target.lineTo(b.x - nx * hb, b.y - ny * hb);
      target.lineTo(a.x - nx * ha, a.y - ny * ha);
    } else {
      target.arc(b.x, b.y, hb, Math.atan2(ny, nx), Math.atan2(-ny, -nx), true);
      target.lineTo(a.x - nx * ha, a.y - ny * ha);
      target.arc(a.x, a.y, ha, Math.atan2(-ny, -nx), Math.atan2(ny, nx), true);
    }
    target.closePath();
    return;
  }

  const rect = isAxisAlignedRect(rawPts);
  if (rect) {
    const [x0, y0, x1, y1] = rect;
    const w = (rawPts[0] && rawPts[0].w !== undefined && !isNaN(rawPts[0].w))
      ? rawPts[0].w
      : ((rawPts[0] && rawPts[0].p !== undefined) ? rawPts[0].p * 2.0 : baseWidth);
    const hw = Math.max(0.05, w / 2);
    // Outer rect (clockwise)
    target.moveTo(x0 - hw, y0 - hw);
    target.lineTo(x1 + hw, y0 - hw);
    target.lineTo(x1 + hw, y1 + hw);
    target.lineTo(x0 - hw, y1 + hw);
    target.closePath();
    // Inner rect (counter-clockwise)
    target.moveTo(x0 + hw, y0 + hw);
    target.lineTo(x0 + hw, y1 - hw);
    target.lineTo(x1 - hw, y1 - hw);
    target.lineTo(x1 - hw, y0 + hw);
    target.closePath();
    return;
  }

  const n = rawPts.length;
  const isClosed = isClosedLoop(rawPts, baseWidth);

  // Segment unit normals
  const segNormals = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = rawPts[i + 1].x - rawPts[i].x;
    const dy = rawPts[i + 1].y - rawPts[i].y;
    const l = Math.hypot(dx, dy);
    if (l < 1e-6) {
      segNormals.push(segNormals.length ? segNormals[segNormals.length - 1] : { nx: 0, ny: 1 });
    } else {
      segNormals.push({ nx: -dy / l, ny: dx / l });
    }
  }
  if (isClosed) {
    const dx = rawPts[0].x - rawPts[n - 1].x;
    const dy = rawPts[0].y - rawPts[n - 1].y;
    const l = Math.hypot(dx, dy);
    if (l < 1e-6) {
      segNormals.push(segNormals.length ? segNormals[segNormals.length - 1] : { nx: 0, ny: 1 });
    } else {
      segNormals.push({ nx: -dy / l, ny: dx / l });
    }
  }

  const left = [];
  const right = [];
  for (let i = 0; i < n; i++) {
    let norm;
    if (isClosed) {
      const n0 = segNormals[(i + n - 1) % n];
      const n1 = segNormals[i];
      const dot = n0.nx * n1.nx + n0.ny * n1.ny;
      const nx = n0.nx + n1.nx;
      const ny = n0.ny + n1.ny;
      const l = Math.hypot(nx, ny);
      if (l < 1e-4 || dot < -0.35) {
        norm = n0;
      } else {
        const miter = Math.min(1.6, 1.0 / Math.max(0.5, l * 0.5));
        norm = { nx: (nx / l) * miter, ny: (ny / l) * miter };
      }
    } else if (i === 0) {
      norm = segNormals[0];
    } else if (i === n - 1) {
      norm = segNormals[n - 2];
    } else {
      const n0 = segNormals[i - 1];
      const n1 = segNormals[i];
      const dot = n0.nx * n1.nx + n0.ny * n1.ny;
      const nx = n0.nx + n1.nx;
      const ny = n0.ny + n1.ny;
      const l = Math.hypot(nx, ny);
      if (l < 1e-4 || dot < -0.35) {
        norm = n0;
      } else {
        const miter = Math.min(1.6, 1.0 / Math.max(0.5, l * 0.5));
        norm = { nx: (nx / l) * miter, ny: (ny / l) * miter };
      }
    }

    const w = (rawPts[i].w !== undefined && !isNaN(rawPts[i].w))
      ? rawPts[i].w
      : (isHighlighter ? baseWidth : ((rawPts[i].p !== undefined) ? rawPts[i].p * 2.0 : baseWidth));
    const h = Math.max(0.05, w / 2);
    left.push({ x: rawPts[i].x + norm.nx * h, y: rawPts[i].y + norm.ny * h, w: h });
    right.push({ x: rawPts[i].x - norm.nx * h, y: rawPts[i].y - norm.ny * h, w: h });
  }

  const leftCubics = openPolylineToCubics(left);
  const rightRev = right.slice().reverse();
  const rightCubics = openPolylineToCubics(rightRev);

  if (isClosed) {
    target.moveTo(left[0].x, left[0].y);
    for (let i = 0; i < leftCubics.length; i++) {
      const c = leftCubics[i];
      target.bezierCurveTo(c[0].x, c[0].y, c[1].x, c[1].y, c[2].x, c[2].y);
    }
    target.closePath();

    target.moveTo(rightRev[0].x, rightRev[0].y);
    for (let i = 0; i < rightCubics.length; i++) {
      const c = rightCubics[i];
      target.bezierCurveTo(c[0].x, c[0].y, c[1].x, c[1].y, c[2].x, c[2].y);
    }
    target.closePath();
    return;
  }

  target.moveTo(left[0].x, left[0].y);
  for (let i = 0; i < leftCubics.length; i++) {
    const c = leftCubics[i];
    target.bezierCurveTo(c[0].x, c[0].y, c[1].x, c[1].y, c[2].x, c[2].y);
  }

  // End cap: round cap bulging OUTWARDS from left to right edge
  const lastPt = rawPts[n - 1];
  const lastW = (lastPt.w !== undefined && !isNaN(lastPt.w)) ? lastPt.w : (isHighlighter ? baseWidth : baseWidth);
  const endR = Math.max(0.05, lastW / 2);
  const aLeftEnd = Math.atan2(left[n - 1].y - lastPt.y, left[n - 1].x - lastPt.x);
  const aRightEnd = Math.atan2(right[n - 1].y - lastPt.y, right[n - 1].x - lastPt.x);
  target.arc(lastPt.x, lastPt.y, endR, aLeftEnd, aRightEnd, true);

  // Right edge in reverse
  for (let i = 0; i < rightCubics.length; i++) {
    const c = rightCubics[i];
    target.bezierCurveTo(c[0].x, c[0].y, c[1].x, c[1].y, c[2].x, c[2].y);
  }

  // Start cap: round cap bulging OUTWARDS from right to left edge
  const firstPt = rawPts[0];
  const firstW = (firstPt.w !== undefined && !isNaN(firstPt.w)) ? firstPt.w : (isHighlighter ? baseWidth : baseWidth);
  const startR = Math.max(0.05, firstW / 2);
  const aRightStart = Math.atan2(right[0].y - firstPt.y, right[0].x - firstPt.x);
  const aLeftStart = Math.atan2(left[0].y - firstPt.y, left[0].x - firstPt.x);
  target.arc(firstPt.x, firstPt.y, startR, aRightStart, aLeftStart, true);

  target.closePath();
}

function getPath2D(stroke) {
  if (typeof Path2D === 'undefined') return null;
  const rawPts = stroke.points || stroke._pts;
  if (!rawPts || !rawPts.length) return null;

  if (stroke.kind === 'chisel' || stroke.tool === 'chisel') {
    return getChiselPath2D(rawPts, stroke.base_width || stroke.baseWidth || 16.0);
  }

  const path = new Path2D();
  const isHighlighter = stroke.kind === 'highlighter';
  const baseW = stroke.base_width || stroke.baseWidth || (isHighlighter ? 16.0 : 2.0);
  traceRibbonContour(path, rawPts, baseW, isHighlighter);
  return path;
}

function drawSegment(ctx, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1e-6;
  const nx = -dy / L, ny = dx / L;
  const wa = (a && a.w !== undefined && !isNaN(a.w)) ? a.w : ((a && a.p !== undefined) ? a.p * 2.0 : 2.0);
  const wb = (b && b.w !== undefined && !isNaN(b.w)) ? b.w : ((b && b.p !== undefined) ? b.p * 2.0 : 2.0);
  const ha = Math.max(0.05, wa / 2), hb = Math.max(0.05, wb / 2);
  ctx.beginPath();
  ctx.moveTo(a.x + nx * ha, a.y + ny * ha);
  ctx.lineTo(b.x + nx * hb, b.y + ny * hb);
  ctx.lineTo(b.x - nx * hb, b.y - ny * hb);
  ctx.lineTo(a.x - nx * ha, a.y - ny * ha);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();                      // round join / cap
  ctx.arc(b.x, b.y, hb, 0, Math.PI * 2);
  ctx.fill();
}

function drawDot(ctx, p) {
  const w = (p && p.w !== undefined && !isNaN(p.w)) ? p.w : ((p && p.p !== undefined) ? p.p * 2.0 : 2.0);
  const r = Math.max(0.1, w / 2);
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fill();
}

function openPolylineToCubics(p) {
  const n = p.length;
  if (n < 2) return [];
  if (n === 2) {
    const a = p[0], b = p[1];
    const wa = (a && a.w !== undefined) ? a.w : 2.0;
    const wb = (b && b.w !== undefined) ? b.w : 2.0;
    const dx = b.x - a.x, dy = b.y - a.y, dw = wb - wa;
    return [[
      { x: a.x + dx / 3, y: a.y + dy / 3, w: wa + dw / 3 },
      { x: a.x + 2 * dx / 3, y: a.y + 2 * dy / 3, w: wa + 2 * dw / 3 },
      b
    ]];
  }

  const t = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const dist = Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
    t[i] = t[i - 1] + Math.max(1e-4, Math.sqrt(dist));
  }

  const m = new Array(n);
  for (let i = 1; i < n - 1; i++) {
    const dt = t[i + 1] - t[i - 1];
    const prevW = p[i - 1].w !== undefined ? p[i - 1].w : 2.0;
    const nextW = p[i + 1].w !== undefined ? p[i + 1].w : 2.0;
    m[i] = {
      x: (p[i + 1].x - p[i - 1].x) / dt,
      y: (p[i + 1].y - p[i - 1].y) / dt,
      w: (nextW - prevW) / dt,
    };
  }

  const dt0 = t[1] - t[0], dt1 = (n > 2) ? (t[2] - t[1]) : dt0;
  const p0w = p[0].w !== undefined ? p[0].w : 2.0;
  const p1w = p[1].w !== undefined ? p[1].w : 2.0;
  const p2w = (p[2] && p[2].w !== undefined) ? p[2].w : p1w;
  m[0] = {
    x: ((2 * dt0 + dt1) * (p[1].x - p[0].x) / dt0 - dt0 * ((p[2] ? p[2].x : p[1].x) - p[1].x) / Math.max(1e-4, dt1)) / Math.max(1e-4, dt0 + dt1),
    y: ((2 * dt0 + dt1) * (p[1].y - p[0].y) / dt0 - dt0 * ((p[2] ? p[2].y : p[1].y) - p[1].y) / Math.max(1e-4, dt1)) / Math.max(1e-4, dt0 + dt1),
    w: ((2 * dt0 + dt1) * (p1w - p0w) / dt0 - dt0 * (p2w - p1w) / Math.max(1e-4, dt1)) / Math.max(1e-4, dt0 + dt1),
  };

  const dtn2 = t[n - 1] - t[n - 2];
  const dtn3 = (n > 2) ? (t[n - 2] - t[n - 3]) : dtn2;
  const pPrev2 = p[n - 3] || p[n - 2];
  const pn1w = p[n - 1].w !== undefined ? p[n - 1].w : 2.0;
  const pn2w = p[n - 2].w !== undefined ? p[n - 2].w : 2.0;
  const prev2w = (pPrev2 && pPrev2.w !== undefined) ? pPrev2.w : pn2w;
  m[n - 1] = {
    x: ((2 * dtn2 + dtn3) * (p[n - 1].x - p[n - 2].x) / dtn2 - dtn2 * (p[n - 2].x - pPrev2.x) / Math.max(1e-4, dtn3)) / Math.max(1e-4, dtn2 + dtn3),
    y: ((2 * dtn2 + dtn3) * (p[n - 1].y - p[n - 2].y) / dtn2 - dtn2 * (p[n - 2].y - pPrev2.y) / Math.max(1e-4, dtn3)) / Math.max(1e-4, dtn2 + dtn3),
    w: ((2 * dtn2 + dtn3) * (pn1w - pn2w) / dtn2 - dtn2 * (pn2w - prev2w) / Math.max(1e-4, dtn3)) / Math.max(1e-4, dtn2 + dtn3),
  };

  const cubics = [];
  for (let i = 0; i < n - 1; i++) {
    const dt = t[i + 1] - t[i];
    const pw = p[i].w !== undefined ? p[i].w : 2.0;
    const c1 = {
      x: p[i].x + (m[i].x * dt) / 3,
      y: p[i].y + (m[i].y * dt) / 3,
      w: pw + (m[i].w * dt) / 3,
    };
    const c2 = {
      x: p[i + 1].x - (m[i + 1].x * dt) / 3,
      y: p[i + 1].y - (m[i + 1].y * dt) / 3,
      w: (p[i + 1].w !== undefined ? p[i + 1].w : 2.0) - (m[i + 1].w * dt) / 3,
    };
    cubics.push([c1, c2, p[i + 1]]);
  }
  return cubics;
}



function cubicAt(p0, cubic, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  const w0 = p0.w !== undefined ? p0.w : 2.0;
  const w1 = (cubic[0] && cubic[0].w !== undefined) ? cubic[0].w : 2.0;
  const w2 = (cubic[1] && cubic[1].w !== undefined) ? cubic[1].w : 2.0;
  const w3 = (cubic[2] && cubic[2].w !== undefined) ? cubic[2].w : 2.0;
  return {
    x: a * p0.x + b * cubic[0].x + c * cubic[1].x + d * cubic[2].x,
    y: a * p0.y + b * cubic[0].y + c * cubic[1].y + d * cubic[2].y,
    w: a * w0 + b * w1 + c * w2 + d * w3,
  };
}

function chaikinSubdivide(points, iterations = 2) {
  let out = points.slice();
  for (let pass = 0; pass < iterations && out.length > 2; pass++) {
    const next = [out[0]];
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i], b = out[i + 1];
      const wa = (a && a.w !== undefined && !isNaN(a.w)) ? a.w : ((a && a.p !== undefined) ? a.p * 2.0 : 2.0);
      const wb = (b && b.w !== undefined && !isNaN(b.w)) ? b.w : ((b && b.p !== undefined) ? b.p * 2.0 : 2.0);
      next.push({
        x: 0.75 * a.x + 0.25 * b.x,
        y: 0.75 * a.y + 0.25 * b.y,
        w: 0.75 * wa + 0.25 * wb,
      });
      next.push({
        x: 0.25 * a.x + 0.75 * b.x,
        y: 0.25 * a.y + 0.75 * b.y,
        w: 0.25 * wa + 0.75 * wb,
      });
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

function quadraticAt(p0, control, p1, t) {
  const u = 1 - t;
  const w0 = (p0 && p0.w !== undefined && !isNaN(p0.w)) ? p0.w : 2.0;
  const wc = (control && control.w !== undefined && !isNaN(control.w)) ? control.w : 2.0;
  const w1 = (p1 && p1.w !== undefined && !isNaN(p1.w)) ? p1.w : 2.0;
  return {
    x: u * u * p0.x + 2 * u * t * control.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * control.y + t * t * p1.y,
    w: u * u * w0 + 2 * u * t * wc + t * t * w1,
  };
}

/**
 * Build a plain, renderable stroke record from raw points (used by the partial
 * eraser when splitting one stroke into surviving fragments).
 * @param {Array<{x:number,y:number}>} points page-local points
 * @param {number[]} rgb 0..1 colour triple
 * @param {number} baseWidth stroke base width in points
 * @param {number} sheet page index
 * @param {string} kind 'pen' | 'highlighter'
 */
function buildStrokeRecord(points, rgb, baseWidth, sheet = 0, kind = 'pen') {
  const safePoints = (points || []).map(p => ({
    x: p.x,
    y: p.y,
    w: p.w !== undefined ? p.w : baseWidth,
    p: p.p,
  }));
  const color = Array.isArray(rgb) && rgb.length >= 3 ? rgb.slice(0, 3) : [0.08, 0.09, 0.14];
  const stroke = {
    id: 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9),
    kind: kind || 'pen',
    rgb: color,
    base_width: baseWidth || 1.6,
    sheet: sheet || 0,
    points: safePoints,
    deleted: false,
    _cachedPath2D: null,
  };
  stroke.cssColor = `rgb(${color.map(v => Math.round(v * 255)).join(',')})`;
  stroke.bbox = computeStrokeBbox(safePoints, stroke.base_width);
  if (typeof Path2D !== 'undefined') {
    try { stroke._cachedPath2D = getPath2D(stroke); } catch (_) { stroke._cachedPath2D = null; }
  }
  return stroke;
}

function drawStroke(ctx, stroke) {
  const rawPts = stroke.points || stroke._pts;
  if (!rawPts || !rawPts.length) return;

  const isHighlighter = stroke.kind === 'highlighter';
  if (isHighlighter) {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = 0.42;
  }

  ctx.fillStyle = stroke.cssColor || (Array.isArray(stroke.rgb) ? `rgb(${stroke.rgb.map(v => Math.round(v * 255)).join(',')})` : (stroke.color || '#141724'));

  if ((!stroke._cachedPath2D || !(stroke._cachedPath2D instanceof Path2D)) && typeof Path2D !== 'undefined') {
    stroke._cachedPath2D = getPath2D(stroke);
  }

  if (stroke._cachedPath2D instanceof Path2D) {
    ctx.fill(stroke._cachedPath2D);
    if (isHighlighter) ctx.restore();
    return;
  }

  const baseW = stroke.base_width || stroke.baseWidth || (isHighlighter ? 16.0 : 2.0);
  ctx.beginPath();
  traceRibbonContour(ctx, rawPts, baseW, isHighlighter);
  ctx.fill();

  if (isHighlighter) ctx.restore();
}

window.Ink = { OneEuro, Streamline, Stroke, drawSegment, drawDot, drawStroke, openPolylineToCubics, cubicAt, chaikinSubdivide, quadraticAt, getPath2D, getChiselPath2D, computeStrokeBbox, traceRibbonContour, isAxisAlignedRect, smoothStrokePoints, recognizeFreehandShape, shapeLinePoints, buildStrokeRecord };

