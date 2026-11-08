/* ============================================================================
 * ui/drawers.js — Navigation Slide-Out Panels & Rail Buttons for Inkwell
 * Renders Thumbnails, Table of Contents, Bookmarks, and Search Panels.
 * ========================================================================== */

import { state, $, escapeHtml, emit } from '../core/state.js';
import * as templates from '../render/templates.js';
import * as ipc from '../core/ipc.js';
import * as textSelection from '../workspace/text-selection.js';
import * as compositor from '../render/compositor.js';
import * as documentOps from '../core/document.js';
import * as annotations from '../workspace/annotations.js';
import * as tiles from '../render/tiles.js';

let _goToPageCallback = null;

function getTargetNavPane() {
  return (state.splitMode && (state.activePane === 'right' || state.drawingPane === 'right')) ? 'right' : 'left';
}

export function setGoToPageCallback(cb) {
  _goToPageCallback = cb;
}

export function initDrawers() {
  bindRailButtons();
  bindMoreMenu();
  bindSearchEvents();
  bindBookmarkEvents();
}

function bindRailButtons() {
  $('btnRailThumbnails') && $('btnRailThumbnails').addEventListener('click', () => toggleDrawer('thumbnails'));
  $('btnRailOutline') && $('btnRailOutline').addEventListener('click', () => toggleDrawer('outline'));
  $('btnRailSearch') && $('btnRailSearch').addEventListener('click', () => toggleDrawer('search'));
  $('btnRailBookmarks') && $('btnRailBookmarks').addEventListener('click', () => toggleDrawer('bookmarks'));
  $('btnRailAnnotations') && $('btnRailAnnotations').addEventListener('click', () => toggleDrawer('annotations'));
  $('btnRailDocInfo') && $('btnRailDocInfo').addEventListener('click', () => toggleDrawer('docinfo'));
  $('btnRailSettings') && $('btnRailSettings').addEventListener('click', () => {
    const modal = $('settingsModal');
    if (modal) modal.classList.remove('hidden');
    else toggleDrawer('settings');
  });
  $('btnCloseDrawer') && $('btnCloseDrawer').addEventListener('click', () => closeDrawer());

  $('btnToggleSidebar') && $('btnToggleSidebar').addEventListener('click', () => toggleDrawer('thumbnails'));
  $('btnCollapseSidebar') && $('btnCollapseSidebar').addEventListener('click', () => closeDrawer());

  // Listen for hardware diagnostics events
  import('../core/state.js').then(({ on }) => {
    on('hardwareDiagnostics', payload => updateHardwareDiagnosticsUI(payload));
  });
}

let _diagElements = null;

export function updateHardwareDiagnosticsUI(diag) {
  if (!diag) return;

  const modal = $('settingsModal');
  const isSettingsVisible = (modal && !modal.classList.contains('hidden')) || state.activeDrawer === 'settings' || state.activeDrawer === 'docinfo';
  if (!isSettingsVisible) return;

  if (!_diagElements) {
    _diagElements = {
      pointerType: $('diagPointerType'),
      pressureSource: $('diagPressureSource'),
      activeDevice: $('diagActiveDevice'),
      livePressure: $('diagLivePressure'),
    };
  }

  if (_diagElements.pointerType) {
    _diagElements.pointerType.textContent = diag.pointerType === 'pen'
      ? 'Stylus Pen'
      : (diag.pointerType === 'eraser' ? 'Stylus Eraser' : 'Mouse / Trackpad');
  }
  if (_diagElements.pressureSource) {
    if (diag.pressureSource === 'native') {
      _diagElements.pressureSource.textContent = 'Native Linux (evdev)';
      _diagElements.pressureSource.className = 'diag-badge green';
    } else if (diag.pressureSource === 'browser') {
      _diagElements.pressureSource.textContent = 'Browser (PointerEvent)';
      _diagElements.pressureSource.className = 'diag-badge';
    } else {
      _diagElements.pressureSource.textContent = 'Fallback (0.5)';
      _diagElements.pressureSource.className = 'diag-badge';
    }
  }
  if (_diagElements.activeDevice && diag.device) {
    _diagElements.activeDevice.textContent = `${diag.device.name || 'Device'} (${diag.device.path || ''})`;
    _diagElements.activeDevice.title = `${diag.device.name || ''} at ${diag.device.path || ''}`;
  }
  if (_diagElements.livePressure && diag.pressure != null) {
    _diagElements.livePressure.textContent = Number(diag.pressure).toFixed(2);
  }
}

