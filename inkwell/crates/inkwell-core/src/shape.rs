//! Parametric vector shapes (Plan 095): lines, arrows, rectangles, ellipses,
//! polygons and polylines that stay editable as shapes and are written as the
//! matching native PDF annotations (`/Line`, `/Square`, `/Circle`,
//! `/Polygon`, `/PolyLine`).
//!
//! Geometry is a list of control points in page space (points, y down), the
//! same space as strokes. Every kind is closed under affine maps, so moving,
//! scaling or rotating a shape is mapping its points:
//!
//! | kind | points |
//! |---|---|
//! | Line, Arrow | `[start, end]` |
//! | Rect, Ellipse | `[c, c + u, c + v]`: centre and two half-axis ends; corners are `c ± u ± v`, the ellipse is `c + u cos t + v sin t` |
//! | Polygon, Polyline | the vertices |
//!
//! `outline` is the single definition of what a shape looks like. The canvas
//! renderer (`ink.js` `shapeOutline`) is a port of it, kept in step by the
//! cross-check fixture in `tests/shapes.rs`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShapeKind {
    Line,
    Arrow,
    Rect,
    Ellipse,
    Polygon,
    Polyline,
}

fn one() -> f64 {
    1.0
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShapeObject {
    pub id: String,
    pub sheet: usize,
    pub kind: ShapeKind,
    pub points: Vec<[f64; 2]>,
    pub stroke_rgb: [f64; 3],
    pub stroke_width: f64,
    #[serde(default)]
    pub fill_rgb: Option<[f64; 3]>,
    #[serde(default = "one")]
    pub opacity: f64,
    /// Dash pattern in points (on, off, ...); `None` = solid.
    #[serde(default)]
    pub dash: Option<Vec<f64>>,
    /// Rounded corners for `Rect` (ignored when its axes aren't
    /// perpendicular, i.e. after a skewing scale).
    #[serde(default)]
    pub corner_radius: f64,
    /// Arrowheads at the start and end (lines and arrows).
    #[serde(default)]
    pub arrow_start: bool,
    #[serde(default)]
    pub arrow_end: bool,
}

/// A path command in page space.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PathCmd {
    MoveTo([f64; 2]),
    LineTo([f64; 2]),
    CurveTo([f64; 2], [f64; 2], [f64; 2]),
    Close,
}

/// Cubic Bézier approximation of a quarter circle.
pub const KAPPA: f64 = 0.552_284_749_830_793_4;
/// Arrowhead wing angle and size, matching the freehand arrow tool.
pub const ARROW_WING_DEG: f64 = 28.0;

fn add(a: [f64; 2], b: [f64; 2]) -> [f64; 2] {
    [a[0] + b[0], a[1] + b[1]]
}
fn sub(a: [f64; 2], b: [f64; 2]) -> [f64; 2] {
    [a[0] - b[0], a[1] - b[1]]
}
fn mul(a: [f64; 2], k: f64) -> [f64; 2] {
    [a[0] * k, a[1] * k]
}
fn len(a: [f64; 2]) -> f64 {
    a[0].hypot(a[1])
}

impl ShapeObject {
    /// Centre and half-axes of a `Rect` or `Ellipse`.
    pub fn axes(&self) -> Option<([f64; 2], [f64; 2], [f64; 2])> {
        match (self.kind, self.points.as_slice()) {
            (ShapeKind::Rect | ShapeKind::Ellipse, [c, a, b, ..]) => Some((*c, sub(*a, *c), sub(*b, *c))),
            _ => None,
        }
    }

    /// `[x0, y0, x1, y1]` when this is a `Rect`/`Ellipse` whose axes are the
    /// page axes (what `/Square` and `/Circle` can describe).
    pub fn axis_aligned_box(&self) -> Option<[f64; 4]> {
        let (c, u, v) = self.axes()?;
        let eps = 1e-6 * (len(u) + len(v)).max(1.0);
        let (hx, hy) = if u[1].abs() <= eps && v[0].abs() <= eps {
            (u[0].abs(), v[1].abs())
        } else if u[0].abs() <= eps && v[1].abs() <= eps {
            (v[0].abs(), u[1].abs())
        } else {
            return None;
        };
        Some([c[0] - hx, c[1] - hy, c[0] + hx, c[1] + hy])
    }

    /// The four corners of a `Rect` (or the box of an `Ellipse`), in order.
    pub fn corners(&self) -> Option<[[f64; 2]; 4]> {
        let (c, u, v) = self.axes()?;
        Some([sub(sub(c, u), v), sub(add(c, u), v), add(add(c, u), v), add(sub(c, u), v)])
    }

    /// Whether `outline` is a closed region that `fill_rgb` fills.
    pub fn is_closed(&self) -> bool {
        matches!(self.kind, ShapeKind::Rect | ShapeKind::Ellipse | ShapeKind::Polygon)
    }

    fn arrow_len(&self) -> f64 {
        (self.stroke_width * 4.5).max(10.0)
    }

