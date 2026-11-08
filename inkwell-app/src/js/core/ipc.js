/* ============================================================================
 * core/ipc.js — Tauri v2 Backend Transport & Bridge for Inkwell
 * Bridges JavaScript frontend to Rust backend commands and WAL journaler.
 * Keeps Tauri-specific invocation logic isolated from other domain modules.
 * ========================================================================== */

import { state, warnDurability } from './state.js';
import { isShape, toBackendShape } from './shapes-model.js';

export function getInvoke() {
  if (typeof window === 'undefined') return null;
  if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
    return window.__TAURI__.core.invoke;
  }
  if (window.__TAURI__ && window.__TAURI__.invoke) {
    return window.__TAURI__.invoke;
  }
  if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
    return window.__TAURI_INTERNALS__.invoke;
  }
  return null;
}

export async function invokeTauri(command, args = {}) {
  const invoke = getInvoke();
  if (!invoke) {
    // Graceful fallback for non-Tauri / test environments
    return null;
  }
  return await invoke(command, args);
}

// ---- Document File Operations ----

/**
 * @param {{restoreShelved?: boolean}} [opts] restoreShelved brings back the
 *   changes set aside by "Don't Save" on the last quit (Plan 090).
 */
export async function openPdf(pathStr, { restoreShelved = false } = {}) {
  return await invokeTauri('open_pdf', { pathStr, restoreShelved });
}

// ---- Journal sequence numbers (Plan 090) ----
// Every journalled mutation is numbered here, after the JS state already holds
// it. A save sends the number its snapshot reflects, and the backend trims
// only journal records at or below it, so edits made while a save runs stay
// recoverable whatever order the IPC calls arrive in.
let journalSeq = 0;

function nextJournalSeq() {
  journalSeq += 1;
  return journalSeq;
}

/** The newest journal sequence number handed out so far. */
export function currentJournalSeq() {
  return journalSeq;
}

export async function openPdfDialog() {
  return await invokeTauri('open_pdf_dialog');
}

export async function openPdfBytes(name, bytes) {
  return await invokeTauri('open_pdf_bytes', { name, bytes });
}

function buildSavePayload(strokes, images, texts) {
  const all = strokes || [];
  const payload = {
    // Plan 095: shapes travel separately, as the backend's ShapeObjects
    shapes: all.filter(s => isShape(s) && !s.deleted).map(toBackendShape),
    strokes: all.filter(s => !isShape(s)).map(s => ({
      id: String(s.id),
      kind: s.kind || 'pen',
      rgb: s.rgb || [0.08, 0.09, 0.14],
      base_width: s.base_width || 1.6,
      sheet: s.sheet || 0,
      deleted: !!s.deleted,
      points: (s.points || []).map(p => ({
        x: p.x !== undefined ? p.x : (p[0] !== undefined ? p[0] : 0),
        y: p.y !== undefined ? p.y : (p[1] !== undefined ? p[1] : 0),
        w: p.w ?? (p.p !== undefined ? p.p : (p[2] !== undefined ? p[2] : 0.5)),
        p: p.p !== undefined ? p.p : (p[2] !== undefined ? p[2] : 0.5),
        t: p.t !== undefined ? p.t : (p[3] !== undefined ? p[3] : 0),
      })),
    })),
    images: (images || []).map(img => ({
      id: String(img.id),
      sheet: img.sheet || 0,
      x: img.x || 0,
      y: img.y || 0,
      width: img.width || 0,
      height: img.height || 0,
      data_url: img.dataUrl || img.data_url || '',
    })),
    texts: (texts || []).filter(t => !t.deleted).map(t => ({
      id: String(t.id),
      sheet: t.sheet || 0,
      x: t.x || 0,
      y: t.y || 0,
      text: t.text || '',
      font_size: t.fontSize || t.font_size || 16,
      color: t.color || '#141724',
      bold: !!t.bold,
      italic: !!t.italic,
      width: t.width || 120,
      height: t.height || 30,
    })),
    bookmarks: (state.bookmarks || []).map(b => ({
      id: String(b.id),
      page: Number(b.page) || 0,
      label: String(b.label || ''),
      created_at: Number(b.createdAt || b.created_at || 0),
    })),
  };
  return payload;
}

/**
 * Save the session. `journalSeq` must be read when the payload is built
 * (it is, synchronously, below). `defaultName` prefills the Save As dialog.
 */
export async function savePdf(pathStr, strokes, images, texts, { defaultName = null } = {}) {
  const payload = buildSavePayload(strokes, images, texts);
  payload.journalSeq = journalSeq;
  if (!pathStr) {
    return await invokeTauri('save_pdf_dialog', { ...payload, defaultName });
  }
  return await invokeTauri('save_pdf', { outPathStr: pathStr, ...payload });
}

/** Conflict copies of the open file left by sync clients (Plan 092), newest first. */
export async function findConflictSiblings() {
  return await invokeTauri('find_conflict_siblings', {});
}