function bindMoreMenu() {
  const btnMore = $('btnRailMore');
  const menu = $('moreOptionsMenu');
  if (btnMore && menu) {
    btnMore.addEventListener('click', e => {
      e.stopPropagation();
      menu.classList.toggle('hidden');
    });

    document.addEventListener('click', e => {
      if (!e.target.closest('#moreOptionsMenu') && !e.target.closest('#btnRailMore')) {
        menu.classList.add('hidden');
      }
    });
  }
}

export function openDrawer(drawerName) {
  const drawer = $('navDrawer');
  if (!drawer) return;

  state.activeDrawer = drawerName;
  drawer.classList.remove('hidden');

  // Highlight active rail button (preserving split button state)
  document.querySelectorAll('.rail-btn').forEach(btn => {
    if (btn.id !== 'btnRailSplit') btn.classList.remove('active');
  });

  const btnMap = {
    thumbnails: $('btnRailThumbnails'),
    outline: $('btnRailOutline'),
    search: $('btnRailSearch'),
    bookmarks: $('btnRailBookmarks'),
    annotations: $('btnRailAnnotations'),
    docinfo: $('btnRailDocInfo'),
  };

  const activeBtn = btnMap[drawerName] || $(`btnRail${drawerName.charAt(0).toUpperCase() + drawerName.slice(1)}`);
  if (activeBtn) activeBtn.classList.add('active');

  // Show corresponding drawer pane
  document.querySelectorAll('.drawer-content').forEach(view => view.classList.add('hidden'));
  const targetId = drawerName === 'docinfo' ? 'drawerDocInfo' : `drawer${drawerName.charAt(0).toUpperCase() + drawerName.slice(1)}`;
  const targetView = $(`drawerView_${drawerName}`) || $(targetId);
  if (targetView) targetView.classList.remove('hidden');

  const titleEl = $('drawerTitle');
  if (titleEl) {
    const titles = {
      thumbnails: 'Thumbnails',
      outline: 'Document Outline',
      search: 'Search in Document',
      bookmarks: 'Bookmarks',
      docinfo: 'Document Details',
      annotations: 'Annotations & Review',
      settings: 'Preferences',
    };
    titleEl.textContent = titles[drawerName] || drawerName;
  }

  if (drawerName === 'thumbnails') renderThumbnails();
  else if (drawerName === 'outline') renderOutline();
  else if (drawerName === 'bookmarks') renderBookmarks();
  else if (drawerName === 'docinfo') renderDocInfo();
  else if (drawerName === 'annotations') annotations.renderAnnotations();

  emit('drawerOpened', { drawer: drawerName });
}

export function renderDocInfo() {
  const titleEl = $('docInfoTitle');
  if (titleEl) {
    titleEl.textContent = state.currentDocTitle || (state.filePath ? state.filePath.split(/[\\/]/).pop() : 'Untitled.pdf');
  }

  const statPages = $('docStatPages');
  if (statPages) {
    statPages.textContent = String((state.pageInfos && state.pageInfos.length) || 1);
  }

  const statStrokes = $('docStatStrokes');
  if (statStrokes) {
    const activeStrokes = (state.strokes || []).filter(s => !s.deleted).length;
    statStrokes.textContent = String(activeStrokes);
  }

  const curPage = state.leftSheet != null ? state.leftSheet : 0;
  const statCurPage = $('docStatCurrentPage');
  if (statCurPage) {
    statCurPage.textContent = `Page ${curPage + 1}`;
  }

  const statDims = $('docStatDimensions');
  if (statDims) {
    const pi = state.pageInfos && state.pageInfos[curPage];
    if (pi && pi.width_pt && pi.height_pt) {
      statDims.textContent = `${Math.round(pi.width_pt)} × ${Math.round(pi.height_pt)} pt`;
    } else {
      statDims.textContent = 'A4 Portrait';
    }
  }

  // Update hardware telemetry badge defaults if not yet emitted
  const diagPointer = $('diagPointerType');
  if (diagPointer && (!diagPointer.textContent || diagPointer.textContent === 'Scanning...')) {
    diagPointer.textContent = state.lastPointerType ? (state.lastPointerType.charAt(0).toUpperCase() + state.lastPointerType.slice(1)) : 'Mouse / Trackpad';
  }

  const diagDevice = $('diagActiveDevice');
  if (diagDevice && (!diagDevice.textContent || diagDevice.textContent === 'Scanning...')) {
    diagDevice.textContent = navigator.userAgentData?.platform || navigator.platform || 'Desktop Host';
  }
}

export function closeDrawer() {
  const drawer = $('navDrawer');
  if (drawer) drawer.classList.add('hidden');
  state.activeDrawer = null;
  document.querySelectorAll('.rail-btn').forEach(btn => {
    if (btn.id !== 'btnRailSplit') btn.classList.remove('active');
  });
  emit('drawerClosed', {});
}

