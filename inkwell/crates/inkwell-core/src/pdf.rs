//! PDF-native writer: three layers in one standard file, appended incrementally.
//!
//!   Layer 1  visual  -- variable-width ribbons as FILLED vector paths
//!   Layer 2  interop -- /Ink annotations carrying /AP appearance streams
//!   Layer 3  data    -- the compressed sidecar, embedded, under private keys
//!
//! Saving uses PDF incremental update: changed objects, a new xref section, and
//! a trailer whose /Prev chains to the previous one. Append-only, so the bytes
//! already on disk are never rewritten -- which is what makes autosave both fast
//! and crash-safe. A torn tail leaves the previous xref valid; recovery is
//! `truncate to the last %%EOF`.

use std::collections::BTreeMap;
use std::io::Write;

use base64::Engine;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use sha2::{Digest, Sha256};

use crate::doc::{self, Document};
use crate::ink::{ribbon_path, PathCmd, Stroke, ToolKind};
use crate::pdfobj::{self as po, Error, Result};
use crate::text_shape;
use crate::xref::ObjIndex;

/// Number of strokes sharing one `/Ink` annotation. One annotation per stroke is
/// spec-correct but a dense page then carries thousands of annotations, which
/// makes Acrobat crawl. Grouping keeps interop without the pathology.
pub const DEFAULT_GROUP: usize = 64;

pub struct PdfFile {
    /// The input file, followed by objects materialised from object streams
    /// (see `xref`). Only `view[..base_len]` is ever written back out.
    view: Vec<u8>,
    base_len: usize,
    index: ObjIndex,
    next_id: u32,
    root_num: u32,
    trailer_id: Option<Vec<u8>>,
    trailer_info: Option<Vec<u8>>,
    prev_xref: usize,
    /// The newest input section is an xref stream, so ours must be one too.
    xref_stream: bool,
    pages: Vec<u32>,
    new_objs: BTreeMap<u32, Vec<u8>>,
}

impl PdfFile {
    pub fn open(bytes: Vec<u8>) -> Result<Self> {
        let base_len = bytes.len();
        let mut view = bytes;
        let index = ObjIndex::build(&mut view)?;
        let tr = index.trailer.clone();
        // Appending plaintext objects to an encrypted file corrupts it for
        // every other reader (qpdf: "error decoding stream data"). Refuse.
        if tr.encrypt.is_some() {
            return Err(Error::Encrypted);
        }
        let root_num = tr.root.ok_or(Error::NoRoot)?;
        let next_id = tr.size.max(index.max_obj.saturating_add(1));

        let mut f = Self {
            prev_xref: index.last_xref,
            xref_stream: index.last_is_stream,
            view,
            base_len,
            index,
            next_id,
            root_num,
            trailer_id: tr.id,
            trailer_info: tr.info,
            pages: Vec::new(),
            new_objs: BTreeMap::new(),
        };
        f.pages = f.collect_pages()?;
        Ok(f)
    }

    pub fn page_count(&self) -> usize {
        self.pages.len()
    }

    // -- structure walk ----------------------------------------------------

    fn obj_dict(&self, num: u32) -> Result<(usize, usize)> {
        let (bs, _) = self.index.find(&self.view, num).ok_or(Error::MissingObject(num))?;
        po::dict_inner(&self.view, bs)
    }

    fn collect_pages(&self) -> Result<Vec<u32>> {
        let cat = self.obj_dict(self.root_num)?;
        let pages_ref = po::dict_get(&self.view, cat, "/Pages")
            .and_then(|r| po::as_ref_num(&self.view, r))
            .ok_or(Error::Malformed("catalog has no /Pages"))?;
        let mut out = Vec::new();
        self.walk_pages(pages_ref, &mut out, 0)?;
        Ok(out)
    }

    fn walk_pages(&self, node: u32, out: &mut Vec<u32>, depth: u32) -> Result<()> {
        if depth > 32 {
            return Err(Error::Malformed("page tree too deep / cyclic"));
        }
        let dict = self.obj_dict(node)?;
        let ty = po::dict_get(&self.view, dict, "/Type")
            .map(|r| self.view[r.0..r.1].to_vec())
            .unwrap_or_default();
        if ty == b"/Page" {
            out.push(node);
            return Ok(());
        }
        if let Some(kids) = po::dict_get(&self.view, dict, "/Kids") {
            for k in refs_in_array(&self.view, kids) {
                self.walk_pages(k, out, depth + 1)?;
            }
        }
        Ok(())
    }

    // -- object emission ---------------------------------------------------

    fn add(&mut self, body: Vec<u8>) -> u32 {
        let n = self.next_id;
        self.next_id += 1;
        self.new_objs.insert(n, body);
        n
    }

    fn replace(&mut self, num: u32, body: Vec<u8>) {
        self.new_objs.insert(num, body);
    }

    fn add_stream(&mut self, dict_extra: &str, data: &[u8], compress: bool) -> u32 {
        let (payload, filter) = if compress {
            let mut e = ZlibEncoder::new(Vec::new(), Compression::best());
            e.write_all(data).expect("in-memory write");
            (e.finish().expect("in-memory finish"), " /Filter /FlateDecode")
        } else {
            (data.to_vec(), "")
        };
        let head = format!("<< {dict_extra}{filter} /Length {} >>\nstream\n", payload.len());
        let mut body = head.into_bytes();
        body.extend_from_slice(&payload);
        body.extend_from_slice(b"\nendstream");
        self.add(body)
    }

    fn resolve_rectangle(&self, r: (usize, usize)) -> Option<[f64; 4]> {
        let raw = if let Some(ref_num) = po::as_ref_num(&self.view, r) {
            let (obj_start, _) = self.index.find(&self.view, ref_num)?;
            let end = po::skip_value(&self.view, obj_start);
            &self.view[obj_start..end]
        } else {
            &self.view[r.0..r.1]
        };

        let s = String::from_utf8_lossy(raw);
        let nums: Vec<f64> = s
            .trim_matches(|c| c == '[' || c == ']')
            .split_whitespace()
            .filter_map(|t| t.parse::<f64>().ok())
            .collect();
        if nums.len() == 4 {
            Some([nums[0], nums[1], nums[2], nums[3]])
        } else {
            None
        }
    }

    /// The box (CropBox, else MediaBox) of the page at `index`.
    pub fn page_box_at(&self, index: usize) -> Option<[f64; 4]> {
        self.pages.get(index).map(|n| self.page_box(*n))
    }

