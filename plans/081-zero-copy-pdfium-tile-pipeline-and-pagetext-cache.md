# Plan 081: Zero-Copy PDFium Tile Pipeline, Prefetch Priority & Backend PageText Cache

| Field | Value |
|---|---|
| **Priority** | P0 |
| **Effort** | M (~220 lines across 2 Rust files) |
| **Category** | Performance / Rust Backend & Tile Rasterization |
| **Depends on** | 078 |
| **Status** | TODO |

## Why

Profiling the Rust tile and text pipeline in `inkwell-app/src-tauri/src/commands.rs` and `state.rs` uncovered four major backend bottlenecks:

1. **Full-Page Multi-MB `Vec<u8>` Clone on Every Single Tile Hit (`commands.rs:780-822`)**:
   `CachedPageBitmap` stores `bgra: Vec<u8>`. In `page_bitmap_for_scale` (`commands.rs:820`), every cache hit returns `Ok((entry.width, entry.height, entry.bgra.clone()))`. At `2.0x` scale on a standard page (`1224 × 1584 × 4 = 7.75 MB`), rendering the 15 tiles of that page clones `7.75 MB × 15 = 116 MB` of heap memory! Furthermore, `render_tile` (`commands.rs:931-953`) then runs a scalar per-pixel `/ 255` alpha-blending loop on every tile crop, even though `page_bitmap_for_scale` already pre-filled the bitmap with opaque `PdfColor::WHITE` (`a == 255`)!
   By converting BGRA → RGBA *once* when constructing `CachedPageBitmap` and storing `rgba: Arc<Vec<u8>>`, cache hits become zero-copy (`Arc::clone`), and cropping each tile row in `render_tile` becomes a single `copy_from_slice` memcpy!

2. **Synchronous Main-Thread PDFium Execution & Prefetch Starvation (`commands.rs:916, 971-995`)**:
   In `render_tile`, `page_bitmap_for_scale(&state, page_index, s)` is called *outside* `tokio::task::spawn_blocking`. Worse, `prefetch_page` locks `state.pdfium` for 50–100 ms to render off-screen pages; if the user scrolls onto a new page while `prefetch_page` is running, visible `render_tile` calls block waiting for `prefetch_page` to release `state.pdfium`!
   Tracking `active_tile_renders: AtomicUsize` in `AppState` lets `prefetch_page` abort/yield immediately if any visible tile render is in flight.

3. **Slow Default Zlib PNG Compression (`commands.rs:956-962`)**:
   `PngEncoder::new(&mut buf)` uses default zlib compression level, spending 3–6 ms per tile compressing local IPC loopback bytes. Using `PngEncoder::new_with_quality(&mut buf, CompressionType::Fast, FilterType::NoFilter)` cuts PNG encode time by ~4×.

4. **Uncached `PageTextData` Re-Extracts & Reparses PDF on Every Call (`commands.rs:1580-1682`)**:
   `get_page_text_data`, `get_page_text_spans`, and `search_pdf` call `pdfium.load_pdf_from_byte_slice` and `extract_page_text_data` from scratch on every invocation. Caching `HashMap<u32, Arc<PageTextData>>` in `AppState` makes repeated text lookups and full-document searches instantaneous.

## Evidence

### `inkwell-app/src-tauri/src/commands.rs:780-822`
```rust
struct CachedPageBitmap {
    key: (u32, u32),
    width: u32,
    height: u32,
    bgra: Vec<u8>,
}
// ...
fn page_bitmap_for_scale(
    state: &AppState,
    page_index: u32,
    scale: f32,
) -> Result<(u32, u32, Vec<u8>), String> {
    let key = (page_index, quantize_scale_bits(scale));
    if let Ok(mut cache) = state.page_bitmap_cache.lock() {
        if let Some(entry) = cache.get(key) {
            return Ok((entry.width, entry.height, entry.bgra.clone()));
        }
    }
```

### `inkwell-app/src-tauri/src/commands.rs:931-962`
```rust
        for row in 0..ts {
            let src_y = crop_y0 + row;
            for col in 0..ts {
                let src_x = crop_x0 + col;
                if src_x < bm_w && src_y < bm_h {
                    let idx = ((src_y * bm_w + src_x) * 4) as usize;
                    if idx + 3 < bgra.len() {
                        let b = bgra[idx] as u16;
                        let g = bgra[idx + 1] as u16;
                        let r = bgra[idx + 2] as u16;
                        let a = bgra[idx + 3] as u16;
                        let out_r = ((r * a + 255 * (255 - a)) / 255) as u8;
                        let out_g = ((g * a + 255 * (255 - a)) / 255) as u8;
                        let out_b = ((b * a + 255 * (255 - a)) / 255) as u8;
                        rgba.extend_from_slice(&[out_r, out_g, out_b, 255]);
                    }
```

## Scope

### Files to Modify
1. `inkwell-app/src-tauri/src/state.rs`
2. `inkwell-app/src-tauri/src/commands.rs`

### Files NOT to Touch
- Do NOT alter `inkwell-pdf` crate public structs or WAL journaling format.

## Step-by-Step Implementation

### Step 1: Add `page_text_cache` & `active_tile_renders` to `AppState` in `inkwell-app/src-tauri/src/state.rs`

