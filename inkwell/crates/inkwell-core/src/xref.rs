//! Cross-reference resolution: classic tables, xref streams, object streams.
//!
//! `ObjIndex::build` walks the `/Prev` chain from the final `startxref`,
//! newest section first, and records where every live object's body starts.
//! It understands classic `xref` tables, hybrid files (`/XRefStm`), and
//! `/Type /XRef` streams (ISO 32000-1 §7.5.8), including PNG predictors.
//!
//! Objects stored compressed inside `/Type /ObjStm` streams are *materialised*:
//! decoded once and appended to the caller's buffer as ordinary
//! `N 0 obj ... endobj` text past the end of the real file. Every byte-range
//! helper in `pdfobj` then works on them unchanged, and the writer truncates
//! the buffer back to the original length before appending its generation,
//! so materialised bytes never reach disk.

use std::collections::{HashMap, HashSet};
use std::io::Write;

use crate::pdfobj::{self as po, Error, Result};

/// The merged trailer of the newest revision. Keys missing from the newest
/// section are inherited from older ones (linearized files keep `/Root` in
/// the first-page trailer only).
#[derive(Debug, Clone, Default)]
pub struct Trailer {
    pub root: Option<u32>,
    pub size: u32,
    pub id: Option<Vec<u8>>,
    pub info: Option<Vec<u8>>,
    pub encrypt: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Copy)]
enum Entry {
    Free,
    /// Byte offset of `N G obj` in the file.
    At(usize),
    /// Compressed: (object stream number, index within it).
    InStream(u32, u32),
}

#[derive(Debug)]
pub struct ObjIndex {
    /// Object number -> byte offset of its body (just past `obj`).
    bodies: HashMap<u32, usize>,
    pub trailer: Trailer,
    /// Offset of the newest xref section (the final `startxref` value).
    pub last_xref: usize,
    /// Whether the newest section is an xref stream. An incremental update
    /// on top of one must itself be an xref stream.
    pub last_is_stream: bool,
    /// `/Prev` of the newest section.
    pub last_prev: Option<usize>,
    /// Highest object number referenced by any section.
    pub max_obj: u32,
}

impl ObjIndex {
    /// Index `buf` (the whole file). Objects from object streams are appended
    /// to `buf`; callers that write must remember the original length.
    pub fn build(buf: &mut Vec<u8>) -> Result<Self> {
        let file_len = buf.len();
        let last_xref = po::last_startxref(buf)?;
        if last_xref >= file_len {
            return Err(Error::Malformed("startxref past end of file"));
        }

        let mut entries: HashMap<u32, Entry> = HashMap::new();
        let mut trailer = Trailer::default();
        let mut visited = HashSet::new();
        let mut queue = vec![last_xref];
        let mut last_is_stream = false;
        let mut last_prev = None;
        let mut first = true;
        let mut max_obj = 0u32;

        while let Some(off) = queue.pop() {
            if !visited.insert(off) || visited.len() > 4096 {
                continue;
            }
            let at = po::skip_ws(buf, off);
            let section = if buf.get(at..at + 4) == Some(b"xref") {
                read_table(buf, at, &mut entries, &mut max_obj)?
            } else {
                read_stream_section(buf, at, &mut entries, &mut max_obj)?
            };
            merge_trailer(buf, section.dict, &mut trailer);
            if first {
                last_is_stream = section.is_stream;
                last_prev = section.prev;
                first = false;
            }
            // Hybrid files: the table's /XRefStm is consulted before /Prev, and
            // entries already set by the table win (insert-if-absent).
            if let Some(p) = section.prev {
                queue.push(p);
            }
            if let Some(x) = section.xref_stm {
                queue.push(x);
            }
        }

        if trailer.root.is_none() {
            return Err(Error::NoRoot);
        }
        if trailer.size == 0 {
            return Err(Error::NoSize);
        }

        let mut bodies = HashMap::new();
        let mut packed: HashMap<u32, Vec<(u32, u32)>> = HashMap::new();
        for (&num, &e) in &entries {
            match e {
                Entry::Free => {}
                Entry::At(o) => {
                    if let Some(b) = body_at(buf, o, num) {
                        bodies.insert(num, b);
                    }
                }
                Entry::InStream(stm, idx) => packed.entry(stm).or_default().push((num, idx)),
            }
        }

        // Materialise object streams after the real file.
        let mut stms: Vec<_> = packed.into_iter().collect();
        stms.sort_by_key(|(s, _)| *s);
        for (stm, members) in stms {
            let Some(&stm_body) = bodies.get(&stm) else {
                return Err(Error::MissingObject(stm));
            };
            let data = decode_stream_at(buf, stm_body, &bodies)?;
            let dict = po::dict_inner(buf, stm_body)?;
            let n = po::dict_get(buf, dict, "/N").and_then(|r| po::as_int(buf, r)).unwrap_or(0) as usize;
            let first_off = po::dict_get(buf, dict, "/First")
                .and_then(|r| po::as_int(buf, r))
                .ok_or(Error::Malformed("object stream has no /First"))? as usize;
            let header = ints(&data[..first_off.min(data.len())]);
            let pairs: Vec<(u32, usize)> =
                header.as_chunks::<2>().0.iter().take(n).map(|c| (c[0] as u32, c[1] as usize)).collect();
            for (num, idx) in members {
                let Some(&(onum, rel)) = pairs.get(idx as usize) else { continue };
                if onum != num {
                    continue;
                }
                let start = first_off + rel;
                let end = pairs
                    .get(idx as usize + 1)
                    .map(|(_, r)| first_off + r)
                    .unwrap_or(data.len())
                    .min(data.len());
                if start >= end {
                    continue;
                }
                buf.extend_from_slice(format!("\n{num} 0 obj\n").as_bytes());
                bodies.insert(num, buf.len());
                buf.extend_from_slice(&data[start..end]);
                buf.extend_from_slice(b"\nendobj\n");
            }
        }

        Ok(Self { bodies, trailer, last_xref, last_is_stream, last_prev, max_obj })
    }

