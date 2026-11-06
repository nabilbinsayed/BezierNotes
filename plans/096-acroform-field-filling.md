# Plan 096: AcroForm Field Filling (Text, Checkbox, Radio, Choice)

| Field | Value |
|---|---|
| **Priority** | P2 |
| **Effort** | L (~600 lines) |
| **Category** | Feature (README roadmap item #2) |
| **Depends on** | 088 (forms live in object streams in most real files), 089 (Unicode appearances) |
| **Status** | TODO |

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