    pub fn page_box(&self, page_num: u32) -> [f64; 4] {
        let mut cur_obj = page_num;
        let mut depth = 0;

        while depth < 32 {
            if let Ok(dict) = self.obj_dict(cur_obj) {
                // Check CropBox first, then MediaBox
                let box_ref = po::dict_get(&self.view, dict, "/CropBox")
                    .or_else(|| po::dict_get(&self.view, dict, "/MediaBox"));

                if let Some(r) = box_ref {
                    if let Some(nums) = self.resolve_rectangle(r) {
                        let (llx, urx) = if nums[0] <= nums[2] { (nums[0], nums[2]) } else { (nums[2], nums[0]) };
                        let (lly, ury) = if nums[1] <= nums[3] { (nums[1], nums[3]) } else { (nums[3], nums[1]) };
                        return [llx, lly, urx, ury];
                    }
                }

                // If not found on this node, follow /Parent up the page tree
                if let Some(parent_ref) = po::dict_get(&self.view, dict, "/Parent") {
                    if let Some(parent_num) = po::as_ref_num(&self.view, parent_ref) {
                        cur_obj = parent_num;
                        depth += 1;
                        continue;
                    }
                }
            }
            break;
        }

        [0.0, 0.0, 595.0, 842.0]
    }

    pub fn page_height(&self, page_num: u32) -> f64 {
        let b = self.page_box(page_num);
        (b[3] - b[1]).abs()
    }

    // -- the interesting part ---------------------------------------------

    /// Write `doc` into the file as a new incremental generation.
    pub fn write_document(&mut self, document: &Document, group: usize) -> Result<()> {
        self.write_document_inner(document, group, None, false)
    }

    /// Write `doc` into the file with optional authoritative explicit page boxes.
    pub fn write_document_with_boxes(
        &mut self,
        document: &Document,
        group: usize,
        explicit_boxes: Option<&std::collections::HashMap<usize, [f64; 4]>>,
    ) -> Result<()> {
        self.write_document_inner(document, group, explicit_boxes, false)
    }

    /// Write a **flattened** (read-only) export: every annotation is still a
    /// standards-compliant vector object, but the editable InkWell sidecar and
    /// `/Inkw_*` catalog markers are omitted, so re-opening the file cannot
    /// resurrect (or accidentally erase) the source ink geometry.
    pub fn write_document_flattened(&mut self, document: &Document, group: usize) -> Result<()> {
        self.write_document_inner(document, group, None, true)
    }

    fn write_document_inner(
        &mut self,
        document: &Document,
        group: usize,
        explicit_boxes: Option<&std::collections::HashMap<usize, [f64; 4]>>,
        flatten: bool,
    ) -> Result<()> {
        let group = group.max(1);
        let sidecar_raw = if flatten { Vec::new() } else { doc::encode_sidecar(document) };
        let hash = Sha256::digest(&sidecar_raw);

        // ---- Layer 1 + 2, per sheet ------------------------------------
        for (sheet_idx, sheet) in document.sheets.iter().enumerate() {
            let (page_num, pdf_page_idx) = match sheet.kind {
                doc::SheetKind::BoundedPage { source_pdf_page } => {
                    match self.pages.get(source_pdf_page) {
                        Some(n) => (*n, source_pdf_page),
                        None => continue,
                    }
                }
                // FreeCanvas materialisation is M7; skip cleanly rather than
                // silently dropping ink into the void.
                doc::SheetKind::FreeCanvas => continue,
            };
            let _ = sheet_idx;

            let pbox = if let Some(boxes) = explicit_boxes {
                boxes.get(&pdf_page_idx).copied().or_else(|| boxes.get(&sheet_idx).copied()).unwrap_or_else(|| self.page_box(page_num))
            } else {
                self.page_box(page_num)
            };

            let strokes: Vec<&Stroke> = sheet.strokes().collect();
            let mut annots = Vec::new();

            // 1. Page template backgrounds (must be rendered first at the bottom of the annotation stack)
            for img in &sheet.images {
                if img.id.starts_with("template_bg_") || img.id.starts_with("img_template_bg_") {
                    if let Some(a) = self.emit_image_annot(img, pbox) {
                        annots.push(a);
                    }
                }
            }

            // 2. User embedded images (below strokes so ink markup over figures remains visible)
            for img in &sheet.images {
                if !img.id.starts_with("template_bg_") && !img.id.starts_with("img_template_bg_") {
                    if let Some(a) = self.emit_image_annot(img, pbox) {
                        annots.push(a);
                    }
                }
            }

            // 3. Vector ink strokes (on top of background templates and user images)
            for chunk in strokes.chunks(group) {
                if let Some(a) = self.emit_group(chunk, pbox) {
                    annots.push(a);
                }
            }

            // 4. Parametric shapes (Plan 095): native /Square, /Circle,
            //    /Line, /Polygon, /PolyLine with /AP
            for shape in &sheet.shapes {
                if let Some(a) = self.emit_shape_annot(shape, pbox) {
                    annots.push(a);
                }
            }

            // 5. Text objects / annotations (top layer)
            for txt in &sheet.text_objects {
                if !txt.text.trim().is_empty() {
                    if let Some(a) = self.emit_text_annot(txt, pbox) {
                        annots.push(a);
                    }
                }
            }
            self.rewrite_page(page_num, &annots)?;
        }

        if flatten {
            // Read-only export: no embedded sidecar, no editable markers.
            return Ok(());
        }

        // ---- Layer 3 ----------------------------------------------------
        let ef = self.add_stream(
            &format!(
                "/Type /EmbeddedFile /Subtype /application#2Fx-inkwell \
                 /Params << /Size {} >>",
                sidecar_raw.len()
            ),
            &sidecar_raw,
            true,
        );
        let fs = self.add(
            format!(
                "<< /Type /Filespec /F (inkwell.doc) /UF (inkwell.doc) \
                 /Desc (Inkwell editable ink data \\(pressure, layers, samples\\)) \
                 /AFRelationship /Supplement /EF << /F {ef} 0 R >> >>"
            )
            .into_bytes(),
        );
        let base_hash = Sha256::digest(&self.view[..self.base_len]);
        self.rewrite_catalog(ef, fs, &hash, &base_hash)?;
        Ok(())
    }