export function toggleDrawer(drawerName) {
  if (state.activeDrawer === drawerName) {
    closeDrawer();
  } else {
    openDrawer(drawerName);
  }
}

function bindBookmarkEvents() {
  const addCurrentPageBookmark = () => {
    const activePage = state.leftSheet != null ? state.leftSheet : 0;
    if (!state.bookmarks) state.bookmarks = [];
    const exists = state.bookmarks.some(b => b.page === activePage);
    if (exists) {
      emit('toast', { message: `Page ${activePage + 1} is already bookmarked`, type: 'info' });
      return;
    }
    state.bookmarks.push({
      id: 'bm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      page: activePage,
      label: `Page ${activePage + 1}`,
      createdAt: Date.now(),
    });
    state.isDirty = true;
    emit('documentChanged', { type: 'bookmark_change' });
    renderBookmarks();
    emit('toast', { message: `Bookmarked Page ${activePage + 1}`, type: 'success' });
  };

  $('btnAddBookmark') && $('btnAddBookmark').addEventListener('click', addCurrentPageBookmark);
  $('btnOutlineAddBookmark') && $('btnOutlineAddBookmark').addEventListener('click', addCurrentPageBookmark);
}

export function renderBookmarks() {
  const list = $('bookmarksList');
  if (!list) return;

  const bookmarks = state.bookmarks || [];
  if (!bookmarks.length) {
    list.innerHTML = `
      <div class="drawer-empty-state">
        <div class="empty-state-icon">🔖</div>
        <div class="empty-state-title">No Bookmarks Yet</div>
        <div class="empty-state-desc">Click "Bookmark Current Page" above to save quick reference points.</div>
      </div>
    `;
    return;
  }

  list.innerHTML = bookmarks.map(bm => `
    <div class="bookmark-card${bm.page === state.leftSheet ? ' active' : ''}" data-page="${bm.page}">
      <div class="bookmark-info">
        <span class="bookmark-title">${escapeHtml(bm.label || `Page ${bm.page + 1}`)}</span>
        <span class="bookmark-meta">Page ${bm.page + 1}</span>
      </div>
      <button class="bookmark-delete-btn" title="Remove Bookmark" data-id="${bm.id}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>
  `).join('');

  list.querySelectorAll('.bookmark-card').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('.bookmark-delete-btn')) return;
      const pageIdx = parseInt(card.dataset.page, 10);
      if (!isNaN(pageIdx) && typeof _goToPageCallback === 'function') {
        const targetPane = getTargetNavPane();
        _goToPageCallback(pageIdx, targetPane);
        list.querySelectorAll('.bookmark-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
      }
    });
  });

  list.querySelectorAll('.bookmark-delete-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const bmId = btn.dataset.id;
      if (!bmId) return;
      state.bookmarks = (state.bookmarks || []).filter(b => String(b.id) !== String(bmId));
      state.isDirty = true;
      emit('documentChanged', { type: 'bookmark_change' });
      renderBookmarks();
      emit('toast', { message: 'Bookmark removed', type: 'info' });
    });
  });
}

async function handleDuplicatePage(idx) {
  try {
    const res = await ipc.duplicatePage(idx);
    const targetIdx = documentOps.duplicatePageAtIndex(idx, res);
    if (typeof _goToPageCallback === 'function' && targetIdx >= 0) {
      _goToPageCallback(targetIdx, 'left');
    }
    renderThumbnails();
    emit('toast', { message: `Page ${idx + 1} duplicated`, type: 'success' });
  } catch (err) {
    console.error('[inkwell/drawers] duplicatePage error:', err);
    emit('toast', { message: 'Failed to duplicate page: ' + (err.message || err), type: 'error' });
  }
}

async function handleRotatePage(idx, clockwise = true) {
  try {
    await ipc.rotatePage(idx, clockwise);
    documentOps.rotatePageAtIndex(idx, clockwise);
    if (typeof _goToPageCallback === 'function') {
      _goToPageCallback(idx, 'left');
    }
    renderThumbnails();
    compositor.scheduleRedrawTiles();
    compositor.redrawAll();
    emit('toast', { message: `Page ${idx + 1} rotated 90°`, type: 'success' });
  } catch (err) {
    console.error('[inkwell/drawers] rotatePage error:', err);
    emit('toast', { message: 'Failed to rotate page: ' + (err.message || err), type: 'error' });
  }
}