    /// `(body_start, body_end)` of object `num`: the same contract as
    /// `pdfobj::find_object`, which remains the fallback for files whose
    /// xref offsets are wrong (readers tolerate that, so we do too).
    pub fn find(&self, d: &[u8], num: u32) -> Option<(usize, usize)> {
        match self.bodies.get(&num) {
            Some(&bs) => {
                let be = po::find(d, b"endobj", bs).unwrap_or(d.len());
                Some((bs, be))
            }
            None => po::find_object(d, num),
        }
    }
}

struct Section {
    dict: (usize, usize),
    prev: Option<usize>,
    xref_stm: Option<usize>,
    is_stream: bool,
}

fn opt_usize(d: &[u8], dict: (usize, usize), key: &str) -> Option<usize> {
    po::dict_get(d, dict, key).and_then(|r| po::as_int(d, r)).and_then(|v| usize::try_from(v).ok())
}

fn merge_trailer(d: &[u8], dict: (usize, usize), t: &mut Trailer) {
    let raw = |k: &str| po::dict_get(d, dict, k).map(|r| d[r.0..r.1].to_vec());
    if t.root.is_none() {
        t.root = po::dict_get(d, dict, "/Root").and_then(|r| po::as_ref_num(d, r));
    }
    if let Some(s) = po::dict_get(d, dict, "/Size").and_then(|r| po::as_int(d, r)) {
        t.size = t.size.max(s.clamp(0, u32::MAX as i64) as u32);
    }
    if t.id.is_none() {
        t.id = raw("/ID");
    }
    if t.info.is_none() {
        t.info = raw("/Info");
    }
    if t.encrypt.is_none() {
        t.encrypt = raw("/Encrypt");
    }
}

/// Classic `xref` table at `at`, followed by `trailer << ... >>`.
fn read_table(d: &[u8], at: usize, entries: &mut HashMap<u32, Entry>, max_obj: &mut u32) -> Result<Section> {
    let mut i = at + 4;
    loop {
        i = po::skip_ws(d, i);
        if d.get(i..i + 7) == Some(b"trailer") {
            break;
        }
        let (start, ni) = int_at(d, i).ok_or(Error::Malformed("xref subsection header"))?;
        let (count, ni) = int_at(d, po::skip_ws(d, ni)).ok_or(Error::Malformed("xref subsection count"))?;
        i = ni;
        for k in 0..count {
            i = po::skip_ws(d, i);
            let (off, ni) = int_at(d, i).ok_or(Error::Malformed("xref entry offset"))?;
            let (_gen, ni) = int_at(d, po::skip_ws(d, ni)).ok_or(Error::Malformed("xref entry generation"))?;
            let ti = po::skip_ws(d, ni);
            let kind = *d.get(ti).ok_or(Error::Malformed("xref entry type"))?;
            i = ti + 1;
            let num = u32::try_from(start + k).map_err(|_| Error::Malformed("object number overflow"))?;
            *max_obj = (*max_obj).max(num);
            let e = match kind {
                b'n' => Entry::At(off as usize),
                b'f' => Entry::Free,
                _ => return Err(Error::Malformed("xref entry type")),
            };
            entries.entry(num).or_insert(e);
        }
    }
    let dict = po::dict_inner(d, i + 7)?;
    Ok(Section {
        dict,
        prev: opt_usize(d, dict, "/Prev"),
        xref_stm: opt_usize(d, dict, "/XRefStm"),
        is_stream: false,
    })
}

