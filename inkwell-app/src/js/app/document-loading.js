/**
 * Turning an opened PDF into session state, plus the open/new-whiteboard flows and their progress UI.
 * (Split out of main.js by Plan 093; behaviour unchanged.)
 */

import { state, $, on } from '../core/state.js';
import * as documentOps from '../core/document.js';
import * as ipc from '../core/ipc.js';
import * as navigation from '../workspace/navigation.js';
import * as scrollbar from '../workspace/scrollbar.js';
import * as annotations from '../workspace/annotations.js';
import * as toast from '../ui/toast.js';
import * as toolbar from '../ui/toolbar.js';
import * as drawers from '../ui/drawers.js';
import { getViewport } from '../app/viewport-ref.js';
import { checkForConflictCopies } from '../ui/merge.js';
import * as shapesModel from '../core/shapes-model.js';
import * as forms from '../workspace/forms.js';
import { finishFirstRun } from '../ui/first-run.js';

export function handlePdfLoadResult(title, pathStr, res, { preserveAnnotations = false } = {}) {
  if (!res) { hideOpenProgress(); return; }
  hideOpenProgress();
  // Capture the live annotation lists BEFORE setDocument replaces them, so a
  // non-destructive reload can keep every unsaved stroke/image/note.
  const liveStrokes = preserveAnnotations ? (state.strokes || []).slice() : null;
  const liveImages = preserveAnnotations ? (state.images || []).slice() : null;
  const liveTexts = preserveAnnotations ? (state.textObjects || []).slice() : null;
  const liveBookmarks = preserveAnnotations ? (state.bookmarks || []).slice() : null;
  const pageInfos = res.page_infos || (Array.isArray(res) ? res : []);
  // Plan 095: shapes live in the stroke list as shape strokes.
  const loadedStrokes = (res.loaded_strokes || []).concat((res.loaded_shapes || []).map(shapesModel.fromBackendShape));
  const loadedImages = res.loaded_images || [];
  const loadedTexts = res.loaded_texts || [];
  const outline = res.outline || [];
  const bookmarks = (res.bookmarks || []).map(b => ({
    id: b.id,
    page: b.page,
    label: b.label,
    createdAt: b.created_at || b.createdAt || Date.now(),
  }));

  state.outline = outline;
  state.bookmarks = bookmarks;
  state.currentDocPath = pathStr;
  state.currentDocTitle = title;

  documentOps.setDocument({
    pageInfos,
    strokes: liveStrokes || loadedStrokes,
    images: liveImages || loadedImages,
    textObjects: liveTexts || loadedTexts,
    bookmarks: liveBookmarks || bookmarks,
  });

  if (preserveAnnotations) {
    // Kept annotations are by definition not yet on disk.
    state.isDirty = true;
    toolbar.updateSaveStatusUI('dirty');
  }

  if (getViewport() && pageInfos.length > 0) {
    getViewport().updateDocumentLayout(pageInfos);
    getViewport().fitPage(pageInfos[0].width_pt, pageInfos[0].height_pt, 'left');
  }

  $('welcomeDropzone') && $('welcomeDropzone').classList.add('hidden');
  navigation.goToPage(0, 'left', getViewport(), false);
  scrollbar.updateDocScrollbar(getViewport());
  drawers.renderOutline();
  drawers.renderBookmarks();
  annotations.resetAnnotationsView();
  const pageBadge = $('badgeThumbnails');
  if (pageBadge) pageBadge.textContent = String(pageInfos.length || 1);
  annotations.scheduleAnnotationRefresh();
  if (typeof window.emitZoomChanged === 'function' && getViewport()) {
    window.emitZoomChanged(getViewport());
  }

  const totalRecovered = (res.recovered_strokes || 0) + (res.recovered_images || 0) + (res.recovered_texts || 0);
  if (totalRecovered > 0) {
    toast.showToast(`Restored ${totalRecovered} items from crash recovery log`, 'info');
  }

  // Changes set aside by "Don't Save" on the last quit (Plan 090): offered,
  // never applied silently. Restoring reopens the file with them replayed;
  // edits made since opening are journalled too, so nothing is lost.
  const shelved = res.shelved_journal_entries || 0;
  if (shelved > 0 && pathStr) {
    toast.showToast(
      `You chose not to save ${shelved} change${shelved === 1 ? '' : 's'} when you last closed this file.`,
      'info',
      { actions: [{ label: 'Restore them', onClick: () => restoreShelvedChanges(title, pathStr) }] },
    );
  }

  // A document is open: the getting-started cards have done their job.
  finishFirstRun();

  // The PDF's own form fields (Plan 096).
  if (pathStr) setTimeout(() => { forms.loadForm(); }, 300);
  else forms.clearForm();

  // Conflict copies left by a sync client (Plan 092): offered, never merged silently.
  if (pathStr) setTimeout(() => { checkForConflictCopies(); }, 600);

  const warm = () => {
    const t0 = performance.now();
    for (const s of state.strokes || []) {
      if (!s.deleted && !s._cachedPath2D && window.Ink && typeof window.Ink.getPath2D === 'function') {
        s._cachedPath2D = window.Ink.getPath2D(s);
        if (typeof window.Ink.computeStrokeBbox === 'function') {
          s.bbox = window.Ink.computeStrokeBbox(s.points, s.base_width);
        }
        if (performance.now() - t0 > 8) {
          setTimeout(warm, 32);
          return;
        }
      }
    }
  };
  setTimeout(warm, 200);
}

