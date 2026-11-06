/* ============================================================================
 * workspace/annotations.js — Annotation Review & Document Audit Panel
 *
 * Aggregates every user-created mark in the open document (freehand ink,
 * highlights / text markup, text notes, images, signatures and stamps) into a
 * single page-grouped review list. Provides filtering, text search, precision
 * jump-to-annotation selection and undoable deletion.
 *
 * Read/write boundary: this module never mutates document state directly except
 * through core/document.js operations, so undo, WAL journaling and autosave all
 * keep working exactly as they do for canvas-originated edits.
 * ========================================================================== */

import { state, $, emit, escapeHtml } from '../core/state.js';
import * as documentOps from '../core/document.js';
import * as compositor from '../render/compositor.js';
import * as navigation from './navigation.js';
import * as toolManager from '../tools/tool-manager.js';
import * as textTool from '../tools/text.js';

const CATEGORY_META = {
  ink: { label: 'Ink', icon: 'pen', tone: 'ink' },
  markup: { label: 'Markup', icon: 'highlight', tone: 'markup' },
  note: { label: 'Text note', icon: 'note', tone: 'note' },
  image: { label: 'Image', icon: 'image', tone: 'image' },
};

let _viewport = null;
let _filter = 'all';
let _query = '';
let _initialized = false;
let _refreshScheduled = false;
let _renderedSignature = '';
let _renderLimit = 200;
const RENDER_CHUNK = 200;

const SVG_ICONS = {
  pen: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 19 7-7 3 3-7 7-3-3z"/><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18z"/></svg>',
  highlight: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 11-6 6v3h3l6-6"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>',
  note: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>',
  image: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  signature: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 18c4-8 7-11 9-9s-2 9 1 9 4-4 4-4"/><path d="M3 22h18"/></svg>',
  stamp: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 21h14"/><path d="M7 21v-3.5a4 4 0 0 1 1.8-3.3L10 13V9a3 3 0 0 1 6 0v4l1.2 1.2A4 4 0 0 1 19 17.5V21"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  target: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
  edit: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
};

// ---- Geometry helpers -------------------------------------------------------

function strokeBounds(stroke) {
  if (!stroke || !stroke.points || !stroke.points.length) return null;
  if (stroke.bbox && Number.isFinite(stroke.bbox.x0)) return stroke.bbox;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const half = Math.max(1, (stroke.base_width || 1.6) / 2);
  for (const pt of stroke.points) {
    const x = Number(pt.x ?? pt[0] ?? 0);
    const y = Number(pt.y ?? pt[1] ?? 0);
    const w = Number(pt.w ?? pt.p ?? 0.5);
    const r = Math.max(1, (stroke.base_width || 1.6) * (0.2 + 0.8 * Math.min(1, Math.max(0, w))) / 2, half);
    if (x - r < minX) minX = x - r;
    if (y - r < minY) minY = y - r;
    if (x + r > maxX) maxX = x + r;
    if (y + r > maxY) maxY = y + r;
  }
  if (!Number.isFinite(minX)) return null;
  return { x0: minX, y0: minY, x1: maxX, y1: maxY };
}

function imageKind(img) {
  const id = String(img && img.id || '');
  if (id.startsWith('signature_') || (img && img.kind === 'signature')) return 'signature';
  if (id.startsWith('stamp_') || (img && img.kind === 'stamp')) return 'stamp';
  return 'image';
}

function truncate(text, max = 90) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  return raw.length > max ? raw.slice(0, max - 1).trimEnd() + '…' : raw;
}

function rgbToCss(rgb) {
  if (!Array.isArray(rgb) || rgb.length < 3) return '#2563eb';
  return `rgb(${rgb.map(v => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 255)).join(',')})`;
}