    /// One `/Ink` annotation covering `strokes`, with an `/AP` appearance stream
    /// holding their filled ribbons.
    fn emit_group(&mut self, strokes: &[&Stroke], page_box: [f64; 4]) -> Option<u32> {
        let llx = page_box[0];
        let lly = page_box[1];
        let urx = page_box[2];
        let ury = page_box[3];

        if strokes.is_empty() {
            return None;
        }

        let page_rect = [llx, lly, urx, ury];

        // appearance content: one fill per stroke
        let mut content = Vec::new();
        let mut needs_multiply = false;
        let mut min_x = f64::INFINITY;
        let mut min_y = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut max_y = f64::NEG_INFINITY;

        for s in strokes {
            let path = ribbon_path(s, 16);
            if path.len() < 3 {
                continue;
            }
            let gs = match s.kind {
                ToolKind::Highlighter => {
                    needs_multiply = true;
                    "/GSm"
                }
                ToolKind::Pen => "/GSn",
            };

            let _ = write!(
                content,
                "q\n{gs} gs\n{:.3} {:.3} {:.3} rg\n",
                s.rgb[0], s.rgb[1], s.rgb[2]
            );

            // PDF user space: origin is bottom-left, y grows up.
            // Canvas space: origin is top-left, y grows down.
            // Map: x_pdf = llx + x_canvas, y_pdf = ury - y_canvas.
            for cmd in &path {
                match cmd {
                    PathCmd::MoveTo(p) => {
                        let xp = llx + p.0;
                        let yp = ury - p.1;
                        min_x = min_x.min(xp);
                        max_x = max_x.max(xp);
                        min_y = min_y.min(yp);
                        max_y = max_y.max(yp);
                        let _ = writeln!(content, "{} {} m", fmt_coord(xp), fmt_coord(yp));
                    }
                    PathCmd::LineTo(p) => {
                        let xp = llx + p.0;
                        let yp = ury - p.1;
                        min_x = min_x.min(xp);
                        max_x = max_x.max(xp);
                        min_y = min_y.min(yp);
                        max_y = max_y.max(yp);
                        let _ = writeln!(content, "{} {} l", fmt_coord(xp), fmt_coord(yp));
                    }
                    PathCmd::CurveTo(c) => {
                        for pt in c {
                            let xp = llx + pt.0;
                            let yp = ury - pt.1;
                            min_x = min_x.min(xp);
                            max_x = max_x.max(xp);
                            min_y = min_y.min(yp);
                            max_y = max_y.max(yp);
                        }
                        let _ = writeln!(
                            content,
                            "{} {} {} {} {} {} c",
                            fmt_coord(llx + c[0].0),
                            fmt_coord(ury - c[0].1),
                            fmt_coord(llx + c[1].0),
                            fmt_coord(ury - c[1].1),
                            fmt_coord(llx + c[2].0),
                            fmt_coord(ury - c[2].1),
                        );
                    }
                    PathCmd::CloseSubpath => {
                        let _ = writeln!(content, "h");
                    }
                    PathCmd::Close => {
                        let _ = writeln!(content, "h f Q");
                    }
                }
            }
        }

        if content.is_empty() {
            return None;
        }

        let annot_rect = if min_x.is_finite() && min_y.is_finite() && max_x.is_finite() && max_y.is_finite() {
            let pad = 1.0;
            [
                (min_x - pad).max(llx),
                (min_y - pad).max(lly),
                (max_x + pad).min(urx),
                (max_y + pad).min(ury),
            ]
        } else {
            page_rect
        };

        let mut gstates = String::from("/GSn << /Type /ExtGState /BM /Normal /ca 1 >>");
        if needs_multiply {
            gstates.push_str(" /GSm << /Type /ExtGState /BM /Multiply /ca 0.42 >>");
        }
        let ap = self.add_stream(
            &format!(
                "/Type /XObject /Subtype /Form /BBox [{}] /Resources << /ExtGState << {gstates} >> >>",
                fmt_rect(&annot_rect)
            ),
            &content,
            true,
        );

        // /InkList: decimated centrelines converted to PDF user space (x_pdf = llx + x_canvas, y_pdf = ury - y_canvas)
        let mut inklist = String::new();
        for s in strokes {
            let is_rect = crate::ink::is_axis_aligned_rect(&s.samples).is_some();
            let simplified = if !is_rect && s.samples.len() > 3 {
                crate::ink::simplify(&s.samples, 0.5)
            } else {
                s.samples.clone()
            };
            let centreline: Vec<(f64, f64)> = if simplified.len() <= 2 {
                simplified.iter().map(|sm| (sm.x, sm.y)).collect()
            } else {
                simplified.iter().step_by(2).map(|sm| (sm.x, sm.y)).collect()
            };
            inklist.push('[');
            for (x, y) in centreline {
                let x_pdf = llx + x;
                let y_pdf = ury - y;
                inklist.push_str(&fmt_coord(x_pdf));
                inklist.push(' ');
                inklist.push_str(&fmt_coord(y_pdf));
                inklist.push(' ');
            }
            if inklist.ends_with(' ') {
                inklist.pop();
            }
            inklist.push(']');
        }
        let head = strokes[0];
        let annot = self.add(
            format!(
                "<< /Type /Annot /Subtype /Ink /F 4 /Rect [{}] \
                 /InkList [{inklist}] /C [{:.3} {:.3} {:.3}] \
                 /BS << /W {:.2} /S /S >> /T (Inkwell) /NM ({}) \
                 /AP << /N {ap} 0 R >> /Inkw_Sid ({}) /Inkw_N {} >>",
                fmt_rect(&annot_rect),
                head.rgb[0],
                head.rgb[1],
                head.rgb[2],
                head.brush.base_width,
                head.id_hex(),
                head.id_hex(),
                strokes.len(),
            )
            .into_bytes(),
        );
        Some(annot)
    }

    fn emit_image_annot(&mut self, img: &doc::ImageObject, page_box: [f64; 4]) -> Option<u32> {
        let llx = page_box[0];
        let ury = page_box[3];

        if img.width <= 0.0 || img.height <= 0.0 {
            return None;
        }

        let x0 = llx + img.x;
        let y0 = ury - (img.y + img.height);
        let x1 = x0 + img.width;
        let y1 = y0 + img.height;
        let annot_rect = [x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1)];

        let idx = img.data_url.find("base64,")?;
        let b64 = &img.data_url[idx + 7..];
        let raw_bytes = base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok()?;

        let dynamic_img = image::ImageReader::new(std::io::Cursor::new(raw_bytes))
            .with_guessed_format().ok()?
            .decode().ok()?;
        let rgb = dynamic_img.to_rgb8();
        let (w, h) = rgb.dimensions();
        let rgb_bytes = rgb.into_raw();

        let smask_xobject = if dynamic_img.color().has_alpha() {
            let rgba = dynamic_img.to_rgba8();
            let alpha_bytes: Vec<u8> = rgba.pixels().map(|p| p[3]).collect();
            let smask_id = self.add_stream(
                &format!(
                    "/Type /XObject /Subtype /Image /Width {w} /Height {h} \
                     /ColorSpace /DeviceGray /BitsPerComponent 8"
                ),
                &alpha_bytes,
                true,
            );
            Some(smask_id)
        } else {
            None
        };

        let img_dict = match smask_xobject {
            Some(smask_id) => format!(
                "/Type /XObject /Subtype /Image /Width {w} /Height {h} \
                 /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask {smask_id} 0 R"
            ),
            None => format!(
                "/Type /XObject /Subtype /Image /Width {w} /Height {h} \
                 /ColorSpace /DeviceRGB /BitsPerComponent 8"
            ),
        };

        let img_xobject = self.add_stream(&img_dict, &rgb_bytes, true);

        let annot_w = (x1 - x0).abs();
        let annot_h = (y1 - y0).abs();
        let mut form_content = Vec::new();
        let _ = writeln!(form_content, "q\n{:.3} 0 0 {:.3} 0 0 cm\n/Im Do\nQ", annot_w, annot_h);

