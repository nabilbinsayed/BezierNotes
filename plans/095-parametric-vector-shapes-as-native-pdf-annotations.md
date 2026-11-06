# Plan 095: Parametric Vector Shapes as Native PDF Annotations

| Field | Value |
|---|---|
| **Priority** | P2 |
| **Effort** | L (~700 lines) |
| **Category** | Feature / Requirement 9 (README roadmap item #1) |
| **Depends on** | 091 (new object kind needs clocks), 093 |
| **Status** | TODO |

## Why

Shapes (line, arrow, rect, ellipse, triangle, and hold-to-snap results from Plan 083) are stored as high-density **strokes**. Once drawn they can't be edited as shapes: no corner handles, no endpoint drag, no stroke-weight or fill change, no corner radius. They also export as `/Ink` polylines, so other readers show "Ink" annotations instead of `/Square`, `/Circle`, `/Line` or `/Polygon` annotations that Acrobat users can select, restyle and comment on. `README.md:189-190` lists this as the next roadmap item.

## Design
- New object kind `ShapeObject { id, kind: Line|Arrow|Rect|Ellipse|Polygon|Polyline, geometry (points / rect + rotation), stroke_rgb, stroke_width, fill_rgb: Option, opacity, dash: Option, corner_radius, arrow_heads, created/modified clocks }`, stored in `Sheet.shapes` and in sidecar v2 (Plan 091's skeleton JSON; shapes are small).
- Rendering: shared geometry in `inkwell-core` (`shape_path(&ShapeObject) -> Vec<PathCmd>`), mirrored in `ink.js` for canvas. One implementation in Rust is exposed to JS through the existing WASM-free approach of porting the small function. Add a cross-check test that both produce the same path for fixtures.
- PDF emission: native subtypes with `/AP`: `/Square` (`/RD` for stroke inset), `/Circle`, `/Line` (`/LE` arrow endings, `/L`), `/Polygon` / `/PolyLine` (`/Vertices`), plus `/IC` interior colour, `/BS` width/dash, `/CA` opacity, `/T (BezierNotes)`, `/Inkw_Sid`. Rounded rects go in the `/AP` path; `/Square` geometry stays the bounding rect.
- Editing: selecting a shape with lasso or a click shows handles (8 resize, 1 rotate, endpoint handles for lines/arrows, vertex handles for polygons). The properties popover offers stroke colour, fill, width, dash, corner radius, and arrowheads. All edits are undoable transactions and are WAL-journalled (new `ShapeUpserted` / `ShapeRemoved` entries).
- Migration: hold-to-snap (Plan 083) and the shape tools create `ShapeObject`s from now on. Existing stroke-shapes stay strokes. Offer "Convert to shape" in the context menu when `recognizeFreehandShape` classifies a selected stroke.
- Import: when opening a PDF that has foreign `/Square` / `/Circle` / `/Line` / `/Polygon` annotations (no `/Inkw_Sid`), show them as read-only rendered content (PDFium already does). Making them editable is out of scope.

## Scope
- `inkwell-core`: `doc.rs` (ShapeObject), new `shape.rs`, `pdf.rs` (emitters), `wal.rs`.
- `inkwell-app/src-tauri`: DTOs + journal command.
- Frontend: `tools/shapes.js`, `tools/lasso.js` (handles), `ui/` popover, `render/overlays.js`, `core/document.js`.

## Verification
- Golden snapshots for each subtype's annotation dict + `/AP`.
- `qpdf --check` + render diff (Plan 087).
- Manual: open the output in Acrobat Reader and confirm the shapes are listed as Square/Circle/Line in the comments pane.
- Smoke: draw → resize → restyle → undo/redo → save → reopen round-trip for every kind.

## STOP Conditions
- STOP if `/AP` and native geometry disagree visually in any reader. The `/AP` is authoritative for display, so keep them consistent.
