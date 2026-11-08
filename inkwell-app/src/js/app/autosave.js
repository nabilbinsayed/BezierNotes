/**
 * Autosave scheduler (Plan 090, SPEC §5).
 *
 * The backend's FlushPolicy decides *when* to rewrite the PDF: after 20 s
 * without edits, when the window loses focus, or at the latest every 3 min.
 * Never per edit: a sync client re-uploads the whole file on every write.
 * Between saves, every edit is already safe in the fsync'd journal.
 *
 * This module only reports what the frontend knows (dirty, time since the
 * last edit and the last save, focus) once a second while there is something
 * to save, and runs a silent save when the policy says so.
 */

import { state, on } from '../core/state.js';
import * as ipc from '../core/ipc.js';
import * as commandsModule from '../core/commands.js';

export const AUTOSAVE_PREF_KEY = 'inkwell_autosave';
// A failed autosave (e.g. the file is locked by another app) must not retry
// every second; the error toast is shown once per backoff window.
const FAILURE_BACKOFF_MS = 30000;

let lastInputAt = Date.now();
let lastFlushAt = Date.now();
let backoffUntil = 0;
let ticking = false;
let lastReason = null;

/**
 * On unless the user turned it off. The old `inkwell_autosave_delay` setting
 * defaulted to 0 ("off") without anyone choosing it, so it is not carried over.
 */
export function loadAutosavePreference() {
  try {
    return localStorage.getItem(AUTOSAVE_PREF_KEY) !== 'off';
  } catch (_) {
    return true;
  }
}

export function setAutosaveEnabled(enabled) {
  state.autosaveEnabled = !!enabled;
  try {
    localStorage.setItem(AUTOSAVE_PREF_KEY, enabled ? 'on' : 'off');
  } catch (_) {
    // Private mode / blocked storage: the choice lasts for this session only.
  }
}

/** Called after any successful save, manual or automatic. */
export function noteFlushed(reason = null) {
  lastFlushAt = Date.now();
  lastReason = reason;
}

export function lastAutosaveReason() {
  return lastReason;
}

function strokeInProgress() {
  return !!(state.cur || state.isErasing || state.lassoPath || state.shapeStart);
}

function modalOpen() {
  return typeof document !== 'undefined' && !!document.querySelector('.modal-overlay:not(.hidden)');
}

/** Whether an automatic save may run right now. */
export function canAutosave(now = Date.now()) {
  return !!(
    state.autosaveEnabled &&
    state.currentDocPath &&
    state.isDirty &&
    !state.isSaving &&
    // Never write over a file that changed on disk until the user chose
    // Reload / Keep mine / Save a copy.
    !state.externalChangePending &&
    !strokeInProgress() &&
    !modalOpen() &&
    now >= backoffUntil
  );
}

/** One scheduler tick; `focusLost` for blur / hidden. Returns the reason saved for, or null. */
export async function autosaveTick(focusLost = false, now = Date.now()) {
  if (ticking || !canAutosave(now)) return null;
  ticking = true;
  try {
    const reason = await ipc.autosaveTick(true, (now - lastInputAt) / 1000, (now - lastFlushAt) / 1000, focusLost);
    if (!reason || !canAutosave()) return null;
    const ok = await commandsModule.commands.execute('file.save', { silent: true, reason });
    if (!ok) backoffUntil = Date.now() + FAILURE_BACKOFF_MS;
    return ok ? reason : null;
  } catch (err) {
    console.warn('[inkwell/autosave] tick failed:', err);
    backoffUntil = Date.now() + FAILURE_BACKOFF_MS;
    return null;
  } finally {
    ticking = false;
  }
}

export function initAutosave() {
  state.autosaveEnabled = loadAutosavePreference();
  on('documentChanged', () => {
    lastInputAt = Date.now();
  });
  setInterval(() => { autosaveTick(false); }, 1000);
  window.addEventListener('blur', () => { autosaveTick(true); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) autosaveTick(true);
  });
}

/** Test hook: make the scheduler believe the last edit/save happened `ms` ago. */
export function _ageForTest(ms) {
  lastInputAt = Date.now() - ms;
  lastFlushAt = Date.now() - ms;
  backoffUntil = 0;
}
