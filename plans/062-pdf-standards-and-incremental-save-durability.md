# Plan 062: PDF Standards & Incremental Save Durability

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 3bf08b7..HEAD -- inkwell/crates/inkwell-core/src/pdf.rs inkwell/crates/inkwell-core/src/pdfobj.rs inkwell/crates/inkwell-core/tests/integration.rs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: pdf | durability | bug
- **Planned at**: commit `3bf08b7`, 2026-10-07

## Why this matters

InkWell's core identity is "native standard PDFs that work everywhere." Several edge cases in `inkwell-core` currently violate ISO 32000-1 or degrade external viewer fidelity:
1. Transparent PNG/WebP images have their alpha channel stripped by `dynamic_img.to_rgb8()`, rendering as opaque black boxes in Adobe Acrobat, Apple Preview, and Chrome. Standard PDF requires a separate `/SMask` (Soft Mask) grayscale image XObject.
2. In PDFs where `/Annots` is an indirect reference (e.g. `/Annots 15 0 R`), `rewrite_page` misidentifies the reference token and nests the object array inside `[ 15 0 R ... ]` instead of resolving it, corrupting the page annotation table and losing preexisting third-party annotations.
3. `rewrite_catalog` strips `/Names` and `/AF` with `dict_without`, destroying existing document bookmarks, named destinations, and PDF/A-3 attachments.
4. `PdfFile::finish()` omits `/Info` from the appended trailer dictionary, hiding document metadata (Title, Author, CreationDate) in external viewers, and reuses `/ID` without generating a fresh second generation ID.
5. `read_stream` fails on single-pass PDFs (pdfTeX, Cairo) that specify stream length via an indirect object (`/Length 12 0 R`).
6. Non-ASCII characters in text notes render as mojibake in external readers due to missing UTF-16BE encoding in `/Contents`.

Landing this plan guarantees standard ISO 32000-1 compliance and 100% visual fidelity in all external PDF viewers.

## Current state

- `inkwell/crates/inkwell-core/src/pdf.rs:475-486`:
  ```rust
  let rgb = dynamic_img.to_rgb8();
  let (w, h) = rgb.dimensions();
  let rgb_bytes = rgb.into_raw();
  let img_xobject = self.add_stream(
      &format!("/Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceRGB /BitsPerComponent 8"),
      &rgb_bytes,
      true,
  );
  ```
  Alpha channels are discarded, emitting opaque RGB with no `/SMask`.
- `inkwell/crates/inkwell-core/src/pdf.rs:601-622`:
  `rewrite_page` inspects `po::dict_get(&dict_bytes, "Annots")` and assumes direct array contents, misinterpreting `N 0 R`.
- `inkwell/crates/inkwell-core/src/pdf.rs:625-647`:
  `rewrite_catalog` calls `po::dict_without(&dict_bytes, &["Names", "AF"])` and writes a replacement dictionary containing only `inkwell.doc`.
- `inkwell/crates/inkwell-core/src/pdf.rs:669-680`:
  `PdfFile::finish()` writes `/Size`, `/Root`, `/Prev`, and existing `/ID`, omitting `/Info` and `/Encrypt`.
- `inkwell/crates/inkwell-core/src/pdf.rs:751-754`:
  `read_stream` calls `po::as_int` directly on `/Length` without resolving indirect references (`N 0 R`).
- `inkwell/crates/inkwell-core/src/pdf.rs:577-594`:
  Text annotations write raw unescaped UTF-8 bytes into `/Contents` string literals.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Core Cargo Tests | `cd inkwell; cargo test -p inkwell-core -- --test-threads=1` | exit 0, all tests pass |
| Core Clippy | `cd inkwell; cargo clippy -p inkwell-core --all-targets` | exit 0, zero warnings |
| Full Workspace Tests | `cd inkwell; cargo test --workspace -- --test-threads=1` | exit 0, all tests pass |

## Scope

**In scope**:
- `inkwell/crates/inkwell-core/src/pdf.rs`
- `inkwell/crates/inkwell-core/src/pdfobj.rs`
- `inkwell/crates/inkwell-core/tests/integration.rs`

**Out of scope**:
- Frontend UI files (`inkwell-app/src/`).
- PDFium bindings (`inkwell-pdf`).

## Steps

### Step 1: Implement `/SMask` soft mask support for transparent image annotations

