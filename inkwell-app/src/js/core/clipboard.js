/* ============================================================================
 * core/clipboard.js — Object and Image Clipboard Engine for Inkwell
 * Encapsulates copying, cutting, pasting, and duplicating of strokes/images/text.
 * ========================================================================== */

import { state, emit } from './state.js';
import * as documentOps from './document.js';
import * as history from './history.js';
import * as ipc from './ipc.js';

let _clipboard = null;

export function hasClipboardContent() {
  return _clipboard !== null && _clipboard.type === 'inkwell_objects';
}

export function getClipboardData() {
  return _clipboard;
}

export function setClipboardData(data) {
  _clipboard = data;
}

export function dataUrlToBlob(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  try {
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx === -1) return null;
    const header = dataUrl.slice(0, commaIdx);
    const b64 = dataUrl.slice(commaIdx + 1);
    const mimeMatch = header.match(/:(.*?);/);
    const mime = (mimeMatch && mimeMatch[1]) ? mimeMatch[1] : 'image/png';
    const binaryStr = atob(b64);
    const len = binaryStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
  } catch (err) {
    console.warn('[inkwell/clipboard] dataUrlToBlob failed:', err);
    return null;
  }
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    if (!blob) return resolve('');
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to convert blob to data URL'));
    reader.readAsDataURL(blob);
  });
}

export function copySelection() {
  const strokes = (state.selectedStrokes || []).filter(s => !s.deleted);
  const images = (state.selectedImages || []).filter(img => !img.deleted);
  const texts = (state.selectedTextObjects || []).filter(t => !t.deleted);

  if (!strokes.length && !images.length && !texts.length) {
    return false;
  }

  _clipboard = {
    type: 'inkwell_objects',
    strokes: strokes.map(serializeStroke),
    images: images.map(serializeImage),
    texts: texts.map(serializeText),
  };

  // Synchronize to system clipboard
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    if (texts.length && !strokes.length && !images.length) {
      if (typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(texts.map(t => t.text).join('\n')).catch(() => {});
      }
    } else if (images.length === 1 && !strokes.length && !texts.length) {
      // Single image: write binary image blob if possible so external apps can paste it
      const img = images[0];
      const url = img.dataUrl || img.data_url || '';
      const blob = dataUrlToBlob(url);
      const jsonStr = JSON.stringify(_clipboard);

      if (blob && typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard.write === 'function') {
        const itemData = {
          [blob.type || 'image/png']: blob,
        };
        try {
          itemData['text/plain'] = new Blob([jsonStr], { type: 'text/plain' });
        } catch (_) {}

        try {
          navigator.clipboard.write([new ClipboardItem(itemData)]).catch(() => {
            if (blob) {
              navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]).catch(() => {
                if (typeof navigator.clipboard.writeText === 'function') {
                  navigator.clipboard.writeText(jsonStr).catch(() => {});
                }
              });
            } else if (typeof navigator.clipboard.writeText === 'function') {
              navigator.clipboard.writeText(jsonStr).catch(() => {});
            }
          });
        } catch (_) {
          if (typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(jsonStr).catch(() => {});
          }
        }
      } else if (typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(jsonStr).catch(() => {});
      }
    } else {
      if (typeof navigator.clipboard.writeText === 'function') {
        try {
          navigator.clipboard.writeText(JSON.stringify(_clipboard)).catch(() => {});
        } catch (_) {}
      }
    }
  }

  emit('clipboardChanged', { count: strokes.length + images.length + texts.length });
  return true;
}

function serializeStroke(s) {
  const pts = (s.points || s._pts || []).map(p => ({
    x: p.x,
    y: p.y,
    p: (p.p !== undefined) ? p.p : 0.8,
    w: (p.w !== undefined) ? p.w : (s.base_width || 1.6),
    t: p.t || 0,
  }));
  return {
    id: s.id,
    sheet: s.sheet || 0,
    kind: s.kind || 'pen',
    rgb: s.rgb ? [...s.rgb] : [0.08, 0.09, 0.14],
    base_width: s.base_width || s.baseWidth || 1.6,
    points: pts,
    _pts: pts,
    deleted: !!s.deleted,
  };
}

