use inkwell_core::pdf::PdfFile;
use inkwell_core::pdfobj::Error as PdfObjError;
use pdfium_render::prelude::*;
use log::debug;

#[derive(Debug)]
pub enum NormaliseError {
    PdfiumInit,
    PdfiumLoad,
    PdfiumSave,
    ParseFailed(PdfObjError),
}

/// Repair a PDF that `inkwell_core::pdfobj` cannot parse by re-serialising
/// it through PDFium.
///
/// Since Plan 088 our reader handles classic tables, xref streams, object
/// streams and linearized files natively, so this runs only for genuinely
/// damaged files (broken xref, bad offsets PDFium reconstructs). It rewrites
/// the whole file, so callers must keep the original and tell the user.
///
/// If the input already parses, it is returned unchanged.
pub fn normalise(pdfium: &Pdfium, input: &[u8]) -> Result<Vec<u8>, NormaliseError> {
    // 1. First try opening with our parser
    match PdfFile::open(input.to_vec()) {
        Ok(_) => {
            debug!("PDF parses natively; no repair needed.");
            return Ok(input.to_vec());
        }
        Err(e) => {
            debug!("PDF parsing failed ({:?}). Repairing with PDFium...", e);
        }
    }

    // 2. Load with PDFium
    let doc = pdfium.load_pdf_from_byte_slice(input, None).map_err(|_| NormaliseError::PdfiumLoad)?;

    // 3. Save back (this re-serialises to classic xref by default)
    let output = doc.save_to_bytes().map_err(|_| NormaliseError::PdfiumSave)?;

    // 4. Verify output
    match PdfFile::open(output.clone()) {
        Ok(_) => Ok(output),
        Err(e) => Err(NormaliseError::ParseFailed(e)),
    }
}
