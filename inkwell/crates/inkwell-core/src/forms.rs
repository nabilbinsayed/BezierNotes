//! AcroForm field filling (Plan 096): read a PDF's interactive form fields,
//! and write new values as an incremental update.
//!
//! Reading walks `/AcroForm /Fields` with `/Kids` inheritance of `/FT`, `/Ff`,
//! `/V`, `/DA`, `/Q`, `/Opt` and `/MaxLen`, through the same object index as
//! everything else (so fields inside object streams work).
//!
//! Writing replaces only the fields whose values the user set: the field's
//! `/V`, each widget's `/AS` (buttons) and a freshly generated `/AP` (text
//! and choice fields, as shaped vector glyphs from `text_shape`, so any
//! script renders in every reader). A value is never written without an
//! appearance that shows it. Buttons keep the form's own on/off appearances;
//! one with no on-state appearance gets a generated tick or dot.
//!
//! JavaScript (`/AA`, `/JS`) and XFA are detected and reported, never run.

use crate::pdf::{fmt_coord, pdf_text_string, refs_in_array, PdfFile};
use crate::pdfobj as po;
use crate::text_shape;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldKind {
    Text,
    Checkbox,
    Radio,
    Combo,
    List,
    Button,
    Signature,
}

/// One on-page appearance of a field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Widget {
    pub obj: u32,
    /// Index of the page it is on, when the file says.
    pub page: Option<usize>,
    /// Its position in that page's `/Annots` (the default tab order).
    pub order: usize,
    /// `/Rect` in PDF user space.
    pub rect: [f64; 4],
    /// For checkboxes and radios: the export name of its "on" state.
    pub on_state: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FormField {
    /// Fully qualified name (`parent.child`): the field's identity.
    pub name: String,
    pub obj: u32,
    pub kind: FieldKind,
    /// Text, the selected option's export value, or a button's on-state
    /// name (`""` / `"Off"` when unset).
    pub value: String,
    /// Choice options as (export value, display text).
    pub options: Vec<(String, String)>,
    pub read_only: bool,
    pub multiline: bool,
    pub comb: bool,
    pub max_len: Option<u32>,
    /// 0 left, 1 centred, 2 right.
    pub quadding: u8,
    /// From `/DA`; 0 means "auto".
    pub font_size: f64,
    pub color: [f64; 3],
    pub widgets: Vec<Widget>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FormInfo {
    pub fields: Vec<FormField>,
    /// Some field or the form has JavaScript actions (not run).
    pub has_scripts: bool,
    /// An XFA form: only its AcroForm fallback (if any) is fillable.
    pub xfa: bool,
}

// ---------------------------------------------------------------------------
// PDF value decoding
// ---------------------------------------------------------------------------

/// Decode a PDF string object (literal or hex) to text: UTF-16BE with a BOM,
/// UTF-8 with a BOM, else PDFDocEncoding (treated as Latin-1).
pub(crate) fn decode_string(raw: &[u8]) -> Option<String> {
    let raw = raw.trim_ascii();
    let bytes = if raw.first() == Some(&b'(') {
        let mut out = Vec::new();
        let mut i = 1;
        let mut depth = 0;
        while i < raw.len() {
            let c = raw[i];
            match c {
                b'\\' if i + 1 < raw.len() => {
                    i += 1;
                    let e = raw[i];
                    match e {
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'0'..=b'7' => {
                            let mut v = 0u32;
                            let mut n = 0;
                            while n < 3 && i < raw.len() && (b'0'..=b'7').contains(&raw[i]) {
                                v = v * 8 + (raw[i] - b'0') as u32;
                                i += 1;
                                n += 1;
                            }
                            out.push(v as u8);
                            continue;
                        }
                        b'\r' | b'\n' => {}
                        other => out.push(other),
                    }
                }
                b'(' => {
                    depth += 1;
                    out.push(c);
                }
                b')' if depth == 0 => break,
                b')' => {
                    depth -= 1;
                    out.push(c);
                }
                _ => out.push(c),
            }
            i += 1;
        }
        out
    } else if raw.first() == Some(&b'<') {
        let hex: Vec<u8> = raw[1..].iter().take_while(|c| **c != b'>').filter(|c| c.is_ascii_hexdigit()).copied().collect();
        hex.chunks(2)
            .map(|p| {
                let s = std::str::from_utf8(p).unwrap_or("0");
                u8::from_str_radix(&format!("{s:0<2}"), 16).unwrap_or(0)
            })
            .collect()
    } else {
        return None;
    };
    Some(if bytes.starts_with(&[0xFE, 0xFF]) {
        let u: Vec<u16> = bytes[2..].chunks(2).map(|c| u16::from_be_bytes([c[0], *c.get(1).unwrap_or(&0)])).collect();
        String::from_utf16_lossy(&u)
    } else if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(&bytes[3..]).into_owned()
    } else {
        bytes.iter().map(|b| *b as char).collect()
    })
}

