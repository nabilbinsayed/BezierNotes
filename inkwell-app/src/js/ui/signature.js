/* ============================================================================
 * ui/signature.js — Signature & Stamp Studio
 *
 * Three professional insertion paths:
 *   1. Draw  — pressure-friendly canvas pad with smoothing and stroke undo.
 *   2. Type  — crisp typographic signatures in three hands.
 *   3. Stamp — approved/draft/confidential/date marks rendered as clean images.
 *
 * All marks land in the document as regular image objects, so they are embedded
 * into the PDF as native image XObjects, participate in undo/redo, and survive
 * every third-party PDF reader. Saved signatures are kept locally as data URLs.
 * ========================================================================== */

import { state, $, emit } from '../core/state.js';
import * as clipboard from '../core/clipboard.js';
import * as compositor from '../render/compositor.js';

const STORAGE_KEY = 'inkwell.signatures.v1';
const MAX_RECENTS = 6;

const FONT_MAP = {
  cursive: '"Caveat", "Segoe Script", "Bradley Hand", "Brush Script MT", cursive',
  serif: 'Georgia, "Times New Roman", serif',
  sans: 'Inter, system-ui, -apple-system, sans-serif',
};

const STAMP_DEFS = [
  { id: 'approved', text: 'APPROVED', sub: 'INKWELL', color: '#15803d', rotate: -5 },
  { id: 'reviewed', text: 'REVIEWED', sub: 'INKWELL', color: '#6d28d9', rotate: -4 },
  { id: 'draft', text: 'DRAFT', sub: 'NOT FINAL', color: '#b45309', rotate: -6 },
  { id: 'confidential', text: 'CONFIDENTIAL', sub: 'DO NOT DISTRIBUTE', color: '#b91c1c', rotate: -4 },
  { id: 'paid', text: 'PAID', sub: 'PAYMENT RECEIVED', color: '#0f766e', rotate: -5 },
  { id: 'void', text: 'VOID', sub: 'CANCELLED', color: '#7f1d1d', rotate: -7 },
  { id: 'received', text: 'RECEIVED', sub: 'DOCUMENT CONTROL', color: '#1d4ed8', rotate: -3 },
  { id: 'date', text: 'DATE', sub: '', color: '#334155', rotate: -2, dynamicDate: true },
];

let _initialized = false;
let _tab = 'draw';
let _color = '#0f172a';
let _width = 3;
let _font = 'cursive';
let _strokes = [];
let _currentStroke = null;
let _isDrawing = false;
let _activeSaved = null;
let _selectedStampId = null;
let _stampCache = new Map();
let _recents = [];

// ---- Local persistence ------------------------------------------------------

function loadRecents() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(item => item && typeof item.dataUrl === 'string' && item.dataUrl.startsWith('data:image/')).slice(0, MAX_RECENTS);
  } catch (e) {
    console.warn('[inkwell/signature] Could not read saved signatures:', e);
    return [];
  }
}

function persistRecents() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_recents.slice(0, MAX_RECENTS)));
  } catch (e) {
    console.warn('[inkwell/signature] Could not persist saved signatures:', e);
  }
}

function saveRecentSignature(dataUrl, label, aspect = 3) {
  if (!dataUrl || dataUrl.length > 1500000) return;
  const entry = {
    id: 'sig_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    dataUrl,
    label: label || 'Signature',
    aspect: Number(aspect) || 3,
    createdAt: Date.now(),
  };
  _recents = [entry, ..._recents.filter(r => r.dataUrl !== dataUrl)].slice(0, MAX_RECENTS);
  persistRecents();
}

// ---- Canvas helpers ---------------------------------------------------------

function fitCanvasToDisplay(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (canvas.width / Math.max(1, rect.width));
  const y = (e.clientY - rect.top) * (canvas.height / Math.max(1, rect.height));
  return { x, y };
}

function drawSmoothStroke(ctx, stroke) {
  const pts = stroke.points;
  if (!pts || !pts.length) return;
  ctx.save();
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 1) {
    ctx.lineTo(pts[0].x + 0.01, pts[0].y + 0.01);
  } else {
    for (let i = 1; i < pts.length - 1; i++) {
      const midX = (pts[i].x + pts[i + 1].x) / 2;
      const midY = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
  }
  ctx.stroke();
  ctx.restore();
}

