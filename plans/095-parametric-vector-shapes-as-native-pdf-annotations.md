# Plan 095: Parametric Vector Shapes as Native PDF Annotations

| Field | Value |
|---|---|
| **Priority** | P2 |
| **Effort** | L (~700 lines) |
| **Category** | Feature / Requirement 9 (README roadmap item #1) |
| **Depends on** | 091 (new object kind needs clocks), 093 |
| **Status** | DONE (2026-11-08; see Outcome) |

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

## Outcome (2026-11-08)

**Core** (`shape.rs`): `ShapeObject` with kinds line/arrow/rect/ellipse/polygon/polyline, and geometry as control points:
- rect and ellipse use a centre plus two half-axis ends, so every affine edit stays exact;
- clocks come from Plan 091's document-level map, with a new `ObjectId::Shape`.

`outline` / `arrow_heads` / `bbox` are the single geometry definition. Shapes are part of merge, the WAL (`ShapeUpsert` / `ShapeRemoved`) and the sidecar; an empty shape list isn't written, so documents without shapes encode byte-identically.

**PDF.** `/Square` and `/Circle` (with `/RD`) for page-aligned rects and ellipses; otherwise `/Polygon` (64 vertices for a rotated ellipse). Also `/Line` with `/LE /ClosedArrow`, `/Polygon` and `/PolyLine`, plus `/C /IC /BS` and `/T (BezierNotes)`, and an `/AP` drawn from `outline`. A rounded rect stays a `/Square`, with the rounding in its `/AP` only.

Two problems the render diff caught and fixed:
- opacity applied twice through an annotation `/CA`; it now lives only in the `/AP`'s ExtGState;
- round caps closing up the dash gaps; dashed strokes now use butt caps.

The `/AP` strokes with constant width (`S`), which is what PDF viewers do for these annotation types. Rule 1's filled ribbons are about pressure ink.

**App.**
- Shapes travel in every save/export/merge payload (`shapes`).
- `journal_shape_mutation` journals live edits; `delete_stroke` also removes shapes.
- They're replayed from the WAL and returned as `loaded_shapes`.

**Frontend.**
- **Model.** Shapes live in the stroke list as stroke-like objects with a `shape` descriptor and `sk`-tagged control points, so selection, lasso move/scale/rotate, undo, delete and paste all work unchanged. `ipc.commitStroke` routes them to the shape journal.
- **Drawing and hit-testing.** `ink.js` ports the geometry. Hit-testing samples the real outline (filled shapes also hit inside).
- **Eraser.** It removes shapes whole.
- **Creation.** The shape tool and hold-to-snap create shapes.
- **Copy as SVG.** It writes stroked paths.
- **Styling.** The selection popover has Fill / Dashed / Rounded / Arrow / Pen style, each one undo step (`restyle_shapes`) and journalled.

**Verification.**
- **Core.** `tests/shapes.rs` (7 tests): subtypes, the `/Square` and `/Circle` geometry matching the `/AP`, sidecar round trip, `qpdf`, no duplicate annotations on re-save, WAL, merge, affine exactness, and the canvas fixture `tests/golden/shape_paths.json`.
- **Golden and render diff.** New `golden_shapes` snapshot. In the render diff, PDFium and Ghostscript agree on 99.6–100 % of ink pixels with shapes included.
- **Smoke.** T33, 8 checks: the canvas output equals Rust's on all 8 fixtures (difference 0), plus create every kind, hit-testing, restyle, undo/redo, lasso move, erase, and save/reopen.
- **Totals.** Rust 161/161, app 25/25, smoke 183/183, clippy and boundaries clean.

**Not done.**
- **Handles.** No per-vertex or endpoint handles: shapes are edited with the lasso's move/scale/rotate and the style toggles.
- **No colour picker.** "Pen style" applies the current pen colour and width.
- **No "Convert to shape".** The context menu doesn't offer it for existing freehand strokes.
- **Not checked in Acrobat.** I haven't confirmed that its comments pane lists the shapes as Square, Circle and Line.
- **Not run in the app.** Focused suites and the torture test were not re-run for this plan.