/// A PDF name (`/Yes`, with `#xx` escapes) without its slash.
pub(crate) fn decode_name(raw: &[u8]) -> Option<String> {
    let raw = raw.trim_ascii();
    let body = raw.strip_prefix(b"/")?;
    let mut out = Vec::new();
    let mut i = 0;
    while i < body.len() {
        if body[i] == b'#' {
            if let Some(v) = body.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(body[i]);
        i += 1;
    }
    Some(String::from_utf8_lossy(&out).into_owned())
}

/// A name for writing: `/` plus the name with delimiters escaped.
fn encode_name(name: &str) -> String {
    let mut s = String::from("/");
    for b in name.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.".contains(&b) {
            s.push(b as char);
        } else {
            let _ = write!(s, "#{b:02X}");
        }
    }
    s
}

/// Font size and fill colour from a `/DA` string ("/Helv 12 Tf 0 0 1 rg").
fn parse_da(da: &str) -> (f64, [f64; 3]) {
    let toks: Vec<&str> = da.split_whitespace().collect();
    let mut size = 0.0;
    let mut color = [0.0; 3];
    for (i, t) in toks.iter().enumerate() {
        let num = |k: usize| toks.get(i.wrapping_sub(k)).and_then(|v| v.parse::<f64>().ok());
        match *t {
            "Tf" => size = num(1).unwrap_or(0.0),
            "g" => {
                let g = num(1).unwrap_or(0.0);
                color = [g; 3];
            }
            "rg" => color = [num(3).unwrap_or(0.0), num(2).unwrap_or(0.0), num(1).unwrap_or(0.0)],
            "k" => {
                let (c, m, y, k) = (num(4).unwrap_or(0.0), num(3).unwrap_or(0.0), num(2).unwrap_or(0.0), num(1).unwrap_or(0.0));
                color = [(1.0 - c) * (1.0 - k), (1.0 - m) * (1.0 - k), (1.0 - y) * (1.0 - k)];
            }
            _ => {}
        }
    }
    (size, color)
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
struct Inherited {
    ft: Option<String>,
    ff: u32,
    v: Option<(usize, usize)>,
    da: Option<String>,
    q: u8,
    opt: Option<(usize, usize)>,
    max_len: Option<u32>,
}

impl PdfFile {
    fn get(&self, dict: (usize, usize), key: &str) -> Option<(usize, usize)> {
        po::dict_get(&self.view, dict, key)
    }

    /// A value, following one indirect reference.
    fn deref(&self, r: (usize, usize)) -> (usize, usize) {
        match po::as_ref_num(&self.view, r).and_then(|n| self.index.find(&self.view, n)) {
            Some((bs, be)) => (bs, be),
            None => r,
        }
    }

    fn dict_of(&self, r: (usize, usize)) -> Option<(usize, usize)> {
        let (s, _) = self.deref(r);
        po::dict_inner(&self.view, s).ok()
    }

    fn bytes(&self, r: (usize, usize)) -> &[u8] {
        &self.view[r.0..r.1]
    }

    fn string_at(&self, r: (usize, usize)) -> Option<String> {
        let r = self.deref(r);
        decode_string(self.bytes(r))
    }

    fn acroform(&self) -> Option<(usize, usize)> {
        let cat = self.obj_dict(self.root_num).ok()?;
        let r = self.get(cat, "/AcroForm")?;
        self.dict_of(r)
    }

    /// The form fields of this file (empty when it has none).
    pub fn form_fields(&self) -> FormInfo {
        let mut info = FormInfo::default();
        let Some(form) = self.acroform() else { return info };
        info.xfa = self.get(form, "/XFA").is_some();
        info.has_scripts = self.get(form, "/AA").is_some();
        let form_da = self.get(form, "/DA").and_then(|r| self.string_at(r));

        // widget object → (page index, position in its /Annots)
        let mut placement: HashMap<u32, (usize, usize)> = HashMap::new();
        for (pi, page) in self.pages.iter().enumerate() {
            if let Ok(pd) = self.obj_dict(*page) {
                if let Some(a) = self.get(pd, "/Annots") {
                    let a = self.deref(a);
                    for (k, n) in refs_in_array(&self.view, a).into_iter().enumerate() {
                        placement.entry(n).or_insert((pi, k));
                    }
                }
            }
        }

        let Some(fields) = self.get(form, "/Fields") else { return info };
        let fields = self.deref(fields);
        let inherit = Inherited { da: form_da, ..Default::default() };
        let mut seen = std::collections::HashSet::new();
        for n in refs_in_array(&self.view, fields) {
            self.walk_field(n, "", &inherit, &placement, &mut info, &mut seen, 0);
        }
        info
    }

    #[allow(clippy::too_many_arguments)]
    fn walk_field(
        &self,
        num: u32,
        prefix: &str,
        parent: &Inherited,
        placement: &HashMap<u32, (usize, usize)>,
        info: &mut FormInfo,
        seen: &mut std::collections::HashSet<u32>,
        depth: u32,
    ) {
        if depth > 32 || !seen.insert(num) {
            return;
        }
        let Ok(d) = self.obj_dict(num) else { return };
        if self.get(d, "/AA").is_some() || self.get(d, "/JS").is_some() {
            info.has_scripts = true;
        }
        let mut inh = parent.clone();
        if let Some(r) = self.get(d, "/FT") {
            inh.ft = decode_name(self.bytes(self.deref(r)));
        }
        if let Some(v) = self.get(d, "/Ff").and_then(|r| po::as_int(&self.view, self.deref(r))) {
            inh.ff = v as u32;
        }
        if let Some(r) = self.get(d, "/V") {
            inh.v = Some(self.deref(r));
        }
        if let Some(s) = self.get(d, "/DA").and_then(|r| self.string_at(r)) {
            inh.da = Some(s);
        }
        if let Some(q) = self.get(d, "/Q").and_then(|r| po::as_int(&self.view, self.deref(r))) {
            inh.q = q.clamp(0, 2) as u8;
        }
        if let Some(r) = self.get(d, "/Opt") {
            inh.opt = Some(self.deref(r));
        }
        if let Some(m) = self.get(d, "/MaxLen").and_then(|r| po::as_int(&self.view, self.deref(r))) {
            inh.max_len = Some(m.max(0) as u32);
        }
        let partial = self.get(d, "/T").and_then(|r| self.string_at(r));
        let name = match (&partial, prefix.is_empty()) {
            (Some(t), true) => t.clone(),
            (Some(t), false) => format!("{prefix}.{t}"),
            (None, _) => prefix.to_string(),
        };

        // Kids that are fields (have /T) recurse; kids without are widgets.
        let kids: Vec<u32> = self.get(d, "/Kids").map(|r| refs_in_array(&self.view, self.deref(r))).unwrap_or_default();
        let (field_kids, widget_kids): (Vec<u32>, Vec<u32>) = kids.into_iter().partition(|k| {
            self.obj_dict(*k).ok().is_some_and(|kd| self.get(kd, "/T").is_some())
        });
        for k in field_kids {
            self.walk_field(k, &name, &inh, placement, info, seen, depth + 1);
        }
        let widgets: Vec<u32> = if !widget_kids.is_empty() {
            widget_kids
        } else if self.get(d, "/Rect").is_some() || self.get(d, "/Subtype").is_some() {
            vec![num]
        } else {
            Vec::new()
        };
        if widgets.is_empty() || partial.is_none() && prefix.is_empty() {
            return;
        }
        self.push_field(num, name, &inh, &widgets, placement, info);
    }

    fn push_field(
        &self,
        num: u32,
        name: String,
        inh: &Inherited,
        widgets: &[u32],
        placement: &HashMap<u32, (usize, usize)>,
        info: &mut FormInfo,
    ) {
        const READ_ONLY: u32 = 1;
        const MULTILINE: u32 = 1 << 12;
        const RADIO: u32 = 1 << 15;
        const PUSH: u32 = 1 << 16;
        const COMBO: u32 = 1 << 17;
        const COMB: u32 = 1 << 24;
        let kind = match inh.ft.as_deref() {
            Some("Tx") => FieldKind::Text,
            Some("Btn") if inh.ff & PUSH != 0 => FieldKind::Button,
            Some("Btn") if inh.ff & RADIO != 0 => FieldKind::Radio,
            Some("Btn") => FieldKind::Checkbox,
            Some("Ch") if inh.ff & COMBO != 0 => FieldKind::Combo,
            Some("Ch") => FieldKind::List,
            Some("Sig") => FieldKind::Signature,
            _ => return,
        };
        let value = match inh.v {
            None => String::new(),
            Some(r) => {
                let b = self.bytes(r).trim_ascii();
                if b.starts_with(b"/") {
                    decode_name(b).unwrap_or_default()
                } else if b.starts_with(b"[") {
                    // multi-select list: the first selection
                    let inner = &b[1..];
                    let at = inner.iter().position(|c| *c == b'(' || *c == b'<').unwrap_or(inner.len());
                    decode_string(&inner[at..]).unwrap_or_default()
                } else {
                    decode_string(b).unwrap_or_default()
                }
            }
        };
        let mut options = Vec::new();
        if let Some(opt) = inh.opt {
            let (s, e) = opt;
            let body = &self.view[s..e];
            // entries are strings or [export display] pairs
            let mut i = body.iter().position(|c| *c == b'[').map(|p| p + 1).unwrap_or(body.len());
            while i < body.len() {
                let c = body[i];
                if c == b']' {
                    break;
                }
                if c == b'(' || c == b'<' {
                    let end = po::skip_value(body, i);
                    let v = decode_string(&body[i..end]).unwrap_or_default();
                    options.push((v.clone(), v));
                    i = end;
                } else if c == b'[' {
                    let end = po::skip_value(body, i);
                    let pair = &body[i + 1..end];
                    let mut parts = Vec::new();
                    let mut j = 0;
                    while j < pair.len() {
                        if pair[j] == b'(' || pair[j] == b'<' {
                            let e2 = po::skip_value(pair, j);
                            parts.push(decode_string(&pair[j..e2]).unwrap_or_default());
                            j = e2;
                        } else {
                            j += 1;
                        }
                    }
                    if let [ex, disp, ..] = parts.as_slice() {
                        options.push((ex.clone(), disp.clone()));
                    } else if let [one] = parts.as_slice() {
                        options.push((one.clone(), one.clone()));
                    }
                    i = end;
                } else {
                    i += 1;
                }
            }
        }
        let (font_size, color) = parse_da(inh.da.as_deref().unwrap_or(""));
        let mut out_widgets = Vec::new();
        for w in widgets {
            let Ok(wd) = self.obj_dict(*w) else { continue };
            let Some(rect) = self.get(wd, "/Rect").and_then(|r| self.resolve_rectangle(r)) else { continue };
            let rect = [rect[0].min(rect[2]), rect[1].min(rect[3]), rect[0].max(rect[2]), rect[1].max(rect[3])];
            let on_state = if matches!(kind, FieldKind::Checkbox | FieldKind::Radio) {
                self.on_state(wd)
            } else {
                None
            };
            let (page, order) = placement.get(w).copied().map(|(p, o)| (Some(p), o)).unwrap_or((None, usize::MAX));
            out_widgets.push(Widget { obj: *w, page, order, rect, on_state });
        }
        if out_widgets.is_empty() {
            return;
        }
        info.fields.push(FormField {
            name,
            obj: num,
            kind,
            value,
            options,
            read_only: inh.ff & READ_ONLY != 0,
            multiline: inh.ff & MULTILINE != 0,
            comb: inh.ff & COMB != 0 && inh.max_len.is_some(),
            max_len: inh.max_len,
            quadding: inh.q,
            font_size,
            color,
            widgets: out_widgets,
        });
    }

    /// The non-"Off" state name in a button widget's `/AP /N` (or `/D`).
    fn on_state(&self, wd: (usize, usize)) -> Option<String> {
        let ap = self.dict_of(self.get(wd, "/AP")?)?;
        for key in ["/N", "/D"] {
            if let Some(states) = self.get(ap, key).and_then(|r| self.dict_of(r)) {
                for (k, _) in po::dict_entries(&self.view, states) {
                    let name = decode_name(self.bytes(k))?;
                    if name != "Off" {
                        return Some(name);
                    }
                }
            }
        }
        None
    }

    // -----------------------------------------------------------------------
    // Writing
    // -----------------------------------------------------------------------

    /// Write `values` (field name → value) into the form, with fresh
    /// appearances. Unknown, read-only, push-button and signature fields are
    /// skipped. Returns the names written.
    pub fn write_form_values(&mut self, values: &BTreeMap<String, String>) -> Vec<String> {
        if values.is_empty() {
            return Vec::new();
        }
        let info = self.form_fields();
        let mut written = Vec::new();
        // object → (keys to drop, entries to add)
        let mut edits: BTreeMap<u32, (Vec<&'static str>, String)> = BTreeMap::new();
        let mut edit = |obj: u32, drop: &[&'static str], add: String| {
            let e = edits.entry(obj).or_default();
            e.0.extend_from_slice(drop);
            e.1.push(' ');
            e.1.push_str(&add);
        };
        for f in &info.fields {
            let Some(v) = values.get(&f.name) else { continue };
            if f.read_only || matches!(f.kind, FieldKind::Button | FieldKind::Signature) {
                continue;
            }
            match f.kind {
                FieldKind::Checkbox | FieldKind::Radio => {
                    let on = !v.is_empty() && v != "Off";
                    let v_name = if on { encode_name(v) } else { "/Off".to_string() };
                    edit(f.obj, &["/V"], format!("/V {v_name}"));
                    for w in &f.widgets {
                        let this_on = on && w.on_state.as_deref() == Some(v.as_str());
                        // a checkbox widget is on for any non-Off value
                        let this_on = this_on || (on && f.kind == FieldKind::Checkbox && w.on_state.is_some());
                        let state = if this_on { w.on_state.clone().unwrap_or_else(|| v.clone()) } else { "Off".into() };
                        let mut drop = vec!["/AS"];
                        let mut add = format!("/AS {}", encode_name(&state));
                        if w.on_state.is_none() {
                            // no appearance for "on" in the file: draw one
                            let (on_ap, off_ap) = self.button_appearances(f, w, v);
                            drop.push("/AP");
                            let _ = write!(add, " /AP << /N << {} {on_ap} 0 R /Off {off_ap} 0 R >> >>", encode_name(v));
                        }
                        edit(w.obj, &drop, add);
                    }
                }
                FieldKind::Text | FieldKind::Combo | FieldKind::List => {
                    let shown = match f.kind {
                        FieldKind::Text => v.clone(),
                        _ => f.options.iter().find(|(ex, _)| ex == v).map(|(_, d)| d.clone()).unwrap_or_else(|| v.clone()),
                    };
                    edit(f.obj, &["/V"], format!("/V {}", pdf_text_string(v)));
                    for w in &f.widgets {
                        let ap = self.text_appearance(f, w, &shown);
                        edit(w.obj, &["/AP"], format!("/AP << /N {ap} 0 R >>"));
                    }
                }
                _ => {}
            }
            written.push(f.name.clone());
        }
        for (obj, (drop, add)) in edits {
            let Ok(d) = self.obj_dict(obj) else { continue };
            let mut body = b"<< ".to_vec();
            body.extend_from_slice(&po::dict_without(&self.view, d, &drop));
            body.extend_from_slice(add.as_bytes());
            body.extend_from_slice(b" >>");
            self.replace(obj, body);
        }
        // The appearances are current: viewers must not regenerate them.
        if !written.is_empty() {
            self.clear_need_appearances();
        }
        written
    }

    fn clear_need_appearances(&mut self) {
        let Ok(cat) = self.obj_dict(self.root_num) else { return };
        let Some(r) = self.get(cat, "/AcroForm") else { return };
        // Only an indirect /AcroForm can be replaced on its own; an inline one
        // keeps its flag (readers then regenerate from /V, which is current).
        let Some(num) = po::as_ref_num(&self.view, r) else { return };
        let Ok(d) = self.obj_dict(num) else { return };
        let mut body = b"<< ".to_vec();
        body.extend_from_slice(&po::dict_without(&self.view, d, &["/NeedAppearances"]));
        body.extend_from_slice(b" /NeedAppearances false >>");
        self.replace(num, body);
    }

    /// A text/choice widget appearance: the value as shaped glyph outlines,
    /// clipped to the field, honouring `/Q`, multiline and comb fields.
    fn text_appearance(&mut self, f: &FormField, w: &Widget, text: &str) -> u32 {
        let (bw, bh) = ((w.rect[2] - w.rect[0]).max(1.0), (w.rect[3] - w.rect[1]).max(1.0));
        let pad = 2.0;
        let lines: Vec<&str> = if f.multiline { text.split('\n').collect() } else { vec![text.lines().next().unwrap_or("")] };
        let mut size = if f.font_size > 0.0 { f.font_size } else { 0.0 };
        if size <= 0.0 {
            // auto size: fit the height (one line) or 12 pt (multiline), then the width
            size = if f.multiline { 12.0 } else { ((bh - 2.0 * pad) / text_shape::LINE_HEIGHT).clamp(4.0, 12.0) };
            let widest = lines.iter().map(|l| text_shape::line_width(l, 1.0, false, false)).fold(0.0, f64::max);
            if !f.comb && widest > 0.0 {
                size = size.min((bw - 2.0 * pad) / widest).max(4.0);
            }
        }
        let lh = size * text_shape::LINE_HEIGHT;
        let [r, g, b] = f.color;
        let mut c = String::new();
        let _ = writeln!(c, "/Tx BMC\nq\n{} {} {} {} re W n", fmt_coord(1.0), fmt_coord(1.0), fmt_coord(bw - 2.0), fmt_coord(bh - 2.0));
        let _ = writeln!(c, "{r:.3} {g:.3} {b:.3} rg");
        // top of the first line box, in the appearance's own space (y up)
        let top = if f.multiline { bh - pad } else { (bh + lh) / 2.0 };
        if f.comb {
            let cells = f.max_len.unwrap_or(1).max(1) as f64;
            let cell = bw / cells;
            for (i, ch) in lines[0].chars().take(cells as usize).enumerate() {
                let s = ch.to_string();
                let cw = text_shape::line_width(&s, size, false, false);
                let dx = cell * i as f64 + (cell - cw) / 2.0;
                let _ = writeln!(c, "q 1 0 0 1 {} 0 cm", fmt_coord(dx));
                c.push_str(&text_shape::note_paths(&s, size, false, false, top));
                let _ = writeln!(c, "f\nQ");
            }
        } else {
            for (i, line) in lines.iter().enumerate() {
                if line.is_empty() {
                    continue;
                }
                let lw = text_shape::line_width(line, size, false, false);
                let dx = match f.quadding {
                    1 => (bw - lw) / 2.0,
                    2 => bw - pad - lw,
                    _ => pad,
                };
                let _ = writeln!(c, "q 1 0 0 1 {} 0 cm", fmt_coord(dx));
                c.push_str(&text_shape::note_paths(line, size, false, false, top - i as f64 * lh));
                let _ = writeln!(c, "f\nQ");
            }
        }
        let _ = writeln!(c, "Q\nEMC");
        self.add_stream(
            &format!("/Type /XObject /Subtype /Form /BBox [0 0 {} {}] /Resources << >>", fmt_coord(bw), fmt_coord(bh)),
            c.as_bytes(),
            true,
        )
    }

    /// On and off appearances for a button whose file has none for "on": a
    /// tick for checkboxes, a dot for radios.
    fn button_appearances(&mut self, f: &FormField, w: &Widget, _value: &str) -> (u32, u32) {
        let (bw, bh) = ((w.rect[2] - w.rect[0]).max(1.0), (w.rect[3] - w.rect[1]).max(1.0));
        let [r, g, b] = f.color;
        let m = bw.min(bh);
        let (cx, cy) = (bw / 2.0, bh / 2.0);
        let mark = if f.kind == FieldKind::Radio {
            let rr = m * 0.25;
            let k = rr * crate::shape::KAPPA;
            format!(
                "{r:.3} {g:.3} {b:.3} rg {} {} m {} {} {} {} {} {} c {} {} {} {} {} {} c {} {} {} {} {} {} c {} {} {} {} {} {} c f",
                fmt_coord(cx + rr), fmt_coord(cy),
                fmt_coord(cx + rr), fmt_coord(cy + k), fmt_coord(cx + k), fmt_coord(cy + rr), fmt_coord(cx), fmt_coord(cy + rr),
                fmt_coord(cx - k), fmt_coord(cy + rr), fmt_coord(cx - rr), fmt_coord(cy + k), fmt_coord(cx - rr), fmt_coord(cy),
                fmt_coord(cx - rr), fmt_coord(cy - k), fmt_coord(cx - k), fmt_coord(cy - rr), fmt_coord(cx), fmt_coord(cy - rr),
                fmt_coord(cx + k), fmt_coord(cy - rr), fmt_coord(cx + rr), fmt_coord(cy - k), fmt_coord(cx + rr), fmt_coord(cy),
            )
        } else {
            format!(
                "{r:.3} {g:.3} {b:.3} RG {} w 1 J 1 j {} {} m {} {} l {} {} l S",
                fmt_coord((m * 0.12).max(0.8)),
                fmt_coord(bw * 0.22), fmt_coord(bh * 0.52),
                fmt_coord(bw * 0.42), fmt_coord(bh * 0.28),
                fmt_coord(bw * 0.78), fmt_coord(bh * 0.74),
            )
        };
        let bbox = format!("/Type /XObject /Subtype /Form /BBox [0 0 {} {}] /Resources << >>", fmt_coord(bw), fmt_coord(bh));
        let on = self.add_stream(&bbox, format!("q {mark} Q").as_bytes(), true);
        let off = self.add_stream(&bbox, b"", true);
        (on, off)
    }
}