/** What merging `otherPath` (null = the open file as it is on disk) would do. */
export async function previewMerge(otherPath) {
  const payload = buildSavePayload(state.strokes, state.images, state.textObjects);
  return await invokeTauri('preview_merge', { otherPath: otherPath || null, ...payload });
}

/** Merge it into the session; `takeOurs`/`takeTheirs` flip notes edited on both sides. */
export async function applyMerge(otherPath, { takeOurs = [], takeTheirs = [] } = {}) {
  const payload = buildSavePayload(state.strokes, state.images, state.textObjects);
  return await invokeTauri('apply_merge', { otherPath: otherPath || null, takeOurs, takeTheirs, ...payload });
}

/** Move a merged conflict copy to the OS trash. */
export async function trashConflictCopy(path) {
  return await invokeTauri('trash_conflict_copy', { path });
}

/** Journal a shape created/edited ('upsert', with its ShapeObject) or deleted ('remove'). */
export async function journalShapeMutation(op, shape, shapeId = null) {
  return await invokeTauri('journal_shape_mutation', {
    op, shape: shape || null, shapeId: shapeId || (shape ? shape.id : null), seq: nextJournalSeq(),
  });
}

/** The open PDF's form fields (Plan 096). */
export async function getFormFields() {
  return await invokeTauri('get_form_fields', {});
}

/** Set a form field's value (journalled; written into the PDF at the next save). */
export async function setFormValue(name, value) {
  return await invokeTauri('set_form_value', { name, value, seq: nextJournalSeq() });
}

/** Ask the backend's FlushPolicy whether to autosave now; returns a reason or null. */
export async function autosaveTick(dirty, sinceInputS, sinceFlushS, focusLost) {
  return await invokeTauri('autosave_tick', { dirty, sinceInputS, sinceFlushS, focusLost });
}

/**
 * Export a copy of the document with optional page subsetting and flattening.
 * Never mutates the live session's PDF bytes, path or WAL on the backend.
 * @param {{selectedPages?: number[]|null, flatten?: boolean, strokes?: any[], images?: any[], texts?: any[]}} options
 */
export async function exportPdfCustom({ selectedPages = null, flatten = false, strokes, images, texts } = {}) {
  const payload = buildSavePayload(
    strokes || state.strokes,
    images || state.images,
    texts || state.textObjects,
  );
  return await invokeTauri('export_pdf_custom_dialog', {
    ...payload,
    selectedPages: Array.isArray(selectedPages) && selectedPages.length ? selectedPages : null,
    flatten: !!flatten,
  });
}

/**
 * Ask the backend whether the open PDF's backing file changed on disk
 * (cloud sync, external editor, git checkout).
 * @returns {Promise<boolean>}
 */
export async function checkExternalFileChange() {
  const invoke = getInvoke();
  if (!invoke) return false;
  try {
    return !!(await invokeTauri('check_external_file_change', {}));
  } catch (err) {
    console.warn('[inkwell/ipc] check_external_file_change failed:', err);
    return false;
  }
}

export async function newWhiteboard() {
  return await invokeTauri('create_blank_document');
}

export async function insertBlankPage(afterIndex = 0, widthPt = 595.0, heightPt = 842.0) {
  return await invokeTauri('insert_blank_page', { index: afterIndex, widthPt, heightPt, seq: nextJournalSeq() });
}

export async function extractOutline() {
  return await invokeTauri('get_pdf_outline');
}

// ---- LOD Tile Rasterization ----

export async function fetchTile(pageIndex, rect, px) {
  return await invokeTauri('render_tile', { page: pageIndex, rect, px });
}

/**
 * Warm the backend full-page bitmap cache without transferring pixels.
 * Used for idle prefetch of the next page so scrolling lands on ready tiles.
 */
export async function prefetchPage(pageIndex, px) {
  return await invokeTauri('prefetch_page', { page: pageIndex, px });
}

// ---- Vector Stroke Persistence ----

export async function commitStroke(sheet, tool, rgb, baseWidth, points, clientId = null) {
  // Shapes ride in the stroke list (Plan 095). Every path that commits a
  // stroke (create, transform, erase, undo, paste) commits a shape through
  // here too; journal it as the shape it is.
  if (clientId !== null) {
    const live = (state.strokes || []).find(s => String(s.id) === String(clientId));
    if (isShape(live)) {
      const shape = toBackendShape({ ...live, sheet: sheet || 0, rgb: rgb || live.rgb, base_width: baseWidth || live.base_width, points: points || live.points });
      await journalShapeMutation('upsert', shape);
      return String(clientId);
    }
  }
  const samplesPayload = (points || []).map(pt => ({
    x: pt.x !== undefined ? pt.x : pt[0],
    y: pt.y !== undefined ? pt.y : pt[1],
    pressure: pt.p !== undefined ? pt.p : (pt[2] !== undefined ? pt[2] : 0.5),
    t_ms: pt.t !== undefined ? pt.t : (pt[3] !== undefined ? pt[3] : 0),
  }));

  return await invokeTauri('commit_stroke', {
      seq: nextJournalSeq(),
    sheet: sheet || 0,
    tool: tool || 'pen',
    rgb: rgb || [0.08, 0.09, 0.14],
    baseWidth: baseWidth || 1.6,
    samples: samplesPayload,
    clientId: clientId ? String(clientId) : null,
  });
}