function serializeImage(img) {
  const url = img.dataUrl || img.data_url || '';
  return {
    id: img.id,
    sheet: img.sheet || 0,
    x: img.x,
    y: img.y,
    width: img.width,
    height: img.height,
    dataUrl: url,
    data_url: url,
    deleted: !!img.deleted,
  };
}

function serializeText(t) {
  return {
    id: t.id,
    sheet: t.sheet || 0,
    x: t.x,
    y: t.y,
    text: t.text || '',
    fontSize: t.fontSize || 16,
    color: t.color || '#141724',
    bold: !!t.bold,
    italic: !!t.italic,
    width: t.width || 140,
    height: t.height || 32,
    deleted: !!t.deleted,
  };
}

export function cutSelection() {
  if (!copySelection()) return false;
  deleteSelection();
  return true;
}

export function deleteSelection() {
  const strokes = (state.selectedStrokes || []).filter(s => !s.deleted);
  const images = (state.selectedImages || []).filter(img => !img.deleted);
  const texts = (state.selectedTextObjects || []).filter(t => !t.deleted);

  if (!strokes.length && !images.length && !texts.length) {
    return false;
  }

  documentOps.deleteObjectsBatch({ strokes, images, textObjects: texts });

  state.selectedStrokes = [];
  state.selectedImages = [];
  state.selectedTextObjects = [];

  emit('selectionCleared', {});
  return true;
}

export function pasteClipboard(activeSheet = 0, offset = 16, targetPagePt = null) {
  if (!hasClipboardContent()) return false;

  const newStrokes = [];
  const newImages = [];
  const newTexts = [];

  let dx = offset;
  let dy = offset;

  if (targetPagePt && typeof targetPagePt.px === 'number' && typeof targetPagePt.py === 'number') {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let hasBounds = false;
    for (const s of (_clipboard.strokes || [])) {
      const pts = s.points || s._pts || [];
      for (const p of pts) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
        hasBounds = true;
      }
    }
    for (const img of (_clipboard.images || [])) {
      minX = Math.min(minX, img.x); minY = Math.min(minY, img.y);
      maxX = Math.max(maxX, img.x + img.width); maxY = Math.max(maxY, img.y + img.height);
      hasBounds = true;
    }
    for (const t of (_clipboard.texts || [])) {
      minX = Math.min(minX, t.x); minY = Math.min(minY, t.y);
      maxX = Math.max(maxX, t.x + (t.width || 120)); maxY = Math.max(maxY, t.y + (t.height || 32));
      hasBounds = true;
    }
    if (hasBounds) {
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      dx = targetPagePt.px - centerX;
      dy = targetPagePt.py - centerY;
    }
  }

  for (const s of (_clipboard.strokes || [])) {
    const pts = (s.points || s._pts || []).map(p => ({
      x: p.x + dx,
      y: p.y + dy,
      p: (p.p !== undefined) ? p.p : 0.8,
      w: (p.w !== undefined) ? p.w : (s.base_width || 1.6),
      t: p.t || 0,
    }));
    const baseW = s.base_width || s.baseWidth || 1.6;
    const clone = {
      id: 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      sheet: activeSheet,
      kind: s.kind || 'pen',
      rgb: s.rgb ? [...s.rgb] : [0.08, 0.09, 0.14],
      base_width: baseW,
      points: pts,
      _pts: pts,
      deleted: false,
    };

    if (window.Ink && typeof window.Ink.computeStrokeBbox === 'function') {
      clone.bbox = window.Ink.computeStrokeBbox(clone.points, clone.base_width);
    }
    if (window.Ink && typeof window.Ink.getPath2D === 'function') {
      clone._cachedPath2D = window.Ink.getPath2D(clone);
    }

    documentOps.addStroke(clone, { recordHistory: false });
    ipc.commitStroke(clone.sheet, clone.kind || 'pen', clone.rgb, clone.base_width, clone.points, clone.id).catch(err => {
      console.warn('[inkwell/clipboard] commitStroke error:', err);
    });
    newStrokes.push(clone);
  }

  for (const img of (_clipboard.images || [])) {
    const url = img.dataUrl || img.data_url || '';
    const clone = {
      id: 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      sheet: activeSheet,
      x: img.x + dx,
      y: img.y + dy,
      width: img.width,
      height: img.height,
      dataUrl: url,
      data_url: url,
      deleted: false,
    };

    if (url) {
      documentOps.ensureImageElement(clone);
    }

    documentOps.upsertImage(clone, { recordHistory: false, isNew: true });
    ipc.journalImageMutation('upsert', clone);
    newImages.push(clone);
  }

  for (const t of (_clipboard.texts || [])) {
    const clone = {
      id: 'txt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      sheet: activeSheet,
      x: t.x + dx,
      y: t.y + dy,
      text: t.text || '',
      fontSize: t.fontSize || 16,
      color: t.color || '#141724',
      bold: !!t.bold,
      italic: !!t.italic,
      width: t.width || 140,
      height: t.height || 32,
      deleted: false,
    };

    documentOps.upsertTextObject(clone, { recordHistory: false, isNew: true });
    ipc.journalTextMutation('upsert', clone);
    newTexts.push(clone);
  }

  // Record batch add in history
  if (newStrokes.length || newImages.length || newTexts.length) {
    history.pushTransaction({
      type: 'add_objects',
      strokes: newStrokes,
      images: newImages,
      textObjects: newTexts,
    });
  }

  state.selectedStrokes = newStrokes;
  state.selectedImages = newImages;
  state.selectedTextObjects = newTexts;

  import('../tools/tool-manager.js').then(tm => {
    tm.setTool('lasso', { isUserSwitch: false });
    import('../ui/toolbar.js').then(tb => tb.updateToolbarUI()).catch(() => {});
  }).catch(() => {});

  emit('selectionChanged', { strokes: newStrokes, images: newImages, textObjects: newTexts });
  return true;
}