export function confirmDeletePageDialog(pageIndex) {
  return new Promise(resolve => {
    const modal = $('confirmDeletePageModal');
    const msg = $('confirmDeletePageMsg');
    const btnCancel = $('btnConfirmDeletePageCancel');
    const btnConfirm = $('btnConfirmDeletePageConfirm');

    if (!modal || !btnCancel || !btnConfirm) {
      resolve(window.confirm(`Are you sure you want to delete Page ${pageIndex + 1}?`));
      return;
    }

    if (msg) {
      msg.textContent = `Are you sure you want to delete Page ${pageIndex + 1}? This action cannot be undone.`;
    }

    modal.classList.remove('hidden');

    const cleanUp = () => {
      btnCancel.removeEventListener('click', onCancel);
      btnConfirm.removeEventListener('click', onConfirm);
      modal.removeEventListener('click', onBackdrop);
      window.removeEventListener('keydown', onKeyDown);
      modal.classList.add('hidden');
    };

    const onCancel = () => {
      cleanUp();
      resolve(false);
    };

    const onConfirm = () => {
      cleanUp();
      resolve(true);
    };

    const onBackdrop = (e) => {
      if (e.target === modal) {
        cleanUp();
        resolve(false);
      }
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        cleanUp();
        resolve(false);
      }
    };

    btnCancel.addEventListener('click', onCancel);
    btnConfirm.addEventListener('click', onConfirm);
    modal.addEventListener('click', onBackdrop);
    window.addEventListener('keydown', onKeyDown);
  });
}

async function handleDeletePage(idx) {
  if (!state.pageInfos || state.pageInfos.length <= 1) {
    emit('toast', { message: 'Cannot delete the only remaining page', type: 'info' });
    return;
  }

  const confirmed = await confirmDeletePageDialog(idx);
  if (!confirmed) return;

  try {
    await ipc.deletePage(idx);
    documentOps.deletePageAtIndex(idx);
    const newPage = Math.min(state.leftSheet, state.pageInfos.length - 1);
    if (typeof _goToPageCallback === 'function') {
      _goToPageCallback(newPage, 'left');
    }
    renderThumbnails();
    emit('toast', { message: `Page ${idx + 1} deleted`, type: 'success' });
  } catch (err) {
    console.error('[inkwell/drawers] deletePage error:', err);
    emit('toast', { message: 'Failed to delete page: ' + (err.message || err), type: 'error' });
  }
}

async function handleReorderPage(fromIdx, toIdx) {
  if (fromIdx === toIdx) return;
  try {
    await ipc.reorderPages(fromIdx, toIdx);
    documentOps.reorderPageAtIndex(fromIdx, toIdx);
    if (typeof _goToPageCallback === 'function') {
      _goToPageCallback(toIdx, 'left');
    }
    renderThumbnails();
    emit('toast', { message: `Page ${fromIdx + 1} moved to position ${toIdx + 1}`, type: 'success' });
  } catch (err) {
    console.error('[inkwell/drawers] reorderPage error:', err);
    emit('toast', { message: 'Failed to reorder page: ' + (err.message || err), type: 'error' });
  }
}

let _thumbObserver = null;
let _thumbQueue = new Map();
let _thumbFrame = null;

function countAnnotationsOnPage(pageIndex) {
  let n = 0;
  for (const s of state.strokes || []) {
    if (!s.deleted && (s.sheet || 0) === pageIndex) n++;
  }
  for (const t of state.textObjects || []) {
    if (!t.deleted && (t.sheet || 0) === pageIndex) n++;
  }
  for (const im of state.images || []) {
    if (im.deleted || (im.sheet || 0) !== pageIndex) continue;
    const id = String(im.id || '');
    if (id.startsWith('template_bg_') || id.startsWith('img_template_bg_')) continue;
    n++;
  }
  return n;
}