        let ap = self.add_stream(
            &format!(
                "/Type /XObject /Subtype /Form /BBox [0 0 {:.3} {:.3}] \
                 /Resources << /XObject << /Im {img_xobject} 0 R >> >>",
                annot_w, annot_h
            ),
            &form_content,
            false,
        );

        let raw_sid = if img.id.starts_with("img_") {
            img.id.clone()
        } else {
            format!("img_{}", img.id)
        };
        let sid = escape_pdf_string(&raw_sid);
        let annot = self.add(
            format!(
                "<< /Type /Annot /Subtype /Stamp /F 4 /Rect [{}] \
                 /T (Inkwell) /AP << /N {ap} 0 R >> /Inkw_Sid ({sid}) >>",
                fmt_rect(&annot_rect)
            )
            .into_bytes(),
        );
        Some(annot)
    }

    fn emit_text_annot(&mut self, text_obj: &doc::TextObject, page_box: [f64; 4]) -> Option<u32> {
        let llx = page_box[0];
        let ury = page_box[3];

        let trimmed = text_obj.text.trim();
        if trimmed.is_empty() {
            return None;
        }

        let fs = text_obj.font_size.max(6.0);
        let line_height = fs * text_shape::LINE_HEIGHT;
        let lines: Vec<&str> = text_obj.text.split('\n').collect();
        let approx_h = (lines.len() as f64 * line_height).max(text_obj.height.max(20.0));
        // The canvas never wraps, so a long line must widen the box rather
        // than be clipped by the appearance's /BBox.
        let widest = lines
            .iter()
            .map(|l| text_shape::line_width(l, fs, text_obj.bold, text_obj.italic))
            .fold(0.0, f64::max);
        let approx_w = text_obj.width.max(60.0).max(widest.ceil() + 1.0);

        let x0 = llx + text_obj.x;
        let y0 = ury - (text_obj.y + approx_h);
        let x1 = x0 + approx_w;
        let y1 = y0 + approx_h;
        let annot_w = (x1 - x0).abs();
        let annot_h = (y1 - y0).abs();
        // Accents on capitals, Bengali vowel signs and italic overhang reach
        // outside the line box; the canvas doesn't clip them, so neither may
        // the /BBox. Glyphs keep their line-box coordinates; only the
        // appearance (and /Rect with it) grows.
        let (pad_x, pad_y) = (0.15 * fs, 0.4 * fs);
        let annot_rect = [x0.min(x1) - pad_x, y0.min(y1) - pad_y, x0.max(x1) + pad_x, y0.max(y1) + pad_y];

        let (cr, cg, cb) = parse_hex_color_rgb(&text_obj.color);

        // Glyph outlines, not font text: every script renders identically in
        // every reader with nothing embedded (see `text_shape`).
        let mut form_content = Vec::new();
        let _ = writeln!(form_content, "q\n{:.3} {:.3} {:.3} rg", cr, cg, cb);
        form_content.extend_from_slice(
            text_shape::note_paths(&text_obj.text, fs, text_obj.bold, text_obj.italic, annot_h).as_bytes(),
        );
        let _ = writeln!(form_content, "f\nQ");

        let ap = self.add_stream(
            &format!(
                "/Type /XObject /Subtype /Form /BBox [{:.3} {:.3} {:.3} {:.3}] /Resources << >>",
                -pad_x,
                -pad_y,
                annot_w + pad_x,
                annot_h + pad_y
            ),
            &form_content,
            true,
        );

        let contents = pdf_text_string(&text_obj.text);
        // Rich text for readers that re-render FreeText from /RC.
        let weight = if text_obj.bold { "bold" } else { "normal" };
        let style = if text_obj.italic { "italic" } else { "normal" };
        let rc = pdf_text_string(&format!(
            "<?xml version=\"1.0\"?><body xmlns=\"http://www.w3.org/1999/xhtml\"><p style=\"font-size:{fs:.1}pt;\
             color:#{:02x}{:02x}{:02x};font-weight:{weight};font-style:{style}\">{}</p></body>",
            (cr * 255.0).round() as u8,
            (cg * 255.0).round() as u8,
            (cb * 255.0).round() as u8,
            xml_escape(&text_obj.text).replace('\n', "<br/>")
        ));
        let raw_sid = if text_obj.id.starts_with("txt_") {
            text_obj.id.clone()
        } else {
            format!("txt_{}", text_obj.id)
        };
        let sid = escape_pdf_string(&raw_sid);
        let font_tag = match (text_obj.bold, text_obj.italic) {
            (true, true) => "/HeBI",
            (true, false) => "/HeB",
            (false, true) => "/HeI",
            (false, false) => "/Helv",
        };
        let annot = self.add(
            format!(
                "<< /Type /Annot /Subtype /FreeText /F 4 /Rect [{}] \
                 /T (Inkwell) /Contents {contents} /RC {rc} \
                 /DA ({font_tag} {:.2} Tf {:.3} {:.3} {:.3} rg) \
                 /AP << /N {ap} 0 R >> /Inkw_Sid ({sid}) >>",
                fmt_rect(&annot_rect),
                fs, cr, cg, cb
            )
            .into_bytes(),
        );
        Some(annot)
    }

    /// One shape as the native annotation type a reader would use for it,
    /// with an `/AP` drawn from `ShapeObject::outline`, the same geometry the
    /// canvas draws. The native keys describe the same shape, so a reader that
    /// regenerates appearances (or lists comments) agrees with the `/AP`:
    /// rects and ellipses that aren't axis-aligned become `/Polygon`s, since
    /// `/Square` and `/Circle` can only describe page-aligned ones. A rounded
    /// rect stays a `/Square` (its corners are in the `/AP` only).
    fn emit_shape_annot(&mut self, s: &crate::shape::ShapeObject, page_box: [f64; 4]) -> Option<u32> {
        use crate::shape::{PathCmd, ShapeKind};
        if s.points.len() < 2 || !s.points.iter().flatten().all(|v| v.is_finite()) {
            return None;
        }
        let (llx, ury) = (page_box[0], page_box[3]);
        let pt = |q: [f64; 2]| -> [f64; 2] { [llx + q[0], ury - q[1]] };
        let num = |v: f64| fmt_coord(v);
        let b = s.bbox();
        // /Rect: the drawn bounds in PDF space, a little slack for joins
        let slack = s.stroke_width.max(0.0) * 0.5 + 0.5;
        let rect = [llx + b[0] - slack, ury - b[3] - slack, llx + b[2] + slack, ury - b[1] + slack];

        let width = s.stroke_width.max(0.0);
        let opacity = s.opacity.clamp(0.0, 1.0);
        let [sr, sg, sb] = s.stroke_rgb.map(|c| c.clamp(0.0, 1.0));
        let fill = if s.is_closed() { s.fill_rgb.map(|f| f.map(|c| c.clamp(0.0, 1.0))) } else { None };
        let dash: Vec<f64> = s.dash.clone().unwrap_or_default().into_iter().filter(|d| d.is_finite() && *d >= 0.0).collect();
        let dash_arr = dash.iter().map(|d| num(*d)).collect::<Vec<_>>().join(" ");

        // ---- appearance ------------------------------------------------
        let mut c = Vec::new();
        let _ = writeln!(c, "q");
        if opacity < 1.0 {
            let _ = writeln!(c, "/GS0 gs");
        }
        // Round caps and joins, except that a dashed stroke gets butt caps:
        // round caps would grow every dash by the stroke width and close the
        // gaps. `ink.js` `drawShape` does the same.
        let cap = if dash.is_empty() { 1 } else { 0 };
        let _ = writeln!(c, "{:.3} {:.3} {:.3} RG {} w {cap} J 1 j", sr, sg, sb, num(width));
        if !dash.is_empty() {
            let _ = writeln!(c, "[{dash_arr}] 0 d");
        }
        if let Some([fr, fg, fb]) = fill {
            let _ = writeln!(c, "{fr:.3} {fg:.3} {fb:.3} rg");
        }
        for cmd in s.outline() {
            match cmd {
                PathCmd::MoveTo(q) => {
                    let q = pt(q);
                    let _ = writeln!(c, "{} {} m", num(q[0]), num(q[1]));
                }
                PathCmd::LineTo(q) => {
                    let q = pt(q);
                    let _ = writeln!(c, "{} {} l", num(q[0]), num(q[1]));
                }
                PathCmd::CurveTo(a, bq, e) => {
                    let (a, bq, e) = (pt(a), pt(bq), pt(e));
                    let _ = writeln!(c, "{} {} {} {} {} {} c", num(a[0]), num(a[1]), num(bq[0]), num(bq[1]), num(e[0]), num(e[1]));
                }
                PathCmd::Close => {
                    let _ = writeln!(c, "h");
                }
            }
        }
        let _ = writeln!(c, "{}", if fill.is_some() { "B" } else { "S" });
        let heads = s.arrow_heads();
        if !heads.is_empty() {
            let _ = writeln!(c, "[] 0 d {sr:.3} {sg:.3} {sb:.3} rg");
            for h in heads {
                let [a, bq, e] = h.map(pt);
                let _ = writeln!(c, "{} {} m {} {} l {} {} l h", num(a[0]), num(a[1]), num(bq[0]), num(bq[1]), num(e[0]), num(e[1]));
            }
            let _ = writeln!(c, "f");
        }
        let _ = writeln!(c, "Q");
        let resources = if opacity < 1.0 {
            format!("/Resources << /ExtGState << /GS0 << /Type /ExtGState /CA {opacity:.3} /ca {opacity:.3} >> >> >>")
        } else {
            "/Resources << >>".to_string()
        };
        // BBox = Rect, identity Matrix: the stream is in page space.
        let ap = self.add_stream(
            &format!("/Type /XObject /Subtype /Form /BBox [{}] {resources}", fmt_rect(&rect)),
            &c,
            true,
        );

        // ---- native geometry ---------------------------------------------
        let border = if dash.is_empty() {
            format!("/BS << /Type /Border /W {} /S /S >>", num(width))
        } else {
            format!("/BS << /Type /Border /W {} /S /D /D [{dash_arr}] >>", num(width))
        };
        let colour = format!("/C [{sr:.3} {sg:.3} {sb:.3}]");
        let interior = fill.map(|[r, g, bq]| format!(" /IC [{r:.3} {g:.3} {bq:.3}]")).unwrap_or_default();
        let vertices = |pts: &[[f64; 2]]| {
            pts.iter().map(|q| { let q = pt(*q); format!("{} {}", num(q[0]), num(q[1])) }).collect::<Vec<_>>().join(" ")
        };
        let aligned = s.axis_aligned_box();
        let (subtype, geometry) = match s.kind {
            ShapeKind::Rect | ShapeKind::Ellipse if aligned.is_some() => {
                let a = aligned.unwrap_or_default();
                // /RD: inset from /Rect to the shape's own bounds
                let inner = [llx + a[0], ury - a[3], llx + a[2], ury - a[1]];
                let rd = [inner[0] - rect[0], inner[1] - rect[1], rect[2] - inner[2], rect[3] - inner[3]]
                    .map(|v| v.max(0.0));
                let sub = if s.kind == ShapeKind::Rect { "/Square" } else { "/Circle" };
                (sub, format!("/RD [{}]{interior}", fmt_rect(&rd)))
            }
            ShapeKind::Rect | ShapeKind::Ellipse => ("/Polygon", format!("/Vertices [{}]{interior}", vertices(&s.polygon_vertices()))),
            ShapeKind::Polygon => ("/Polygon", format!("/Vertices [{}]{interior}", vertices(&s.points))),
            ShapeKind::Polyline => ("/PolyLine", format!("/Vertices [{}]", vertices(&s.points))),
            ShapeKind::Line | ShapeKind::Arrow => {
                let (a, e) = (pt(s.points[0]), pt(s.points[1]));
                let end = |on: bool| if on { "/ClosedArrow" } else { "/None" };
                let ic = if s.arrow_start || s.arrow_end { format!(" /IC [{sr:.3} {sg:.3} {sb:.3}]") } else { String::new() };
                (
                    "/Line",
                    format!(
                        "/L [{} {} {} {}] /LE [{} {}]{ic}",
                        num(a[0]), num(a[1]), num(e[0]), num(e[1]), end(s.arrow_start), end(s.arrow_end)
                    ),
                )
            }
        };
        let raw_sid = if s.id.starts_with("shp_") { s.id.clone() } else { format!("shp_{}", s.id) };
        let sid = escape_pdf_string(&raw_sid);
        let nm = escape_pdf_string(&s.id);
        // Opacity lives in the /AP's ExtGState only: a /CA here would multiply
        // it again in every reader that honours /CA (Ghostscript does).
        let annot = self.add(
            format!(
                "<< /Type /Annot /Subtype {subtype} /F 4 /Rect [{}] {geometry} {colour} {border} /T (BezierNotes) /NM ({nm}) /AP << /N {ap} 0 R >> /Inkw_Sid ({sid}) >>",
                fmt_rect(&rect)
            )
            .into_bytes(),
        );
        Some(annot)
    }

    /// Replace the page's `/Annots`, dropping our own from the previous
    /// generation but preserving anyone else's (Acrobat comments, form fields).
    fn rewrite_page(&mut self, page_num: u32, annots: &[u32]) -> Result<()> {
        let dict = self.obj_dict(page_num)?;
        let mut kept: Vec<u32> = Vec::new();
        if let Some(r) = po::dict_get(&self.view, dict, "/Annots") {
            let annot_range = if let Some(ind_num) = po::as_ref_num(&self.view, r) {
                self.index.find(&self.view, ind_num)
            } else {
                Some(r)
            };
            if let Some(ar) = annot_range {
                for n in refs_in_array(&self.view, ar) {
                    let is_ours = self
                        .obj_dict(n)
                        .ok()
                        .map(|d| po::dict_get(&self.view, d, "/Inkw_Sid").is_some())
                        .unwrap_or(false);
                    if !is_ours {
                        kept.push(n);
                    }
                }
            }
        }
        let mut body = b"<< ".to_vec();
        body.extend_from_slice(&po::dict_without(&self.view, dict, &["/Annots"]));
        body.extend_from_slice(b"/Annots [");
        for n in kept.iter().chain(annots.iter()) {
            body.extend_from_slice(format!("{n} 0 R ").as_bytes());
        }
        body.extend_from_slice(b"] >>");
        self.replace(page_num, body);
        Ok(())
    }

    fn rewrite_catalog(&mut self, ef: u32, fs: u32, hash: &[u8], base_hash: &[u8]) -> Result<()> {
        let dict = self.obj_dict(self.root_num)?;

        // 1. Check if existing catalog has /Names and preserve other trees (e.g. /Dests, /JavaScript) and existing EmbeddedFiles
        let names_section = if let Some(names_range) = po::dict_get(&self.view, dict, "/Names") {
            let names_inner = if let Some(ind) = po::as_ref_num(&self.view, names_range) {
                self.obj_dict(ind).ok()
            } else {
                po::dict_inner(&self.view, names_range.0).ok()
            };
            if let Some(inner) = names_inner {
                let mut existing_pairs = Vec::new();
                if let Some(ef_range) = po::dict_get(&self.view, inner, "/EmbeddedFiles") {
                    existing_pairs = extract_embedded_files_names(&self.view, &self.index, ef_range);
                }
                existing_pairs.push(format!("(inkwell.doc) {fs} 0 R"));
                let mut nb = po::dict_without(&self.view, inner, &["/EmbeddedFiles"]);
                nb.extend_from_slice(
                    format!("/EmbeddedFiles << /Names [{}] >>\n", existing_pairs.join(" ")).as_bytes(),
                );
                format!("/Names <<\n{}>>\n", String::from_utf8_lossy(&nb))
            } else {
                format!("/Names << /EmbeddedFiles << /Names [(inkwell.doc) {fs} 0 R] >> >>\n")
            }
        } else {
            format!("/Names << /EmbeddedFiles << /Names [(inkwell.doc) {fs} 0 R] >> >>\n")
        };

        // 2. Check if existing catalog has /AF and preserve other attachments
        let af_section = if let Some(af_range) = po::dict_get(&self.view, dict, "/AF") {
            let af_inner = if let Some(ind) = po::as_ref_num(&self.view, af_range) {
                self.index.find(&self.view, ind)
            } else {
                Some(af_range)
            };
            let mut af_refs = Vec::new();
            if let Some(ar) = af_inner {
                for n in refs_in_array(&self.view, ar) {
                    // Drop earlier generations' sidecar filespecs; keeping them
                    // would pin every old sidecar in the file forever.
                    let ours = self
                        .obj_dict(n)
                        .ok()
                        .and_then(|d| po::dict_get(&self.view, d, "/UF"))
                        .is_some_and(|r| &self.view[r.0..r.1] == b"(inkwell.doc)");
                    if n != fs && !ours {
                        af_refs.push(format!("{n} 0 R"));
                    }
                }
            }
            af_refs.push(format!("{fs} 0 R"));
            format!("/AF [{}]\n", af_refs.join(" "))
        } else {
            format!("/AF [{fs} 0 R]\n")
        };

        let mut body = b"<< ".to_vec();
        body.extend_from_slice(&po::dict_without(
            &self.view,
            dict,
            &["/Names", "/AF", "/Inkw_Doc", "/Inkw_Ver", "/Inkw_Hash", "/Inkw_Base", "/Inkw_BaseHash"],
        ));
        body.extend_from_slice(names_section.as_bytes());
        body.extend_from_slice(af_section.as_bytes());
        body.extend_from_slice(
            format!(
                "/Inkw_Doc {ef} 0 R\n\
                 /Inkw_Ver 1\n\
                 /Inkw_Hash <{}>\n\
                 /Inkw_Base {}\n\
                 /Inkw_BaseHash <{}>\n>>",
                hex(hash),
                self.base_len,
                hex(base_hash)
            )
            .as_bytes(),
        );
        let n = self.root_num;
        self.replace(n, body);
        Ok(())
    }

    /// Serialise the appended generation. The prefix is byte-identical to the
    /// input, always.
    pub fn finish(self) -> Vec<u8> {
        let mut buf = self.view;
        buf.truncate(self.base_len); // drop materialised object-stream copies
        if !buf.ends_with(b"\n") {
            buf.push(b'\n');
        }
        let mut offsets: BTreeMap<u32, usize> = BTreeMap::new();
        for (num, body) in &self.new_objs {
            offsets.insert(*num, buf.len());
            buf.extend_from_slice(format!("{num} 0 obj\n").as_bytes());
            buf.extend_from_slice(body);
            buf.extend_from_slice(b"\nendobj\n");
        }

        let mut trailer = format!("/Root {} 0 R /Prev {}", self.root_num, self.prev_xref).into_bytes();
        if let Some(info) = &self.trailer_info {
            trailer.extend_from_slice(b" /Info ");
            trailer.extend_from_slice(info);
        }
        trailer.extend_from_slice(b" /ID ");
        trailer.extend_from_slice(&update_trailer_id(self.trailer_id.as_deref()));

        let xref_off = buf.len();
        if self.xref_stream {
            // ISO 32000-1 §7.5.8.4: an update to an xref-stream file must use
            // an xref stream; a classic table chained after one is invalid for
            // strict readers. The stream lists itself.
            let xnum = self.next_id;
            offsets.insert(xnum, xref_off);
            let mut index = String::new();
            let mut rows = Vec::with_capacity(offsets.len() * 7);
            for (num, off) in &offsets {
                index.push_str(&format!("{num} 1 "));
                rows.push(1u8);
                rows.extend_from_slice(&(*off as u32).to_be_bytes());
                rows.extend_from_slice(&[0, 0]);
            }
            let mut z = ZlibEncoder::new(Vec::new(), Compression::best());
            z.write_all(&rows).expect("in-memory write");
            let packed = z.finish().expect("in-memory finish");
            buf.extend_from_slice(
                format!(
                    "{xnum} 0 obj\n<< /Type /XRef /Size {} /W [1 4 2] /Index [{}] ",
                    xnum + 1,
                    index.trim_end()
                )
                .as_bytes(),
            );
            buf.extend_from_slice(&trailer);
            buf.extend_from_slice(format!(" /Filter /FlateDecode /Length {} >>\nstream\n", packed.len()).as_bytes());
            buf.extend_from_slice(&packed);
            buf.extend_from_slice(b"\nendstream\nendobj\n");
        } else {
            buf.extend_from_slice(b"xref\n0 1\n0000000000 65535 f \n");
            // one subsection per object: valid, and avoids run-length bookkeeping
            for (num, off) in &offsets {
                buf.extend_from_slice(format!("{num} 1\n{off:010} 00000 n \n").as_bytes());
            }
            buf.extend_from_slice(format!("trailer\n<< /Size {} ", self.next_id).as_bytes());
            buf.extend_from_slice(&trailer);
            buf.extend_from_slice(b" >>\n");
        }
        buf.extend_from_slice(format!("startxref\n{xref_off}\n%%EOF\n").as_bytes());
        buf
    }
}

