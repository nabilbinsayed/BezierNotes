# Plan 085: Smart PDF Export Engine (Page Ranges, Annotated-Pages-Only & Flattened PDF Mode)

| Field | Value |
|---|---|
| **Priority** | P2 |
| **Effort** | M (~200 lines across 4 files) |
| **Category** | Feature / Document IO & Export |
| **Depends on** | 081 |
| **Status** | TODO |

## Why

In `inkwell-app/src/index.html:415-448` and `inkwell-app/src/js/main.js:1853-1867`, `#exportModal` already exists in the DOM, but currently only forwards to a full-document editable save. Users working with multi-hundred-page textbooks, research papers, or graded exams need to:
1. Export **All Pages**, **Annotated Pages Only**, **Current Page Only**, or a **Custom Page Range** (e.g. `1-5, 8, 11-14`).
2. Choose between **Editable InkWell Vector PDF** (preserves the `INKWELL_META` marker for future editing in InkWell) and **Flattened Read-Only Vector PDF** (strips editable sidecar metadata so signatures and grading marks are permanently baked into the standard PDF page streams).

## Evidence

### `inkwell-app/src/js/main.js:1853-1867`
```javascript
  const exportConfirmBtn = document.getElementById('exportConfirmBtn');
  if (exportConfirmBtn) {
    exportConfirmBtn.addEventListener('click', async () => {
      closeModal(exportModal);
      await exportPdfWithDialog();
    });
  }
```

## Scope

### Files to Modify
1. `inkwell-app/src/index.html`
2. `inkwell-app/src/js/main.js`
3. `inkwell-app/src-tauri/src/commands.rs`
4. `inkwell-app/test_app_smoke.py`

### Files NOT to Touch
- Do NOT modify `save_document` (`Ctrl+S` incremental save on the active document must remain untouched).

## Step-by-Step Implementation

### Step 1: Upgrade `#exportModal` Controls in `inkwell-app/src/index.html`

Inside `#exportModal` (`index.html:415-448`), add accessible (`>=44x44px` touch target) options:
- `#exportRangeMode`: `<select>` or radio group with values:
  - `'all'` — All Pages
  - `'annotated'` — Annotated Pages Only
  - `'current'` — Current Page Only
  - `'custom'` — Custom Page Range (`#exportCustomRangeInput`, placeholder `"e.g. 1-3, 5, 8-10"`)
- `#exportFlattenCheckbox`: Checkbox `"Flatten annotations (read-only vector PDF)"`.

### Step 2: Add Page-Range Parser & Export Filtering in `inkwell-app/src/js/main.js`

1. Export a pure helper `parsePageRangeSpec(specStr, totalPages)` (and attach to `window.parsePageRangeSpec` for testing):
   - Parses comma-separated 1-based page numbers and ranges (`"1-3, 5"` -> `[0, 1, 2, 4]`), deduplicated and sorted in ascending order, clamped to `0 .. totalPages - 1`.
2. When `#exportConfirmBtn` is clicked:
   - Compute the list of 0-based page indices `selectedPages` according to `#exportRangeMode`:
     - `'all'`: all sheets `0 .. totalPages - 1`
     - `'current'`: `[state.leftSheet || 0]`
     - `'annotated'`: sorted set of sheets that contain at least one non-deleted stroke, image, or text object
     - `'custom'`: `parsePageRangeSpec(customInput.value, totalPages)`
   - If `selectedPages.length === 0`, show a warning toast (`"No pages match the selected export filter"`) and keep the modal open.
   - Pass `{ selectedPages, flatten }` to `exportPdfWithDialog({ selectedPages, flatten })`.

### Step 3: Support `flatten` & `selected_pages` in `export_pdf_custom` (`inkwell-app/src-tauri/src/commands.rs`)

Add optional parameters `flatten: Option<bool>` and `selected_pages: Option<Vec<u32>>` to `save_document` (or a dedicated `export_pdf_custom` command invoked by `exportPdfWithDialog`):
- When `flatten == Some(true)`, omit the `% INKWELL_META:` comment line from the generated page content streams so the annotations remain 100% standard PDF vector paths (`/T (Inkwell)`) but are locked against accidental erasure upon re-open.
- When `selected_pages` is `Some(pages)` and specifies a strict subset of pages, filter the exported PDF's page list using `pdfium` page extraction / `inkwell-pdf` page tree construction before `atomic_write`.

## Verification

```bash
cd inkwell && cargo test --workspace -- --test-threads=1 && cargo clippy --all-targets
cd ../inkwell-app && python3 test_app_smoke.py
```

## STOP Conditions
- STOP if exporting a subset of pages mutates `state.pdf_bytes` or `state.doc_path` of the currently open document—exporting with a custom range or flatten option must write exclusively to the chosen export target path without corrupting the live editing session.