export async function drawThumbnailCanvas(canvas, idx, pi) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (!pi) pi = (state.pageInfos && state.pageInfos[idx]) || { width_pt: 595, height_pt: 842 };
  const thumbW = canvas.width;
  const thumbH = canvas.height;
  const pw = (pi && pi.width_pt > 0) ? pi.width_pt : 595;
  const ph = (pi && pi.height_pt > 0) ? pi.height_pt : 842;
  const scale = thumbW / pw;

  ctx.clearRect(0, 0, thumbW, thumbH);

  // 1. Background template (paper color + guidelines)
  const tmpl = (pi && pi.template) ? pi.template : 'blank';
  const isDark = tmpl === 'dark';
  ctx.fillStyle = isDark ? '#0f172a' : '#ffffff';
  ctx.fillRect(0, 0, thumbW, thumbH);

  if (tmpl !== 'blank') {
    ctx.save();
    ctx.scale(thumbW / pw, thumbH / ph);
    templates.drawPageTemplateGuidelines(ctx, tmpl, pw, ph);
    ctx.restore();
  }

  // Real PDF page content (not for dark paper or canvas pages)
  if (!isDark && !pi.canvas) {
    try {
      const baseSpan = (pw <= 512 && ph <= 512) ? 512 : Math.max(pw, ph);
      const px = Math.round((thumbW / pw) * baseSpan);   // backend output width = pw*px/baseSpan = thumbW
      const res = await tiles.fetchTile(idx, [0, 0, pw, ph], px);
      const isDetachedFromDom = canvas.parentElement && !canvas.isConnected;
      if (!isDetachedFromDom && res && res.data) {
        ctx.drawImage(res.data, 0, 0, thumbW, thumbH);
      }
    } catch (e) {
      console.warn('[inkwell/thumb] page render failed', idx, e);
    }
  }

  const isDetachedFromDom = canvas.parentElement && !canvas.isConnected;
  if (isDetachedFromDom) return;

  // 2. Images on this sheet (loaded elements are cached on _el / element)
  const images = (state.images || []).filter(im => im.sheet === idx && !im.deleted);
  for (const im of images) {
    const el = im._el || im.element;
    if (!el || !el.complete || !el.naturalWidth) continue;
    try {
      ctx.drawImage(el, im.x * scale, im.y * scale, (im.width || 100) * scale, (im.height || 100) * scale);
    } catch (_) {}
  }

  // 3. Vector strokes on this sheet (spatial map first, filter fallback)
  const sheetStrokes = (state._strokesBySheet && state._strokesBySheet.get && state._strokesBySheet.get(idx)) ||
    (state.strokes || []).filter(s => s.sheet === idx && !s.deleted);
  ctx.save();
  ctx.scale(scale, scale);
  for (const st of sheetStrokes) {
    if (st.deleted) continue;
    if (window.Ink && typeof window.Ink.drawStroke === 'function') {
      window.Ink.drawStroke(ctx, st, 1.0);
    } else if (st.points && st.points.length) {
      ctx.save();
      const rgb = st.rgb || [0, 0, 0];
      ctx.strokeStyle = `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`;
      ctx.lineWidth = st.base_width || 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(st.points[0].x, st.points[0].y);
      for (let i = 1; i < st.points.length; i++) {
        ctx.lineTo(st.points[i].x, st.points[i].y);
      }
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.restore();

  // 4. Text notes on this sheet (wrap multi-line notes into the thumbnail)
  const texts = (state.textObjects || []).filter(t => t.sheet === idx && !t.deleted);
  for (const t of texts) {
    const fontSize = Math.max(6, (t.fontSize || 16) * scale);
    ctx.font = `${t.bold ? '700 ' : ''}${t.italic ? 'italic ' : ''}${fontSize}px Inter, sans-serif`;
    ctx.fillStyle = t.color || '#141724';
    ctx.textBaseline = 'top';
    const maxW = Math.max(20, thumbW - (t.x || 0) * scale - 4);
    const lines = String(t.text || '').split('\n').slice(0, 5);
    let ty = (t.y || 0) * scale;
    for (const line of lines) {
      const words = line.split(/(\s+)/);
      let current = '';
      for (const word of words) {
        const next = current + word;
        if (ctx.measureText(next).width > maxW && current) {
          ctx.fillText(current, (t.x || 0) * scale, ty);
          ty += fontSize * 1.3;
          current = word.trimStart();
        } else {
          current = next;
        }
      }
      if (current) {
        ctx.fillText(current, (t.x || 0) * scale, ty);
        ty += fontSize * 1.3;
      }
      if (ty > thumbH) break;
    }
  }
}

async function paintThumbJob(job) {
  if (!job || !job.card || !job.card.isConnected) return;
  await drawThumbnailCanvas(job.canvas, job.idx, job.pi);
  if (job.card && job.card.isConnected) {
    job.card.classList.add('thumb-rendered');
  }
}

/**
 * Paint visible thumbnails in small animation-frame budgets. Large notebooks
 * with hundreds of pages no longer block the first drawer open with a long
 * synchronous canvas rasterisation loop.
 */
function scheduleThumbPaint() {
  if (_thumbFrame) return;
  _thumbFrame = requestAnimationFrame(() => {
    _thumbFrame = null;
    let budget = 2;
    for (const [key, job] of _thumbQueue) {
      _thumbQueue.delete(key);
      paintThumbJob(job);
      if (--budget <= 0) break;
    }
    if (_thumbQueue.size) scheduleThumbPaint();
  });
}

function queueThumbnail(card, canvas, idx, pi, immediate = false) {
  const job = { card, canvas, idx, pi };
  if (immediate) {
    paintThumbJob(job);
    return;
  }
  _thumbQueue.set(`${idx}:${pi && pi.width_pt}:${pi && pi.height_pt}`, job);
  scheduleThumbPaint();
}

export function refreshThumbnailBadges() {
  const grid = $('thumbnailGrid');
  if (!grid) return;
  grid.querySelectorAll('.thumb-card').forEach(card => {
    const idx = parseInt(card.getAttribute('data-page'), 10);
    if (Number.isNaN(idx)) return;
    const badge = card.querySelector('.thumb-anno-count');
    if (!badge) return;
    const n = countAnnotationsOnPage(idx);
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.classList.toggle('hidden', n === 0);
  });
  const railBadge = $('badgeThumbnails');
  if (railBadge) railBadge.textContent = String((state.pageInfos || []).length || 1);
}

export function updateThumbnailActiveCards() {
  const grid = $('thumbnailGrid');
  if (!grid) return;
  const isSplit = !!state.splitMode;
  grid.querySelectorAll('.thumb-card').forEach(card => {
    const idx = parseInt(card.getAttribute('data-page'), 10);
    const isLeft = (idx === state.leftSheet);
    const isRight = (isSplit && idx === state.rightSheet);
    card.classList.toggle('active', isLeft || isRight);
    card.classList.toggle('active-left', isLeft);
    card.classList.toggle('active-right', isRight);
  });
}

export function renderThumbnails() {
  const grid = $('thumbnailGrid');
  if (!grid || !state.pageInfos || !state.pageInfos.length) return;

  if (_thumbObserver) {
    _thumbObserver.disconnect();
    _thumbObserver = null;
  }
  _thumbQueue.clear();

  grid.innerHTML = '';
  const pageCount = state.pageInfos.length;
  const railBadge = $('badgeThumbnails');
  if (railBadge) railBadge.textContent = String(pageCount);

  const observer = (typeof IntersectionObserver === 'function')
    ? new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const card = entry.target;
          const idx = parseInt(card.getAttribute('data-page'), 10);
          const canvas = card.querySelector('canvas.thumb-canvas');
          const pi = state.pageInfos[idx];
          if (canvas && pi && !card.classList.contains('thumb-rendered')) {
            queueThumbnail(card, canvas, idx, pi, false);
          }
          observer.unobserve(card);
        }
      }, { rootMargin: '260px 0px' })
    : null;
  _thumbObserver = observer;

  state.pageInfos.forEach((pi, idx) => {
    const isLeft = (idx === state.leftSheet);
    const isRight = (state.splitMode && idx === state.rightSheet);
    let cardClasses = 'thumb-card';
    if (isLeft) cardClasses += ' active active-left';
    if (isRight) cardClasses += ' active active-right';
    const card = document.createElement('div');
    card.className = cardClasses;
    card.setAttribute('data-page', idx);
    card.setAttribute('draggable', 'true');

    // Thumbnail Action Buttons Overlay
    const actions = document.createElement('div');
    actions.className = 'thumb-card-actions';

    const btnDup = document.createElement('button');
    btnDup.className = 'btn-thumb-act btn-thumb-duplicate';
    btnDup.title = 'Duplicate Page';
    btnDup.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
    btnDup.addEventListener('click', async e => {
      e.stopPropagation();
      await handleDuplicatePage(idx);
    });

    const btnRot = document.createElement('button');
    btnRot.className = 'btn-thumb-act btn-thumb-rotate';
    btnRot.title = 'Rotate Page 90°';
    btnRot.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>';
    btnRot.addEventListener('click', async e => {
      e.stopPropagation();
      await handleRotatePage(idx, true);
    });

    const btnDel = document.createElement('button');
    btnDel.className = 'btn-thumb-act btn-thumb-del';
    btnDel.title = 'Delete Page';
    if (state.pageInfos.length <= 1) {
      btnDel.disabled = true;
      btnDel.style.opacity = '0.35';
      btnDel.style.cursor = 'not-allowed';
    }
    btnDel.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';
    btnDel.addEventListener('click', async e => {
      e.stopPropagation();
      await handleDeletePage(idx);
    });

    actions.appendChild(btnDup);
    actions.appendChild(btnRot);
    actions.appendChild(btnDel);
    card.appendChild(actions);

    // Thumbnail Canvas Preview (painted lazily when scrolled into view)
    const canvas = document.createElement('canvas');
    canvas.className = 'thumb-canvas';
    const thumbW = 240;
    const thumbH = Math.round(thumbW * ((pi.height_pt || 842) / (pi.width_pt || 595)));
    canvas.width = thumbW;
    canvas.height = thumbH;
    card.appendChild(canvas);

    // Annotation count badge
    const annoBadge = document.createElement('span');
    annoBadge.className = 'thumb-anno-count hidden';
    const annoCount = countAnnotationsOnPage(idx);
    annoBadge.textContent = annoCount > 99 ? '99+' : String(annoCount);
    annoBadge.classList.toggle('hidden', annoCount === 0);
    card.appendChild(annoBadge);

    const label = document.createElement('div');
    label.className = 'thumb-label';
    label.textContent = `Page ${idx + 1}`;
    card.appendChild(label);

    // Card click navigation
    card.addEventListener('click', e => {
      if (e.target.closest('.thumb-card-actions')) return;
      const targetPane = getTargetNavPane();
      if (typeof _goToPageCallback === 'function') {
        _goToPageCallback(idx, targetPane);
      }
      if (state.splitMode) {
        if (targetPane === 'right') {
          grid.querySelectorAll('.thumb-card.active-right').forEach(c => {
            c.classList.remove('active-right');
            if (!c.classList.contains('active-left')) c.classList.remove('active');
          });
          card.classList.add('active', 'active-right');
        } else {
          grid.querySelectorAll('.thumb-card.active-left').forEach(c => {
            c.classList.remove('active-left');
            if (!c.classList.contains('active-right')) c.classList.remove('active');
          });
          card.classList.add('active', 'active-left');
        }
      } else {
        grid.querySelectorAll('.thumb-card').forEach(c => c.classList.remove('active', 'active-left', 'active-right'));
        card.classList.add('active');
      }
    });

    // HTML5 Drag-and-Drop Reordering
    card.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', String(idx));
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      grid.querySelectorAll('.thumb-card').forEach(c => c.classList.remove('drag-over'));
    });

    card.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      card.classList.add('drag-over');
    });

    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over');
    });

    card.addEventListener('drop', async e => {
      e.preventDefault();
      card.classList.remove('drag-over');
      const fromStr = e.dataTransfer.getData('text/plain');
      const fromIdx = parseInt(fromStr, 10);
      const toIdx = idx;
      if (!isNaN(fromIdx) && fromIdx !== toIdx) {
        await handleReorderPage(fromIdx, toIdx);
      }
    });

    grid.appendChild(card);

    if (observer) observer.observe(card);
    queueThumbnail(card, canvas, idx, pi, idx < 2);
  });

  // Keep the active page visible when the drawer opens on a deep page.
  requestAnimationFrame(() => {
    const active = grid.querySelector('.thumb-card.active');
    if (active && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest' });
    }
  });
}

