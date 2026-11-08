//! PDF form fields (Plan 096): list the open document's AcroForm fields for
//! the fill overlay, and journal values the user sets. Values are written
//! into the PDF (with fresh appearances) by the next save, from
//! `Document::form_values`.

use super::*;
use inkwell_core::forms::{FieldKind, FormField};

#[derive(Debug, Clone, Serialize)]
pub struct WidgetDto {
    pub page: usize,
    /// Tab order within the page (`/Annots` position).
    pub order: usize,
    /// Page space: points from the page's top-left, y down.
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub on_state: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FieldDto {
    pub name: String,
    pub kind: FieldKind,
    /// The value to show: what the user set this session, else the file's.
    pub value: String,
    /// The value the current page rendering shows (the saved file's).
    pub rendered_value: String,
    pub options: Vec<(String, String)>,
    pub read_only: bool,
    pub multiline: bool,
    pub comb: bool,
    pub max_len: Option<u32>,
    pub quadding: u8,
    pub font_size: f64,
    pub color: [f64; 3],
    pub widgets: Vec<WidgetDto>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct FormDto {
    pub fields: Vec<FieldDto>,
    pub has_scripts: bool,
    pub xfa: bool,
}

pub(crate) fn form_dto(bytes: &[u8], pending: &std::collections::BTreeMap<String, String>) -> FormDto {
    let Ok(file) = PdfFile::open(bytes.to_vec()) else { return FormDto::default() };
    let info = file.form_fields();
    let to_dto = |f: FormField| -> Option<FieldDto> {
        if matches!(f.kind, FieldKind::Button | FieldKind::Signature) {
            return None;
        }
        let widgets: Vec<WidgetDto> = f
            .widgets
            .iter()
            .filter_map(|w| {
                let page = w.page?;
                let b = file.page_box_at(page)?;
                Some(WidgetDto {
                    page,
                    order: w.order,
                    x: w.rect[0] - b[0],
                    y: b[3] - w.rect[3],
                    w: w.rect[2] - w.rect[0],
                    h: w.rect[3] - w.rect[1],
                    on_state: w.on_state.clone(),
                })
            })
            .collect();
        if widgets.is_empty() {
            return None;
        }
        Some(FieldDto {
            value: pending.get(&f.name).cloned().unwrap_or_else(|| f.value.clone()),
            rendered_value: f.value,
            name: f.name,
            kind: f.kind,
            options: f.options,
            read_only: f.read_only,
            multiline: f.multiline,
            comb: f.comb,
            max_len: f.max_len,
            quadding: f.quadding,
            font_size: f.font_size,
            color: f.color,
            widgets,
        })
    };
    FormDto { fields: info.fields.into_iter().filter_map(to_dto).collect(), has_scripts: info.has_scripts, xfa: info.xfa }
}

#[tauri::command]
pub async fn get_form_fields(state: State<'_, AppState>) -> Result<FormDto, String> {
    let Some(bytes) = state.pdf_bytes.lock().map_err(|e| format!("Lock error: {e}"))?.clone() else {
        return Ok(FormDto::default());
    };
    let pending = state.doc.lock().unwrap().as_ref().map(|d| d.form_values.clone()).unwrap_or_default();
    Ok(form_dto(&bytes, &pending))
}

/// Set a field's value (journalled); the next save writes it into the PDF.
#[tauri::command]
pub async fn set_form_value(name: String, value: String, seq: Option<u64>, state: State<'_, AppState>) -> Result<bool, String> {
    if name.is_empty() || name.len() > 4096 || value.len() > 1_000_000 {
        return Err("invalid form value".to_string());
    }
    let seq = journal_seq(state.inner(), seq);
    {
        let mut g = state.doc.lock().unwrap();
        let doc = g.as_mut().ok_or("No document open")?;
        doc.form_values.insert(name.clone(), value.clone());
    }
    if let Some(tx) = state.wal.lock().unwrap().as_ref() {
        let _ = tx.send(WalOp::Append(WalEntry::FieldValue { name, value }, seq));
    }
    state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_come_in_page_space_with_pending_values() {
        let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../inkwell/fixtures/forms/all_fields.pdf")).unwrap();
        let mut pending = std::collections::BTreeMap::new();
        pending.insert("name".to_string(), "Grace".to_string());
        let dto = form_dto(&bytes, &pending);
        let name = dto.fields.iter().find(|f| f.name == "name").unwrap();
        assert_eq!((name.value.as_str(), name.rendered_value.as_str()), ("Grace", "Ada Lovelace"));
        let w = &name.widgets[0];
        // /Rect [100 700 400 724] on a 792 pt tall page
        assert_eq!((w.x, w.y, w.w, w.h), (100.0, 68.0, 300.0, 24.0));
        assert_eq!(dto.fields.iter().find(|f| f.name == "size").unwrap().widgets.len(), 2);
    }
}