/// `/Type /XRef` stream object at `at`.
fn read_stream_section(
    d: &[u8],
    at: usize,
    entries: &mut HashMap<u32, Entry>,
    max_obj: &mut u32,
) -> Result<Section> {
    let body = obj_body(d, at).ok_or(Error::Malformed("startxref points at neither a table nor an object"))?;
    let dict = po::dict_inner(d, body)?;
    let ty = po::dict_get(d, dict, "/Type").map(|r| &d[r.0..r.1]);
    if ty != Some(b"/XRef") {
        return Err(Error::Malformed("startxref object is not /Type /XRef"));
    }
    let w: Vec<usize> = po::dict_get(d, dict, "/W")
        .map(|r| ints(&d[r.0..r.1]).into_iter().map(|v| v as usize).collect())
        .unwrap_or_default();
    if w.len() != 3 || w.iter().any(|&x| x > 8) {
        return Err(Error::Malformed("xref stream /W"));
    }
    let size = po::dict_get(d, dict, "/Size").and_then(|r| po::as_int(d, r)).unwrap_or(0) as u64;
    let index: Vec<u64> = po::dict_get(d, dict, "/Index")
        .map(|r| ints(&d[r.0..r.1]))
        .unwrap_or_else(|| vec![0, size]);
    // Xref stream dictionaries hold their entries directly (no indirect /Length).
    let data = decode_stream_at(d, body, &HashMap::new())?;

    let row = w.iter().sum::<usize>();
    if row == 0 {
        return Err(Error::Malformed("xref stream /W is all zero"));
    }
    let field = |rowbytes: &[u8], k: usize| -> u64 {
        let s: usize = w[..k].iter().sum();
        rowbytes[s..s + w[k]].iter().fold(0u64, |a, &b| (a << 8) | b as u64)
    };
    let mut r = 0usize;
    for pair in index.as_chunks::<2>().0 {
        for k in 0..pair[1] {
            let Some(rowbytes) = data.get(r * row..(r + 1) * row) else {
                return Err(Error::Malformed("xref stream shorter than /Index"));
            };
            r += 1;
            let num = u32::try_from(pair[0] + k).map_err(|_| Error::Malformed("object number overflow"))?;
            *max_obj = (*max_obj).max(num);
            // Type defaults to 1 when its field width is zero.
            let ty = if w[0] == 0 { 1 } else { field(rowbytes, 0) };
            let e = match ty {
                0 => Entry::Free,
                1 => Entry::At(field(rowbytes, 1) as usize),
                2 => Entry::InStream(field(rowbytes, 1) as u32, field(rowbytes, 2) as u32),
                _ => continue, // reserved types are ignored, per spec
            };
            entries.entry(num).or_insert(e);
        }
    }
    Ok(Section { dict, prev: opt_usize(d, dict, "/Prev"), xref_stm: None, is_stream: true })
}

/// Position just past `N G obj` at `at`, or `None` if `at` isn't an object.
fn obj_body(d: &[u8], at: usize) -> Option<usize> {
    let (_, i) = int_at(d, at)?;
    let (_, i) = int_at(d, po::skip_ws(d, i))?;
    let i = po::skip_ws(d, i);
    (d.get(i..i + 3) == Some(b"obj")).then(|| po::skip_ws(d, i + 3))
}

/// Body start of object `num` at offset `o`, verifying the header matches.
fn body_at(d: &[u8], o: usize, num: u32) -> Option<usize> {
    let at = po::skip_ws(d, o);
    let (n, _) = int_at(d, at)?;
    (n == num as u64).then(|| obj_body(d, at)).flatten()
}

fn int_at(d: &[u8], i: usize) -> Option<(u64, usize)> {
    let mut j = i;
    while j < d.len() && d[j].is_ascii_digit() {
        j += 1;
    }
    if j == i {
        return None;
    }
    std::str::from_utf8(&d[i..j]).ok()?.parse().ok().map(|v| (v, j))
}

/// All unsigned integers in a byte range (arrays, ObjStm headers).
fn ints(b: &[u8]) -> Vec<u64> {
    b.split(|c| !c.is_ascii_digit()).filter(|t| !t.is_empty()).filter_map(|t| std::str::from_utf8(t).ok()?.parse().ok()).collect()
}

