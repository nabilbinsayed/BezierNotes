/* ============================================================================
 * core/document.js — Authoritative Document Domain Operations for Inkwell
 * Owns document mutations (strokes, images, text, pages) and transaction records.
 * Does not own Tauri IPC transport or rendering logic directly.
 * ========================================================================== */

import { state, emit } from './state.js';
import * as history from './history.js';

let _mutationListener = null;

/**
 * Register a listener for persistence (WAL journaling, dirty flags) and compositor invalidation.
 * @param {Function} listener (type, payload) => void
 */
export function setMutationListener(listener) {
  _mutationListener = listener;
}

function notifyMutation(type, payload) {
  state.isDirty = true;
  if (typeof _mutationListener === 'function') {
    try {
      _mutationListener(type, payload);
    } catch (e) {
      console.warn('[inkwell/document] Mutation listener error:', e);
    }
  }
  emit('documentChanged', { type, payload });
}

// ---- Strokes Operations ----

export function rebuildStrokesBySheet() {
  const map = new Map();
  for (const s of state.strokes || []) {
    if (!s.deleted) {
      const sheet = s.sheet || 0;
      if (!map.has(sheet)) map.set(sheet, []);
      map.get(sheet).push(s);
    }
  }
  state._strokesBySheet = map;
}

export function getStrokesForSheet(sheetIndex) {
  if (!state._strokesBySheet) {
    rebuildStrokesBySheet();
  }
  return state._strokesBySheet.get(sheetIndex) || [];
}

export function addStroke(stroke, { recordHistory = true } = {}) {
  if (!stroke) return;
  if (!state.strokes) state.strokes = [];
  
  stroke.deleted = false;
  state.strokes.push(stroke);

  if (!state._strokesBySheet) state._strokesBySheet = new Map();
  const sheet = stroke.sheet || 0;
  if (!state._strokesBySheet.has(sheet)) state._strokesBySheet.set(sheet, []);
  state._strokesBySheet.get(sheet).push(stroke);

  if (recordHistory) {
    history.pushTransaction({
      type: 'add_stroke',
      stroke,
    });
  }

  notifyMutation('add_stroke', { stroke });
  return stroke;
}

export function deleteStrokes(strokeIds, { recordHistory = true } = {}) {
  if (!strokeIds || !strokeIds.length) return [];
  const idSet = new Set(strokeIds.map(String));
  const deletedStrokes = [];

  for (const s of state.strokes) {
    if (!s.deleted && idSet.has(String(s.id))) {
      s.deleted = true;
      deletedStrokes.push(s);
    }
  }

  if (deletedStrokes.length > 0) {
    rebuildStrokesBySheet();
    if (recordHistory) {
      history.pushTransaction({
        type: 'erase_strokes',
        strokes: deletedStrokes,
      });
    }
    notifyMutation('erase_strokes', { strokes: deletedStrokes });
  }

  return deletedStrokes;
}

export function clearPageInk(sheetIndex, { recordHistory = true } = {}) {
  const strokesOnSheet = (state.strokes || []).filter(s => !s.deleted && (s.sheet || 0) === sheetIndex);
  if (!strokesOnSheet.length) return [];

  for (const s of strokesOnSheet) {
    s.deleted = true;
  }

  rebuildStrokesBySheet();

  if (recordHistory) {
    history.pushTransaction({
      type: 'erase_strokes',
      strokes: strokesOnSheet,
    });
  }

  notifyMutation('erase_strokes', { strokes: strokesOnSheet });
  return strokesOnSheet;
}

export function ensureImageElement(img, onLoaded) {
  if (!img) return null;
  const url = img.dataUrl || img.data_url;
  if (!url) return null;
  img.dataUrl = url;
  img.data_url = url;

  if (typeof Image === 'undefined') return null;

  if (!img._el || img._el.src !== url) {
    const el = new Image();
    el.onload = () => {
      if (typeof onLoaded === 'function') {
        onLoaded(img);
      } else {
        import('../render/compositor.js').then(c => c.scheduleRedrawAll()).catch(() => {});
      }
    };
    el.src = url;
    img._el = el;
  }
  return img._el;
}