fn update_trailer_id(orig: Option<&[u8]>) -> Vec<u8> {
    use std::time::SystemTime;
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut h1 = [0u8; 16];
    h1[0..8].copy_from_slice(&(nanos as u64).to_le_bytes());
    h1[8..16].copy_from_slice(&((nanos >> 64) as u64 ^ 0xa5a5_5a5a_3333_cccc_u64).to_be_bytes());
    let id2 = hex(&h1);

    if let Some(id_bytes) = orig {
        let s = String::from_utf8_lossy(id_bytes);
        let trimmed = s.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            let inner = trimmed[1..trimmed.len() - 1].trim();
            if let Some(first_tok) = inner.split_whitespace().next() {
                return format!("[ {} <{}> ]", first_tok, id2).into_bytes();
            }
        }
        id_bytes.to_vec()
    } else {
        let mut h0 = [0u8; 16];
        h0[0..8].copy_from_slice(&(!nanos as u64).to_be_bytes());
        h0[8..16].copy_from_slice(&((nanos >> 64) as u64 ^ 0x5a5a_a5a5_cccc_3333_u64).to_le_bytes());
        format!("[ <{}> <{}> ]", hex(&h0), id2).into_bytes()
    }
}

// ---------------------------------------------------------------------------
// reading the sidecar back
// ---------------------------------------------------------------------------