function renderPad() {
  const canvas = $('signaturePad');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const stroke of _strokes) drawSmoothStroke(ctx, stroke);
  if (_currentStroke) drawSmoothStroke(ctx, _currentStroke);

  const placeholder = $('sigPadPlaceholder');
  if (placeholder) {
    const empty = !_strokes.length && !_currentStroke;
    placeholder.classList.toggle('hidden', !empty);
  }
}

function clearPad() {
  _strokes = [];
  _currentStroke = null;
  _isDrawing = false;
  _activeSaved = null;
  renderPad();
  updateRecentSelection();
  updateInsertHint();
}

function trimCanvas(sourceCanvas, padding = 14) {
  const ctx = sourceCanvas.getContext('2d');
  if (!ctx) return null;
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  let data;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch (e) {
    console.warn('[inkwell/signature] Could not inspect signature pixels:', e);
    return null;
  }
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 6) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;

  const pad = padding;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(h - 1, maxY + pad);

  const out = document.createElement('canvas');
  out.width = Math.max(2, maxX - minX + 1);
  out.height = Math.max(2, maxY - minY + 1);
  const outCtx = out.getContext('2d');
  outCtx.drawImage(sourceCanvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return {
    dataUrl: out.toDataURL('image/png'),
    width: out.width,
    height: out.height,
    aspect: out.width / Math.max(1, out.height),
  };
}

// ---- Typed signature --------------------------------------------------------