export function renderOutline() {
  const container = $('outlineList');
  const emptyState = $('outlineEmptyState');
  if (!container) return;

  const outline = state.outline || [];
  if (!outline.length) {
    container.innerHTML = '';
    if (emptyState) emptyState.classList.remove('hidden');
    return;
  }

  if (emptyState) emptyState.classList.add('hidden');

  function renderTree(nodes, depth = 0) {
    return nodes.map(node => {
      const hasChildren = node.children && node.children.length > 0;
      const targetPage = node.page_index != null ? node.page_index : null;
      const pageLabel = targetPage != null ? `p. ${targetPage + 1}` : '';
      const childrenHtml = hasChildren ? `<div class="outline-children">${renderTree(node.children, depth + 1)}</div>` : '';

      return `
        <div class="outline-item" data-page="${targetPage != null ? targetPage : ''}">
          <div class="outline-header" data-page="${targetPage != null ? targetPage : ''}">
            <button class="outline-toggle ${hasChildren ? '' : 'leaf'}" title="Toggle section">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>
            </button>
            <span class="outline-title" title="${escapeHtml(node.title)}">${escapeHtml(node.title)}</span>
            ${pageLabel ? `<span class="outline-page-badge">${pageLabel}</span>` : ''}
          </div>
          ${childrenHtml}
        </div>
      `;
    }).join('');
  }

  container.innerHTML = renderTree(outline);

  container.querySelectorAll('.outline-header').forEach(header => {
    header.addEventListener('click', e => {
      if (e.target.closest('.outline-toggle')) return;
      const pageStr = header.dataset.page;
      if (pageStr !== '' && typeof _goToPageCallback === 'function') {
        const pageIdx = parseInt(pageStr, 10);
        if (!isNaN(pageIdx)) {
          const targetPane = getTargetNavPane();
          _goToPageCallback(pageIdx, targetPane);
          container.querySelectorAll('.outline-item').forEach(el => el.classList.remove('active'));
          header.closest('.outline-item').classList.add('active');
        }
      }
    });
  });

  container.querySelectorAll('.outline-toggle').forEach(toggleBtn => {
    toggleBtn.addEventListener('click', e => {
      e.stopPropagation();
      toggleBtn.classList.toggle('collapsed');
      const item = toggleBtn.closest('.outline-item');
      if (item) {
        const children = item.querySelector(':scope > .outline-children');
        if (children) {
          children.classList.toggle('hidden');
        }
      }
    });
  });
}

