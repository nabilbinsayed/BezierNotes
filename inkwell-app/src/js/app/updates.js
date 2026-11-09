/**
 * Update checks (Plan 098): once a day, quietly. When a newer version exists,
 * a non-modal toast offers "Restart to install". The app never restarts on its
 * own, and never over unsaved work: installing saves first.
 */

import { state } from '../core/state.js';
import * as ipc from '../core/ipc.js';
import * as toast from '../ui/toast.js';
import * as commandsModule from '../core/commands.js';

const LAST_CHECK_KEY = 'beziernotes_update_checked_at';
const DAY_MS = 24 * 60 * 60 * 1000;

function lastCheck() {
  try {
    return parseInt(localStorage.getItem(LAST_CHECK_KEY) || '0', 10) || 0;
  } catch (_) {
    return 0;
  }
}

/** Check now (`force`) or if a day has passed; resolves to the backend's status. */
export async function checkForUpdates({ force = false } = {}) {
  if (!ipc.getInvoke()) return null;
  if (!force && Date.now() - lastCheck() < DAY_MS) return null;
  let status;
  try {
    status = await ipc.checkForUpdate();
  } catch (err) {
    console.info('[inkwell/updates] update check failed:', err);
    return null;
  }
  if (!status || !status.configured) return status;
  try {
    localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
  } catch (_) {
    // blocked storage: we just check again next launch
  }
  if (status.available) {
    toast.showToast(`BezierNotes ${status.available} is available.`, 'info', {
      actions: [{ label: 'Restart to install', onClick: () => installUpdate() }],
    });
  } else if (force) {
    toast.showToast(`You have the latest version (${status.current}).`, 'success');
  }
  return status;
}

export async function installUpdate() {
  if (state.isDirty) {
    const saved = await commandsModule.commands.execute('file.save');
    if (!saved) {
      toast.showToast('Save your changes first: installing the update restarts the app.', 'info');
      return false;
    }
  }
  try {
    toast.showToast('Downloading the update…', 'info');
    await ipc.installUpdate();
    return true;
  } catch (err) {
    toast.showToast('Update failed: ' + err, 'error');
    return false;
  }
}

export function initUpdates() {
  setTimeout(() => { checkForUpdates(); }, 30000);
  setInterval(() => { checkForUpdates(); }, 60 * 60 * 1000);
}