export function upsertImage(imageObj, { recordHistory = true, isNew = false } = {}) {
  if (!imageObj || !imageObj.id) return;
  if (!state.images) state.images = [];

  imageObj.deleted = false;
  const url = imageObj.dataUrl || imageObj.data_url || '';
  imageObj.dataUrl = url;
  imageObj.data_url = url;
  ensureImageElement(imageObj);

  const existingIdx = state.images.findIndex(img => String(img.id) === String(imageObj.id));
  if (existingIdx >= 0) {
    state.images[existingIdx] = imageObj;
  } else {
    state.images.push(imageObj);
  }

  if (recordHistory && isNew) {
    history.pushTransaction({
      type: 'add_image',
      image: imageObj,
    });
  }

  notifyMutation('upsert_image', { image: imageObj, isNew });
  return imageObj;
}

export function deleteImage(imageId, { recordHistory = true } = {}) {
  if (!imageId || !state.images) return null;
  const img = state.images.find(im => String(im.id) === String(imageId));
  if (!img || img.deleted) return null;

  img.deleted = true;

  if (recordHistory) {
    history.pushTransaction({
      type: 'delete_image',
      image: img,
    });
  }

  notifyMutation('delete_image', { image: img });
  return img;
}

// ---- Text Note Operations ----

export function upsertTextObject(textObj, { recordHistory = true, isNew = false } = {}) {
  if (!textObj || !textObj.id) return;
  if (!state.textObjects) state.textObjects = [];

  textObj.deleted = false;
  if (!textObj.width || !textObj.height) {
    const fontSize = textObj.fontSize || 16;
    const lines = (textObj.text || '').split('\n');
    let maxLineW = 100;
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.font = `${fontSize}px Inter, system-ui, -apple-system, sans-serif`;
        for (const line of lines) {
          const w = ctx.measureText(line).width;
          if (w > maxLineW) maxLineW = w;
        }
      }
    }
    textObj.width = Math.max(10, maxLineW + 16);
    textObj.height = Math.max(20, lines.length * fontSize * 1.35 + 8);
  }

  const existingIdx = state.textObjects.findIndex(t => String(t.id) === String(textObj.id));
  if (existingIdx >= 0) {
    state.textObjects[existingIdx] = textObj;
  } else {
    state.textObjects.push(textObj);
  }

  if (recordHistory && isNew) {
    history.pushTransaction({
      type: 'add_text_object',
      textObj,
    });
  }

  notifyMutation('upsert_text', { textObj, isNew });
  return textObj;
}

export function deleteTextObject(textId, { recordHistory = true } = {}) {
  if (!textId || !state.textObjects) return null;
  const t = state.textObjects.find(txt => String(txt.id) === String(textId));
  if (!t || t.deleted) return null;

  t.deleted = true;

  if (recordHistory) {
    history.pushTransaction({
      type: 'delete_text_object',
      textObj: t,
    });
  }

  notifyMutation('delete_text', { textObj: t });
  return t;
}

// ---- Multi-Object Batch Deletion & Transformations ----

export function deleteObjectsBatch({ strokes = [], images = [], textObjects = [] }, { recordHistory = true } = {}) {
  const deletedStrokes = [];
  const deletedImages = [];
  const deletedTexts = [];

  for (const s of strokes) {
    if (!s.deleted) {
      s.deleted = true;
      deletedStrokes.push(s);
    }
  }
  for (const img of images) {
    if (!img.deleted) {
      img.deleted = true;
      deletedImages.push(img);
    }
  }
  for (const t of textObjects) {
    if (!t.deleted) {
      t.deleted = true;
      deletedTexts.push(t);
    }
  }

  if (deletedStrokes.length || deletedImages.length || deletedTexts.length) {
    if (deletedStrokes.length) rebuildStrokesBySheet();
    if (recordHistory) {
      history.pushTransaction({
        type: 'delete_objects',
        strokes: deletedStrokes,
        images: deletedImages,
        textObjects: deletedTexts,
      });
    }
    notifyMutation('delete_objects', {
      strokes: deletedStrokes,
      images: deletedImages,
      textObjects: deletedTexts,
    });
  }
}