function bindSearchEvents() {
  const input = $('drawerSearchInput');
  const go = $('btnExecuteSearch');

  if (go) {
    go.addEventListener('click', () => executeSearch());
  }
  if (input) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        executeSearch();
      }
    });
  }
}

export function openSearchWithQuery(query) {
  openDrawer('search');
  const input = $('drawerSearchInput');
  if (input) {
    input.value = query;
    executeSearch();
  }
}

export async function executeSearch() {
  const input = $('drawerSearchInput');
  const q = (input && input.value || '').trim();
  state.searchQuery = q;
  state.searchResults = [];

  if (!q) {
    renderSearchResults([]);
    compositor.redrawAll();
    return;
  }

  const results = await ipc.invokeTauri('search_pdf', { query: q }).catch(err => {
    console.warn('[inkwell/drawers] search_pdf error:', err);
    return [];
  });

  const searchRects = await buildSearchRects(q, results || []);
  state.searchResults = searchRects;
  state.activeSearchMatch = 0;
  renderSearchResults(results || []);
  compositor.redrawAll();
}

export async function buildSearchRects(q, results) {
  if (!q || !results || !results.length) return [];
  const qLower = q.toLowerCase();
  const searchRects = [];

  for (const item of results) {
    const pageIndex = item.page_index;
    const pageData = await textSelection.ensurePageTextData(pageIndex);
    if (!pageData || !pageData.chars || !pageData.chars.length) continue;

    const chars = pageData.chars;
    const fullText = chars.map(c => c.c).join('').toLowerCase();
    let pos = 0;

    while ((pos = fullText.indexOf(qLower, pos)) !== -1) {
      if (searchRects.length >= 500) break;
      const matchedChars = chars.slice(pos, pos + qLower.length);
      if (matchedChars.length > 0) {
        const lineGroups = new Map();
        for (const ch of matchedChars) {
          if (!ch.rect) continue;
          const lIdx = ch.line_index !== undefined ? ch.line_index : 0;
          if (!lineGroups.has(lIdx)) lineGroups.set(lIdx, []);
          lineGroups.get(lIdx).push(ch);
        }
        for (const [lIdx, lineChs] of lineGroups.entries()) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const ch of lineChs) {
            minX = Math.min(minX, ch.rect[0]);
            minY = Math.min(minY, ch.rect[1]);
            maxX = Math.max(maxX, ch.rect[2]);
            maxY = Math.max(maxY, ch.rect[3]);
          }
          if (minX !== Infinity) {
            searchRects.push({
              pageIndex,
              lineIndex: lIdx,
              rect: [minX, minY, maxX, maxY],
              snippet: item.snippet,
            });
          }
        }
      }
      pos += qLower.length || 1;
    }
    if (searchRects.length >= 500) break;
  }
  return searchRects;
}