function renderTypedSignature({ forInsert = false } = {}) {
  const canvas = $('sigTypePreview');
  const input = $('sigTypeInput');
  if (!canvas) return null;
  const text = (input ? input.value : '').trim();
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!text) {
    ctx.save();
    ctx.fillStyle = 'rgba(148, 163, 184, 0.55)';
    ctx.font = '600 34px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Your signature will appear here', canvas.width / 2, canvas.height / 2);
    ctx.restore();
    return null;
  }

  const fontSize = 112;
  ctx.save();
  ctx.fillStyle = _color;
  ctx.font = `${_font === 'cursive' ? 'italic ' : ''}${fontSize}px ${FONT_MAP[_font] || FONT_MAP.cursive}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const measured = ctx.measureText(text).width;
  const scale = Math.min(1, (canvas.width - 60) / Math.max(1, measured));
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.scale(scale, scale);
  ctx.fillText(text, 0, 0);
  ctx.restore();

  if (!forInsert) return null;
  return trimCanvas(canvas, 16);
}

// ---- Stamps -----------------------------------------------------------------

function stampDateText() {
  try {
    return new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' }).toUpperCase();
  } catch (_) {
    return new Date().toISOString().slice(0, 10);
  }
}

function makeStampData(def) {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 232;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const color = def.color || '#15803d';

  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(((def.rotate || 0) * Math.PI) / 180);
  ctx.translate(-canvas.width / 2, -canvas.height / 2);

  const x = 22, y = 22, w = canvas.width - 44, h = canvas.height - 44;
  const radius = 18;
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, radius);
  else ctx.rect(x, y, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.62)';
  ctx.fill();

  ctx.strokeStyle = color;
  ctx.lineWidth = 9;
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, radius);
  else ctx.rect(x, y, w, h);
  ctx.stroke();

  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x + 12, y + 12, w - 24, h - 24, radius - 7);
  else ctx.rect(x + 12, y + 12, w - 24, h - 24);
  ctx.stroke();
  ctx.globalAlpha = 1;

  const mainText = def.dynamicDate ? stampDateText() : def.text;
  const subText = def.dynamicDate ? 'DATE' : (def.sub || '');
  const mainSize = mainText.length > 13 ? 50 : (mainText.length > 10 ? 58 : 68);
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `800 ${mainSize}px Inter, system-ui, sans-serif`;
  ctx.fillText(mainText, canvas.width / 2, canvas.height / 2 + (subText ? -12 : 0));

  if (subText) {
    ctx.font = '700 20px Inter, system-ui, sans-serif';
    ctx.globalAlpha = 0.9;
    ctx.fillText(subText, canvas.width / 2, canvas.height / 2 + 44);
  }
  ctx.restore();

  return canvas.toDataURL('image/png');
}

function getStampData(id) {
  if (!_stampCache.has(id)) {
    const def = STAMP_DEFS.find(s => s.id === id);
    if (!def) return null;
    _stampCache.set(id, makeStampData(def));
  }
  return _stampCache.get(id);
}

function renderStampGrid() {
  const grid = $('sigStampGrid');
  if (!grid) return;
  grid.innerHTML = STAMP_DEFS.map(def => {
    const url = getStampData(def.id);
    return `
      <button type="button" class="sig-stamp-card" data-stamp-id="${def.id}" title="${def.text}">
        <img src="${url}" alt="${def.text} stamp preview" draggable="false">
      </button>`;
  }).join('');

  grid.onclick = e => {
    const card = e.target.closest('.sig-stamp-card');
    if (!card) return;
    _selectedStampId = card.getAttribute('data-stamp-id');
    _activeSaved = null;
    grid.querySelectorAll('.sig-stamp-card').forEach(c => c.classList.toggle('active', c === card));
    updateInsertHint();
  };
}

// ---- Recent signatures ------------------------------------------------------

function renderRecents() {
  const wrap = $('sigRecentWrap');
  const list = $('sigRecentList');
  if (!wrap || !list) return;
  if (!_recents.length) {
    wrap.classList.add('hidden');
    list.innerHTML = '';
    return;
  }
  wrap.classList.remove('hidden');
  list.innerHTML = _recents.map(entry => `
    <button type="button" class="sig-recent-card" data-recent-id="${entry.id}" title="Use saved signature">
      <img src="${entry.dataUrl}" alt="Saved signature" draggable="false">
      <span class="sig-recent-meta">${new Date(entry.createdAt || Date.now()).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
    </button>`).join('');

  const update = () => {
    list.querySelectorAll('.sig-recent-card').forEach(card => {
      card.classList.toggle('active', !!_activeSaved && card.getAttribute('data-recent-id') === _activeSaved.id);
    });
  };
  list.onclick = e => {
    const card = e.target.closest('.sig-recent-card');
    if (!card) return;
    const id = card.getAttribute('data-recent-id');
    _activeSaved = _recents.find(r => r.id === id) || null;
    _selectedStampId = null;
    if ($('sigStampGrid')) $('sigStampGrid').querySelectorAll('.sig-stamp-card').forEach(c => c.classList.remove('active'));
    update();
    updateInsertHint();
  };
  update();
}

function updateRecentSelection() {
  const list = $('sigRecentList');
  if (!list) return;
  list.querySelectorAll('.sig-recent-card').forEach(card => {
    card.classList.toggle('active', !!_activeSaved && card.getAttribute('data-recent-id') === _activeSaved.id);
  });
}

function updateInsertHint() {
  const hint = $('sigInsertHint');
  const btn = $('btnSigInsert');
  if (!hint || !btn) return;
  if (_activeSaved) {
    hint.textContent = 'Saved signature selected';
    btn.textContent = 'Insert Signature';
  } else if (_tab === 'stamp') {
    hint.textContent = _selectedStampId ? 'Stamp selected' : 'Choose a stamp above';
    btn.textContent = 'Insert Stamp';
  } else if (_tab === 'type') {
    hint.textContent = 'Type a name to create a signature';
    btn.textContent = 'Insert Signature';
  } else {
    hint.textContent = 'Draw your signature above';
    btn.textContent = 'Insert Signature';
  }
}

// ---- Tabs ---------------------------------------------------------------

function setTab(tab) {
  _tab = ['draw', 'type', 'stamp'].includes(tab) ? tab : 'draw';
  document.querySelectorAll('.sig-tab').forEach(btn => {
    const active = btn.getAttribute('data-sig-tab') === _tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  $('sigPanelDraw') && $('sigPanelDraw').classList.toggle('hidden', _tab !== 'draw');
  $('sigPanelType') && $('sigPanelType').classList.toggle('hidden', _tab !== 'type');
  $('sigPanelStamp') && $('sigPanelStamp').classList.toggle('hidden', _tab !== 'stamp');
  $('sigRecentWrap') && $('sigRecentWrap').classList.toggle('hidden', _tab === 'stamp' || !_recents.length);

  if (_tab === 'type') {
    renderTypedSignature();
    setTimeout(() => { const input = $('sigTypeInput'); if (input) input.focus(); }, 40);
  }
  if (_tab === 'stamp') {
    _activeSaved = null;
    updateRecentSelection();
  }
  updateInsertHint();
}

// ---- Insert -------------------------------------------------------------

async function insertCurrent() {
  let dataUrl = null;
  let kind = 'signature';
  let label = 'Signature';
  let widthPt = 180;
  let aspect = 3;

  if (_activeSaved) {
    dataUrl = _activeSaved.dataUrl;
    aspect = _activeSaved.aspect || 3;
    widthPt = 170;
  } else if (_tab === 'stamp') {
    if (!_selectedStampId) {
      emit('toast', { message: 'Choose a stamp first', type: 'info' });
      return false;
    }
    dataUrl = getStampData(_selectedStampId);
    const def = STAMP_DEFS.find(s => s.id === _selectedStampId);
    label = def ? def.text : 'Stamp';
    kind = 'stamp';
    widthPt = 200;
    aspect = 640 / 232;
  } else if (_tab === 'type') {
    const trimmed = renderTypedSignature({ forInsert: true });
    if (!trimmed) {
      emit('toast', { message: 'Type your name before inserting', type: 'info' });
      return false;
    }
    dataUrl = trimmed.dataUrl;
    aspect = trimmed.aspect;
    label = ($('sigTypeInput') && $('sigTypeInput').value.trim()) || 'Signature';
    widthPt = 190;
  } else {
    if (!_strokes.length) {
      emit('toast', { message: 'Draw your signature before inserting', type: 'info' });
      return false;
    }
    const canvas = $('signaturePad');
    const trimmed = canvas ? trimCanvas(canvas, 16) : null;
    if (!trimmed) {
      emit('toast', { message: 'The signature pad is empty', type: 'info' });
      return false;
    }
    dataUrl = trimmed.dataUrl;
    aspect = trimmed.aspect;
    widthPt = 190;
  }

  if (!dataUrl) {
    emit('toast', { message: 'Could not render the signature', type: 'error' });
    return false;
  }

  const viewport = typeof window.getViewport === 'function' ? window.getViewport() : null;
  const pane = state.drawingPane || 'left';
  const sheet = viewport && typeof viewport.getActivePageInView === 'function'
    ? viewport.getActivePageInView(pane)
    : (state.leftSheet || 0);

  const id = (kind === 'stamp' ? 'stamp_' : 'signature_') + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  try {
    const img = await clipboard.pasteImageDataUrl(dataUrl, sheet, null, id, {
      widthPt,
      maxWidthPt: 260,
      maxHeightPt: 140,
      kind,
      label,
    });
    if (!img) throw new Error('Image insertion returned no object');

    if (kind !== 'stamp') {
      saveRecentSignature(dataUrl, label, aspect);
      renderRecents();
    }
    emit('toast', {
      message: kind === 'stamp' ? `${label} stamp inserted — drag to reposition` : 'Signature inserted — drag to reposition',
      type: 'success',
    });
    closeSignatureStudio();
    compositor.scheduleRedrawAll();
    return true;
  } catch (err) {
    console.error('[inkwell/signature] Insert failed:', err);
    emit('toast', { message: 'Could not insert signature: ' + (err && err.message ? err.message : err), type: 'error' });
    return false;
  }
}

// ---- Open/close & wiring ------------------------------------------------

export function openSignatureStudio(tab = 'draw') {
  const modal = $('signatureModal');
  if (!modal) return;
  _recents = loadRecents();
  _activeSaved = null;
  _selectedStampId = null;
  if (document.fonts && typeof document.fonts.load === 'function') {
    document.fonts.load('400 112px Caveat').then(() => {
      if (!_activeSaved) renderTypedSignature();
    }).catch(() => {});
  }
  // Refresh the date stamp so an app left open overnight prints today's date.
  _stampCache.delete('date');
  renderStampGrid();
  renderRecents();
  renderPad();
  renderTypedSignature();
  setTab(tab);
  updateInsertHint();
  modal.classList.remove('hidden');
}

export function closeSignatureStudio() {
  const modal = $('signatureModal');
  if (modal) modal.classList.add('hidden');
  _activeSaved = null;
  _selectedStampId = null;
}

function bindPad() {
  const canvas = $('signaturePad');
  if (!canvas) return;

  canvas.addEventListener('pointerdown', e => {
    if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    _isDrawing = true;
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    _activeSaved = null;
    updateRecentSelection();
    const pt = fitCanvasToDisplay(canvas, e);
    _currentStroke = { color: _color, width: _width, points: [pt] };
    renderPad();
  });

  canvas.addEventListener('pointermove', e => {
    if (!_isDrawing || !_currentStroke) return;
    e.preventDefault();
    const pt = fitCanvasToDisplay(canvas, e);
    const last = _currentStroke.points[_currentStroke.points.length - 1];
    if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < 0.6) return;
    _currentStroke.points.push(pt);
    renderPad();
  });

  const endStroke = e => {
    if (!_isDrawing) return;
    _isDrawing = false;
    if (_currentStroke && _currentStroke.points.length) {
      _strokes.push(_currentStroke);
    }
    _currentStroke = null;
    renderPad();
    updateInsertHint();
    if (canvas.releasePointerCapture && e && e.pointerId !== undefined) {
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    }
  };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave', e => {
    // Mouse leaving the pad while not captured should close the stroke.
    if (_isDrawing && e.pointerType === 'mouse' && (!e.buttons)) endStroke(e);
  });
}

function bindControls() {
  document.querySelectorAll('.sig-tab').forEach(btn => {
    btn.addEventListener('click', () => setTab(btn.getAttribute('data-sig-tab')));
  });

  $('btnCloseSignatureModal') && $('btnCloseSignatureModal').addEventListener('click', closeSignatureStudio);
  $('btnCancelSignature') && $('btnCancelSignature').addEventListener('click', closeSignatureStudio);
  $('btnSigInsert') && $('btnSigInsert').addEventListener('click', insertCurrent);

  const modal = $('signatureModal');
  if (modal) {
    modal.addEventListener('click', e => {
      if (e.target === modal) closeSignatureStudio();
    });
  }

  $('btnSigClearPad') && $('btnSigClearPad').addEventListener('click', clearPad);
  $('btnSigUndoStroke') && $('btnSigUndoStroke').addEventListener('click', () => {
    if (_strokes.length) {
      _strokes.pop();
      renderPad();
      updateInsertHint();
    }
  });

  document.querySelectorAll('#sigColorRow .sig-color-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      _color = dot.getAttribute('data-color') || '#0f172a';
      document.querySelectorAll('#sigColorRow .sig-color-dot').forEach(d => d.classList.toggle('active', d === dot));
      renderTypedSignature();
    });
  });

  $('sigPenWidth') && $('sigPenWidth').addEventListener('input', e => {
    _width = Number(e.target.value) || 3;
  });

  $('sigTypeInput') && $('sigTypeInput').addEventListener('input', () => {
    _activeSaved = null;
    updateRecentSelection();
    renderTypedSignature();
    updateInsertHint();
  });

  document.querySelectorAll('.sig-font-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _font = btn.getAttribute('data-font') || 'cursive';
      document.querySelectorAll('.sig-font-btn').forEach(b => b.classList.toggle('active', b === btn));
      _activeSaved = null;
      updateRecentSelection();
      renderTypedSignature();
    });
  });

  $('btnSigClearRecent') && $('btnSigClearRecent').addEventListener('click', () => {
    _recents = [];
    _activeSaved = null;
    persistRecents();
    renderRecents();
    updateInsertHint();
  });

  $('btnDockSignature') && $('btnDockSignature').addEventListener('click', () => openSignatureStudio('draw'));
  $('btnMoreSignature') && $('btnMoreSignature').addEventListener('click', () => {
    const menu = $('moreOptionsMenu');
    if (menu) menu.classList.add('hidden');
    openSignatureStudio('draw');
  });
}

export function initSignatureStudio() {
  if (_initialized) return;
  _initialized = true;
  _recents = loadRecents();
  bindPad();
  bindControls();
  // Warm the stamp cache so opening the Stamps tab is instantaneous.
  for (const def of STAMP_DEFS) getStampData(def.id);
  renderRecents();
}

export function getSavedSignatureCount() {
  return _recents.length;
}