export function commitTransform({ initialStrokes = [], initialImages = [], initialTextObjects = [], finalStrokes = [], finalImages = [], finalTextObjects = [] }, { recordHistory = true } = {}) {
  if (recordHistory) {
    history.pushTransaction({
      type: 'transform_objects',
      initialStrokes: initialStrokes.map(s => ({
        id: s.id,
        sheet: s.sheet ?? 0,
        kind: s.kind || s.tool || 'pen',
        rgb: s.rgb || [0, 0, 0],
        base_width: s.base_width || s.baseWidth || 1.6,
        points: s.points.map(p => ({ ...p })),
      })),
      initialImages: initialImages.map(img => ({ id: img.id, sheet: img.sheet ?? 0, x: img.x, y: img.y, width: img.width, height: img.height })),
      initialTextObjects: initialTextObjects.map(t => ({ id: t.id, sheet: t.sheet ?? 0, x: t.x, y: t.y, fontSize: t.fontSize })),
      finalStrokes: finalStrokes.map(s => ({
        id: s.id,
        sheet: s.sheet ?? 0,
        kind: s.kind || s.tool || 'pen',
        rgb: s.rgb || [0, 0, 0],
        base_width: s.base_width || s.baseWidth || 1.6,
        points: s.points.map(p => ({ ...p })),
      })),
      finalImages: finalImages.map(img => ({ id: img.id, sheet: img.sheet ?? 0, x: img.x, y: img.y, width: img.width, height: img.height })),
      finalTextObjects: finalTextObjects.map(t => ({ id: t.id, sheet: t.sheet ?? 0, x: t.x, y: t.y, fontSize: t.fontSize })),
    });
  }

  notifyMutation('transform_objects', {
    strokes: state.selectedStrokes,
    images: state.selectedImages,
    textObjects: state.selectedTextObjects,
  });
}

// ---- Document Setup & Page Management ----

export function setDocument({ pageInfos = [], strokes = [], images = [], textObjects = [], outline = [], bookmarks = [] } = {}) {
  state.pageInfos = pageInfos;
  state.strokes = strokes;
  state.images = (images || []).map(img => {
    const url = img.dataUrl || img.data_url || '';
    img.dataUrl = url;
    img.data_url = url;
    if (url) {
      ensureImageElement(img);
    }
    return img;
  });
  state.textObjects = (textObjects || []).map(t => {
    const fs = t.fontSize || t.font_size || 16;
    t.fontSize = fs;
    t.font_size = fs;
    return t;
  });
  state.outline = outline;
  state.bookmarks = bookmarks;
  state.selectedStrokes = [];
  state.selectedImages = [];
  state.selectedTextObjects = [];
  state.isDirty = false;

  // Clear PDF text layer caches, selection, and search state
  state.pageTextData = {};
  state.pageTextSpans = {};
  state.pageTextLoading = {};
  state.selectedTextSpans = [];
  state.selectedTextString = '';
  state.textSelection = null;
  state.textSelectAnchor = null;
  state.textSelectPending = null;
  state.isSelectingText = false;
  state.searchQuery = '';
  state.searchResults = [];
  state.activeSearchMatch = 0;
  state.isSearching = false;

  rebuildStrokesBySheet();
  history.clearHistory();
  emit('documentLoaded', { pageInfos, strokesCount: strokes.length });
}

export function insertPageAtIndex(targetIndex, pageInfo) {
  if (!state.pageInfos) state.pageInfos = [];
  const insertIdx = Math.max(0, Math.min(state.pageInfos.length, targetIndex));
  state.pageInfos.splice(insertIdx, 0, pageInfo);
  state.pageInfos.forEach((pi, idx) => {
    if (pi) {
      pi.page_index = idx;
      pi.pageIndex = idx;
    }
  });

  // Shift sheet index of any existing strokes, images, text on or after insertIdx
  for (const s of state.strokes || []) {
    if (s.sheet >= insertIdx) s.sheet += 1;
  }
  for (const img of state.images || []) {
    if (img.sheet >= insertIdx) img.sheet += 1;
  }
  for (const t of state.textObjects || []) {
    if (t.sheet >= insertIdx) t.sheet += 1;
  }

  // Shift cached page text data for indices >= insertIdx
  if (state.pageTextData && Object.keys(state.pageTextData).length > 0) {
    const newPageTextData = {};
    const newPageTextSpans = {};
    for (const key of Object.keys(state.pageTextData).map(Number).sort((a, b) => b - a)) {
      if (key >= insertIdx) {
        newPageTextData[key + 1] = state.pageTextData[key];
        if (state.pageTextSpans && state.pageTextSpans[key]) {
          newPageTextSpans[key + 1] = state.pageTextSpans[key];
        }
      } else {
        newPageTextData[key] = state.pageTextData[key];
        if (state.pageTextSpans && state.pageTextSpans[key]) {
          newPageTextSpans[key] = state.pageTextSpans[key];
        }
      }
    }
    state.pageTextData = newPageTextData;
    state.pageTextSpans = newPageTextSpans;
  }

  rebuildStrokesBySheet();
  notifyMutation('insert_page', { pageIndex: insertIdx, pageInfo });
  return insertIdx;
}

