/**
 * Cloud conflict copies and merging them in (Plan 092).
 *
 * After a document opens, the backend looks for conflict copies of it that
 * sync clients left in the same folder ("notes (1).pdf", "notes
 * (conflicted copy …).pdf", "notes-DESKTOP-ABC.pdf", "notes.sync-conflict-…").
 * A banner offers to merge one. Merging also answers the change-on-disk
 * banner: the session and the changed file are merged instead of one
 * replacing the other.
 *
 * The merge preview lists what would change; notes edited on both sides show
 * both texts, with the newer one preselected. Applying is one undo step.
 */

import { state, $ } from '../core/state.js';
import * as ipc from '../core/ipc.js';
import * as documentOps from '../core/document.js';
import * as toast from './toast.js';
import * as commandsModule from '../core/commands.js';

/** Incoming ink stays highlighted this long after a merge. */
export const HIGHLIGHT_MS = 2000;

let _pending = null;      // { otherPath, preview, onMerged, onApplied }
let _dismissed = new Set(); // sibling paths the user said "not now" to, this session
let _currentSibling = null;

function ago(ms) {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function plural(n, one, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`;
}

// ---- conflict-copy banner ----

/** Look for conflict copies of the open file; show the banner for the newest. */
export async function checkForConflictCopies() {
  if (!state.currentDocPath || !ipc.getInvoke()) return null;
  let siblings;
  try {
    siblings = await ipc.findConflictSiblings();
  } catch (err) {
    console.warn('[inkwell/merge] conflict copy scan failed:', err);
    return null;
  }
  const next = (siblings || []).find(s => !_dismissed.has(s.path));
  if (next) showConflictBanner(next);
  else hideConflictBanner();
  return next || null;
}

export function showConflictBanner(sibling) {
  const banner = $('conflictCopyBanner');
  if (!banner) return;
  _currentSibling = sibling;
  const detail = $('conflictCopyDetail');
  if (detail) {
    const when = ago(sibling.modified_ms);
    detail.textContent = `From ${sibling.source}${when ? ', ' + when : ''}: ${sibling.name}. Merging keeps the work from both.`;
  }
  banner.classList.remove('hidden');
}

export function hideConflictBanner() {
  const banner = $('conflictCopyBanner');
  if (banner) banner.classList.add('hidden');
}

export function dismissConflictCopy() {
  if (_currentSibling) _dismissed.add(_currentSibling.path);
  _currentSibling = null;
  hideConflictBanner();
}

export function mergeCurrentSibling() {
  if (!_currentSibling) return Promise.resolve(false);
  const sibling = _currentSibling;
  return openMergePreview(sibling.path, {
    onMerged: () => {
      hideConflictBanner();
      offerToTrash(sibling);
    },
  });
}

/** After the merge is saved, offer to move the copy to the trash (never deleted outright). */
function offerToTrash(sibling) {
  toast.showToast(`Merged ${sibling.name}. Its work is now in this notebook.`, 'success', {
    actions: [{
      label: 'Move copy to Trash',
      onClick: async () => {
        try {
          await ipc.trashConflictCopy(sibling.path);
          _dismissed.add(sibling.path);
          toast.showToast(`Moved ${sibling.name} to the Trash.`, 'info');
        } catch (err) {
          toast.showToast(String(err), 'error');
        }
      },
    }],
  });
}

// ---- preview drawer ----

/**
 * Preview merging `otherPath` (null = the open file's version on disk) into
 * the session, and show the drawer.
 */
export async function openMergePreview(otherPath, { onMerged = null, onApplied = null } = {}) {
  let preview;
  try {
    preview = await ipc.previewMerge(otherPath);
  } catch (err) {
    toast.showToast(String(err), 'error');
    return false;
  }
  if (!preview) return false;
  _pending = { otherPath, preview, onMerged, onApplied };
  renderPreview(preview);
  const modal = $('mergeModal');
  if (modal) {
    modal.classList.remove('hidden');
    const go = $('btnApplyMerge');
    if (go) go.focus();
  }
  return true;
}

function renderPreview(p) {
  const name = $('mergeOtherName');
  if (name) name.textContent = p.other_name;
  const list = $('mergeSummary');
  if (list) {
    const rows = [];
    if (p.added_strokes) rows.push(`+${plural(p.added_strokes, 'stroke')} from the other copy`);
    if (p.added_other) rows.push(`+${plural(p.added_other, 'note, image or bookmark', 'notes, images or bookmarks')} from the other copy`);
    if (p.changed) rows.push(`${plural(p.changed, 'item')} updated to the other copy's newer version`);
    if (p.removed) rows.push(`−${plural(p.removed, 'item')} deleted in the other copy`);
    if (p.pages_kept_by_ink) rows.push(`${plural(p.pages_kept_by_ink, 'page')} kept: deleted there, but has ink here`);
    if (!rows.length && !p.conflicts.length) rows.push('Nothing to bring over: this notebook already has everything in the other copy.');
    list.replaceChildren(...rows.map(t => {
      const li = document.createElement('li');
      li.textContent = t;
      return li;
    }));
  }
  const conflicts = $('mergeConflicts');
  if (conflicts) {
    conflicts.replaceChildren();
    const notes = p.conflicts.filter(c => c.kind === 'note');
    for (const c of notes) conflicts.appendChild(conflictRow(c));
    const others = p.conflicts.length - notes.length;
    if (others) {
      const li = document.createElement('p');
      li.className = 'merge-conflict-other';
      li.textContent = `${plural(others, 'other item')} changed on both sides; the newer version is kept.`;
      conflicts.appendChild(li);
    }
    conflicts.classList.toggle('hidden', !p.conflicts.length);
  }
  const pages = $('mergePages');
  if (pages) {
    pages.textContent = p.pages_affected.length
      ? `Pages affected: ${p.pages_affected.map(i => i + 1).join(', ')}`
      : '';
  }
}

