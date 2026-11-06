//! Text notes as shaped vector glyph outlines (Plan 089).
//!
//! A FreeText appearance written with a standard Type1 font can only show
//! WinAnsi characters, so Bangla, accents and anything non-Latin came out as
//! mojibake in other readers. Instead the appearance is drawn the same way
//! ink is: filled vector paths. Text is split into runs by font coverage,
//! shaped with rustybuzz (conjuncts, reordering and vowel signs for Bengali,
//! kerning for Latin), and every glyph outline becomes `m/l/c/h` operators.
//! No font is embedded, so the result looks identical in every reader;
//! searchability and copy come from the annotation's `/Contents`.
//!
//! The faces are the ones the app canvas uses (`inkwell-app/src/fonts`), and
//! the layout mirrors the canvas: explicit newlines only, `size * 1.35`
//! line height, and the first line's baseline where Chromium puts it for
//! `textBaseline = 'top'`: `ascent / (ascent + descent)` of the primary
//! face (Inter), measured at 0.8006 em. Inter is variable; like Chrome's
//! `font-optical-sizing: auto`, `opsz` follows the font size, otherwise
//! Latin lines drift wider than on the canvas.

use std::fmt::Write;
use std::sync::OnceLock;

use rustybuzz::ttf_parser::{GlyphId, OutlineBuilder};
use rustybuzz::{Face, UnicodeBuffer};

pub const LINE_HEIGHT: f64 = 1.35;

/// Slant for faces without a real italic (Bengali), matching what browsers
/// synthesise: about 14 degrees.
const SYNTHETIC_OBLIQUE: f64 = 0.25;

const INTER: &[u8] = include_bytes!("../fonts/InterVariable.ttf");
const INTER_ITALIC: &[u8] = include_bytes!("../fonts/InterVariable-Italic.ttf");

struct Faces {
    /// Default instances, for coverage and metrics only.
    inter: Face<'static>,
    bengali: [Face<'static>; 2], // regular, bold
}

fn faces() -> &'static Faces {
    static FACES: OnceLock<Faces> = OnceLock::new();
    FACES.get_or_init(|| {
        let f = |b: &'static [u8]| Face::from_slice(b, 0).expect("bundled font parses");
        Faces {
            inter: f(INTER),
            bengali: [
                f(include_bytes!("../fonts/NotoSansBengali-Regular.ttf")),
                f(include_bytes!("../fonts/NotoSansBengali-Bold.ttf")),
            ],
        }
    })
}

/// Inter instanced the way Chrome draws it: wght 400/700, opsz = size
/// clamped to the axis range (14..32).
fn inter_instance(size: f64, bold: bool, italic: bool) -> Face<'static> {
    let mut f = Face::from_slice(if italic { INTER_ITALIC } else { INTER }, 0).expect("bundled font parses");
    f.set_variation(rustybuzz::ttf_parser::Tag::from_bytes(b"wght"), if bold { 700.0 } else { 400.0 });
    f.set_variation(rustybuzz::ttf_parser::Tag::from_bytes(b"opsz"), size.clamp(14.0, 32.0) as f32);
    f
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Family {
    Inter,
    Bengali,
}

/// Distance from the top of a line box to its baseline, in ems.
pub fn baseline_ratio() -> f64 {
    let f = &faces().inter;
    let (a, d) = (f.ascender() as f64, -(f.descender() as f64));
    a / (a + d)
}

/// Which family draws `c`, or `None` for joiners that belong to whatever
/// they join (ZWNJ/ZWJ, the dotted circle).
///
/// Like Chrome's per-character font fallback, the primary face (Inter) wins
/// whenever it has the glyph: a space or colon between Bengali words is set
/// in Inter, exactly as on the canvas, or line widths drift apart.
fn family_of(c: char) -> Option<Family> {
    if matches!(c, '\u{200C}' | '\u{200D}' | '\u{25CC}') {
        return None;
    }
    let f = faces();
    if f.inter.glyph_index(c).is_some() {
        Some(Family::Inter)
    } else if f.bengali[0].glyph_index(c).is_some() {
        Some(Family::Bengali)
    } else {
        // Uncovered characters fall back to Inter's .notdef box: visible,
        // unlike silently dropping them.
        Some(Family::Inter)
    }
}

/// Split one line into maximal runs of a single family.
fn runs(line: &str) -> Vec<(Family, &str)> {
    let fams: Vec<(usize, Option<Family>)> = line.char_indices().map(|(i, c)| (i, family_of(c))).collect();
    // Joiners take the previous family, or the next one at the start.
    let first = fams.iter().find_map(|(_, f)| *f).unwrap_or(Family::Inter);
    let mut cur = first;
    let mut out: Vec<(Family, usize)> = Vec::new();
    for &(i, f) in &fams {
        let fam = f.unwrap_or(cur);
        cur = fam;
        if out.last().is_none_or(|(lf, _)| *lf != fam) {
            out.push((fam, i));
        }
    }
    out.iter()
        .enumerate()
        .map(|(k, &(fam, start))| {
            let end = out.get(k + 1).map_or(line.len(), |&(_, e)| e);
            (fam, &line[start..end])
        })
        .collect()
}

