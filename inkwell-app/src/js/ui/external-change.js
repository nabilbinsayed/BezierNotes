/**
 * The "changed on disk" banner and reload flow (Plan 086).
 * (Split out of main.js by Plan 093; behaviour unchanged.)
 */

import { state, $, on } from '../core/state.js';
import * as ipc from '../core/ipc.js';
import * as annotations from '../workspace/annotations.js';
import * as toast from '../ui/toast.js';
import * as commandsModule from '../core/commands.js';
import { friendlyError, handlePdfLoadResult, hideOpenProgress, showOpenProgress } from '../app/document-loading.js';
import { openMergePreview } from './merge.js';

export function showExternalChangeBanner() {
  const banner = $('externalChangeBanner');
  if (!banner) return;
  const title = $('externalChangeTitle');
  const detail = $('externalChangeDetail');
  const name = (state.currentDocPath || '').split(/[\\/]/).pop();
  if (title) title.textContent = name ? `${name} changed on disk` : 'This PDF changed on disk';
  if (detail) {
    detail.textContent = state.isDirty
      ? 'Another app or cloud sync updated the file. Autosave is paused until you choose; your unsaved annotations are safe either way.'
      : 'Another app or cloud sync updated the file. Autosave is paused until you choose.';
  }
  banner.classList.remove('hidden');
}

/** Close the banner because the user resolved the change. */
function resolveExternalChange() {
  state.externalChangePending = false;
  hideExternalChangeBanner();
}

/**
 * "Merge" (Plan 092): fold the changed file into this session instead of
 * choosing one version. Falls back to the other choices when the file on disk
 * can't be merged (e.g. it is a different document now).
 */
export function mergeExternal() {
  return openMergePreview(null, {
    onApplied: () => resolveExternalChange(),
    onMerged: () => toast.showToast('Merged the changed file into your version and saved.', 'success'),
  });
}

/**
 * "Keep mine": carry on with this version. The backend already re-stamped the
 * file when it reported the change, so the next save overwrites it without a
 * second alarm.
 */
export function keepMineExternal() {
  resolveExternalChange();
  toast.showToast('Keeping your version. Your next save replaces the changed file.', 'info');
}

/**
 * "Save a copy": write this version to a new file (Save As, prefilled) and
 * continue there, leaving the changed file untouched.
 */
export async function saveCopyExternal() {
  const path = state.currentDocPath || '';
  const stem = (path.split(/[\\/]/).pop() || 'Document.pdf').replace(/\.pdf$/i, '');
  const ok = await commandsModule.commands.execute('file.save', { saveAsCopyName: `${stem} (BezierNotes copy).pdf` });
  if (ok) {
    resolveExternalChange();
    toast.showToast('Saved your version as a copy; the changed file was left as it is.', 'success');
  }
  return ok;
}

export function hideExternalChangeBanner() {
  const banner = $('externalChangeBanner');
  if (banner) banner.classList.add('hidden');
}

export let _externalCheckBusy = false;

/**
 * Poll the backend for an out-of-band modification of the open file. Never
 * reloads automatically: the user always gets the non-destructive banner first.
 */
export async function checkForExternalChanges() {
  if (_externalCheckBusy) return false;
  if (!ipc.getInvoke()) return false;
  if (!state.currentDocPath || state.isSaving) return false;
  if (typeof document !== 'undefined' && document.hidden) return false;
  _externalCheckBusy = true;
  try {
    const changed = await ipc.checkExternalFileChange();
    if (changed && state.currentDocPath) {
      state.externalChangePending = true;
      showExternalChangeBanner();
      return true;
    }
    return false;
  } catch (err) {
    console.warn('[inkwell/main] external change check failed:', err);
    return false;
  } finally {
    _externalCheckBusy = false;
  }
}

/** Reload the on-disk PDF while keeping every unsaved session annotation. */
export async function reloadExternalPdf() {
  const path = state.currentDocPath;
  if (!path) {
    hideExternalChangeBanner();
    return false;
  }
  showOpenProgress('Reloading updated PDF…');
  try {
    const res = await ipc.openPdf(path);
    if (!res) {
      toast.showToast('Could not reload the updated PDF from disk', 'error');
      return false;
    }
    const title = path.split(/[\\/]/).pop();
    handlePdfLoadResult(title, path, res, { preserveAnnotations: true });
    resolveExternalChange();
    toast.showToast('Reloaded the updated PDF — unsaved annotations kept', 'success');
    return true;
  } catch (err) {
    const msg = friendlyError(err);
    if (msg) toast.showToast('Reload failed: ' + msg, 'error');
    return false;
  } finally {
    hideOpenProgress();
  }
}
