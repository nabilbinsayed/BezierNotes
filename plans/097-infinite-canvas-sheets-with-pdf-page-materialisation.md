# Plan 097: Infinite Canvas Sheets with PDF Page Materialisation (M7)

| Field | Value |
|---|---|
| **Priority** | P3 |
| **Effort** | XL |
| **Category** | Feature / Requirement 6 (optional) |
| **Depends on** | 091, 095 |
| **Status** | TODO |

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
