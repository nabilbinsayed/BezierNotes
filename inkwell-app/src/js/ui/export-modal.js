/**
 * The export dialog: page-range parsing, annotated-page detection and the export calls (Plan 085).
 * (Split out of main.js by Plan 093; behaviour unchanged.)
 */

import { state, $ } from '../core/state.js';
import * as ipc from '../core/ipc.js';
import * as templates from '../render/templates.js';
import * as annotations from '../workspace/annotations.js';
import * as toast from '../ui/toast.js';
import * as toolbar from '../ui/toolbar.js';
import { friendlyError } from '../app/document-loading.js';

export function prepareAllImagesForSave() {
  const templateImages = (state.pageInfos || [])
    .map((pi, idx) => (pi && pi.template && pi.template !== 'blank') ? templates.renderPageTemplateBackgroundToDataUrl(pi, idx) : null)
    .filter(Boolean);
  const nonDeletedImages = (state.images || []).filter(img => !img.deleted && (!img.id || (!img.id.startsWith('template_bg_') && !img.id.startsWith('img_template_bg_'))));
  return [...templateImages, ...nonDeletedImages];
}

/**
 * Parse a user page-range specification into sorted, deduplicated 0-based page
 * indices clamped to the document. Accepts "1-3, 5, 8-10" style input.
 * @param {string} specStr
 * @param {number} totalPages
 * @returns {number[]}
 */
export function parsePageRangeSpec(specStr, totalPages) {
  const total = Math.max(0, Number(totalPages) || 0);
  if (typeof specStr !== 'string' || !specStr.trim()) return [];
  const picked = new Set();
  for (const rawPart of specStr.split(',')) {
    const part = rawPart.trim();
    if (!part) continue;
    const match = part.match(/^(\d+)\s*(?:[-\u2013]\s*(\d+))?$/);
    if (!match) continue;
    let from = parseInt(match[1], 10);
    let to = match[2] !== undefined ? parseInt(match[2], 10) : from;
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    if (from > to) {
      const swap = from;
      from = to;
      to = swap;
    }
    for (let page = from; page <= to; page++) {
      const idx = page - 1;
      if (idx >= 0 && idx < total) picked.add(idx);
    }
  }
  return Array.from(picked).sort((a, b) => a - b);
}

/** Pages that actually carry user annotations (ink, images or text objects). */
export function computeAnnotatedPages() {
  const sheets = new Set();
  for (const s of (state.strokes || [])) {
    if (!s.deleted) sheets.add(s.sheet || 0);
  }
  for (const img of (state.images || [])) {
    if (img.deleted) continue;
    if (img.id && (img.id.startsWith('template_bg_') || img.id.startsWith('img_template_bg_'))) continue;
    sheets.add(img.sheet || 0);
  }
  for (const t of (state.textObjects || [])) {
    if (!t.deleted) sheets.add(t.sheet || 0);
  }
  return Array.from(sheets).sort((a, b) => a - b);
}

export function syncExportCustomInputVisibility() {
  const sel = $('exportRangeMode');
  const input = $('exportCustomRangeInput');
  if (!sel || !input) return;
  input.classList.toggle('hidden', sel.value !== 'custom');
  if (sel.value === 'custom') {
    input.setAttribute('aria-hidden', 'false');
  } else {
    input.setAttribute('aria-hidden', 'true');
  }
}

/** Refresh the export modal's labels/hints when it opens or the filter changes. */
export function refreshExportModal() {
  const total = (state.pageInfos || []).length || 1;
  const annotated = computeAnnotatedPages();
  const sel = $('exportRangeMode');
  if (sel) {
    const option = sel.querySelector('option[value="annotated"]');
    if (option) option.textContent = `Annotated Pages Only (${annotated.length})`;
    const currentOption = sel.querySelector('option[value="current"]');
    if (currentOption) currentOption.textContent = `Current Page Only (${(state.leftSheet || 0) + 1})`;
  }
  const hint = $('exportRangeHint');
  if (hint) {
    hint.textContent = `${total} page${total === 1 ? '' : 's'} in this document · ${annotated.length} annotated`;
  }
  syncExportCustomInputVisibility();
}

/** Export the document to a new file without touching the live session. */
export async function exportPdfWithDialog({ selectedPages = null, flatten = false } = {}) {
  try {
    state.isSaving = true;
    toolbar.updateSaveStatusUI('saving');
    const imagesToSave = prepareAllImagesForSave();
    await ipc.exportPdfCustom({
      selectedPages,
      flatten,
      strokes: state.strokes,
      images: imagesToSave,
      texts: state.textObjects,
    });
    toolbar.updateSaveStatusUI(state.isDirty ? 'dirty' : 'saved');
    toast.showToast(
      flatten ? 'Flattened read-only PDF exported' : 'PDF copy exported successfully',
      'success',
    );
    return true;
  } catch (e) {
    const msg = friendlyError(e);
    if (msg && msg !== 'CANCELLED') toast.showToast('Export failed: ' + msg, 'error');
    toolbar.updateSaveStatusUI(state.isDirty ? 'dirty' : 'saved');
    return false;
  } finally {
    state.isSaving = false;
  }
}

/** Apply the smart-export controls and dispatch the export. */
export async function exportWithSelectedOptions() {
  const totalPages = (state.pageInfos || []).length || 1;
  const mode = $('exportRangeMode') ? $('exportRangeMode').value : 'all';
  let selectedPages = null;

  if (mode === 'current') {
    selectedPages = [state.leftSheet || 0];
  } else if (mode === 'annotated') {
    selectedPages = computeAnnotatedPages();
  } else if (mode === 'custom') {
    selectedPages = parsePageRangeSpec($('exportCustomRangeInput') ? $('exportCustomRangeInput').value : '', totalPages);
  }

  if (Array.isArray(selectedPages) && selectedPages.length === 0) {
    toast.showToast('No pages match the selected export filter', 'warning');
    return false;
  }

  const flatten = !!($('exportFlattenCheckbox') && $('exportFlattenCheckbox').checked);
  $('exportModal') && $('exportModal').classList.add('hidden');
  return exportPdfWithDialog({ selectedPages, flatten });
}