1. In `inkwell/crates/inkwell-core/src/pdf.rs:470-490` (`emit_image_annot`):
   - Check if `dynamic_img.color().has_alpha()`:
     - If true, extract the RGB bytes (`dynamic_img.to_rgb8()`) AND the 8-bit alpha channel bytes (`dynamic_img.to_rgba8().pixels().map(|p| p[3]).collect()`).
     - Emit the alpha bytes as a separate image XObject:
       ```rust
       let smask_xobject = self.add_stream(
           &format!("/Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceGray /BitsPerComponent 8"),
           &alpha_bytes,
           true,
       );
       ```
     - Attach `/SMask {smask_xobject} 0 R` to the main image XObject dictionary.
     - If false, emit standard `/ColorSpace /DeviceRGB` without `/SMask`.

**Verify**: Write a unit test in `integration.rs` verifying that an image with transparent pixels produces an image XObject with `/SMask`.

### Step 2: Preserve indirect `/Annots` references and merge preexisting annotations

1. In `inkwell/crates/inkwell-core/src/pdf.rs:595-624` (`rewrite_page`):
   - When extracting `/Annots`:
     - If the value is an indirect reference (`as_ref_num`), resolve the target array object using `find_object`.
     - Collect existing annotation object numbers using `refs_in_array`.
     - Filter out previous InkWell annotations (those matching `/Inkw_Sid`).
     - Retain all other third-party annotations (links, highlights, form widgets).
     - Write the updated `/Annots [ ... ]` array referencing retained objects plus new InkWell annotations.

**Verify**: Add a test in `integration.rs` testing incremental save on a PDF with an indirect `/Annots 10 0 R`.

### Step 3: Preserve catalog `/Names` and `/AF` entries during incremental catalog update

1. In `inkwell/crates/inkwell-core/src/pdf.rs:625-650` (`rewrite_catalog`):
   - Instead of discarding `/Names` and `/AF`, inspect if the catalog dictionary already contains them.
   - If `/Names` exists: parse its entries (e.g. `/Dests`, `/JavaScript`), and append `/EmbeddedFiles << /Names [ (inkwell.doc) {ef_spec} 0 R ] >>`.
   - If `/AF` exists: append `{ef_spec} 0 R` to the existing `/AF [ ... ]` array.

**Verify**: Test incremental save on a PDF with named destinations; assert that destination entries remain present.

### Step 4: Preserve `/Info` and generate second-generation `/ID` in trailer

1. In `inkwell/crates/inkwell-core/src/pdf.rs:660-685` (`PdfFile::finish()`):
   - Copy `/Info {num} 0 R` and `/Encrypt {num} 0 R` from the base trailer if present.
   - In `/ID [ id1 id2 ]`, preserve the original `id1` string and generate a fresh random 16-byte hex hash for `id2`, complying with ISO 32000-1 § 14.4.

**Verify**: Verify that `/Info` is preserved in output PDF bytes after `write_document`.

### Step 5: Support indirect `/Length` in `read_stream` & UTF-16BE text in `/Contents`

1. In `inkwell/crates/inkwell-core/src/pdf.rs:750-760` (`read_stream`):
   - If `po::as_int` returns `None`, check for indirect reference (`as_ref_num`); resolve the object and parse integer length.
2. In `inkwell/crates/inkwell-core/src/pdf.rs:575-595` (`emit_text_annot`):
   - If `text_obj.text` contains non-ASCII characters, encode `/Contents` string as big-endian UTF-16 prefixed with BOM `\xFE\xFF` formatted as hex string `<FEFF...>`.
   - Sanitize `sid` through `escape_pdf_string` and ensure it only contains alphanumeric and underscore characters.

**Verify**: `cd inkwell; cargo test --workspace -- --test-threads=1` and `cargo clippy --all-targets`.

## Done criteria

- [ ] Transparent images emit `/SMask` soft mask grayscale XObjects, preserving transparency in external PDF viewers.
- [ ] Indirect `/Annots` arrays are resolved and preserved without array nesting corruption.
- [ ] Catalog `/Names` (bookmarks/destinations) and `/AF` entries are merged rather than discarded.
- [ ] Document `/Info` metadata (Title, Author) is preserved in incremental update trailers.
- [ ] Indirect `/Length` stream references parse without error.
- [ ] Non-ASCII text annotations encode cleanly as UTF-16BE in `/Contents`.
- [ ] All unit and integration tests pass with zero clippy warnings.