export async function deleteStroke(strokeIdStr) {
  return await invokeTauri('delete_stroke', { strokeIdStr: String(strokeIdStr), seq: nextJournalSeq() });
}

// ---- WAL Mutation Journaling (Images & Text) ----

export function journalImageMutation(op, imgObj) {
  if (!imgObj) return Promise.resolve(false);
  if (op === 'add' || op === 'upsert') {
    const url = imgObj.dataUrl || imgObj.data_url || '';
    return invokeTauri('journal_image_mutation', {
      seq: nextJournalSeq(),
      op: 'upsert',
      image: {
        id: String(imgObj.id),
        sheet: imgObj.sheet || 0,
        x: imgObj.x ?? 0,
        y: imgObj.y ?? 0,
        width: imgObj.width ?? 0,
        height: imgObj.height ?? 0,
        data_url: url,
      },
      imageId: null,
    }).catch(e => {
      console.warn('[inkwell/ipc] journal_image_mutation error:', e);
      warnDurability('Change journal unavailable — unsaved work at risk');
      return false;
    });
  } else if (op === 'delete' || op === 'remove') {
    return invokeTauri('journal_image_mutation', {
      seq: nextJournalSeq(),
      op: 'delete',
      image: null,
      imageId: String(imgObj.id),
    }).catch(e => {
      console.warn('[inkwell/ipc] journal_image_mutation error:', e);
      warnDurability('Change journal unavailable — unsaved work at risk');
      return false;
    });
  }
  return Promise.resolve(false);
}

export function journalTextMutation(op, textObj) {
  if (!textObj) return;
  if (op === 'add' || op === 'upsert') {
    invokeTauri('journal_text_mutation', {
      seq: nextJournalSeq(),
      op: 'upsert',
      text: {
        id: String(textObj.id),
        sheet: textObj.sheet || 0,
        x: textObj.x,
        y: textObj.y,
        text: textObj.text || '',
        font_size: textObj.fontSize || 16,
        color: textObj.color || '#141724',
        bold: !!textObj.bold,
        italic: !!textObj.italic,
        width: textObj.width || 120,
        height: textObj.height || 30,
      },
      textId: null,
    }).catch(e => {
      console.warn('[inkwell/ipc] journal_text_mutation error:', e);
      warnDurability('Change journal unavailable — unsaved work at risk');
    });
  } else if (op === 'delete' || op === 'remove') {
    invokeTauri('journal_text_mutation', {
      seq: nextJournalSeq(),
      op: 'delete',
      text: null,
      textId: String(textObj.id),
    }).catch(e => {
      console.warn('[inkwell/ipc] journal_text_mutation error:', e);
      warnDurability('Change journal unavailable — unsaved work at risk');
    });
  }
}

// ---- Page Operations ----

export async function deletePage(pageIndex) {
  return await invokeTauri('delete_page', { index: pageIndex, seq: nextJournalSeq() });
}

export async function reorderPages(fromIndex, toIndex) {
  return await invokeTauri('reorder_page', { fromIndex, toIndex, seq: nextJournalSeq() });
}

export async function duplicatePage(pageIndex) {
  return await invokeTauri('duplicate_page', { index: pageIndex, seq: nextJournalSeq() });
}

export async function rotatePage(pageIndex, clockwise = true) {
  return await invokeTauri('rotate_page', { index: pageIndex, clockwise, seq: nextJournalSeq() });
}

// ---- Native Stylus evdev Hardware Stream ----

export function initNativeStylusStream(onMessage) {
  if (typeof window === 'undefined') return;
  if (!window.__TAURI__ || !window.__TAURI__.core || !window.__TAURI__.core.invoke || !window.__TAURI__.core.Channel) {
    return;
  }

  try {
    const channel = new window.__TAURI__.core.Channel();
    channel.onmessage = (msg) => {
      if (typeof onMessage === 'function') {
        onMessage(msg);
      }
    };

    window.__TAURI__.core.invoke('start_stylus_stream', { channel })
      .catch(err => console.warn('[inkwell/ipc] Native stylus stream start error:', err));
  } catch (e) {
    console.warn('[inkwell/ipc] Native stylus stream init failed:', e);
  }
}

// ---- Frameless Window Actions ----

export async function minimizeWindow() {
  return await invokeTauri('minimize_window');
}

export async function toggleMaximizeWindow() {
  return await invokeTauri('toggle_maximize_window');
}

export async function closeWindow() {
  return await invokeTauri('close_window');
}

export async function checkPdfiumStatus() {
  const res = await invokeTauri('check_pdfium_status');
  return res === true;
}