    /// The stroked path: everything except arrowheads.
    pub fn outline(&self) -> Vec<PathCmd> {
        let p = &self.points;
        let mut out = Vec::new();
        match self.kind {
            ShapeKind::Line | ShapeKind::Arrow => {
                if let [a, b, ..] = p.as_slice() {
                    // Shorten the shaft under each head so its cap can't poke
                    // through the tip.
                    let d = sub(*b, *a);
                    let l = len(d);
                    let back = self.arrow_len() * ARROW_WING_DEG.to_radians().cos();
                    let (mut a, mut b) = (*a, *b);
                    if l > 1e-9 {
                        let e = mul(d, 1.0 / l);
                        if self.arrow_start && l > back {
                            a = add(a, mul(e, back));
                        }
                        if self.arrow_end && l > back {
                            b = sub(b, mul(e, back));
                        }
                    }
                    out.push(PathCmd::MoveTo(a));
                    out.push(PathCmd::LineTo(b));
                }
            }
            ShapeKind::Rect => {
                let Some((c, u, v)) = self.axes() else { return out };
                let (lu, lv) = (len(u), len(v));
                let perpendicular = lu > 0.0 && lv > 0.0 && ((u[0] * v[0] + u[1] * v[1]) / (lu * lv)).abs() < 1e-6;
                let r = self.corner_radius.clamp(0.0, lu.min(lv));
                if r > 1e-9 && perpendicular {
                    let (eu, ev) = (mul(u, 1.0 / lu), mul(v, 1.0 / lv));
                    // corner k at c + su*u + sv*v; walk them in order
                    let corner = |su: f64, sv: f64| add(add(c, mul(u, su)), mul(v, sv));
                    let k = KAPPA * r;
                    let signs = [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)];
                    for (i, (su, sv)) in signs.iter().enumerate() {
                        let q = corner(*su, *sv);
                        // direction along the edge arriving at this corner, and leaving it
                        let (inn, outd) = match i {
                            0 => (mul(ev, -1.0), eu),
                            1 => (eu, ev),
                            2 => (ev, mul(eu, -1.0)),
                            _ => (mul(eu, -1.0), mul(ev, -1.0)),
                        };
                        let start = sub(q, mul(inn, r));
                        let end = add(q, mul(outd, r));
                        if i == 0 {
                            out.push(PathCmd::MoveTo(start));
                        } else {
                            out.push(PathCmd::LineTo(start));
                        }
                        out.push(PathCmd::CurveTo(add(start, mul(inn, k)), sub(end, mul(outd, k)), end));
                    }
                    out.push(PathCmd::Close);
                } else if let Some(cs) = self.corners() {
                    out.push(PathCmd::MoveTo(cs[0]));
                    for q in &cs[1..] {
                        out.push(PathCmd::LineTo(*q));
                    }
                    out.push(PathCmd::Close);
                }
            }
            ShapeKind::Ellipse => {
                let Some((c, u, v)) = self.axes() else { return out };
                // four quarter arcs; exact under any affine map of a circle
                let at = |cu: f64, sv: f64| add(add(c, mul(u, cu)), mul(v, sv));
                let q = [at(1.0, 0.0), at(0.0, 1.0), at(-1.0, 0.0), at(0.0, -1.0)];
                let tangent = [v, mul(u, -1.0), mul(v, -1.0), u];
                out.push(PathCmd::MoveTo(q[0]));
                for i in 0..4 {
                    let (a, b) = (q[i], q[(i + 1) % 4]);
                    out.push(PathCmd::CurveTo(
                        add(a, mul(tangent[i], KAPPA)),
                        sub(b, mul(tangent[(i + 1) % 4], KAPPA)),
                        b,
                    ));
                }
                out.push(PathCmd::Close);
            }
            ShapeKind::Polygon | ShapeKind::Polyline => {
                if let Some((first, rest)) = p.split_first() {
                    out.push(PathCmd::MoveTo(*first));
                    for q in rest {
                        out.push(PathCmd::LineTo(*q));
                    }
                    if self.kind == ShapeKind::Polygon {
                        out.push(PathCmd::Close);
                    }
                }
            }
        }
        out
    }

    /// Filled arrowhead triangles (tip first), in the stroke colour.
    pub fn arrow_heads(&self) -> Vec<[[f64; 2]; 3]> {
        let mut out = Vec::new();
        if !matches!(self.kind, ShapeKind::Line | ShapeKind::Arrow) {
            return out;
        }
        let [a, b] = match self.points.as_slice() {
            [a, b, ..] => [*a, *b],
            _ => return out,
        };
        let l = len(sub(b, a));
        if l < 1e-9 {
            return out;
        }
        let head = |tip: [f64; 2], from: [f64; 2]| -> [[f64; 2]; 3] {
            let ang = (tip[1] - from[1]).atan2(tip[0] - from[0]);
            let w = ARROW_WING_DEG.to_radians();
            let len = self.arrow_len();
            [
                tip,
                [tip[0] - len * (ang - w).cos(), tip[1] - len * (ang - w).sin()],
                [tip[0] - len * (ang + w).cos(), tip[1] - len * (ang + w).sin()],
            ]
        };
        if self.arrow_start {
            out.push(head(a, b));
        }
        if self.arrow_end {
            out.push(head(b, a));
        }
        out
    }

    /// Bounds of everything drawn, including half the stroke width.
    pub fn bbox(&self) -> [f64; 4] {
        let mut b = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
        let mut grow = |q: [f64; 2]| {
            b[0] = b[0].min(q[0]);
            b[1] = b[1].min(q[1]);
            b[2] = b[2].max(q[0]);
            b[3] = b[3].max(q[1]);
        };
        match self.kind {
            ShapeKind::Ellipse => {
                if let Some((c, u, v)) = self.axes() {
                    let hx = u[0].hypot(v[0]);
                    let hy = u[1].hypot(v[1]);
                    grow([c[0] - hx, c[1] - hy]);
                    grow([c[0] + hx, c[1] + hy]);
                }
            }
            ShapeKind::Rect => {
                if let Some(cs) = self.corners() {
                    cs.into_iter().for_each(&mut grow);
                }
            }
            _ => self.points.iter().copied().for_each(&mut grow),
        }
        for h in self.arrow_heads() {
            h.into_iter().for_each(&mut grow);
        }
        if b[0] > b[2] {
            return [0.0; 4];
        }
        let hw = self.stroke_width.max(0.0) / 2.0;
        [b[0] - hw, b[1] - hw, b[2] + hw, b[3] + hw]
    }

    /// Vertices for a `/Polygon` standing in for a rect or ellipse that isn't
    /// axis-aligned (64 per ellipse: indistinguishable from the curve).
    pub fn polygon_vertices(&self) -> Vec<[f64; 2]> {
        match self.kind {
            ShapeKind::Rect => self.corners().map(|c| c.to_vec()).unwrap_or_default(),
            ShapeKind::Ellipse => match self.axes() {
                Some((c, u, v)) => (0..64)
                    .map(|i| {
                        let t = i as f64 / 64.0 * std::f64::consts::TAU;
                        add(add(c, mul(u, t.cos())), mul(v, t.sin()))
                    })
                    .collect(),
                None => Vec::new(),
            },
            _ => self.points.clone(),
        }
    }
}