/// Appends glyph outlines as PDF path operators under an affine map from
/// font units to annotation space: x' = ox + s*(x + k*y), y' = oy + s*y.
struct Pdf<'a> {
    out: &'a mut String,
    ox: f64,
    oy: f64,
    s: f64,
    shear: f64,
    /// Current point in annotation space, for quadratic -> cubic conversion.
    last: (f64, f64),
}

impl Pdf<'_> {
    fn pt(&self, x: f32, y: f32) -> (f64, f64) {
        let (x, y) = (x as f64, y as f64);
        (self.ox + self.s * (x + self.shear * y), self.oy + self.s * y)
    }
}

fn num(v: f64) -> String {
    let r = (v * 100.0).round() / 100.0;
    if r == r.trunc() {
        format!("{}", r as i64)
    } else {
        format!("{r:.2}").trim_end_matches('0').to_string()
    }
}

impl OutlineBuilder for Pdf<'_> {
    fn move_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.pt(x, y);
        self.last = (x, y);
        let _ = writeln!(self.out, "{} {} m", num(x), num(y));
    }
    fn line_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.pt(x, y);
        self.last = (x, y);
        let _ = writeln!(self.out, "{} {} l", num(x), num(y));
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        // TrueType quadratics as exact cubics (degree elevation).
        let (cx, cy) = self.pt(x1, y1);
        let (ex, ey) = self.pt(x, y);
        let (sx, sy) = self.last;
        self.last = (ex, ey);
        let c1 = (sx + 2.0 / 3.0 * (cx - sx), sy + 2.0 / 3.0 * (cy - sy));
        let c2 = (ex + 2.0 / 3.0 * (cx - ex), ey + 2.0 / 3.0 * (cy - ey));
        let _ = writeln!(
            self.out,
            "{} {} {} {} {} {} c",
            num(c1.0),
            num(c1.1),
            num(c2.0),
            num(c2.1),
            num(ex),
            num(ey)
        );
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let (a, b, c) = (self.pt(x1, y1), self.pt(x2, y2), self.pt(x, y));
        self.last = c;
        let _ = writeln!(self.out, "{} {} {} {} {} {} c", num(a.0), num(a.1), num(b.0), num(b.1), num(c.0), num(c.1));
    }
    fn close(&mut self) {
        self.out.push_str("h\n");
    }
}

/// Path operators (no fill operator) drawing `text` in annotation space,
/// whose origin is the annotation's lower-left corner and whose height is
/// `box_h`. Lines start at x = 0; the first baseline sits
/// `baseline_ratio() * size` below the top edge, like the canvas.
pub fn note_paths(text: &str, size: f64, bold: bool, italic: bool, box_h: f64) -> String {
    let f = faces();
    let inter = inter_instance(size, bold, italic);
    let mut out = String::new();
    let line_h = size * LINE_HEIGHT;
    let first_baseline = box_h - baseline_ratio() * size;

    for (li, line) in text.split('\n').enumerate() {
        let baseline = first_baseline - li as f64 * line_h;
        let mut pen = 0.0f64;
        for (fam, run) in runs(line.trim_end_matches('\r')) {
            let (face, shear) = match fam {
                Family::Inter => (&inter, 0.0),
                Family::Bengali => (&f.bengali[usize::from(bold)], if italic { SYNTHETIC_OBLIQUE } else { 0.0 }),
            };
            let scale = size / face.units_per_em() as f64;
            let mut buf = UnicodeBuffer::new();
            buf.push_str(run);
            buf.guess_segment_properties();
            let shaped = rustybuzz::shape(face, &[], buf);
            for (info, pos) in shaped.glyph_infos().iter().zip(shaped.glyph_positions()) {
                let mut b = Pdf {
                    out: &mut out,
                    ox: pen + pos.x_offset as f64 * scale,
                    oy: baseline + pos.y_offset as f64 * scale,
                    s: scale,
                    shear,
                    last: (0.0, 0.0),
                };
                face.outline_glyph(GlyphId(info.glyph_id as u16), &mut b);
                pen += pos.x_advance as f64 * scale;
            }
        }
    }
    out
}

/// Advance width of one line in points (for tests and layout checks).
pub fn line_width(line: &str, size: f64, bold: bool, italic: bool) -> f64 {
    let f = faces();
    let inter = inter_instance(size, bold, italic);
    runs(line)
        .into_iter()
        .map(|(fam, run)| {
            let face = match fam {
                Family::Inter => &inter,
                Family::Bengali => &f.bengali[usize::from(bold)],
            };
            let mut buf = UnicodeBuffer::new();
            buf.push_str(run);
            buf.guess_segment_properties();
            let shaped = rustybuzz::shape(face, &[], buf);
            let units: i32 = shaped.glyph_positions().iter().map(|p| p.x_advance).sum();
            units as f64 * size / face.units_per_em() as f64
        })
        .sum()
}

/// Glyph ids for `text` in the family that would draw it (shaping tests).
pub fn shaped_glyphs(text: &str) -> Vec<(bool, Vec<u16>)> {
    let f = faces();
    runs(text)
        .into_iter()
        .map(|(fam, run)| {
            let face = if fam == Family::Bengali { &f.bengali[0] } else { &f.inter };
            let mut buf = UnicodeBuffer::new();
            buf.push_str(run);
            buf.guess_segment_properties();
            let shaped = rustybuzz::shape(face, &[], buf);
            (fam == Family::Bengali, shaped.glyph_infos().iter().map(|g| g.glyph_id as u16).collect())
        })
        .collect()
}
