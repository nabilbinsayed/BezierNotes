# Plan 089: Unicode-Correct Text Annotations with Shaped Vector Appearances

| Field | Value |
|---|---|
| **Priority** | P0 |
| **Effort** | M (~450 lines + bundled font subset) |
| **Category** | File-Format Integrity / Internationalisation |
| **Depends on** | 087 |
| **Status** | TODO |

## Why

Typed text notes render correctly **only for plain ASCII** in any reader other than BezierNotes. The appearance stream uses the standard Type1 Helvetica fonts (WinAnsi single-byte encoding) but writes the note's raw **UTF-8 bytes** into a `Tj` string. As a result:
- Bangla, Arabic, CJK, Cyrillic and emoji show as mojibake or nothing in Acrobat, Chrome, Edge and Apple Books;
- even Latin accents (`é` = UTF-8 `C3 A9`) render as two wrong glyphs.

`/Contents` is correctly UTF-16BE, so the *data* is fine. The visual layer (Layer 1/2) breaks the "opens identically everywhere" contract. The primary user annotates Bangla course material (`Higher_Math_Bangla_chapter_3.pdf` is in the repo root), so this is a daily-use defect, not an edge case.

## Evidence

- `inkwell/crates/inkwell-core/src/pdf.rs:626-629`: font resources are `/Type1 /BaseFont /Helvetica*` only.
- `pdf.rs:631-636`: each line is `escape_pdf_string(line)` → `(…) Tj`, i.e. UTF-8 bytes in a single-byte font.
- `pdf.rs:649-658`: `/Contents` is UTF-16BE hex for non-ASCII, which confirms the inconsistency.

## Design

Render the appearance as **vector glyph outlines**, not as font text. This matches how ink is already written (filled paths, Non-Negotiable #1), needs no font embedding, CIDFont, `ToUnicode` or `/DA` font-availability games, and is pixel-identical in every reader. Searchability and copy are preserved through `/Contents` (and `/RC` rich text), which is what readers index for FreeText annotations.

1. Add `rustybuzz` (shaping, pure Rust) and `ttf-parser` to `inkwell-core`.
2. Bundle a subset font set under `inkwell/crates/inkwell-core/fonts/`: Noto Sans (Latin/Greek/Cyrillic) Regular/Bold/Italic/BoldItalic and Noto Sans Bengali Regular/Bold, all OFL. Use `include_bytes!` behind a `bundled-fonts` default feature. Keep the total < 1.5 MB; subset with `pyftsubset` in a documented script.
3. Font fallback per run: segment the string by script (`unicode-script` crate), pick the first bundled face with coverage, shape with rustybuzz (correct Bangla conjuncts, reordering and matras), and convert glyph outlines via `ttf_parser::OutlineBuilder` into `m/l/c/h` path ops scaled to `font_size`. Fill with the note colour.
4. Line breaking: wrap on UAX #14 opportunities (`unicode-linebreak`) at the annotation width the frontend already sends; keep the existing explicit-newline behaviour.
5. Bold/italic: use the real bold/italic faces when present; synthesise oblique via a shear matrix only as a fallback (Bengali has no italic).
6. Frontend parity: the in-app canvas uses the same faces. Load the bundled fonts via `@font-face` from `src/assets/fonts/` so what you type is what other readers show. Today the canvas uses system fonts, which can differ.
7. Keep `/Contents` UTF-16BE; add `/RC` with the XHTML rich-text equivalent for readers that re-render FreeText from rich text.

## Scope

### Files to Modify / Create
- `inkwell/crates/inkwell-core/src/pdf.rs`: `emit_text_annot` builds path-based appearances.
- `inkwell/crates/inkwell-core/src/text_shape.rs` (new): segmentation, fallback, shaping, outline → `PathCmd`.
- `inkwell/crates/inkwell-core/Cargo.toml`: deps + `bundled-fonts` feature.
- `inkwell-app/src/assets/fonts/*`, `inkwell-app/src/styles.css`: `@font-face` for the same faces.
- `inkwell-app/src/js/tools/text.js`: use the bundled family stack.
- `licenses/`: add the OFL text for Noto.

### Files NOT to Touch
- `inkwell/crates/inkwell-pdf/src/text_embed.rs` (PDFium-based path). Delete it in this plan only if it is dead code; check `grep -rn text_embed` first.

## Verification

- Golden test (Plan 087): `"Hello"`, `"café"`, `"বাংলা গণিত"` (conjuncts), `"مرحبا"`, mixed-script line. Snapshot the path ops.
- Render diff (Plan 087): PDFium vs MuPDF on the Bangla note must agree within threshold. Also visually compare against the in-app canvas screenshot in the smoke test.
- Smoke: add a check that typing Bangla into a note and saving produces an annotation whose `/Contents` decodes to the same string.

## STOP Conditions
- STOP if bundled fonts push the release binary over +3 MB. Re-subset first.
- STOP if rustybuzz output for Bangla differs from HarfBuzz (`hb-shape`) on the test strings. Shaping correctness is the whole point.