// ---- External file modification guard (cloud sync / other editors) ----

export async function openFileTrigger() {
  const invoke = ipc.getInvoke();
  if (invoke) {
    showOpenProgress('Reading document…');
    try {
      const res = await ipc.openPdfDialog();
      if (res && res[0]) {
        const pathStr = res[0];
        const r = res[1] || {};
        const title = pathStr.split('\\').pop().split('/').pop();
        showOpenProgress('Preparing page layout…');
        handlePdfLoadResult(title, pathStr, r);
        return;
      }
    } catch (e) {
      if (e !== 'CANCELLED' && e !== 'No file selected') {
        console.warn('[inkwell] openPdfDialog failed, falling back to input:', e);
      }
    } finally {
      hideOpenProgress();
    }
  }
  $('pdfFileInput') && $('pdfFileInput').click();
}

export function friendlyError(e) {
  if (typeof e === 'string') {
    if (/CANCELLED/i.test(e)) return null;
    if (/lock|denied|permission/i.test(e)) return 'File is locked — close it in other apps and retry.';
    if (/No document open|No PDF/i.test(e)) return 'Open a document first.';
    return e;
  }
  return (e && e.message) ? e.message : 'Unexpected error';
}

export function showOpenProgress(message = 'Preparing page layout…') {
  const overlay = $('openProgressOverlay');
  const msg = $('openProgressMsg');
  if (msg) msg.textContent = message;
  if (overlay) overlay.classList.remove('hidden');
}

export function hideOpenProgress() {
  const overlay = $('openProgressOverlay');
  if (overlay) overlay.classList.add('hidden');
}

export async function createNewWhiteboard() {
  try {
    const res = await ipc.newWhiteboard();
    if (res) {
      handlePdfLoadResult('Untitled Note', null, res);
      toast.showToast('Created new whiteboard PDF', 'success');
      return;
    }
  } catch (e) {
    const msg = friendlyError(e);
    if (msg) toast.showToast('Failed to create whiteboard: ' + msg, 'error');
  }
  // Immediate client fallback so document layout is active on first render
  handlePdfLoadResult('Untitled Note', null, {
    page_infos: [{ page_index: 0, width_pt: 842.0, height_pt: 595.0, template: 'blank' }],
    loaded_strokes: [],
    loaded_images: [],
    loaded_texts: [],
    outline: [],
  });
}

/** Reopen `pathStr` with the changes "Don't Save" set aside folded back in. */
export async function restoreShelvedChanges(title, pathStr) {
  showOpenProgress('Restoring set-aside changes…');
  try {
    const res = await ipc.openPdf(pathStr, { restoreShelved: true });
    if (res) {
      handlePdfLoadResult(title, pathStr, res);
      toast.showToast('Restored the changes you had set aside', 'success');
    }
  } catch (err) {
    const msg = friendlyError(err);
    if (msg) toast.showToast('Could not restore: ' + msg, 'error');
  } finally {
    hideOpenProgress();
  }
}