/// The bytes the next BezierNotes generation should be appended to.
///
/// Every save records `/Inkw_Base` (the length of the bytes it was appended
/// to) and `/Inkw_BaseHash` in the catalog. When the file is still exactly
/// "that base + one BezierNotes generation", appending to the base instead of
/// the whole file replaces our previous generation rather than stacking on
/// it, so the file stays `original + current ink` across any number of
/// sessions instead of growing with each one.
///
/// Anything else (no marker, hash mismatch, or another tool's incremental
/// update after ours) returns the whole file: never discard someone else's
/// revision to save bytes.
pub fn writable_base(bytes: &[u8]) -> &[u8] {
    rebase_len(bytes).map_or(bytes, |n| &bytes[..n])
}

/// SHA-256 of the file's original bytes (`writable_base`): what base page ids
/// are derived from (`Document::assign_base_page_ids`), so every device that
/// opens the same file, saved by us or not, gives its pages the same ids.
pub fn base_fingerprint(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(writable_base(bytes)).into()
}

fn rebase_len(bytes: &[u8]) -> Option<usize> {
    ::memchr::memmem::find(bytes, b"/Inkw_Base ")?;
    let mut view = bytes.to_vec();
    let index = ObjIndex::build(&mut view).ok()?;
    let d = &view[..];
    let (bs, _) = index.find(d, index.trailer.root?)?;
    let cat = po::dict_inner(d, bs).ok()?;
    let len = usize::try_from(po::as_int(d, po::dict_get(d, cat, "/Inkw_Base")?)?).ok()?;
    let want = po::dict_get(d, cat, "/Inkw_BaseHash")
        .map(|r| String::from_utf8_lossy(&d[r.0..r.1]).trim().trim_matches(['<', '>']).to_ascii_lowercase())?;
    if len == 0 || len >= bytes.len() {
        return None;
    }
    let base = &bytes[..len];
    if hex(&Sha256::digest(base)) != want {
        return None;
    }
    // Exactly one generation after the base, and it is ours: the newest
    // section starts past the base and chains straight back to the base's
    // own newest section. A later foreign update would chain to ours instead.
    let base_xref = po::last_startxref(base).ok()?;
    (index.last_xref >= len && index.last_prev == Some(base_xref)).then_some(len)
}