export function insertPage(afterIndex, pageInfo) {
  return insertPageAtIndex(afterIndex + 1, pageInfo);
}

export function duplicatePageAtIndex(sourceIndex, newPageInfo) {
  if (!state.pageInfos || sourceIndex < 0 || sourceIndex >= state.pageInfos.length) return -1;
  const targetIndex = sourceIndex + 1;
  const srcPi = state.pageInfos[sourceIndex] || {};
  const pageInfo = newPageInfo ? {
    page_index: targetIndex,
    pageIndex: targetIndex,
    width_pt: newPageInfo.width_pt || srcPi.width_pt || 595.0,
    height_pt: newPageInfo.height_pt || srcPi.height_pt || 842.0,
    template: srcPi.template || 'blank',
  } : {
    page_index: targetIndex,
    pageIndex: targetIndex,
    width_pt: srcPi.width_pt || 595.0,
    height_pt: srcPi.height_pt || 842.0,
    template: srcPi.template || 'blank',
  };

  state.pageInfos.splice(targetIndex, 0, pageInfo);
  state.pageInfos.forEach((pi, idx) => {
    if (pi) {
      pi.page_index = idx;
      pi.pageIndex = idx;
    }
  });

  // Shift existing objects on or after targetIndex
  for (const s of state.strokes || []) {
    if (s.sheet >= targetIndex) s.sheet += 1;
  }
  for (const img of state.images || []) {
    if (img.sheet >= targetIndex) img.sheet += 1;
  }
  for (const t of state.textObjects || []) {
    if (t.sheet >= targetIndex) t.sheet += 1;
  }
  for (const bm of state.bookmarks || []) {
    if (bm.page >= targetIndex) bm.page += 1;
  }

  // Clone strokes from sourceIndex
  const clonedStrokes = [];
  for (const s of state.strokes || []) {
    if (s.sheet === sourceIndex && !s.deleted) {
      const clone = {
        ...s,
        id: 'stk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        sheet: targetIndex,
        points: (s.points || []).map(p => ({ ...p })),
        _cachedPath2D: null,
      };
      clonedStrokes.push(clone);
    }
  }
  state.strokes.push(...clonedStrokes);

  // Clone images from sourceIndex
  const clonedImages = [];
  for (const img of state.images || []) {
    if (img.sheet === sourceIndex && !img.deleted) {
      const clone = {
        ...img,
        id: 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        sheet: targetIndex,
      };
      if (clone.dataUrl) ensureImageElement(clone);
      clonedImages.push(clone);
    }
  }
  state.images.push(...clonedImages);

  // Clone textObjects from sourceIndex
  const clonedTexts = [];
  for (const t of state.textObjects || []) {
    if (t.sheet === sourceIndex && !t.deleted) {
      const clone = {
        ...t,
        id: 'txt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        sheet: targetIndex,
      };
      clonedTexts.push(clone);
    }
  }
  state.textObjects.push(...clonedTexts);

  rebuildStrokesBySheet();
  notifyMutation('duplicate_page', { sourceIndex, targetIndex, pageInfo });
  return targetIndex;
}

export function deletePageAtIndex(pageIndex) {
  if (!state.pageInfos || state.pageInfos.length <= 1) return false;
  if (pageIndex < 0 || pageIndex >= state.pageInfos.length) return false;

  state.pageInfos.splice(pageIndex, 1);
  state.pageInfos.forEach((pi, idx) => {
    if (pi) {
      pi.page_index = idx;
      pi.pageIndex = idx;
    }
  });

  // Remove objects on deleted sheet and decrement sheet index for succeeding pages
  state.strokes = (state.strokes || []).filter(s => {
    if (s.sheet === pageIndex) return false;
    if (s.sheet > pageIndex) s.sheet -= 1;
    return true;
  });

  state.images = (state.images || []).filter(img => {
    if (img.sheet === pageIndex) return false;
    if (img.sheet > pageIndex) img.sheet -= 1;
    return true;
  });

  state.textObjects = (state.textObjects || []).filter(t => {
    if (t.sheet === pageIndex) return false;
    if (t.sheet > pageIndex) t.sheet -= 1;
    return true;
  });

  state.bookmarks = (state.bookmarks || []).filter(bm => {
    if (bm.page === pageIndex) return false;
    if (bm.page > pageIndex) bm.page -= 1;
    return true;
  });

  state.pageTextData = {};
  state.pageTextSpans = {};

  rebuildStrokesBySheet();
  notifyMutation('delete_page', { pageIndex });
  return true;
}