/**
 * Pastes an image given its Data URL onto the specified page.
 * Automatically computes proportional dimensions and centers at target point or page center.
 */
export async function pasteImageDataUrl(dataUrl, activeSheet = 0, targetPagePt = null, customId = null, options = {}) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;

  // 1. Decode HTMLImageElement to obtain natural dimensions
  const imgEl = new Image();
  await new Promise((resolve, reject) => {
    imgEl.onload = () => resolve();
    imgEl.onerror = err => reject(new Error('Failed to load image data URL: ' + err));
    imgEl.src = dataUrl;
  });

  const naturalW = imgEl.naturalWidth || imgEl.width || 320;
  const naturalH = imgEl.naturalHeight || imgEl.height || 240;

  // 2. Determine target page layout & scale constraints
  const pi = (state.pageInfos && state.pageInfos[activeSheet]) || { width_pt: 595, height_pt: 842 };
  const pageW = pi.width_pt || 595;
  const pageH = pi.height_pt || 842;

  // Screen pixels to PDF points is ~0.75. Callers inserting signatures or
  // stamps can request a document-relative preferred width instead.
  const preferredWidth = Number(options.widthPt) > 0 ? Number(options.widthPt) : null;
  let w = preferredWidth ? preferredWidth : naturalW * 0.75;
  let h = preferredWidth ? preferredWidth * (naturalH / Math.max(1, naturalW)) : naturalH * 0.75;

  // Fit within 75% of page width & height (or caller-specified caps)
  const maxW = Number(options.maxWidthPt) > 0 ? Number(options.maxWidthPt) : pageW * 0.75;
  const maxH = Number(options.maxHeightPt) > 0 ? Number(options.maxHeightPt) : pageH * 0.75;
  if (w > maxW || h > maxH) {
    const scale = Math.min(maxW / w, maxH / h);
    w *= scale;
    h *= scale;
  }
  w = Math.max(30, Math.round(w * 10) / 10);
  h = Math.max(30, Math.round(h * 10) / 10);

  // 3. Compute (x, y) coordinates
  let x, y;
  if (targetPagePt && typeof targetPagePt.px === 'number' && typeof targetPagePt.py === 'number') {
    x = targetPagePt.px - w / 2;
    y = targetPagePt.py - h / 2;
  } else {
    // Default to page center
    x = (pageW - w) / 2;
    y = (pageH - h) / 2;
  }

  // Clamp within page boundaries with a safe margin
  x = Math.max(10, Math.min(pageW - w - 10, x));
  y = Math.max(10, Math.min(pageH - h - 10, y));

  x = Math.round(x * 10) / 10;
  y = Math.round(y * 10) / 10;

  const newImage = {
    id: customId || ('img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)),
    sheet: activeSheet,
    x,
    y,
    width: w,
    height: h,
    dataUrl,
    data_url: dataUrl,
    _el: imgEl,
    deleted: false,
    kind: options.kind || undefined,
    label: options.label || undefined,
    createdAt: Date.now(),
  };

  documentOps.upsertImage(newImage, { recordHistory: true, isNew: true });
  ipc.journalImageMutation('upsert', newImage);

  // Select the newly pasted image and switch to lasso tool
  state.selectedStrokes = [];
  state.selectedImages = [newImage];
  state.selectedTextObjects = [];

  import('../tools/tool-manager.js').then(tm => {
    tm.setTool('lasso', { isUserSwitch: false });
    import('../ui/toolbar.js').then(tb => tb.updateToolbarUI()).catch(() => {});
  }).catch(() => {});

  emit('selectionChanged', { strokes: [], images: [newImage], textObjects: [] });
  import('../render/compositor.js').then(c => c.scheduleRedrawAll()).catch(() => {});

  return newImage;
}

