# Plan 089: Unicode-Correct Text Annotations with Shaped Vector Appearances

| Field | Value |
|---|---|
| **Priority** | P0 |
| **Effort** | M (~450 lines + bundled font subset) |
| **Category** | File-Format Integrity / Internationalisation |
| **Depends on** | 087 |
| **Status** | DONE (2026-11-06; see Outcome) |

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

## Outcome (2026-11-06)

**Fonts (deviation from the plan, on purpose).** The notes use the app's own **Inter** (variable, subset, `wght` + `opsz` axes kept) for Latin, Greek and Cyrillic, plus **Noto Sans Bengali** Regular/Bold, instead of Noto Sans. That keeps notes looking exactly as they already did in the app. Inter must stay variable: Chrome sets `opsz` = font size (`font-optical-sizing: auto`), and static `opsz 14` instances made 18 pt lines visibly wider than the canvas. The fonts are generated by `tools/gen_note_fonts.sh` into `inkwell-core/fonts/` (1.36 MB, under the 1.5 MB budget), with the Bengali WOFF2s also in `inkwell-app/src/fonts/`. OFL texts sit beside the fonts (`licenses/` is gitignored PDFium output) and are noted in `LICENSE`.

**Writer.** New `inkwell-core/src/text_shape.rs`:
- Picks a font per character the way Chrome does: Inter whenever it has the glyph, otherwise Bengali; ZWJ/ZWNJ and the dotted circle join their neighbours.
- Shapes each run with rustybuzz.
- Turns outlines into `m/l/c/h` ops: quadratics become exact cubics, and Bengali "italic" gets a 0.25 shear.

`emit_text_annot` now:
- writes a Flate-compressed form with no font resources (`/Resources << >>`);
- pads the `/BBox`/`/Rect` (0.15 em horizontal, 0.4 em vertical) so accents and vowel signs aren't clipped;
- widens the box to the shaped line width, since the canvas never wraps;
- writes `/Contents` as a lossless PDF text string (ASCII newlines used to be turned into spaces) and adds `/RC` rich text.

Layout mirrors the canvas: explicit newlines only, 1.35 line height, and the first baseline at `ascent/(ascent+descent)` = 0.8006 em, measured in Chromium for `textBaseline = 'top'`.

**App.** `js/core/note-font.js` is the single note font stack (`Inter, "Noto Sans Bengali", …`), used by the compositor, the lasso preview and note measurement. The inline editor CSS uses the same stack. `@font-face` rules were added for the Bengali faces, and they are preloaded at startup with a repaint when they arrive.

**Verification.**
- `tests/text_shape.rs` (7 tests): line widths match Chromium's canvas within 0.5% for 7 Latin, bold, italic, Bangla and mixed strings (Chrome shapes with HarfBuzz, so this also checks rustybuzz). Also covers the baseline ratio, the ক্ষ conjunct as one glyph, কি reordering, script runs, `/Contents` round-trip incl. newlines, no Type1 fonts, and the box fitting the text.
- A pixel overlay of the Ghostscript render against the Chromium canvas for 5 notes (Bangla conjuncts, accents, bold/italic, mixed, two lines) is identical apart from anti-aliasing.
- `render_diff` now includes a bold Bangla+Latin note, with PDFium vs Ghostscript agreement 0.996–1.000.
- Goldens regenerated: text appearances are now paths.
- Smoke T29 (4 checks): the Bengali fonts load in the webview, the canvas Bangla width is 205.171 pt (the same value the Rust test pins), and the editor uses the stack.
- Rust 118/118, strict conformance, clippy clean on both workspaces, smoke 154/154.

**Not done / limits.**
- Scripts beyond Latin/Greek/Cyrillic/Bengali (Arabic, CJK, Devanagari, emoji) draw Inter's `.notdef` box in the PDF; the canvas falls back to system fonts. Add faces to `gen_note_fonts.sh` when needed.
- No automatic line wrapping, on purpose, to match the canvas.
- `inkwell-pdf/src/text_embed.rs` (dead PDFium text path) is left for Plan 093's dead-code pass.
- Not checked in the running desktop app; the smoke suite drives the same frontend in Chromium.
