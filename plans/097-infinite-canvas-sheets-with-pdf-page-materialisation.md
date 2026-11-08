# Plan 097: Infinite Canvas Sheets with PDF Page Materialisation (M7)

| Field | Value |
|---|---|
| **Priority** | P3 |
| **Effort** | XL |
| **Category** | Feature / Requirement 6 (optional) |
| **Depends on** | 091, 095 |
| **Status** | DONE (2026-11-09; see Outcome) |

## Why

Requirement #6 and `SPEC.md` M7. `SheetKind::FreeCanvas` already exists in the model, but `write_document` skips it entirely (`pdf.rs`, "FreeCanvas materialisation is M7; skip cleanly"). Ink on such a sheet would survive only in the sidecar and be **invisible in every other reader**, which violates the degradation contract (`SPEC.md` §1.5). It is unreachable today (`Sheet::blank()` has no callers; "New Whiteboard" creates a real PDFium page), so this is a feature gap, not a live bug.

## Design
- **Model**: a FreeCanvas sheet is an unbounded plane in pt units with an optional background template. It sits in the notebook's page list like any other sheet (it has a `page_id` and `order_key` from Plan 091).
- **Materialisation on save** (the important part): compute the ink bounding box, tile it into pages of a chosen size (default A4 portrait, setting: "canvas export page size"), and emit real PDF pages appended after the sheet's position, each carrying the clipped Layer 1/2 content for its tile. Mark the generated pages `/Inkw_CanvasTile <<sheet_id, row, col>>` so on reopen BezierNotes reconstitutes the single canvas from the sidecar and ignores the tiles for editing. Other readers see an ordinary multi-page PDF.
- **Viewport**: reuse the existing tile compositor without PDF tiles, with LOD-agnostic vector ink; pan/zoom is unbounded (clamp zoom 5 %–3,200 %); minimap overlay.
- **UI**: "New canvas page" in the insert-page modal; a canvas sheet shows a dotted infinite grid template.

## Scope
- `inkwell-core/src/pdf.rs` (tile materialisation, page-tree insertion), `doc.rs`.
- `inkwell-app/src/js/viewport.js`, `render/compositor.js`, `render/templates.js`, insert-page modal.

## Verification
- A canvas with ink spanning 3×2 tiles saves as 6 extra pages that pass `qpdf --check`, render identically in MuPDF, and reopen as one editable canvas.
- Erasing all ink and saving removes the tiles (no orphan pages).

## STOP Conditions
- Do not expose FreeCanvas creation in any UI until materialisation passes its verification. Never let users put ink where other readers can't see it.

## Outcome (2026-11-09)

**Materialisation** (`pdf.rs` `materialise_canvases`; done and verified first, as the STOP condition requires).
- **Tiling.** On save, each `FreeCanvas` sheet's content is split along a fixed A4 grid (`CANVAS_TILE`), with negative coordinates allowed. Every tile with content becomes an ordinary page appended to the root page node, carrying its strokes, images, shapes and text notes as Layers 1–2. Each tile is marked `/Inkw_CanvasTile [<page id> row col]`.
- **No stacking or orphans.** Tiles are rebuilt on every save: the rebased base has none, and tiles a PDFium page operation baked into a base are dropped from the root `/Kids`. So re-saving never stacks them, and erasing everything leaves no orphan pages.
- **Reopening.** `PdfFile::real_page_count()` excludes tiles. The canvas reopens from the sidecar as one editable sheet.

**Model and app.**
- `Sheet::canvas()` (dot template).
- Canvas sheets always come after the PDF-backed sheets, so PDF page indices never shift. As a result:
  - the open path drops tile pages before matching sheets to pages, pads PDF sheets before the canvases, and appends one page info per canvas (`canvas: true`, sized to its content plus room, in whole tiles);
  - `add_canvas_page` and canvas deletion are journalled (`WalEntry::CanvasAdded` / `CanvasRemoved`) and replayed;
  - duplicate, rotate and move refuse canvas pages with a message;
  - new PDF pages are inserted before the canvases.

**Frontend.**
- **Creation.** "Infinite canvas" is a paper size in the Insert Page dialog, and "Add Canvas Page (Infinite)" is in the command palette; both append a canvas page.
- **No PDF work.** Canvas pages skip PDF tiles, prefetch, thumbnail rendering and text extraction.
- **Growth.** A canvas page grows by a tile when ink comes within 200 pt of its right or bottom edge.

**Verification.**
- **Core.** `tests/canvas.rs` (4 tests): a 3×2 canvas saves as exactly 6 extra pages and passes `qpdf --check`; it reopens as one canvas with all its strokes; re-saving doesn't stack; erasing removes the tiles (rebased, or over a base holding tiles); negative coordinates get a page.
- **Render diff.** Every tile page of a 3×2 canvas shows ink in **both PDFium and Ghostscript**.
- **App test.** A canvas saved through `save_blocking` becomes 1 page + 2 tiles, and reopens as 2 page infos (the second a canvas).
- **Smoke.** T35, 4 checks.
- **Totals.** Rust 172/172, app 27/27, smoke 193/193, strict conformance, clippy and boundaries clean.

**Not done / limits.**
- **Not truly unbounded.** Canvases grow right and down (in whole pages) rather than being an unbounded plane in every direction; there's no minimap and no 5 %–3,200 % zoom clamp of its own.
- **Tile settings.** The tile page size is fixed at A4 (no "canvas export page size" setting), and empty tiles are skipped, so a sparse canvas exports as only the tiles with content.
- **No undo of adding.** Adding a canvas page has no undo; delete it like any page.
- **Exports.** Page-subset exports don't include canvas pages; an "all pages" export does, as tiles.
- **Not checked in MuPDF.** Ghostscript and PDFium are what the tests use.