export async function pasteFromSystemClipboard(activeSheet = 0, targetPagePt = null) {
  // 1. Try reading system clipboard via modern navigator.clipboard.read()
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.read === 'function') {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        // 1a. Check for image item
        const imageType = item.types.find(t => t.startsWith('image/'));
        if (imageType) {
          // If item also includes inkwell_objects in text/plain, prefer rich inkwell objects
          if (item.types.includes('text/plain')) {
            try {
              const textBlob = await item.getType('text/plain');
              const text = await textBlob.text();
              const data = JSON.parse(text);
              if (data && data.type === 'inkwell_objects') {
                _clipboard = data;
                return pasteClipboard(activeSheet, 16, targetPagePt);
              }
            } catch (_) {}
          }

          // Otherwise paste the image blob
          const blob = await item.getType(imageType);
          const dataUrl = await blobToDataUrl(blob);
          if (dataUrl) {
            const pastedImg = await pasteImageDataUrl(dataUrl, activeSheet, targetPagePt);
            return !!pastedImg;
          }
        }
      }
    } catch (err) {
      console.warn('[inkwell/clipboard] navigator.clipboard.read error or permission denied:', err);
    }
  }

  // 2. Try reading system clipboard text via navigator.clipboard.readText()
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        const trimmed = text.trim();

        // 2a. Is the text an image Data URL?
        if (trimmed.startsWith('data:image/')) {
          const pastedImg = await pasteImageDataUrl(trimmed, activeSheet, targetPagePt);
          return !!pastedImg;
        }

        // 2b. Is the text serialized Inkwell JSON?
        try {
          const data = JSON.parse(trimmed);
          if (data && data.type === 'inkwell_objects') {
            _clipboard = data;
            return pasteClipboard(activeSheet, 16, targetPagePt);
          }
        } catch (_) {}

        // 2c. Normal text -> create sticky text note
        const px = (targetPagePt && typeof targetPagePt.px === 'number') ? targetPagePt.px : 80;
        const py = (targetPagePt && typeof targetPagePt.py === 'number') ? targetPagePt.py : 120;
        const newTextObj = {
          id: 'txt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
          sheet: activeSheet,
          x: px,
          y: py,
          text: trimmed,
          fontSize: 16,
          color: state.textColor || '#141724',
          bold: false,
          italic: false,
          width: Math.max(140, Math.min(400, trimmed.length * 8)),
          height: 36,
          deleted: false,
        };

        documentOps.upsertTextObject(newTextObj, { recordHistory: true, isNew: true });
        ipc.journalTextMutation('upsert', newTextObj);

        state.selectedStrokes = [];
        state.selectedImages = [];
        state.selectedTextObjects = [newTextObj];

        import('../tools/tool-manager.js').then(tm => {
          tm.setTool('lasso', { isUserSwitch: false });
          import('../ui/toolbar.js').then(tb => tb.updateToolbarUI()).catch(() => {});
        }).catch(() => {});

        emit('selectionChanged', { strokes: [], images: [], textObjects: [newTextObj] });
        import('../render/compositor.js').then(c => c.scheduleRedrawAll()).catch(() => {});
        return true;
      }
    } catch (err) {
      console.warn('[inkwell/clipboard] pasteFromSystemClipboard error:', err);
    }
  }

  // 3. Fallback to internal _clipboard if available
  if (hasClipboardContent()) {
    return pasteClipboard(activeSheet, 16, targetPagePt);
  }

  return false;
}