function conflictRow(c) {
  const box = document.createElement('fieldset');
  box.className = 'merge-conflict';
  box.dataset.id = c.id;
  const legend = document.createElement('legend');
  legend.textContent = 'This note was edited in both copies. Keep:';
  box.appendChild(legend);
  for (const side of ['ours', 'theirs']) {
    const label = document.createElement('label');
    label.className = 'merge-choice';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = `merge-${c.id}`;
    input.value = side;
    input.checked = c.winner === side;
    const who = document.createElement('strong');
    who.textContent = side === 'ours' ? 'This copy' : 'Other copy';
    const text = document.createElement('span');
    text.className = 'merge-choice-text';
    text.textContent = c[side] || '(empty)';
    label.append(input, who, text);
    box.appendChild(label);
  }
  return box;
}

export function closeMergePreview() {
  _pending = null;
  const modal = $('mergeModal');
  if (modal) modal.classList.add('hidden');
}

/** The user's choices for notes edited on both sides, against the merge's own pick. */
function overrides() {
  const takeOurs = [];
  const takeTheirs = [];
  if (!_pending) return { takeOurs, takeTheirs };
  for (const c of _pending.preview.conflicts.filter(c => c.kind === 'note')) {
    const picked = document.querySelector(`input[name="merge-${CSS.escape(c.id)}"]:checked`);
    const side = picked ? picked.value : c.winner;
    if (side === c.winner) continue;
    (side === 'ours' ? takeOurs : takeTheirs).push(c.id);
  }
  return { takeOurs, takeTheirs };
}

/** Apply the previewed merge to the session as one undo step, then save. */
export async function applyPendingMerge() {
  if (!_pending) return false;
  const { otherPath, onMerged, onApplied } = _pending;
  let res;
  try {
    res = await ipc.applyMerge(otherPath, overrides());
  } catch (err) {
    toast.showToast('Merge failed: ' + String(err), 'error');
    return false;
  }
  closeMergePreview();
  if (!res) return false;

  documentOps.replaceAnnotations({
    strokes: res.strokes || [],
    images: res.images || [],
    textObjects: res.texts || [],
    bookmarks: (res.bookmarks || []).map(b => ({
      id: b.id,
      page: b.page,
      label: b.label,
      createdAt: b.created_at || b.createdAt || Date.now(),
    })),
  }, { label: 'Merge' });
  highlightIncoming(res.incoming_stroke_ids || []);
  if (typeof onApplied === 'function') onApplied(res);
  if (typeof window.__inkwellAfterMerge === 'function') window.__inkwellAfterMerge(res);

  // Save right away: the merge exists only in this session until then.
  const saved = await commandsModule.commands.execute('file.save', { silent: true, reason: 'merge' });
  if (saved && typeof onMerged === 'function') onMerged(res);
  else if (!saved) toast.showToast('Merged. Save to keep it: the merge is not on disk yet.', 'info');
  return true;
}

function highlightIncoming(ids) {
  if (!ids.length) return;
  state.mergeHighlight = { ids: new Set(ids.map(String)), until: Date.now() + HIGHLIGHT_MS };
  window.scheduleRedrawAll && window.scheduleRedrawAll();
  setTimeout(() => {
    state.mergeHighlight = null;
    window.scheduleRedrawAll && window.scheduleRedrawAll();
  }, HIGHLIGHT_MS);
}

export function bindMergeUi() {
  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
  on('btnMergeConflictCopy', () => { mergeCurrentSibling(); });
  on('btnDismissConflictCopy', () => { dismissConflictCopy(); });
  on('btnApplyMerge', () => { applyPendingMerge(); });
  on('btnCancelMerge', () => { closeMergePreview(); });
  on('btnCloseMergeModal', () => { closeMergePreview(); });
  const modal = $('mergeModal');
  if (modal) {
    modal.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.stopPropagation(); closeMergePreview(); }
    });
  }
}