1. In `CachedPageBitmap` (`commands.rs:780` or `state.rs`): change `bgra: Vec<u8>` to `rgba: Arc<Vec<u8>>`.
2. In `AppState` (`state.rs:74-124`):
   - Add `pub page_text_cache: Mutex<HashMap<u32, Arc<inkwell_pdf::text::PageTextData>>>`
   - Add `pub active_tile_renders: std::sync::atomic::AtomicUsize`
   - In `clear_page_bitmap_cache(&self)` (`commands.rs:880` or `state.rs`), also clear `self.page_text_cache.lock()`.

### Step 2: Pre-Convert BGRA → RGBA Once & Return `Arc<Vec<u8>>` in `page_bitmap_for_scale` (`commands.rs:813-876`)

1. Change return type of `page_bitmap_for_scale` to `Result<(u32, u32, Arc<Vec<u8>>), String>`.
2. On cache hit: return `Ok((entry.width, entry.height, Arc::clone(&entry.rgba)))`.
3. On cache miss, after `let raw_bgra = bitmap.as_raw_bytes();`:
   Convert `raw_bgra` into `rgba_vec` once:
   ```rust
   let mut rgba_vec = vec![255u8; raw_bgra.len()];
   for (src, dst) in raw_bgra.chunks_exact(4).zip(rgba_vec.chunks_exact_mut(4)) {
       let a = src[3];
       if a == 255 {
           dst[0] = src[2];
           dst[1] = src[1];
           dst[2] = src[0];
           dst[3] = 255;
       } else if a == 0 {
           dst[0] = 255;
           dst[1] = 255;
           dst[2] = 255;
           dst[3] = 255;
       } else {
           let a16 = a as u16;
           let inv = 255 - a16;
           dst[0] = ((src[2] as u16 * a16 + 255 * inv) / 255) as u8;
           dst[1] = ((src[1] as u16 * a16 + 255 * inv) / 255) as u8;
           dst[2] = ((src[0] as u16 * a16 + 255 * inv) / 255) as u8;
           dst[3] = 255;
       }
   }
   let arc_rgba = Arc::new(rgba_vec);
   ```
4. Store `Arc::clone(&arc_rgba)` in `PageBitmapLruCache` and return `Ok((actual_w, actual_h, arc_rgba))`.

### Step 3: Fast Row-Slice Tile Crop, Fast PNG Encoding & Prefetch Yielding in `commands.rs`

1. In `render_tile` (`commands.rs:902-969`):
   - Increment `state.active_tile_renders.fetch_add(1, Ordering::AcqRel)` before calling `page_bitmap_for_scale` (and decrement via a drop guard or immediately after `page_bitmap_for_scale` completes).
   - Inside `tokio::task::spawn_blocking`, pre-allocate `let mut rgba = vec![255u8; (ts * ts * 4) as usize];` (already filled with `255` white!).
   - For each row `row in 0..ts`:
     ```rust
     let src_y = crop_y0 + row;
     if src_y >= bm_h || crop_x0 >= bm_w {
         continue; // Already 255 (opaque white)
     }
     let copy_cols = ts.min(bm_w - crop_x0);
     let src_start = ((src_y * bm_w + crop_x0) * 4) as usize;
     let src_end = src_start + (copy_cols * 4) as usize;
     let dst_start = (row * ts * 4) as usize;
     let dst_end = dst_start + (copy_cols * 4) as usize;
     if src_end <= bm_rgba.len() {
         rgba[dst_start..dst_end].copy_from_slice(&bm_rgba[src_start..src_end]);
     }
     ```
   - Encode with fast PNG settings:
     ```rust
     use image::codecs::png::{CompressionType, FilterType, PngEncoder};
     let mut buf = Vec::with_capacity((ts * ts) as usize);
     let encoder = PngEncoder::new_with_quality(&mut buf, CompressionType::Fast, FilterType::NoFilter);
     encoder
         .write_image(&rgba, ts, ts, image::ExtendedColorType::Rgba8)
         .map_err(|e| format!("PNG encode failed: {e}"))?;
     ```

2. In `prefetch_page` (`commands.rs:971-995`):
   - Before rendering each scale, check:
     ```rust
     if state.active_tile_renders.load(std::sync::atomic::Ordering::Acquire) > 0 {
         return Ok(());
     }
     ```

3. In `get_page_text_data`, `get_page_text_spans`, and `search_pdf` (`commands.rs:1580-1682`):
   - Create a helper `get_or_extract_page_text(state: &AppState, page_index: u32) -> Result<Arc<inkwell_pdf::text::PageTextData>, String>` that checks `state.page_text_cache` first, and on a miss extracts `PageTextData`, inserts it into `state.page_text_cache`, and returns `Arc<PageTextData>`.
   - Use `get_or_extract_page_text` in `get_page_text_data`, `get_page_text_spans` (returning `data.spans.clone()`), and `search_pdf`!

## Verification

1. Run Rust tests & clippy:
   ```bash
   cd inkwell && cargo test --workspace -- --test-threads=1 && cargo clippy --all-targets
   ```
2. Run Desktop App Playwright smoke suite:
   ```bash
   cd inkwell-app && python3 test_app_smoke.py
   ```

## STOP Conditions
- STOP if `clear_page_bitmap_cache` does not also clear `page_text_cache`—any page insertion, deletion, rotation, or document reload must invalidate both caches.