export async function handlePasteEvent(e, activeSheet = 0, targetPagePt = null) {
  if (!e || !e.clipboardData) return false;

  const items = e.clipboardData.items;
  if (items && items.length) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const file = it.getAsFile();
        if (file) {
          const dataUrl = await blobToDataUrl(file);
          if (dataUrl) {
            e.preventDefault();
            const pastedImg = await pasteImageDataUrl(dataUrl, activeSheet, targetPagePt);
            return !!pastedImg;
          }
        }
      }
    }
  }

  if (e.clipboardData.files && e.clipboardData.files.length) {
    for (let i = 0; i < e.clipboardData.files.length; i++) {
      const file = e.clipboardData.files[i];
      if (file.type.startsWith('image/')) {
        const dataUrl = await blobToDataUrl(file);
        if (dataUrl) {
          e.preventDefault();
          const pastedImg = await pasteImageDataUrl(dataUrl, activeSheet, targetPagePt);
          return !!pastedImg;
        }
      }
    }
  }

  const text = e.clipboardData.getData('text/plain');
  if (text && text.trim()) {
    const trimmed = text.trim();
    if (trimmed.startsWith('data:image/')) {
      e.preventDefault();
      const pastedImg = await pasteImageDataUrl(trimmed, activeSheet, targetPagePt);
      return !!pastedImg;
    }
    try {
      const data = JSON.parse(trimmed);
      if (data && data.type === 'inkwell_objects') {
        e.preventDefault();
        _clipboard = data;
        return pasteClipboard(activeSheet, 16, targetPagePt);
      }
    } catch (_) {}
  }

  return false;
}

export function duplicateSelection(activeSheet = 0, offset = 18) {
  const strokes = (state.selectedStrokes || []).filter(s => !s.deleted);
  const images = (state.selectedImages || []).filter(img => !img.deleted);
  const texts = (state.selectedTextObjects || []).filter(t => !t.deleted);

  if (!strokes.length && !images.length && !texts.length) return false;

  const tempClipboard = _clipboard;
  _clipboard = {
    type: 'inkwell_objects',
    strokes: strokes.map(serializeStroke),
    images: images.map(serializeImage),
    texts: texts.map(serializeText),
  };

  const result = pasteClipboard(activeSheet, offset);
  _clipboard = tempClipboard;
  return result;
}

// ---- Vector SVG Clipping for Obsidian & LaTeX ----