export function reorderPageAtIndex(fromIndex, toIndex) {
  if (!state.pageInfos || fromIndex < 0 || fromIndex >= state.pageInfos.length ||
      toIndex < 0 || toIndex >= state.pageInfos.length || fromIndex === toIndex) {
    return false;
  }

  const [movedPage] = state.pageInfos.splice(fromIndex, 1);
  state.pageInfos.splice(toIndex, 0, movedPage);
  state.pageInfos.forEach((pi, idx) => {
    if (pi) {
      pi.page_index = idx;
      pi.pageIndex = idx;
    }
  });

  function mapIndex(idx) {
    if (idx === fromIndex) return toIndex;
    if (fromIndex < toIndex) {
      if (idx > fromIndex && idx <= toIndex) return idx - 1;
    } else {
      if (idx >= toIndex && idx < fromIndex) return idx + 1;
    }
    return idx;
  }

  for (const s of state.strokes || []) {
    s.sheet = mapIndex(s.sheet);
  }
  for (const img of state.images || []) {
    img.sheet = mapIndex(img.sheet);
  }
  for (const t of state.textObjects || []) {
    t.sheet = mapIndex(t.sheet);
  }
  for (const bm of state.bookmarks || []) {
    bm.page = mapIndex(bm.page);
  }

  state.pageTextData = {};
  state.pageTextSpans = {};

  rebuildStrokesBySheet();
  notifyMutation('reorder_page', { fromIndex, toIndex });
  return true;
}

// ---- Undo / Redo Domain Dispatches ----

export function performUndo() {
  const tx = history.popUndo();
  if (!tx) return false;

  if (tx.type === 'add_stroke' && tx.stroke) {
    tx.stroke.deleted = true;
    rebuildStrokesBySheet();
    history.pushRedo(tx);
    notifyMutation('undo_add_stroke', { stroke: tx.stroke });
  } else if (tx.type === 'erase_strokes' && tx.strokes) {
    for (const s of tx.strokes) s.deleted = false;
    rebuildStrokesBySheet();
    history.pushRedo(tx);
    notifyMutation('undo_erase_strokes', { strokes: tx.strokes });
  } else if (tx.type === 'delete_objects') {
    for (const s of (tx.strokes || [])) s.deleted = false;
    for (const img of (tx.images || [])) img.deleted = false;
    for (const t of (tx.textObjects || [])) t.deleted = false;
    rebuildStrokesBySheet();
    history.pushRedo(tx);
    notifyMutation('undo_delete_objects', tx);
  } else if (tx.type === 'add_objects') {
    for (const s of (tx.strokes || [])) s.deleted = true;
    for (const img of (tx.images || [])) img.deleted = true;
    for (const t of (tx.textObjects || [])) t.deleted = true;
    rebuildStrokesBySheet();
    history.pushRedo(tx);
    notifyMutation('undo_add_objects', tx);
  } else if (tx.type === 'add_image' && tx.image) {
    tx.image.deleted = true;
    history.pushRedo(tx);
    notifyMutation('undo_add_image', { image: tx.image });
  } else if (tx.type === 'delete_image' && tx.image) {
    tx.image.deleted = false;
    history.pushRedo(tx);
    notifyMutation('undo_delete_image', { image: tx.image });
  } else if (tx.type === 'add_text_object' && tx.textObj) {
    tx.textObj.deleted = true;
    history.pushRedo(tx);
    notifyMutation('undo_add_text_object', { textObj: tx.textObj });
  } else if (tx.type === 'delete_text_object' && tx.textObj) {
    tx.textObj.deleted = false;
    history.pushRedo(tx);
    notifyMutation('undo_delete_text_object', { textObj: tx.textObj });
  } else if (tx.type === 'transform_objects') {
    for (const init of (tx.initialStrokes || [])) {
      const s = state.strokes.find(st => st.id === init.id);
      if (s) {
        s.points = init.points.map(p => ({ ...p }));
        if (init.sheet !== undefined) s.sheet = init.sheet;
        if (init.kind) s.kind = init.kind;
        if (init.rgb) s.rgb = init.rgb;
        if (init.base_width) s.base_width = init.base_width;
        s._cachedPath2D = null;
        if (window.Ink && typeof window.Ink.computeStrokeBbox === 'function') {
          s.bbox = window.Ink.computeStrokeBbox(s.points, s.base_width);
        }
      }
    }
    rebuildStrokesBySheet();
    for (const init of (tx.initialImages || [])) {
      const img = (state.images || []).find(im => im.id === init.id);
      if (img) {
        if (init.sheet !== undefined) img.sheet = init.sheet;
        img.x = init.x; img.y = init.y;
        img.width = init.width; img.height = init.height;
      }
    }
    for (const init of (tx.initialTextObjects || [])) {
      const t = (state.textObjects || []).find(txt => txt.id === init.id);
      if (t) {
        if (init.sheet !== undefined) t.sheet = init.sheet;
        t.x = init.x; t.y = init.y;
        if (init.fontSize) t.fontSize = init.fontSize;
      }
    }
    history.pushRedo(tx);
    notifyMutation('undo_transform_objects', tx);
  }

  return true;
}