/// Decode the stream whose object body starts at `body`: FlateDecode (or no
/// filter) with optional PNG/TIFF predictors. `bodies` resolves an indirect
/// `/Length`; without it we fall back to the `endstream` keyword.
fn decode_stream_at(d: &[u8], body: usize, bodies: &HashMap<u32, usize>) -> Result<Vec<u8>> {
    let dict = po::dict_inner(d, body)?;
    let after = po::skip_value(d, body);
    let sk = po::skip_ws(d, after);
    if d.get(sk..sk + 6) != Some(b"stream") {
        return Err(Error::Malformed("object is not a stream"));
    }
    let mut ds = sk + 6;
    if d.get(ds) == Some(&b'\r') {
        ds += 1;
    }
    if d.get(ds) == Some(&b'\n') {
        ds += 1;
    }
    let len = po::dict_get(d, dict, "/Length").and_then(|r| {
        po::as_int(d, r).map(|v| v as usize).or_else(|| {
            let n = po::as_ref_num(d, r)?;
            let b = *bodies.get(&n)?;
            let e = po::skip_value(d, b);
            po::as_int(d, (b, e)).map(|v| v as usize)
        })
    });
    let de = match len {
        Some(l) if ds + l <= d.len() => ds + l,
        _ => po::find(d, b"endstream", ds).ok_or(Error::Malformed("unterminated stream"))?,
    };
    let raw = &d[ds..de];

    // Only no filter or a single /FlateDecode (bare or in a one-element array).
    let filter = po::dict_get(d, dict, "/Filter").map(|r| &d[r.0..r.1]).unwrap_or(b"");
    let names = filter.iter().filter(|&&c| c == b'/').count();
    let flate = names == 1 && po::find(filter, b"/FlateDecode", 0).is_some();
    if names > 0 && !flate {
        return Err(Error::Malformed("unsupported stream filter for xref/object stream"));
    }
    let data = if flate {
        let mut out = Vec::new();
        let mut dec = flate2::write::ZlibDecoder::new(&mut out);
        dec.write_all(raw).map_err(Error::Io)?;
        dec.finish().map_err(Error::Io)?;
        out
    } else {
        raw.to_vec()
    };

    let parms = po::dict_get(d, dict, "/DecodeParms");
    let (predictor, columns) = match parms {
        Some(r) => {
            let inner = if d[r.0] == b'[' { po::skip_ws(d, r.0 + 1) } else { r.0 };
            match po::dict_inner(d, inner) {
                Ok(pd) => (
                    po::dict_get(d, pd, "/Predictor").and_then(|x| po::as_int(d, x)).unwrap_or(1),
                    po::dict_get(d, pd, "/Columns").and_then(|x| po::as_int(d, x)).unwrap_or(1) as usize,
                ),
                Err(_) => (1, 1),
            }
        }
        None => (1, 1),
    };
    match predictor {
        1 => Ok(data),
        10..=15 => unpredict_png(&data, columns),
        _ => Err(Error::Malformed("unsupported predictor")),
    }
}

/// Undo PNG row filters (one filter-type byte per row). Xref streams use
/// 1 byte per "pixel", so `bpp = 1`.
fn unpredict_png(data: &[u8], columns: usize) -> Result<Vec<u8>> {
    let stride = columns + 1;
    let mut out = Vec::with_capacity(data.len() / stride * columns);
    let mut prev = vec![0u8; columns];
    for row in data.chunks(stride) {
        if row.len() < stride {
            break;
        }
        let (ft, src) = (row[0], &row[1..]);
        let mut cur = vec![0u8; columns];
        for i in 0..columns {
            let a = if i > 0 { cur[i - 1] } else { 0 };
            let b = prev[i];
            let c = if i > 0 { prev[i - 1] } else { 0 };
            cur[i] = match ft {
                0 => src[i],
                1 => src[i].wrapping_add(a),
                2 => src[i].wrapping_add(b),
                3 => src[i].wrapping_add(((a as u16 + b as u16) / 2) as u8),
                4 => {
                    let p = a as i16 + b as i16 - c as i16;
                    let (pa, pb, pc) = ((p - a as i16).abs(), (p - b as i16).abs(), (p - c as i16).abs());
                    let pred = if pa <= pb && pa <= pc { a } else if pb <= pc { b } else { c };
                    src[i].wrapping_add(pred)
                }
                _ => return Err(Error::Malformed("bad PNG predictor row type")),
            };
        }
        out.extend_from_slice(&cur);
        prev = cur;
    }
    Ok(out)
}