class SvgPathRecorder {
  constructor(offsetX = 0, offsetY = 0) {
    this.offsetX = offsetX;
    this.offsetY = offsetY;
    this.d = '';
  }
  moveTo(x, y) {
    this.d += `M ${(x - this.offsetX).toFixed(2)} ${(y - this.offsetY).toFixed(2)} `;
  }
  lineTo(x, y) {
    this.d += `L ${(x - this.offsetX).toFixed(2)} ${(y - this.offsetY).toFixed(2)} `;
  }
  bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y) {
    this.d += `C ${(cp1x - this.offsetX).toFixed(2)} ${(cp1y - this.offsetY).toFixed(2)}, ${(cp2x - this.offsetX).toFixed(2)} ${(cp2y - this.offsetY).toFixed(2)}, ${(x - this.offsetX).toFixed(2)} ${(y - this.offsetY).toFixed(2)} `;
  }
  arc(cx, cy, r, sa, ea, ccw = false) {
    const startX = cx + r * Math.cos(sa);
    const startY = cy + r * Math.sin(sa);
    const endX = cx + r * Math.cos(ea);
    const endY = cy + r * Math.sin(ea);

    this.d += `L ${(startX - this.offsetX).toFixed(2)} ${(startY - this.offsetY).toFixed(2)} `;

    let diff = ea - sa;
    if (!ccw && diff < 0) diff += Math.PI * 2;
    if (ccw && diff > 0) diff -= Math.PI * 2;
    const absDiff = Math.abs(diff);
    const largeArc = absDiff > Math.PI ? 1 : 0;
    const sweep = ccw ? 0 : 1;

    if (absDiff >= Math.PI * 1.999) {
      const midX = cx - r * Math.cos(sa);
      const midY = cy - r * Math.sin(sa);
      this.d += `A ${r.toFixed(2)} ${r.toFixed(2)} 0 0 ${sweep} ${(midX - this.offsetX).toFixed(2)} ${(midY - this.offsetY).toFixed(2)} `;
      this.d += `A ${r.toFixed(2)} ${r.toFixed(2)} 0 0 ${sweep} ${(startX - this.offsetX).toFixed(2)} ${(startY - this.offsetY).toFixed(2)} `;
    } else {
      this.d += `A ${r.toFixed(2)} ${r.toFixed(2)} 0 ${largeArc} ${sweep} ${(endX - this.offsetX).toFixed(2)} ${(endY - this.offsetY).toFixed(2)} `;
    }
  }
  closePath() {
    this.d += 'Z ';
  }
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function getSelectionBbox() {
  const strokes = (state.selectedStrokes || []).filter(s => !s.deleted);
  const images = (state.selectedImages || []).filter(img => !img.deleted);
  const texts = (state.selectedTextObjects || []).filter(t => !t.deleted);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let hasItems = false;

  for (const s of strokes) {
    const halfW = (s.base_width || 2) / 2;
    for (const pt of (s.points || s._pts || [])) {
      const w = (pt.w !== undefined ? pt.w / 2 : halfW) || halfW;
      minX = Math.min(minX, pt.x - w);
      minY = Math.min(minY, pt.y - w);
      maxX = Math.max(maxX, pt.x + w);
      maxY = Math.max(maxY, pt.y + w);
      hasItems = true;
    }
  }

  for (const img of images) {
    minX = Math.min(minX, img.x);
    minY = Math.min(minY, img.y);
    maxX = Math.max(maxX, img.x + img.width);
    maxY = Math.max(maxY, img.y + img.height);
    hasItems = true;
  }

  for (const t of texts) {
    minX = Math.min(minX, t.x);
    minY = Math.min(minY, t.y);
    maxX = Math.max(maxX, t.x + (t.width || 120));
    maxY = Math.max(maxY, t.y + (t.height || 32));
    hasItems = true;
  }

  if (!hasItems) return null;
  return [minX, minY, maxX, maxY];
}

