/**
 * The "changed on disk" banner and reload flow (Plan 086).
 * (Split out of main.js by Plan 093; behaviour unchanged.)
 */

import { state, $, on } from '../core/state.js';
import * as ipc from '../core/ipc.js';
import * as annotations from '../workspace/annotations.js';
import * as toast from '../ui/toast.js';
import { friendlyError, handlePdfLoadResult, hideOpenProgress, showOpenProgress } from '../app/document-loading.js';

export function showExternalChangeBanner() {
  const banner = $('externalChangeBanner');
  if (!banner) return;
  const title = $('externalChangeTitle');
  const detail = $('externalChangeDetail');
  const name = (state.currentDocPath || '').split(/[\\/]/).pop();
  if (title) title.textContent = name ? `${name} changed on disk` : 'This PDF changed on disk';
  if (detail) {
    detail.textContent = state.isDirty
      ? 'Another app or cloud sync updated the file. Your unsaved annotations are safe — reload keeps them.'
      : 'Another app or cloud sync updated the file. Reload to pick up the new base pages.';
  }
  banner.classList.remove('hidden');
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
    hideExternalChangeBanner();
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
