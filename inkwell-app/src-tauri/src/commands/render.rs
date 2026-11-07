//! Page rasterisation for the tile compositor, with the full-page bitmap cache and idle prefetch.

use super::*;

/// Normalize a PDFium page buffer to opaque RGBA by compositing any residual
/// alpha over the white page background. Runs once per rendered page, never per
/// tile, so tile crops stay pure memcpy operations.
fn normalize_page_rgba_in_place(bytes: &mut [u8]) {
    for px in bytes.as_chunks_mut::<4>().0 {
        let a = px[3];
        if a == 255 {
            continue;
        }
        if a == 0 {
            px[0] = 255;
            px[1] = 255;
            px[2] = 255;
            px[3] = 255;
            continue;
        }
        let a16 = a as u16;
        let inv = 255 - a16;
        px[0] = ((px[0] as u16 * a16 + 255 * inv) / 255) as u8;
        px[1] = ((px[1] as u16 * a16 + 255 * inv) / 255) as u8;
        px[2] = ((px[2] as u16 * a16 + 255 * inv) / 255) as u8;
        px[3] = 255;
    }
}

/// Render (or fetch from the LRU cache) a full-page PDFium bitmap at `scale`.
///
/// PDFium page rendering is the expensive part of first paint, so both the
/// visible-tile path and the idle adjacent-page prefetch share this helper.
/// Callers must not hold any state lock when invoking it.
fn page_bitmap_for_scale(
    state: &AppState,
    page: u32,
    scale: f64,
) -> Result<(Arc<Vec<u8>>, u32, u32), String> {
    let arc_bytes = state
        .pdf_bytes
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?
        .clone()
        .ok_or("No PDF loaded")?;

    let (page_w, page_h) = {
        let dim_guard = state.page_dimensions.lock().map_err(|e| format!("Lock error: {e}"))?;
        dim_guard.get(&page).copied().unwrap_or((595.0, 842.0))
    };

    let target_w = ((page_w * scale).round().max(1.0) as i32).min(4096);
    let target_h = ((page_h * scale).round().max(1.0) as i32).min(4096);

    let cached = {
        let mut cache_guard = state.page_bitmap_cache.lock().map_err(|e| format!("Lock error: {e}"))?;
        cache_guard.get(page, target_w, target_h)
    };
    if let Some(cached_data) = cached {
        return Ok(cached_data);
    }

    let pdfium_guard = state.pdfium.lock().map_err(|e| format!("Lock error: {e}"))?;
    let cached_inside = {
        let mut cache_guard = state.page_bitmap_cache.lock().map_err(|e| format!("Lock error: {e}"))?;
        cache_guard.get(page, target_w, target_h)
    };
    if let Some(cached_data) = cached_inside {
        return Ok(cached_data);
    }

    let pdfium = pdfium_guard.as_ref().ok_or_else(|| {
        "PDFium is not available (pdfium.dll was not found at startup). \
         PDF tiles cannot be rendered.".to_string()
    })?;

    let started = Instant::now();
    let mut doc = pdfium
        .load_pdf_from_byte_slice(&arc_bytes, None)
        .map_err(|e| format!("PDFium load error: {e:?}"))?;

    let mut page_obj = doc.pages_mut().get(page as i32).map_err(|e| format!("PDFium page error: {e:?}"))?;

    // Filter out InkWell-authored annotations in-memory so they are not baked into
    // the background bitmap tile (avoiding ghosting and preserving full interactive erasing/selection).
    // Third-party annotations (from Okular, Acrobat, Drawboard, etc.) are preserved and rendered.
    let annot_count = page_obj.annotations().len();
    for i in (0..annot_count).rev() {
        let is_inkwell = if let Ok(annot) = page_obj.annotations().get(i) {
            annot.creator().as_deref() == Some("Inkwell")
        } else {
            false
        };
        if is_inkwell {
            let annots = page_obj.annotations_mut();
            if let Ok(annot) = annots.get(i) {
                let _ = annots.delete_annotation(annot);
            }
        }
    }

    let actual_w = page_obj.width().value as f64;
    let actual_h = page_obj.height().value as f64;
    let target_w = ((actual_w * scale).round().max(1.0) as i32).min(4096);
    let target_h = ((actual_h * scale).round().max(1.0) as i32).min(4096);

    let config = PdfRenderConfig::new()
        .set_target_width(target_w)
        .set_maximum_height(target_h)
        .set_clear_color(PdfColor::WHITE)
        .render_annotations(true);

    let bitmap = page_obj.render_with_config(&config).map_err(|e| {
        format!("PDFium failed to render page {page}: {e:?}")
    })?;

    // PDFium renders with FPDF_REVERSE_BYTE_ORDER (pdfium-render's default), so
    // the buffer is already RGBA. Composite any residual alpha over white ONCE
    // here instead of re-blending every pixel of every tile crop.
    let mut normalized = bitmap.as_raw_bytes();
    normalize_page_rgba_in_place(&mut normalized);
    let rgba = Arc::new(normalized);
    let bw = bitmap.width() as u32;
    let bh = bitmap.height() as u32;

    let mut cache_guard = state.page_bitmap_cache.lock().map_err(|e| format!("Lock error: {e}"))?;
    cache_guard.put(CachedPageBitmap {
        page,
        target_w,
        target_h,
        rgba_bytes: rgba.clone(),
        bitmap_w: bw,
        bitmap_h: bh,
    });

    if let Ok(mut dim_guard) = state.page_dimensions.lock() {
        dim_guard.insert(page, (actual_w, actual_h));
    }

    if std::env::var_os("INKWELL_PROFILE_TILES").is_some() {
        eprintln!("[inkwell/tile] page {page} rendered {bw}x{bh} at scale {scale:.3} in {} ms", started.elapsed().as_millis());
    }

    Ok((rgba, bw, bh))
}