/// Extract and verify the embedded editable data.
pub enum SidecarStatus {
    /// Full-fidelity data recovered.
    Ok(Document),
    /// No Inkwell data in this file (a plain PDF, or one saved by another app
    /// that dropped the embedded file). Fall back to `/InkList` reconstruction.
    Absent,
    /// Present but unusable. Never a hard failure: warn and fall back.
    Corrupt(String),
    /// Present and parsed, but the visual layer has since been changed by
    /// another application, so the two layers disagree.
    Stale(Document),
}

pub fn read_sidecar(bytes: &[u8]) -> Result<SidecarStatus> {
    let d = bytes;
    // Fast path for the overwhelming majority of PDFs: a clean document has no
    // Inkwell catalog key, so skip the trailer/object walk entirely. This keeps
    // first-open responsive on multi-megabyte files.
    if ::memchr::memmem::find(d, b"/Inkw_Doc").is_none() {
        return Ok(SidecarStatus::Absent);
    }
    let mut view = d.to_vec();
    let index = ObjIndex::build(&mut view)?;
    let d = &view[..];
    let root = index.trailer.root.ok_or(Error::NoRoot)?;
    let (bs, _) = index.find(d, root).ok_or(Error::MissingObject(root))?;
    let cat = po::dict_inner(d, bs)?;

    let ef = match po::dict_get(d, cat, "/Inkw_Doc").and_then(|r| po::as_ref_num(d, r)) {
        Some(n) => n,
        None => return Ok(SidecarStatus::Absent),
    };
    let raw = match read_stream_in(d, &index, ef) {
        Ok(v) => v,
        Err(e) => return Ok(SidecarStatus::Corrupt(e.to_string())),
    };
    let declared = po::dict_get(d, cat, "/Inkw_Hash").map(|r| {
        String::from_utf8_lossy(&d[r.0..r.1]).trim().trim_matches(['<', '>']).to_ascii_lowercase()
    });
    let actual = hex(&Sha256::digest(&raw));

    match doc::decode_sidecar(&raw) {
        Ok(doc) => {
            if declared.as_deref().is_some_and(|h| h != actual) {
                Ok(SidecarStatus::Stale(doc))
            } else {
                Ok(SidecarStatus::Ok(doc))
            }
        }
        Err(e) => Ok(SidecarStatus::Corrupt(e.to_string())),
    }
}

/// Decode one stream object's data, honouring `/Filter /FlateDecode`.
pub fn read_stream(d: &[u8], num: u32) -> Result<Vec<u8>> {
    let mut view = d.to_vec();
    let index = ObjIndex::build(&mut view)?;
    read_stream_in(&view, &index, num)
}