export function renderSearchResults(searchItems) {
  const container = $('drawerSearchResults');
  if (!container) return;

  if (!searchItems || !searchItems.length) {
    container.innerHTML = `
      <div class="drawer-empty-state">
        <div class="empty-state-icon">🔍</div>
        <div class="empty-state-title">No Results Found</div>
        <div class="empty-state-desc">Try searching for a different term or keyword.</div>
      </div>
    `;
    return;
  }

  container.innerHTML = searchItems.map((item, idx) => {
    return `
      <div class="search-result-card" data-page="${item.page_index}" data-idx="${idx}">
        <div class="search-result-header">
          <span class="search-page-badge">Page ${item.page_index + 1}</span>
          <span class="search-match-count">${item.match_count || 1} match${(item.match_count || 1) > 1 ? 'es' : ''}</span>
        </div>
        <div class="search-snippet">${escapeHtml(item.snippet)}</div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.search-result-card').forEach(el => {
    el.addEventListener('click', () => {
      const pageStr = el.dataset.page;
      if (pageStr !== '' && typeof _goToPageCallback === 'function') {
        const pageIdx = parseInt(pageStr, 10);
        if (!isNaN(pageIdx)) {
          const targetPane = getTargetNavPane();
          _goToPageCallback(pageIdx, targetPane);
          container.querySelectorAll('.search-result-card').forEach(item => item.classList.remove('active'));
          el.classList.add('active');
        }
      }
    });
  });
}
