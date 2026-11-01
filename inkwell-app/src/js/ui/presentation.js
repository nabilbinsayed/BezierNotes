/* ============================================================================
 * ui/presentation.js — Chrome-free Presentation Mode
 *
 * A study / lecture stage: hides every panel, fits the active page to the whole
 * window, keeps the laser pointer one key away, supports arrow-key paging and a
 * blank-screen cut, and restores the exact zoom/pan/tool when you exit.
 * ========================================================================== */

import { state, $ } from '../core/state.js';
import * as navigation from '../workspace/navigation.js';
import * as toolManager from '../tools/tool-manager.js';
import * as compositor from '../render/compositor.js';

let _active = false;
let _blank = false;
let _prevTool = 'pen';
let _prevZoom = { zoom: 1, panX: 0, panY: 0, splitMode: false };
let _hudTimer = null;
let _initialized = false;

export function isPresentationActive() {
  return _active;
}

function viewport() {
  return typeof window.getViewport === 'function' ? window.getViewport() : null;
}

function currentPageInfo() {
  const pi = (state.pageInfos || [])[state.leftSheet || 0] || (state.pageInfos || [])[0];
  return pi || { width_pt: 595, height_pt: 842 };
}

function fitCurrentPage() {
  const vp = viewport();
  const stage = $('stage');
  if (!vp || !stage) return;
  const pi = currentPageInfo();
  const widthPt = Math.max(1, pi.width_pt || 595);
  const heightPt = Math.max(1, pi.height_pt || 842);
  vp.updateStageRect();
  const bounds = vp.getPaneBounds('left');
  const margin = 28;
  const zoom = Math.max(0.15, Math.min(8, Math.min(
    Math.max(80, bounds.width - margin) / widthPt,
    Math.max(80, bounds.height - margin) / heightPt
  )));
  const layout = typeof vp.getPageLayout === 'function' ? vp.getPageLayout(state.leftSheet || 0) : null;
  const centerX = layout ? layout.x + widthPt / 2 : widthPt / 2;
  const centerY = layout ? layout.y + heightPt / 2 : heightPt / 2;
  vp.zoom = zoom;
  vp.panX = Math.round(bounds.width / 2 - centerX * zoom);
  vp.panY = Math.round(bounds.height / 2 - centerY * zoom);
  if (typeof vp.onChange === 'function') vp.onChange();
  if (typeof window.emitZoomChanged === 'function') window.emitZoomChanged(vp);
  compositor.scheduleRedrawTiles();
  compositor.scheduleRedrawAll();
}

export function updatePresentationHud() {
  const total = (state.pageInfos || []).length || 1;
  const page = Math.min(total, Math.max(1, (state.leftSheet || 0) + 1));
  const label = $('presentPageLabel');
  if (label) label.textContent = `${page} / ${total}`;
  const blankBtn = $('btnPresentBlank');
  if (blankBtn) {
    blankBtn.classList.toggle('active', _blank);
    blankBtn.textContent = _blank ? 'Show Page' : 'Blank';
  }
}

function showHud() {
  const hud = $('presentationHud');
  if (hud) hud.classList.remove('present-hud-dim');
  clearTimeout(_hudTimer);
  _hudTimer = setTimeout(() => {
    if (_active && hud) hud.classList.add('present-hud-dim');
  }, 2600);
}

export function presentationNext() {
  if (!_active) return;
  const vp = viewport();
  const next = Math.min((state.pageInfos || []).length - 1, (state.leftSheet || 0) + 1);
  if (next === (state.leftSheet || 0)) return;
  navigation.goToPage(next, 'left', vp);
  fitCurrentPage();
  updatePresentationHud();
  showHud();
}

export function presentationPrev() {
  if (!_active) return;
  const vp = viewport();
  const prev = Math.max(0, (state.leftSheet || 0) - 1);
  if (prev === (state.leftSheet || 0)) return;
  navigation.goToPage(prev, 'left', vp);
  fitCurrentPage();
  updatePresentationHud();
  showHud();
}

export function togglePresentationBlank() {
  if (!_active) return;
  _blank = !_blank;
  document.body.classList.toggle('presentation-blank', _blank);
  const overlay = $('presentationBlank');
  if (overlay) overlay.classList.toggle('hidden', !_blank);
  updatePresentationHud();
  showHud();
}