function safeCssColor(value) {
  const raw = String(value || '').trim();
  if (/^#[0-9a-f]{3,8}$/i.test(raw)) return raw;
  if (/^rgba?\([0-9., %]+\)$/i.test(raw)) return raw;
  return '#2563eb';
}

// ---- Aggregation ------------------------------------------------------------

/**
 * Collect every annotation in the document, newest data model included.
 * Each entry keeps a direct reference to the underlying object so actions do
 * not need to look it up again (and so undo restores the same identity).
 */
function collectAllAnnotations() {
  const items = [];
  const pageCount = (state.pageInfos || []).length;
  const clampPage = (sheet) => {
    const n = Number(sheet) || 0;
    return n >= 0 && n < pageCount ? n : 0;
  };

  (state.strokes || []).forEach((stroke, index) => {
    if (!stroke || stroke.deleted) return;
    const isMarkup = String(stroke.id || '').startsWith('markup_') || stroke.kind === 'highlighter';
    const category = isMarkup ? 'markup' : 'ink';
    const kind = CATEGORY_META[category];
    const nPoints = (stroke.points || []).length;
    let title = isMarkup ? 'Highlight / markup' : 'Ink stroke';
    if (isMarkup && String(stroke.id || '').startsWith('markup_underline_')) title = 'Underline';
    else if (isMarkup && String(stroke.id || '').startsWith('markup_strikethrough_')) title = 'Strikethrough';
    else if (stroke.kind === 'highlighter') title = 'Highlighter stroke';
    const snippetParts = [];
    if (stroke.snippet) snippetParts.push(truncate(stroke.snippet));
    if (nPoints) snippetParts.push(`${nPoints} sample${nPoints === 1 ? '' : 's'}`);
    const width = Number(stroke.base_width || 1.6);
    if (width) snippetParts.push(`${width.toFixed(1)} pt wide`);
    items.push({
      id: String(stroke.id),
      category,
      page: clampPage(stroke.sheet),
      title,
      snippet: snippetParts.join(' • '),
      color: rgbToCss(stroke.rgb),
      createdAt: Number(stroke.createdAt || 0),
      order: index,
      // Bounding boxes are only needed when jumping to an item; computing them
      // for every stroke on every panel refresh made large notebooks expensive.
      bbox: stroke.bbox && Number.isFinite(stroke.bbox.x0) ? stroke.bbox : null,
      obj: stroke,
      icon: SVG_ICONS[kind.icon] || SVG_ICONS.pen,
    });
  });

  (state.textObjects || []).forEach((note, index) => {
    if (!note || note.deleted) return;
    const text = note.text || '';
    items.push({
      id: String(note.id),
      category: 'note',
      page: clampPage(note.sheet),
      title: text ? 'Text note' : 'Empty text note',
      snippet: truncate(text) || 'No text content',
      color: safeCssColor(note.color),
      createdAt: Number(note.createdAt || 0),
      order: 100000 + index,
      bbox: { x0: note.x || 0, y0: note.y || 0, x1: (note.x || 0) + (note.width || 120), y1: (note.y || 0) + (note.height || 30) },
      obj: note,
      icon: SVG_ICONS.note,
    });
  });

  (state.images || []).forEach((img, index) => {
    if (!img || img.deleted) return;
    if (String(img.id || '').startsWith('template_bg_') || String(img.id || '').startsWith('img_template_bg_')) return;
    const kind = imageKind(img);
    const meta = kind === 'signature'
      ? { icon: SVG_ICONS.signature, title: 'Signature' }
      : kind === 'stamp'
        ? { icon: SVG_ICONS.stamp, title: 'Stamp' }
        : { icon: SVG_ICONS.image, title: 'Image' };
    items.push({
      id: String(img.id),
      category: 'image',
      page: clampPage(img.sheet),
      title: meta.title,
      snippet: truncate(img.label || '') || `${Math.round(img.width || 0)} × ${Math.round(img.height || 0)} pt`,
      color: '#3b82f6',
      createdAt: Number(img.createdAt || 0),
      order: 200000 + index,
      bbox: { x0: img.x || 0, y0: img.y || 0, x1: (img.x || 0) + (img.width || 0), y1: (img.y || 0) + (img.height || 0) },
      obj: img,
      icon: meta.icon,
    });
  });

  items.sort((a, b) => a.page - b.page || a.order - b.order);
  return items;
}

export function collectAnnotations() {
  const items = collectAllAnnotations();

  if (_filter !== 'all') {
    const wanted = _filter === 'ink' ? ['ink']
      : _filter === 'markup' ? ['markup']
        : _filter === 'note' ? ['note']
          : _filter === 'image' ? ['image'] : [];
    if (wanted.length) return items.filter(item => wanted.includes(item.category));
  }
  if (!_query) return items;
  const q = _query.toLowerCase();
  return items.filter(item =>
    item.title.toLowerCase().includes(q) ||
    item.snippet.toLowerCase().includes(q) ||
    `page ${item.page + 1}`.includes(q)
  );
}

/** Public count used by rail badges and status summaries. */
export function annotationCount() {
  try {
    let n = 0;
    for (const s of state.strokes || []) if (s && !s.deleted) n++;
    for (const t of state.textObjects || []) if (t && !t.deleted) n++;
    for (const im of state.images || []) {
      if (!im || im.deleted) continue;
      const id = String(im.id || '');
      if (id.startsWith('template_bg_') || id.startsWith('img_template_bg_')) continue;
      n++;
    }
    return n;
  } catch (_) {
    return 0;
  }
}

// ---- Badges & refresh scheduling -------------------------------------------

export function updateAnnotationBadge() {
  const badge = $('badgeAnnotations');
  if (!badge) return;
  const n = annotationCount();
  badge.textContent = n > 999 ? '999+' : String(n);
  badge.classList.toggle('hidden', n === 0);
  badge.classList.toggle('green', false);
}

export function resetAnnotationsView() {
  _filter = 'all';
  _query = '';
  _renderLimit = RENDER_CHUNK;
  _renderedSignature = '';
  const search = $('annotationSearchInput');
  if (search) search.value = '';
  document.querySelectorAll('#annotationFilterChips .annotation-filter-chip').forEach(chip => {
    const active = chip.getAttribute('data-filter') === 'all';
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

export function scheduleAnnotationRefresh() {
  if (_refreshScheduled) return;
  _refreshScheduled = true;
  // Coalesce bursts of stroke commits into one cheap badge update, and only
  // rebuild the review DOM after the user pauses (or immediately when the
  // drawer is freshly opened via openDrawer()).
  setTimeout(() => {
    _refreshScheduled = false;
    updateAnnotationBadge();
    const drawer = $('drawerAnnotations');
    if (drawer && !drawer.classList.contains('hidden')) {
      renderAnnotations({ preserveScroll: true });
    }
  }, 160);
}

// ---- Rendering --------------------------------------------------------------

function renderEmptyState() {
  const isFiltered = _filter !== 'all' || !!_query;
  return `
    <div class="annotation-empty">
      <div class="annotation-empty-icon">${isFiltered ? '🔎' : '🖋️'}</div>
      <div class="annotation-empty-title">${isFiltered ? 'No matching annotations' : 'No annotations yet'}</div>
      <div class="annotation-empty-desc">${isFiltered
        ? 'Try a different filter or clear the search field.'
        : 'Use the pen, highlighter, text or stamp tools. Every mark you make will appear here for fast review.'}</div>
    </div>`;
}

function formatWhen(createdAt) {
  if (!createdAt) return '';
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function renderAnnotations(options = {}) {
  const list = $('annotationList');
  if (!list) return;
  const keepScroll = options && options.preserveScroll ? list.scrollTop : 0;

  const items = collectAnnotations();
  const total = annotationCount();
  const signature = `${_filter}|${_query}|${total}|${_renderLimit}|${items.map(i => `${i.id}:${i.title}:${i.snippet}`).join(',')}`;
  const countEl = $('annotationCountLabel');
  if (countEl) {
    if (items.length === total) {
      countEl.textContent = `${total} annotation${total === 1 ? '' : 's'}`;
    } else {
      countEl.textContent = `${items.length} of ${total} shown`;
    }
  }

  // Avoid regenerating DOM when nothing changed — keeps the drawer buttery
  // smooth while inking with the panel open.
  if (signature === _renderedSignature && list.childElementCount) return;
  _renderedSignature = signature;

  if (!items.length) {
    list.innerHTML = renderEmptyState();
    return;
  }

  const visibleItems = items.slice(0, _renderLimit);
  const groups = new Map();
  for (const item of visibleItems) {
    if (!groups.has(item.page)) groups.set(item.page, []);
    groups.get(item.page).push(item);
  }

  const html = [];
  for (const [page, pageItems] of groups) {
    html.push(`
      <div class="annotation-group" data-page="${page}">
        <div class="annotation-group-header">
          <span class="annotation-page-chip">Page ${page + 1}</span>
          <span class="annotation-group-count">${pageItems.length}</span>
        </div>`);
    for (const item of pageItems) {
      const when = formatWhen(item.createdAt);
      html.push(`
        <div class="annotation-card" data-annotation-id="${escapeHtml(item.id)}" data-category="${item.category}" tabindex="0" role="button" aria-label="${escapeHtml(item.title)} on page ${page + 1}">
          <span class="annotation-type-icon tone-${item.category}" style="--annotation-color:${item.color}">${item.icon}</span>
          <span class="annotation-card-body">
            <span class="annotation-card-title">${escapeHtml(item.title)}${when ? `<span class="annotation-time">${escapeHtml(when)}</span>` : ''}</span>
            <span class="annotation-card-snippet">${escapeHtml(item.snippet || '')}</span>
          </span>
          <span class="annotation-card-actions">
            ${item.category === 'note' ? `<button type="button" class="annotation-action-btn annotation-edit" title="Edit text note" aria-label="Edit text note">${SVG_ICONS.edit}</button>` : ''}
            <button type="button" class="annotation-action-btn annotation-goto" title="Jump to annotation" aria-label="Jump to annotation">${SVG_ICONS.target}</button>
            <button type="button" class="annotation-action-btn annotation-delete" title="Delete annotation (undoable)" aria-label="Delete annotation">${SVG_ICONS.trash}</button>
          </span>
        </div>`);
    }
    html.push('</div>');
  }
  if (items.length > visibleItems.length) {
    html.push(`<button type="button" class="annotation-load-more" data-remaining="${items.length - visibleItems.length}">
      Show ${Math.min(RENDER_CHUNK, items.length - visibleItems.length)} more
      <span>${items.length - visibleItems.length} remaining</span>
    </button>`);
  }
  list.innerHTML = html.join('');
  if (keepScroll) list.scrollTop = keepScroll;
}

// ---- Actions ----------------------------------------------------------------

export function focusAnnotationById(annotationId) {
  const category = (() => {
    const stroke = (state.strokes || []).find(s => String(s.id) === String(annotationId) && !s.deleted);
    if (stroke) return 'stroke';
    const note = (state.textObjects || []).find(t => String(t.id) === String(annotationId) && !t.deleted);
    if (note) return 'note';
    const image = (state.images || []).find(im => String(im.id) === String(annotationId) && !im.deleted);
    if (image) return 'image';
    return null;
  })();
  if (!category) return false;

  const record = collectAllAnnotations().find(i => i.id === String(annotationId));
  const page = record ? record.page : 0;
  if (record && !record.bbox && record.obj && record.obj.points) {
    record.bbox = strokeBounds(record.obj);
  }

  navigation.goToPage(page, 'left', _viewport);

  // Center the annotation in the viewport rather than only snapping page-top.
  if (_viewport && record && record.bbox) {
    const layout = _viewport.getPageLayout(page);
    const stage = $('stage');
    if (layout && stage) {
      const z = _viewport.zoom;
      const bounds = typeof _viewport.getPaneBounds === 'function'
        ? _viewport.getPaneBounds('left')
        : { x: 0, y: 0, width: stage.clientWidth, height: stage.clientHeight };
      const centerX = (record.bbox.x0 + record.bbox.x1) / 2;
      const centerY = (record.bbox.y0 + record.bbox.y1) / 2;
      const targetX = Math.round(bounds.x + bounds.width / 2 - (layout.x + centerX) * z);
      const targetY = Math.round(bounds.y + bounds.height / 2 - (layout.y + centerY) * z);
      _viewport.setPan(targetX, targetY, 'left');
    }
  }

  toolManager.setTool('lasso');
  state.selectedStrokes = category === 'stroke' ? [record?.obj].filter(Boolean) : [];
  state.selectedImages = category === 'image' ? [record?.obj].filter(Boolean) : [];
  state.selectedTextObjects = category === 'note' ? [record?.obj].filter(Boolean) : [];
  state.transformMode = null;
  state.lassoPath = null;
  emit('selectionChanged', {});
  compositor.scheduleRedrawAll();
  return true;
}

export function deleteAnnotationById(annotationId) {
  const stroke = (state.strokes || []).find(s => String(s.id) === String(annotationId) && !s.deleted);
  if (stroke) {
    documentOps.deleteStrokes([stroke.id]);
  } else {
    const note = (state.textObjects || []).find(t => String(t.id) === String(annotationId) && !t.deleted);
    if (note) {
      documentOps.deleteTextObject(note.id);
    } else {
      const image = (state.images || []).find(im => String(im.id) === String(annotationId) && !im.deleted);
      if (!image) return false;
      documentOps.deleteImage(image.id);
    }
  }
  _renderedSignature = '';
  compositor.redrawAll();
  scheduleAnnotationRefresh();
  emit('toast', { message: 'Annotation deleted — press Ctrl+Z to undo', type: 'info' });
  return true;
}

// ---- Markdown summary -------------------------------------------------------

export function buildAnnotationSummary() {
  const items = collectAllAnnotations();
  const title = state.currentDocTitle || 'Untitled document';
  const lines = [];
  lines.push(`# Annotations — ${title}`);
  lines.push('');
  const stamp = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  lines.push(`_${(state.pageInfos || []).length || 1} page${(state.pageInfos || []).length === 1 ? '' : 's'} • ${items.length} annotation${items.length === 1 ? '' : 's'} • ${stamp}_`);
  lines.push('');

  let page = null;
  for (const item of items) {
    if (item.page !== page) {
      page = item.page;
      lines.push(`## Page ${page + 1}`);
      lines.push('');
    }
    const detail = item.snippet ? ` — ${item.snippet}` : '';
    lines.push(`- **${item.title}**${detail}`);
  }
  if (!items.length) lines.push('_No annotations._');
  return lines.join('\n');
}

async function copyAnnotationSummary() {
  const markdown = buildAnnotationSummary();
  let copied = false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(markdown);
      copied = true;
    }
  } catch (e) {
    // WebKitGTK can reject clipboard writes without a user gesture context.
    console.warn('[inkwell/annotations] Clipboard API rejected, using selection fallback:', e);
  }
  if (!copied) {
    try {
      const area = document.createElement('textarea');
      area.value = markdown;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      copied = document.execCommand('copy');
      area.remove();
    } catch (e) {
      console.warn('[inkwell/annotations] Clipboard fallback failed:', e);
    }
  }
  if (copied) {
    emit('toast', { message: 'Annotation summary copied as Markdown', type: 'success' });
    return true;
  }
  emit('toast', { message: 'Could not access the clipboard', type: 'error' });
  return false;
}

// ---- Event wiring ------------------------------------------------------------

function setFilter(filter) {
  const next = ['all', 'ink', 'markup', 'note', 'image'].includes(filter) ? filter : 'all';
  if (_filter === next) return;
  _filter = next;
  _renderLimit = RENDER_CHUNK;
  document.querySelectorAll('#annotationFilterChips .annotation-filter-chip').forEach(chip => {
    const active = chip.getAttribute('data-filter') === _filter;
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  _renderedSignature = '';
  renderAnnotations();
}

export function initAnnotations(viewport) {
  if (viewport) _viewport = viewport;
  if (_initialized) return;
  _initialized = true;

  const list = $('annotationList');
  if (list) {
    list.addEventListener('click', e => {
      const loadMore = e.target.closest('.annotation-load-more');
      if (loadMore) {
        _renderLimit += RENDER_CHUNK;
        renderAnnotations({ preserveScroll: true });
        return;
      }
      const action = e.target.closest('.annotation-action-btn');
      const card = e.target.closest('.annotation-card');
      if (!card) return;
      const id = card.getAttribute('data-annotation-id');
      if (!id) return;
      if (action && action.classList.contains('annotation-delete')) {
        e.stopPropagation();
        deleteAnnotationById(id);
        return;
      }
      if (action && action.classList.contains('annotation-edit')) {
        e.stopPropagation();
        focusAnnotationById(id);
        const item = collectAllAnnotations().find(i => i.id === id);
        if (item && item.category === 'note' && _viewport) {
          textTool.startEditing(item.obj, _viewport, 'left', { isNew: false });
        }
        return;
      }
      focusAnnotationById(id);
    });
    list.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const card = e.target.closest('.annotation-card');
      if (!card) return;
      e.preventDefault();
      const id = card.getAttribute('data-annotation-id');
      if (id) focusAnnotationById(id);
    });
  }

  const chips = $('annotationFilterChips');
  if (chips) {
    chips.addEventListener('click', e => {
      const chip = e.target.closest('.annotation-filter-chip');
      if (!chip) return;
      setFilter(chip.getAttribute('data-filter'));
    });
  }

  const summaryBtn = $('btnAnnotationSummary');
  if (summaryBtn) summaryBtn.addEventListener('click', copyAnnotationSummary);

  const search = $('annotationSearchInput');
  if (search) {
    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        _query = search.value.trim();
        _renderLimit = RENDER_CHUNK;
        _renderedSignature = '';
        renderAnnotations();
      }, 90);
    });
  }

  updateAnnotationBadge();
}

export function setAnnotationsViewport(viewport) {
  _viewport = viewport;
}