/// One shape of every kind and feature, shared by the golden snapshot, the
/// render diff and the canvas cross-check (`tests/golden/shape_paths.json`).
pub fn fixtures() -> Vec<ShapeObject> {
    let base = |id: &str, kind: ShapeKind, points: Vec<[f64; 2]>| ShapeObject {
        id: id.into(),
        sheet: 0,
        kind,
        points,
        stroke_rgb: [0.1, 0.2, 0.6],
        stroke_width: 3.0,
        fill_rgb: None,
        opacity: 1.0,
        dash: None,
        corner_radius: 0.0,
        arrow_start: false,
        arrow_end: false,
    };
    let (r30, c30) = (30f64.to_radians().sin(), 30f64.to_radians().cos());
    vec![
        ShapeObject { fill_rgb: Some([0.95, 0.85, 0.2]), ..base("rect", ShapeKind::Rect, vec![[150.0, 120.0], [230.0, 120.0], [150.0, 170.0]]) },
        ShapeObject { corner_radius: 12.0, ..base("rounded", ShapeKind::Rect, vec![[380.0, 120.0], [440.0, 120.0], [380.0, 160.0]]) },
        base("ellipse", ShapeKind::Ellipse, vec![[150.0, 260.0], [220.0, 260.0], [150.0, 300.0]]),
        // rotated 30°: no /Circle can say that, so it is a /Polygon
        ShapeObject {
            opacity: 0.5,
            fill_rgb: Some([0.2, 0.7, 0.4]),
            ..base("tilted", ShapeKind::Ellipse, vec![[400.0, 280.0], [400.0 + 60.0 * c30, 280.0 + 60.0 * r30], [400.0 - 30.0 * r30, 280.0 + 30.0 * c30]])
        },
        ShapeObject { arrow_end: true, ..base("arrow", ShapeKind::Arrow, vec![[90.0, 400.0], [300.0, 470.0]]) },
        ShapeObject { dash: Some(vec![6.0, 4.0]), arrow_start: true, arrow_end: true, ..base("line", ShapeKind::Line, vec![[330.0, 400.0], [500.0, 400.0]]) },
        ShapeObject { stroke_width: 2.0, fill_rgb: Some([0.9, 0.3, 0.3]), ..base("triangle", ShapeKind::Polygon, vec![[150.0, 520.0], [220.0, 640.0], [80.0, 640.0]]) },
        base("zigzag", ShapeKind::Polyline, vec![[300.0, 540.0], [340.0, 620.0], [380.0, 540.0], [420.0, 620.0]]),
    ]
}
