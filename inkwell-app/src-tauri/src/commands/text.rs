//! PDF text: search, per-page spans and character data, and the outline.

use super::*;

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResultItem {
    pub page_index: usize,
    pub snippet: String,
    pub match_count: usize,
}

#[tauri::command]
pub async fn search_pdf(
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<SearchResultItem>, String> {
    let query_trimmed = query.trim();
    if query_trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let bytes = state
        .pdf_bytes
        .lock()
        .unwrap()
        .clone()
        .ok_or("No PDF loaded")?;

    let pdfium_guard = state.pdfium.lock().unwrap();
    let pdfium = pdfium_guard.as_ref().ok_or("PDFium not available")?;

    let doc = pdfium
        .load_pdf_from_byte_slice(&bytes, None)
        .map_err(|e| format!("PDFium load error: {e:?}"))?;

    let mut results = Vec::new();
    let q_lower = query_trimmed.to_lowercase();
    let n_pages = doc.pages().len() as usize;

    let q_chars: Vec<char> = q_lower.chars().collect();
    for i in 0..n_pages {
        let page_index = i as u32;
        // Reuse the memoized page text model: a full-document search must not
        // re-parse every page through PDFium on each keystroke.
        let data = match cached_page_text(state.inner(), page_index) {
            Some(cached) => cached,
            None => {
                let extracted = inkwell_pdf::extract_page_text_data(&doc, page_index);
                store_page_text(state.inner(), page_index, extracted)
            }
        };
        if data.text.is_empty() {
            continue;
        }

        let text_chars: Vec<char> = data.text.chars().collect();
        let text_lower: String = data.text.to_lowercase();
        let text_lower_chars: Vec<char> = text_lower.chars().collect();

        if !q_chars.is_empty() {
            if let Some(char_idx) = text_lower_chars.windows(q_chars.len()).position(|w| w == q_chars.as_slice()) {
                let start = char_idx.saturating_sub(40).min(text_chars.len());
                let end = (char_idx + q_chars.len() + 40).min(text_chars.len()).max(start);
                let snippet_str: String = text_chars[start..end].iter().collect();
                let snippet = format!(
                    "{}{}{}",
                    if start > 0 { "…" } else { "" },
                    snippet_str.replace('\n', " "),
                    if end < text_chars.len() { "…" } else { "" }
                );
                let match_count = text_lower_chars.windows(q_chars.len()).filter(|w| *w == q_chars.as_slice()).count();
                results.push(SearchResultItem {
                    page_index: i,
                    snippet,
                    match_count,
                });
            }
        }
    }

    Ok(results)
}

#[tauri::command]
pub async fn get_page_text_spans(
    page_index: usize,
    state: State<'_, AppState>,
) -> Result<Vec<inkwell_pdf::TextSpan>, String> {
    if let Some(cached) = cached_page_text(state.inner(), page_index as u32) {
        return Ok(cached.spans.clone());
    }

    let bytes_opt = state.pdf_bytes.lock().unwrap().clone();
    let Some(bytes) = bytes_opt else {
        return Ok(Vec::new());
    };

    let pdfium_guard = state.pdfium.lock().unwrap();
    let pdfium = pdfium_guard.as_ref().ok_or("PDFium not available")?;

    let doc = pdfium
        .load_pdf_from_byte_slice(&bytes, None)
        .map_err(|e| format!("PDFium load error: {e:?}"))?;

    let data = inkwell_pdf::extract_page_text_data(&doc, page_index as u32);
    let spans = data.spans.clone();
    store_page_text(state.inner(), page_index as u32, data);
    Ok(spans)
}

#[tauri::command]
pub async fn get_page_text_data(
    page_index: usize,
    state: State<'_, AppState>,
) -> Result<inkwell_pdf::PageTextData, String> {
    if let Some(cached) = cached_page_text(state.inner(), page_index as u32) {
        return Ok((*cached).clone());
    }

    let bytes_opt = state.pdf_bytes.lock().unwrap().clone();
    let Some(bytes) = bytes_opt else {
        return Ok(inkwell_pdf::PageTextData {
            page_index,
            text: String::new(),
            lines: Vec::new(),
            chars: Vec::new(),
            spans: Vec::new(),
        });
    };

    let pdfium_guard = state.pdfium.lock().unwrap();
    let pdfium = pdfium_guard.as_ref().ok_or("PDFium not available")?;

    let doc = pdfium
        .load_pdf_from_byte_slice(&bytes, None)
        .map_err(|e| format!("PDFium load error: {e:?}"))?;

    let data = inkwell_pdf::extract_page_text_data(&doc, page_index as u32);
    Ok((*store_page_text(state.inner(), page_index as u32, data)).clone())
}

#[tauri::command]
pub async fn get_pdf_outline(state: State<'_, AppState>) -> Result<Vec<inkwell_pdf::TocItem>, String> {
    let bytes = state
        .pdf_bytes
        .lock()
        .unwrap()
        .clone()
        .ok_or("No PDF loaded")?;

    let pdfium_guard = state.pdfium.lock().unwrap();
    let pdfium = pdfium_guard.as_ref().ok_or("PDFium not available")?;

    let doc = pdfium
        .load_pdf_from_byte_slice(&bytes, None)
        .map_err(|e| format!("PDFium load error: {e:?}"))?;

    Ok(inkwell_pdf::extract_outline(&doc))
}