#[tauri::command]
pub async fn render_tile(
    page: u32,
    rect: [f64; 4],
    px: u32,
    state: State<'_, AppState>,
) -> Result<tauri::ipc::Response, String> {
    // Cap tile resolution to bound the IPC payload size (RGBA = w*h*4 bytes).
    let px = px.clamp(16, 2048);
    if !(rect[0].is_finite() && rect[1].is_finite() && rect[2].is_finite() && rect[3].is_finite())
        || rect[2] <= rect[0]
        || rect[3] <= rect[1]
    {
        return Err(format!("Invalid tile rectangle: {rect:?}"));
    }

    if std::env::var_os("INKWELL_PROFILE_TILES").is_some() {
        eprintln!("[inkwell/tile] request page {page} rect {rect:?} px {px}");
    }

    let rw = (rect[2] - rect[0]).max(1.0);
    let rh = (rect[3] - rect[1]).max(1.0);
    // Standardize scale against the 512pt grid tile size when px >= 64 and rw/rh <= 512,
    // so boundary-clipped tiles (< 512pt wide/tall) hit the same cached full-page bitmap.
    let base_span = if rw <= 512.0 && rh <= 512.0 { 512.0 } else { rw.max(rh) };
    let scale = (px as f64) / base_span;

    // Track that a user-visible tile is waiting so the idle prefetcher can yield
    // instead of holding the PDFium lock for an off-screen page.
    state
        .active_tile_renders
        .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    let (rgba_bytes, bitmap_w, bitmap_h) = {
        let _guard = ActiveTileRenderGuard(&state.active_tile_renders);
        page_bitmap_for_scale(state.inner(), page, scale)?
    };

    // Offload the tile crop to a worker thread. The source page bitmap is
    // normalized RGBA, so cropping is one memcpy per row.
    tauri::async_runtime::spawn_blocking(move || {
        let out_w = (rw * scale).round().max(1.0) as u32;
        let out_h = (rh * scale).round().max(1.0) as u32;

        let x0 = (rect[0] * scale).round().max(0.0) as u32;
        let y0 = (rect[1] * scale).round().max(0.0) as u32;

        let mut rgba_data = vec![255u8; (out_w * out_h * 4) as usize];
        if x0 < bitmap_w && y0 < bitmap_h {
            let copy_cols = out_w.min(bitmap_w.saturating_sub(x0));
            let copy_rows = out_h.min(bitmap_h.saturating_sub(y0));
            let row_bytes = (copy_cols * 4) as usize;

            for row in 0..copy_rows {
                let src_start = (((y0 + row) * bitmap_w + x0) * 4) as usize;
                let src_end = src_start + row_bytes;
                let dst_start = ((row * out_w) * 4) as usize;
                let dst_end = dst_start + row_bytes;
                if src_end <= rgba_bytes.len() {
                    rgba_data[dst_start..dst_end].copy_from_slice(&rgba_bytes[src_start..src_end]);
                }
            }
        }

        let expected_len = (out_w as usize) * (out_h as usize) * 4;
        if rgba_data.len() != expected_len {
            return Err(format!(
                "PDFium returned an invalid tile buffer for page {page}: expected {expected_len} RGBA bytes ({out_w}x{out_h}), got {}",
                rgba_data.len()
            ));
        }

        Ok(tauri::ipc::Response::new(rgba_data))
    })
    .await
    .map_err(|e| format!("Tile worker task failed: {e}"))?
}