export function performRedo() {
  const tx = history.popRedo();
  if (!tx) return false;

  if (tx.type === 'add_stroke' && tx.stroke) {
    tx.stroke.deleted = false;
    rebuildStrokesBySheet();
    history.pushUndoRaw(tx);
    notifyMutation('redo_add_stroke', { stroke: tx.stroke });
  } else if (tx.type === 'erase_strokes' && tx.strokes) {
    for (const s of tx.strokes) s.deleted = true;
    rebuildStrokesBySheet();
    history.pushUndoRaw(tx);
    notifyMutation('redo_erase_strokes', { strokes: tx.strokes });
  } else if (tx.type === 'delete_objects') {
    for (const s of (tx.strokes || [])) s.deleted = true;
    for (const img of (tx.images || [])) img.deleted = true;
    for (const t of (tx.textObjects || [])) t.deleted = true;
    rebuildStrokesBySheet();
    history.pushUndoRaw(tx);
    notifyMutation('redo_delete_objects', tx);
  } else if (tx.type === 'add_objects') {
    for (const s of (tx.strokes || [])) s.deleted = false;
    for (const img of (tx.images || [])) img.deleted = false;
    for (const t of (tx.textObjects || [])) t.deleted = false;
    rebuildStrokesBySheet();
    history.pushUndoRaw(tx);
    notifyMutation('redo_add_objects', tx);
  } else if (tx.type === 'transform_objects') {
    for (const final of (tx.finalStrokes || [])) {
      const s = state.strokes.find(st => st.id === final.id);
      if (s) {
        s.points = final.points.map(p => ({ ...p }));
        if (final.sheet !== undefined) s.sheet = final.sheet;
        if (final.kind) s.kind = final.kind;
        if (final.rgb) s.rgb = final.rgb;
        if (final.base_width) s.base_width = final.base_width;
        s._cachedPath2D = null;
        if (window.Ink && typeof window.Ink.computeStrokeBbox === 'function') {
          s.bbox = window.Ink.computeStrokeBbox(s.points, s.base_width);
        }
      }
    }
    rebuildStrokesBySheet();
    for (const final of (tx.finalImages || [])) {
      const img = (state.images || []).find(im => im.id === final.id);
      if (img) {
        if (final.sheet !== undefined) img.sheet = final.sheet;
        img.x = final.x; img.y = final.y;
        img.width = final.width; img.height = final.height;
      }
    }
    for (const final of (tx.finalTextObjects || [])) {
      const t = (state.textObjects || []).find(txt => txt.id === final.id);
      if (t) {
        if (final.sheet !== undefined) t.sheet = final.sheet;
        t.x = final.x; t.y = final.y;
        if (final.fontSize) t.fontSize = final.fontSize;
      }
    }
    history.pushUndoRaw(tx);
    notifyMutation('redo_transform_objects', tx);
  } else if (tx.type === 'add_image' && tx.image) {
    tx.image.deleted = false;
    history.pushUndoRaw(tx);
    notifyMutation('redo_add_image', { image: tx.image });
  } else if (tx.type === 'delete_image' && tx.image) {
    tx.image.deleted = true;
    history.pushUndoRaw(tx);
    notifyMutation('redo_delete_image', { image: tx.image });
  } else if (tx.type === 'add_text_object' && tx.textObj) {
    tx.textObj.deleted = false;
    history.pushUndoRaw(tx);
    notifyMutation('redo_add_text_object', { textObj: tx.textObj });
  } else if (tx.type === 'delete_text_object' && tx.textObj) {
    tx.textObj.deleted = true;
    history.pushUndoRaw(tx);
    notifyMutation('redo_delete_text_object', { textObj: tx.textObj });
  }

  return true;
}