export function enterPresentation() {
  if (_active) return;
  const vp = viewport();
  _active = true;
  _blank = false;
  state.presentationMode = true;
  _prevTool = state.activeTool || 'pen';
  if (vp) {
    _prevZoom = {
      zoom: vp.zoom,
      panX: vp.panX,
      panY: vp.panY,
      splitMode: !!vp.splitMode,
      rightZoom: vp.rightZoom,
      rightPanX: vp.rightPanX,
      rightPanY: vp.rightPanY,
    };
  }

  if (typeof window.drawers !== 'undefined' && window.drawers.closeDrawer) {
    window.drawers.closeDrawer();
  }
  // Starting a presentation should clear transient dialogs rather than leave a
  // settings or signature window floating over the stage.
  document.querySelectorAll('.modal-overlay, .modal-backdrop').forEach(m => m.classList.add('hidden'));
  if (typeof window.toolbar !== 'undefined' && window.toolbar.hidePropPopover) {
    window.toolbar.hidePropPopover();
  }

  // Presentation is single-page by definition; leave split view temporarily.
  if (vp && vp.splitMode && typeof window.commands !== 'undefined') {
    window.commands.execute('view.toggleSplit');
  }

  document.body.classList.add('presentation-mode');
  document.body.classList.remove('presentation-blank');
  const overlay = $('presentationBlank');
  if (overlay) overlay.classList.add('hidden');
  const hud = $('presentationHud');
  if (hud) hud.classList.remove('hidden');

  try { toolManager.setTool('laser'); } catch (_) {}

  // Let the flex layout settle after the chrome disappears before measuring.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      compositor.resize();
      fitCurrentPage();
      updatePresentationHud();
      showHud();
    });
  });
}

export function exitPresentation() {
  if (!_active) return;
  _active = false;
  _blank = false;
  state.presentationMode = false;
  document.body.classList.remove('presentation-mode', 'presentation-blank');
  const overlay = $('presentationBlank');
  if (overlay) overlay.classList.add('hidden');
  const hud = $('presentationHud');
  if (hud) hud.classList.add('hidden');

  try { toolManager.setTool(_prevTool || 'pen'); } catch (_) {}

  const vp = viewport();
  requestAnimationFrame(() => {
    compositor.resize();
    if (vp) {
      vp.zoom = _prevZoom.zoom || 1;
      vp.panX = _prevZoom.panX || 0;
      vp.panY = _prevZoom.panY || 0;
      vp.rightZoom = _prevZoom.rightZoom || vp.zoom;
      vp.rightPanX = _prevZoom.rightPanX || 0;
      vp.rightPanY = _prevZoom.rightPanY || 0;
      if (typeof vp.onChange === 'function') vp.onChange();
    }
    if (_prevZoom.splitMode && vp && !vp.splitMode && typeof window.commands !== 'undefined') {
      window.commands.execute('view.toggleSplit');
    }
    compositor.scheduleRedrawTiles();
    compositor.scheduleRedrawAll();
  });
}

export function togglePresentation() {
  if (_active) exitPresentation();
  else enterPresentation();
}

function handlePresentationKey(e) {
  if (!_active) return;
  const key = e.key;

  if (key === 'Escape' || key === 'F5') {
    e.preventDefault();
    e.stopPropagation();
    exitPresentation();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (key === 'ArrowRight' || key === 'ArrowDown' || key === 'PageDown' || key === ' ' || key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    if (_blank) togglePresentationBlank();
    else presentationNext();
    return;
  }
  if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'PageUp' || key === 'Backspace') {
    e.preventDefault();
    e.stopPropagation();
    if (_blank) togglePresentationBlank();
    else presentationPrev();
    return;
  }
  if (key === 'b' || key === 'B' || key === '.') {
    e.preventDefault();
    e.stopPropagation();
    togglePresentationBlank();
    return;
  }
  if (key === 'l' || key === 'L' || key === 'k' || key === 'K') {
    e.preventDefault();
    e.stopPropagation();
    try { toolManager.setTool('laser'); } catch (_) {}
    showHud();
    return;
  }

  // Presentation is a stage: single-key tool shortcuts must not fire and
  // silently change the pen while the audience is watching.
  if (key.length === 1 || key === 'F1') {
    e.preventDefault();
    e.stopPropagation();
  }
}

export function initPresentation() {
  if (_initialized) return;
  _initialized = true;

  $('btnPresentPrev') && $('btnPresentPrev').addEventListener('click', presentationPrev);
  $('btnPresentNext') && $('btnPresentNext').addEventListener('click', presentationNext);
  $('btnPresentBlank') && $('btnPresentBlank').addEventListener('click', togglePresentationBlank);
  $('btnPresentExit') && $('btnPresentExit').addEventListener('click', exitPresentation);

  const stage = $('stage');
  if (stage) {
    stage.addEventListener('pointermove', () => { if (_active) showHud(); }, { passive: true });
  }

  window.addEventListener('keydown', handlePresentationKey, true);
  window.addEventListener('resize', () => {
    if (_active) requestAnimationFrame(() => { fitCurrentPage(); showHud(); });
  });

  // Keep the HUD page number honest while the user scrolls with a pen/touch.
  window.addEventListener('inkwell:active-page', updatePresentationHud);
}

export function presentationPageChanged() {
  if (!_active) return;
  fitCurrentPage();
  updatePresentationHud();
}
