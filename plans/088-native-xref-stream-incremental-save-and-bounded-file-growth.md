# Plan 088: Native Xref-Stream Incremental Save & Bounded File Growth

| Field | Value |
|---|---|
| **Priority** | P0 |
| **Effort** | L (~700 lines in `pdfobj.rs` / `pdf.rs` + tests) |
| **Category** | File-Format Integrity / Non-Negotiable #2 |
| **Depends on** | 087 |
| **Status** | TODO |

## Why

Two defects break the "original bytes are never touched" and "trivial cloud sync" promises for the files people actually use.

**1. Most real PDFs get rewritten by PDFium on the first save.** `PdfFile::open` rejects any file whose last xref is a cross-reference stream (`Error::XrefStream`). Every PDF 1.5+ produced by Word, LaTeX (`pdflatex` default), Chrome "Save as PDF", scanners and publishers uses xref streams. `save_pdf` then falls back to `inkwell_pdf::normalise`, which **re-serialises the whole document through PDFium**, and saves *that* as the new base. Consequences:
- the original byte prefix is gone forever after the first save (Non-Negotiable #2 violated for the majority of inputs);
- digital signatures are invalidated, linearization and PDF/A conformance are dropped, and PDFium may discard structure it doesn't model;
- the very first save re-uploads a completely different file to Drive/OneDrive.

**2. Every save session appends a full copy of all ink + the sidecar on top of the previous save.** On open, `original_pdf_bytes` is set to the *entire* file as read from disk, including earlier BezierNotes revisions (`commands.rs:621`). Each save then appends another generation with every stroke's appearance stream plus the full compressed sidecar. Old generations become unreachable but stay in the file. A lecture PDF annotated over a semester of sessions grows by roughly (ink + sidecar) × sessions, and every sync re-uploads the bloat.

## Evidence

- `inkwell/crates/inkwell-core/src/pdf.rs:45-50`: `if d.get(at..at + 4) != Some(b"xref") { return Err(Error::XrefStream); }`.
- `inkwell/crates/inkwell-pdf/src/normalise.rs:22-49`: PDFium `load_pdf_from_byte_slice` → `save_to_bytes`.
- `inkwell-app/src-tauri/src/commands.rs:1438-1452` (`save_pdf`) and `:1668-1682` (export): normalise fallback; `:1465-1467` permanently replaces `original_pdf_bytes` with the normalised bytes.
- `inkwell-app/src-tauri/src/commands.rs:621`: `original_pdf_bytes = arc_bytes` (the full on-disk file).
- `pdf.rs:697`: page rewrite filters prior annots by `/Inkw_Sid`, so old objects are orphaned rather than reused.

## Design

### Part A: Read and write cross-reference streams (ISO 32000-1 §7.5.8)
1. In `pdfobj.rs`, add an xref resolver that walks the `/Prev` chain and understands both classic `xref` tables and `/Type /XRef` streams (`/W`, `/Index`, Flate + PNG predictors 10–15), including hybrid files (`/XRefStm`).
2. Add object-stream support (`/Type /ObjStm`, `/N`, `/First`) to `find_object`, so the page tree, catalog and annots inside compressed object streams can be read. Replace the current byte-scan `find_object` with an offset table built once per open (also a speed win on large files).
3. In `PdfFile::finish`, when the base's last section is an xref stream, emit the incremental section as an **xref stream** (one new `/Type /XRef` object with `/Prev`, `/Size`, `/Root`, `/Info`, `/ID`), never a classic table. A classic section chained after an xref stream is invalid for strict readers.
4. Encrypted inputs: today `trailer_encrypt` is copied and new objects are written in plaintext. Either implement RC4/AES object encryption for appended objects using the base's `/Encrypt` dictionary (empty user password case), or refuse with a clear error. Never silently write unencrypted objects into an encrypted file.
5. Keep `normalise` **only** for genuinely broken files, i.e. those where the xref is damaged and PDFium had to reconstruct it. When it runs, the UI must say so: a toast "This PDF was repaired and will be rewritten on save. Original kept as `name.orig.pdf`". Write that backup once.

### Part B: Bounded growth (rebase on the pre-BezierNotes revision)
1. On the first BezierNotes save of a file, record the byte length of the untouched base in the catalog: `/Inkw_Base <len>` plus `/Inkw_BaseHash <sha256 of base[..len]>`.
2. On open, if `/Inkw_Base` is present and `sha256(bytes[..len])` matches, set `original_pdf_bytes = bytes[..len]`. The base's own `%%EOF` must end exactly at `len`. The next save then appends exactly **one** fresh generation on top of the untouched original, so file size is `original + current ink`, independent of how many sessions came before.
3. If the hash mismatches (another tool appended its own incremental update after ours), fall back to today's behaviour (append on top of everything). Otherwise we would discard a third party's changes.
4. Pages inserted/deleted/reordered by BezierNotes must still work. Those page-tree edits are part of our generation and are re-emitted on each save from the `Document` model, so they survive the rebase. Verify with the insert-blank-page test.

## Scope

### Files to Modify
- `inkwell/crates/inkwell-core/src/pdfobj.rs`: xref chain resolver, xref stream decode, ObjStm decode, offset table.
- `inkwell/crates/inkwell-core/src/pdf.rs`: `open` accepts xref streams; `finish` writes an xref stream when needed; `/Inkw_Base` + `/Inkw_BaseHash`; encrypted-file policy.
- `inkwell-app/src-tauri/src/commands.rs`: open path computes the rebased `original_pdf_bytes`; normalise becomes repair-only with backup + user-visible notice.
- `inkwell/crates/inkwell-pdf/src/normalise.rs`: rename to `repair` semantics; return a flag the UI can surface.

### Files NOT to Touch
- Layer 1/2/3 content generation (`emit_group`, `emit_text_annot`, sidecar encoding). This plan changes only how objects are located and how the section is framed.

## Verification

```bash
cd inkwell && cargo test --workspace -- --test-threads=1   # 087's xref-stream fixtures now pass un-ignored
cd inkwell && cargo clippy --all-targets
qpdf --check out.pdf                                        # on every conformance fixture
```

Required new assertions (in Plan 087's `conformance.rs`):
- xref-stream, object-stream, linearized and signed fixtures: `out.starts_with(input)`.
- Signed fixture: the original signature still validates (`pdfsig` from poppler reports the original revision as valid; ours is an "incremental update after signing").
- Open → save → close → reopen → save, 10 times, unchanged ink: final size − original size == first-save appended size ± 1 KB.

## STOP Conditions
- STOP if writing an xref-stream section makes `qpdf --check` or Acrobat Reader complain about *any* fixture. Do not ship a section format that only PDFium accepts.
- STOP if rebasing would drop a non-BezierNotes revision. The hash check must make this impossible; add a fixture with a foreign incremental update after ours to prove it.