fn read_stream_in(d: &[u8], index: &ObjIndex, num: u32) -> Result<Vec<u8>> {
    let (bs, be) = index.find(d, num).ok_or(Error::MissingObject(num))?;
    let dict = po::dict_inner(d, bs)?;
    let sk = po::find(&d[bs..be], b"stream", 0)
        .map(|p| bs + p)
        .ok_or(Error::Malformed("object is not a stream"))?;
    let mut ds = sk + 6;
    if d.get(ds) == Some(&b'\r') {
        ds += 1;
    }
    if d.get(ds) == Some(&b'\n') {
        ds += 1;
    }
    let len = po::dict_get(d, dict, "/Length")
        .and_then(|r| {
            if let Some(n) = po::as_int(d, r) {
                Some(n)
            } else if let Some(ind) = po::as_ref_num(d, r) {
                let (ind_bs, ind_be) = index.find(d, ind)?;
                po::as_int(d, (ind_bs, ind_be))
            } else {
                None
            }
        })
        .ok_or(Error::Malformed("stream has no /Length"))? as usize;
    let de = (ds + len).min(d.len());
    let raw = &d[ds..de];

    let flate = po::dict_get(d, dict, "/Filter")
        .map(|r| po::find(&d[r.0..r.1], b"FlateDecode", 0).is_some())
        .unwrap_or(false);
    if !flate {
        return Ok(raw.to_vec());
    }
    let mut out = Vec::new();
    let mut dec = flate2::write::ZlibDecoder::new(&mut out);
    dec.write_all(raw).map_err(Error::Io)?;
    dec.finish().map_err(Error::Io)?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// crash recovery
// ---------------------------------------------------------------------------

/// Truncate a torn file back to its last complete generation.
///
/// This is the entire recovery routine, and it works because incremental
/// updates only ever append: every `%%EOF` in the file marks a point at which
/// the document was fully valid on disk.
pub fn recover_truncated(data: &[u8]) -> Option<&[u8]> {
    let p = po::rfind(data, b"%%EOF")?;
    let mut j = p + 5;
    while j < data.len() && (data[j] == b'\r' || data[j] == b'\n') {
        j += 1;
    }
    Some(&data[..j])
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn fmt_coord(v: f64) -> String {
    let rounded = (v * 100.0).round() / 100.0;
    if (rounded - rounded.round()).abs() < 1e-4 {
        format!("{}", rounded.round() as i64)
    } else {
        let s = format!("{:.2}", rounded);
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn fmt_rect(b: &[f64; 4]) -> String {
    format!("{} {} {} {}", fmt_coord(b[0]), fmt_coord(b[1]), fmt_coord(b[2]), fmt_coord(b[3]))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Collect `N 0 R` object numbers appearing in an array value range.
fn refs_in_array(d: &[u8], range: (usize, usize)) -> Vec<u32> {
    let s = String::from_utf8_lossy(&d[range.0..range.1]);
    let toks: Vec<&str> = s
        .trim_matches(|c| c == '[' || c == ']')
        .split_whitespace()
        .collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 2 < toks.len() + 1 {
        if i + 2 < toks.len() + 1 && toks.get(i + 2) == Some(&"R") {
            if let Ok(n) = toks[i].parse::<u32>() {
                out.push(n);
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    out
}

fn extract_embedded_files_names(d: &[u8], index: &ObjIndex, ef_range: (usize, usize)) -> Vec<String> {
    let ef_inner = if let Some(ind) = po::as_ref_num(d, ef_range) {
        if let Some(obj) = index.find(d, ind) {
            po::dict_inner(d, obj.0).ok()
        } else {
            None
        }
    } else {
        po::dict_inner(d, ef_range.0).ok()
    };
    let mut pairs = Vec::new();
    if let Some(inner) = ef_inner {
        if let Some(names_arr_range) = po::dict_get(d, inner, "/Names") {
            let arr_range = if let Some(ind) = po::as_ref_num(d, names_arr_range) {
                if let Some(obj) = index.find(d, ind) {
                    obj
                } else {
                    names_arr_range
                }
            } else {
                names_arr_range
            };
            let slice = &d[arr_range.0..arr_range.1];
            let open_idx = slice.iter().position(|&b| b == b'[');
            let close_idx = slice.iter().rposition(|&b| b == b']');
            if let (Some(open), Some(close)) = (open_idx, close_idx) {
                let start = arr_range.0 + open + 1;
                let end = arr_range.0 + close;
                let mut cur = start;
                while cur < end {
                    cur = po::skip_ws(d, cur);
                    if cur >= end {
                        break;
                    }
                    let key_start = cur;
                    let key_end = po::skip_value(d, cur);
                    if key_end <= key_start || key_end > end {
                        break;
                    }
                    cur = po::skip_ws(d, key_end);
                    if cur >= end {
                        break;
                    }
                    let val_start = cur;
                    let val_end = po::skip_value(d, cur);
                    if val_end <= val_start || val_end > end {
                        break;
                    }
                    let key_bytes = &d[key_start..key_end];
                    let is_inkwell = key_bytes == b"(inkwell.doc)"
                        || key_bytes.eq_ignore_ascii_case(b"<696e6b77656c6c2e646f63>");
                    if !is_inkwell {
                        let pair_str = format!(
                            "{} {}",
                            String::from_utf8_lossy(key_bytes),
                            String::from_utf8_lossy(&d[val_start..val_end])
                        );
                        pairs.push(pair_str);
                    }
                    cur = val_end;
                }
            }
        }
    }
    pairs
}

fn parse_hex_color_rgb(hex: &str) -> (f64, f64, f64) {
    let clean = hex.trim().trim_start_matches('#');
    if clean.len() == 6 {
        let r = u8::from_str_radix(&clean[0..2], 16).unwrap_or(20);
        let g = u8::from_str_radix(&clean[2..4], 16).unwrap_or(23);
        let b = u8::from_str_radix(&clean[4..6], 16).unwrap_or(36);
        (r as f64 / 255.0, g as f64 / 255.0, b as f64 / 255.0)
    } else {
        (0.08, 0.09, 0.14)
    }
}

/// A PDF text string (§7.9.2.2) that keeps every character, newlines
/// included: a literal for ASCII, UTF-16BE with BOM otherwise.
fn pdf_text_string(s: &str) -> String {
    if s.is_ascii() {
        let mut out = String::from("(");
        for c in s.chars() {
            match c {
                '(' | ')' | '\\' => {
                    out.push('\\');
                    out.push(c);
                }
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                _ => out.push(c),
            }
        }
        out.push(')');
        out
    } else {
        let mut hex_str = String::from("<FEFF");
        for u in s.encode_utf16() {
            let _ = std::fmt::Write::write_fmt(&mut hex_str, format_args!("{u:04X}"));
        }
        hex_str.push('>');
        hex_str
    }
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn escape_pdf_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '(' => out.push_str("\\("),
            ')' => out.push_str("\\)"),
            '\\' => out.push_str("\\\\"),
            '\r' => {},
            '\n' => out.push(' '),
            _ => out.push(c),
        }
    }
    out
}
