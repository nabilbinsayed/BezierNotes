# Plan 078: Instant PDF Open — Fast Page Sizes, Sidecar Fast Path, and Adjacent-Page Prefetch

## Status

- **Priority**: P0 (perceived performance / daily-driver blocker)
- **Effort**: M
- **Risk**: LOW
- **Category**: performance | ux | backend
- **Executed**: 2026-11-01
- **Result**: DONE — desktop smoke 126/126, Rust workspace 89/89, Clippy clean

## Symptom

Opening a real 8.8 MB, 33-page vector textbook (`Higher_Math_Bangla_chapter_3.pdf`)
was visibly slower than Chrome/Acrobat. Pages did not feel instant, especially on
a debug build or on the first visit to every page.

## Root causes found by profiling

Measured with a PDFium harness on the 9 MB fixture (debug / release):

| Stage | Before | Cause |
|---|---:|---|
| Page metadata (`extract_pdf_meta`) | **765 ms / 765 ms** | Loaded every page with `doc.pages().get(i)` just to read `width()` / `height()`. `FPDF_LoadPage` parses page resources; 33 pages × ~23 ms. |
| Sidecar probe (annotated PDF) | **1.10 s debug / 57 ms release** | `find_object` walked all 9 MB with a naive byte-by-byte substring iterator to locate the catalog. |
| Sidecar probe (clean PDF) | same walk | No marker check; every clean PDF paid for a trailer/object walk even though it could not contain a sidecar. |
| First page bitmap | 93–96 ms | Full-page PDFium raster at 2× DPR (1044×1368). This is the floor for sharp first paint; now amortised by caching. |
| Next-page bitmap | 50–74 ms on first visit | No prefetch; every first tile of every page paid the full page render before displaying. |

The app's `open_pdf` command itself took ~1.8 s in debug; the UI showed no
progress feedback during the wait.

## Changes

### 1. Fast page-size API (`inkwell-app/src-tauri/src/commands.rs`)

`extract_pdf_meta` now uses `doc.pages().page_size(i)` (`FPDF_GetPageSizeByIndexF`),
which reads the page box without loading page content.

- 33-page fixture: **765 ms → 1.1–1.6 ms**.
- Verified identical dimensions against `PdfPage::width()/height()` across the
  fixture corpus, including a 90°-rotated PDF.

### 2. Sidecar lookup fast paths

- Added `memchr` to `inkwell-core` and rewired `pdfobj::find` / `pdfobj::rfind`
  to `memmem` substring search. Debug `find_object` on the 9 MB file:
  **557 ms → 69 ms**.
- `read_sidecar` now checks for the ASCII `/Inkw_Doc` marker before parsing the
  trailer. Clean PDFs return `Absent` immediately, without a 9 MB object walk.
- App `open_pdf` on the annotated fixture dropped to **124–226 ms debug**; the
  remaining time is sidecar decode (382 strokes) plus document/state setup.

### 3. Adjacent-page prefetch

- New backend command `prefetch_page(page, px)` renders a full page bitmap into
  the existing LRU cache **without transferring pixels over IPC**.
- Extracted the shared `page_bitmap_for_scale` helper used by both `render_tile`
  and `prefetch_page`.
- The compositor schedules prefetch of the next **two** pages after the viewport
  settles (480 ms, deduplicated for 8 s per page/scale). It skips while a stroke
  is active, during presentation, and after rapid navigation.
- First page initially paints at ~250 ms after open; page 1 painted in the
  background 37–74 ms later, so scrolling down no longer waits on PDFium.

### 4. Perceived latency

- Added a lightweight bottom "Opening PDF — Preparing page layout…" overlay for
  file picker, drag-and-drop and launch-from-CLI paths, removed on success or
  failure.
- Added `INKWELL_PROFILE_TILES=1` to print page render/prefetch timings.
- Added an open-duration line to the existing `[inkwell] Opened PDF` log.

## Verification

| Command | Result |
|---|---|
| `cd inkwell-app && py -3 test_app_smoke.py` | 126/126 checks, zero console errors |
| `cd inkwell && cargo test --workspace -- --test-threads=1` | 89/89 tests |
| `cd inkwell && cargo clippy --all-targets` | zero warnings |

Profiling harness (release where noted):

```
read                  6.0 ms
load document         0.4 ms   33 pages
page sizes fast       1.6 ms   (was 765 ms)
page loads slow     765.0 ms   (no longer used)
read sidecar         56.7 ms   annotated fixture (debug: 1.10 s → 0.18 s)
page 0 render        93.4 ms   full page at 1×; 96 ms at 2× DPR debug
```

Actual app launch on the test machine (2× HiDPI display):

| Build | `open_pdf` | First page render | Page 1 prefetch | Page 2 prefetch |
|---|---:|---:|---:|---:|
| debug | 124–226 ms | 53–96 ms | 37–74 ms | ~100 ms |
| release | **119 ms** | **82 ms** | **55 ms** (≈0.7 s after open) | 101 ms (≈0.8 s after open) |

A clean 15-page academic PDF (arXiv, with a 22-node outline) opened in **7 ms**
and rendered its first page in **81 ms** at 2× DPR. From process start, the
release app reached first page paint at ~1.3–1.5 s; ~1.0 s of that is
WebKitGTK/webview boot before `open_pdf` is even invoked. Opening a document
from an already-running app is therefore ~0.1–0.3 s to first pixels.

## Not changed

- PDF writing, sidecar schema, annotation geometry, and the append-only save path.
- Webview startup (~1.0–1.3 s on this machine) remains outside PDF opening; a
  launch-from-CLI measurement therefore includes that fixed cost.

## Files

- `inkwell-app/src-tauri/src/commands.rs`
- `inkwell-app/src-tauri/src/main.rs`
- `inkwell-app/src/js/core/ipc.js`
- `inkwell-app/src/js/render/compositor.js`
- `inkwell-app/src/js/main.js`
- `inkwell-app/src/index.html`
- `inkwell/crates/inkwell-core/src/pdf.rs`
- `inkwell/crates/inkwell-core/src/pdfobj.rs`
- `inkwell/crates/inkwell-core/Cargo.toml`
- `inkwell/crates/inkwell-core/tests/integration.rs`
- `inkwell/crates/inkwell-pdf/examples/bench_open.rs` (profiling harness)