/// Warm the full-page bitmap cache for an off-screen page without paying the
/// cost of transferring its pixels to the webview. The frontend calls this from
/// an idle callback for the next page so scrolling lands on a ready bitmap.
#[tauri::command]
pub async fn prefetch_page(
    page: u32,
    px: u32,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let px = px.clamp(64, 2048);
    // Never fight a tile the user is actually waiting on: prefetch is idle work.
    if state
        .active_tile_renders
        .load(std::sync::atomic::Ordering::Acquire)
        > 0
    {
        return Ok(false);
    }
    let scale = (px as f64) / 512.0;
    let started = Instant::now();
    page_bitmap_for_scale(state.inner(), page, scale)?;
    if std::env::var_os("INKWELL_PROFILE_TILES").is_some() {
        eprintln!("[inkwell/tile] prefetched page {page} at scale {scale:.3} in {} ms", started.elapsed().as_millis());
    }
    Ok(true)
}

#[cfg(test)]
mod tile_pipeline_tests {
    use super::*;

    #[test]
    fn opaque_pixels_pass_through_unchanged() {
        let mut px = vec![12u8, 34, 56, 255, 200, 100, 50, 255];
        normalize_page_rgba_in_place(&mut px);
        assert_eq!(px, vec![12u8, 34, 56, 255, 200, 100, 50, 255]);
    }

    #[test]
    fn fully_transparent_pixels_become_white() {
        let mut px = vec![0u8, 0, 0, 0, 255, 255, 255, 0];
        normalize_page_rgba_in_place(&mut px);
        assert_eq!(px, vec![255u8; 8]);
    }

    #[test]
    fn partial_alpha_is_composited_over_white() {
        let mut px = vec![0u8, 0, 0, 128];
        normalize_page_rgba_in_place(&mut px);
        // 128/255 of black over white ≈ 127
        assert_eq!(px[3], 255);
        assert!((px[0] as i32 - 127).abs() <= 1, "got {}", px[0]);
        assert!((px[1] as i32 - 127).abs() <= 1, "got {}", px[1]);
        assert!((px[2] as i32 - 127).abs() <= 1, "got {}", px[2]);
    }

    #[test]
    fn trailing_bytes_without_a_full_pixel_are_ignored() {
        let mut px = vec![10u8, 20, 30, 255, 7];
        normalize_page_rgba_in_place(&mut px);
        assert_eq!(px, vec![10u8, 20, 30, 255, 7]);
    }
}
