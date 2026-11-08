# Plan 096: AcroForm Field Filling (Text, Checkbox, Radio, Choice)

| Field | Value |
|---|---|
| **Priority** | P2 |
| **Effort** | L (~600 lines) |
| **Category** | Feature (README roadmap item #2) |
| **Depends on** | 088 (forms live in object streams in most real files), 089 (Unicode appearances) |
| **Status** | DONE (2026-11-09; see Outcome) |

## Why

Students and professionals routinely receive fillable PDFs (assignment cover sheets, applications, tax forms). BezierNotes renders and can flatten form widgets but cannot fill them (`README.md:191-192`), so users must switch apps. Filling a form is also the most common reason to sign a PDF, and the signature studio (Plan 077) already exists.

## Design
- **Read**: walk `/AcroForm /Fields` (with `/Kids` inheritance of `/FT`, `/V`, `/DA`, `/Ff`, `/Opt`, `/MaxLen`, `/Q`) using the Plan 088 object resolver. Produce `FormField { fqn, kind, rect per widget, page, value, options, flags }`. PDFium's form-fill environment (`FPDF_InitFormFillEnvironment`, `FORM_*`) can provide hit-testing and rendering with `FPDF_FFLDraw`. Prefer it for **display** so field appearances match other readers.
- **UI**: a "Fill" mode (auto-enabled when a document has fields; badge in the header). Clicking a text field overlays a DOM `<input>`/`<textarea>` positioned in page space (respecting zoom/rotation, `/Q` alignment, `/MaxLen`, comb fields). Checkboxes and radios toggle on click. Choice fields use a native `<select>`. Tab/Shift+Tab follows `/Annots` order (or `/Tabs`). 44 px minimum touch target via an invisible hit-area expansion.
- **Write**: incremental update of each changed field dict's `/V` (and widget `/AS` for buttons), plus a regenerated `/AP` per widget. Text appearances use Plan 089's shaped vector glyphs, so non-Latin entries render everywhere. Set `/NeedAppearances false`. Never touch unchanged fields (append-only, minimal section).
- **Undo / WAL**: `FieldValueChanged { fqn, old, new, clock }` entries; values round-trip through sidecar v2 so a merge (Plan 092) can LWW them.
- **Out of scope**: JavaScript actions (`/AA`, calculate/format/validate scripts). Detect them and show "This form uses scripts; calculated fields won't update". XFA forms: detect and show a clear unsupported message.
- **Flatten on export**: Plan 085's flatten path bakes field appearances into page content when "flatten" is ticked.

## Scope
- `inkwell-core/src/forms.rs` (new), `pdf.rs` (field writes).
- `inkwell-pdf` (PDFium form environment wrapper).
- `inkwell-app/src-tauri/src/commands/forms.rs` (after Plan 093).
- Frontend: `js/workspace/forms.js` (new), overlays, keyboard tab order.

## Verification
- Fixtures: a qpdf-generated form with each field type plus an IRS-style real form (object streams, inherited `/DA`).
- Fill → save → open in PDFium and MuPDF: values present, appearances correct; `qpdf --check` clean; original prefix preserved.
- Smoke: tab order, checkbox toggle, Bangla text in a text field, undo.

## STOP Conditions
- STOP if writing `/V` without a fresh `/AP` is the only option for some field type. A blank-looking field in Chrome would be worse than not supporting it.

## Outcome (2026-11-09)

**Core** (`inkwell-core/src/forms.rs`).
- **Reading.** `PdfFile::form_fields()` walks `/AcroForm /Fields` with `/Kids` inheritance (`/FT /Ff /V /DA /Q /Opt /MaxLen`) through the Plan 088 object index, so fields in object streams work. It decodes literal, hex and UTF-16 strings and `#`-escaped names. Each widget gets its page and its `/Annots` position, which is the tab order. JavaScript (`/AA`, `/JS`) and XFA are detected.
- **Writing.** `write_form_values()` replaces only the fields the user set:
  - `/V`, with a fresh `/AP` per text or choice widget. The appearance is shaped glyph outlines (Plan 089), honouring `/Q`, multiline, comb and auto size.
  - `/AS` per button widget. A button that has no "on" appearance gets a generated tick or dot, so a value is never written without an appearance (STOP condition).
  - `/NeedAppearances false` on an indirect `/AcroForm`.
  - Read-only, push-button and signature fields are never written.
- **Model.** Values live in `Document::form_values`: in the sidecar (omitted when empty, so other documents encode unchanged), stamped with `ObjectId::Field` clocks, merged last-writer-wins (Plan 092), and journalled as `WalEntry::FieldValue`. They are also written in flattened exports.

**App.** `get_form_fields` returns widgets in page space, with pending values overlaid and the rendered (saved) value alongside. `set_form_value` is journalled, and replayed on open.

**Frontend** (`js/workspace/forms.js`).
- **Controls.** Fill mode lays `<input>`/`<textarea>`/`<select>` and toggle buttons over the widgets, in page and `/Annots` order, so Tab follows the form.
- **Rendering.** PDFium's page rendering already shows saved values, so controls are transparent until edited. While a value is pending they cover the stale rendering, until a save (`documentSaved`) refreshes the tiles.
- **Behaviour.** Each change is one undo step (`form_value`) and is journalled each way. Checkboxes and radios have 44 px hit areas.
- **Notices.** A fill chip toggles fill mode. A toast names scripts and XFA.

**Fixtures.** `inkwell/fixtures/forms/all_fields.pdf` has every field kind (`tools/gen_form_fixture.py`, normalised by qpdf). The real `corpus/irs_w9.pdf` is an XFA hybrid with object streams.

**Verification.**
- **Core.** `tests/forms.rs` (5 tests): reading every kind; filling everything including Bangla, then reread, `qpdf --check` and prefix preserved; read-only untouched; sidecar round trip and no stacking on re-save; W-9 filling; merge last-writer-wins and the WAL.
- **Render diff.** A new check fills every kind and requires ink inside each widget in **both PDFium and Ghostscript**. It passes. PDFium tests in that file now take turns with a mutex: running two of them at once crashed PDFium.
- **App test.** Widget page-space conversion and the pending overlay.
- **Smoke.** T34, 6 checks: tab order, script notice, Bangla, checkbox, exclusive radio, choice, read-only, undo/redo journalling, covers clearing after save, and zoom tracking.
- **Totals.** Rust 167/167, app 26/26, smoke 189/189, strict conformance, clippy and boundaries clean.

**Not done / limits.**
- **Display.** Field display uses the saved appearances plus the overlay; PDFium's form-fill environment is not used.
- **Overlay coverage.** Fields are overlaid in the left pane only (split view's right pane shows the rendering), and rotated widgets (`/MK /R`) are positioned unrotated.
- **Choices.** List boxes show the selected option like a combo; there's no multi-select.
- **Inline `/AcroForm`.** An inline `/AcroForm` keeps its `/NeedAppearances` (readers then regenerate from `/V`, which is current).
- **No real-app check.** Not checked in MuPDF or Acrobat.