export function serializeSelectionToSvg() {
  const bbox = getSelectionBbox();
  if (!bbox) return null;

  const pad = 12;
  const minX = bbox[0] - pad;
  const minY = bbox[1] - pad;
  const maxX = bbox[2] + pad;
  const maxY = bbox[3] + pad;
  const w = Math.max(10, Math.round(maxX - minX));
  const h = Math.max(10, Math.round(maxY - minY));

  const strokes = (state.selectedStrokes || []).filter(s => !s.deleted);
  const images = (state.selectedImages || []).filter(img => !img.deleted);
  const texts = (state.selectedTextObjects || []).filter(t => !t.deleted);

  let svgElements = '';

  // 1. Images
  for (const img of images) {
    const url = img.dataUrl || img.data_url || '';
    if (url) {
      const ix = (img.x - minX).toFixed(2);
      const iy = (img.y - minY).toFixed(2);
      const iw = (img.width || 100).toFixed(2);
      const ih = (img.height || 100).toFixed(2);
      svgElements += `  <image href="${escapeXml(url)}" x="${ix}" y="${iy}" width="${iw}" height="${ih}" />\n`;
    }
  }

  // 2. Strokes
  for (const s of strokes) {
    const rawPts = s.points || s._pts || [];
    if (!rawPts.length) continue;
    const baseW = s.base_width || s.baseWidth || 2.0;
    const isHighlighter = s.kind === 'highlighter';
    const rgb = s.rgb || [0, 0, 0];
    const color = `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`;

    const recorder = new SvgPathRecorder(minX, minY);
    if (window.Ink && typeof window.Ink.traceRibbonContour === 'function') {
      window.Ink.traceRibbonContour(recorder, rawPts, baseW);
    } else {
      recorder.moveTo(rawPts[0].x, rawPts[0].y);
      for (let i = 1; i < rawPts.length; i++) {
        recorder.lineTo(rawPts[i].x, rawPts[i].y);
      }
    }

    const pathData = recorder.d.trim();
    if (pathData) {
      if (isHighlighter) {
        svgElements += `  <path d="${pathData}" fill="${color}" opacity="0.45" style="mix-blend-mode: multiply;" />\n`;
      } else {
        svgElements += `  <path d="${pathData}" fill="${color}" />\n`;
      }
    }
  }

  // 3. Text objects
  for (const t of texts) {
    const lines = (t.text || '').split('\n');
    const fs = t.fontSize || 16;
    const color = t.color || '#141724';
    const tx = (t.x - minX).toFixed(2);
    lines.forEach((line, idx) => {
      const ty = (t.y - minY + (idx + 1) * fs * 1.2).toFixed(2);
      svgElements += `  <text x="${tx}" y="${ty}" font-size="${fs}" font-family="Inter, system-ui, sans-serif" fill="${color}">${escapeXml(line)}</text>\n`;
    });
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">\n${svgElements}</svg>`;
}

export async function copySelectionAsSvg() {
  const svgString = serializeSelectionToSvg();
  if (!svgString) {
    emit('toast', { message: 'No selection to copy as SVG', type: 'info' });
    return false;
  }

  const bbox = getSelectionBbox();
  const pad = 12;
  const minX = bbox[0] - pad;
  const minY = bbox[1] - pad;
  const maxX = bbox[2] + pad;
  const maxY = bbox[3] + pad;
  const w = Math.max(10, Math.round(maxX - minX));
  const h = Math.max(10, Math.round(maxY - minY));

  let pngBlob = null;
  try {
    const dpr = 2.0;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.scale(dpr, dpr);
      ctx.translate(-minX, -minY);

      const images = (state.selectedImages || []).filter(img => !img.deleted);
      for (const img of images) {
        if (img._el && img._el.complete) {
          ctx.drawImage(img._el, img.x, img.y, img.width, img.height);
        }
      }

      const strokes = (state.selectedStrokes || []).filter(s => !s.deleted);
      for (const s of strokes) {
        if (window.Ink && typeof window.Ink.drawStroke === 'function') {
          window.Ink.drawStroke(ctx, s);
        }
      }

      const texts = (state.selectedTextObjects || []).filter(t => !t.deleted);
      for (const t of texts) {
        const lines = (t.text || '').split('\n');
        const fs = t.fontSize || 16;
        ctx.font = `${fs}px Inter, system-ui, sans-serif`;
        ctx.fillStyle = t.color || '#141724';
        lines.forEach((line, idx) => {
          ctx.fillText(line, t.x, t.y + (idx + 1) * fs * 1.2);
        });
      }

      pngBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    }
  } catch (err) {
    console.warn('[inkwell/clipboard] PNG rasterization failed:', err);
  }

  let copied = false;
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    try {
      const items = {
        'text/plain': new Blob([svgString], { type: 'text/plain' }),
        'image/svg+xml': new Blob([svgString], { type: 'image/svg+xml' }),
      };
      if (pngBlob) {
        items['image/png'] = pngBlob;
      }
      await navigator.clipboard.write([new ClipboardItem(items)]);
      copied = true;
    } catch (_) {
      try {
        if (typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(svgString);
          copied = true;
        }
      } catch (err) {
        console.warn('[inkwell/clipboard] writeText fallback failed:', err);
      }
    }
  }

  if (copied) {
    emit('toast', { message: 'Copied selection as SVG / Vector graphic', type: 'success' });
  } else {
    emit('toast', { message: 'Failed to write to clipboard', type: 'error' });
  }
  return copied;
}
