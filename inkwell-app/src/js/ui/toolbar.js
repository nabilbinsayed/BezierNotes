/* ============================================================================
 * ui/toolbar.js — Complete Toolbar & UI Controls Binding for Inkwell
 * Binds floating dock, tool switches, color pickers, width sliders, modals & zoom.
 * ========================================================================== */

import { state, $, emit, on } from '../core/state.js';
import * as toolManager from '../tools/tool-manager.js';
import * as commandsModule from '../core/commands.js';
import * as history from '../core/history.js';

let _viewport = null;

export function setViewport(vp) {
  _viewport = vp;
}

export function initToolbar(viewport) {
  if (viewport) _viewport = viewport;
  bindDockButtons();
  bindPropertyControls();
  bindUndoRedoButtons();
  bindZoomControls();
  bindModals();
  updateToolbarUI();
  updateUndoRedoUI();
  renderCustomColorSwatches();
  on('toolPropertyChanged', () => syncColorUI());
}

export function updateToolbarUI() {
  const activeTool = state.activeTool || 'pen';

  // Update floating dock button states
  const toolButtonMap = {
    pen: $('btnDockPen'),
    highlighter: $('btnDockHighlighter'),
    eraser: $('btnDockEraser'),
    lasso: $('btnDockLasso'),
    pan: $('btnDockPan'),
    laser: $('btnDockLaser'),
    rect: $('btnDockShapes'),
    ellipse: $('btnDockShapes'),
    ruler: $('btnDockShapes'),
    line: $('btnDockShapes'),
    text: $('btnDockText'),
    textSelect: $('btnDockTextSelect'),
    textselect: $('btnDockTextSelect'),
  };

  document.querySelectorAll('.dock-btn').forEach(btn => {
    if (btn.id !== 'btnDockAddPreset' && btn.id !== 'btnDockStylusOptions') {
      btn.classList.remove('active');
    }
  });

  const activeBtn = toolButtonMap[activeTool];
  if (activeBtn) activeBtn.classList.add('active');

  const eraserBtn = $('btnDockEraser');
  if (eraserBtn) {
    const partial = state.eraserMode === 'partial';
    eraserBtn.title = partial
      ? 'Eraser — Partial split (click to switch to whole stroke)'
      : 'Eraser — Whole stroke (click to switch to partial split)';
    eraserBtn.setAttribute('aria-label', eraserBtn.title);
    eraserBtn.setAttribute('data-eraser-mode', state.eraserMode);
    eraserBtn.classList.toggle('eraser-partial', partial);
  }

  // Update legacy buttons if present
  const legacyMap = {
    pen: $('btnPen'),
    highlighter: $('btnHighlighter'),
    eraser: $('btnEraser'),
    lasso: $('btnLasso'),
    pan: $('btnPan'),
    laser: $('btnLaser'),
    rect: $('btnRect'),
    ellipse: $('btnEllipse'),
    ruler: $('btnRuler'),
    line: $('btnRuler'),
  };
  Object.entries(legacyMap).forEach(([tool, btn]) => {
    if (btn) btn.classList.toggle('active', tool === activeTool);
  });

  const shapesBtn = $('btnDockShapes');
  if (shapesBtn) {
    const iconSvg = shapesBtn.querySelector('.dock-icon');
    const shortcutSpan = shapesBtn.querySelector('.dock-shortcut');
    if (activeTool === 'ellipse' || state.shapeKind === 'ellipse') {
      if (iconSvg) iconSvg.innerHTML = '<circle cx="12" cy="12" r="8"/>';
      shapesBtn.title = 'Shape: Ellipse (O)';
      if (shortcutSpan) shortcutSpan.textContent = 'O';
    } else if (activeTool === 'line' || activeTool === 'ruler' || state.shapeKind === 'line') {
      if (iconSvg) iconSvg.innerHTML = '<line x1="4" y1="20" x2="20" y2="4"/><line x1="8" y1="14" x2="10" y2="16"/><line x1="11" y1="11" x2="13" y2="13"/><line x1="14" y1="8" x2="16" y2="10"/>';
      shapesBtn.title = 'Shape: Line (L)';
      if (shortcutSpan) shortcutSpan.textContent = 'L';
    } else if (state.shapeKind === 'arrow') {
      if (iconSvg) iconSvg.innerHTML = '<line x1="5" y1="19" x2="19" y2="5"/><polyline points="10 5 19 5 19 14"/>';
      shapesBtn.title = 'Shape: Arrow';
      if (shortcutSpan) shortcutSpan.textContent = 'A';
    } else if (state.shapeKind === 'triangle') {
      if (iconSvg) iconSvg.innerHTML = '<polygon points="12 3 22 21 2 21"/>';
      shapesBtn.title = 'Shape: Triangle';
      if (shortcutSpan) shortcutSpan.textContent = '▲';
    } else {
      if (iconSvg) iconSvg.innerHTML = '<rect x="4" y="4" width="16" height="16" rx="2"/>';
      shapesBtn.title = 'Shape: Rectangle (R)';
      if (shortcutSpan) shortcutSpan.textContent = 'R';
    }
  }

  const curShape = state.shapeKind || 'rect';
  document.querySelectorAll('.btn-shape-select').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-shape') === curShape);
  });

  syncColorUI();
  updateSaveStatusUI(state.isSaving ? 'saving' : (state.isDirty ? 'dirty' : 'saved'));
}

export function updateSaveStatusUI(status) {
  const badge = $('docStatusBadge');
  const text = $('docStatusText');
  if (!badge || !text) return;

  badge.classList.remove('dirty', 'saving');
  if (status === 'saving') {
    badge.classList.add('saving');
    text.textContent = 'Saving...';
  } else if (status === 'dirty') {
    badge.classList.add('dirty');
    text.textContent = state.autosaveDelayMs > 0 ? 'Autosaving...' : 'Unsaved';
  } else {
    text.textContent = 'Vector Ready';
  }
}

export function updateUndoRedoUI() {
  const btnUndo = $('btnUndo');
  const btnHeaderUndo = $('btnHeaderUndo');
  const btnRedo = $('btnRedo');
  const btnHeaderRedo = $('btnHeaderRedo');

  const canU = history.canUndo();
  const canR = history.canRedo();

  if (btnUndo) {
    btnUndo.disabled = !canU;
    btnUndo.classList.toggle('disabled', !canU);
  }
  if (btnHeaderUndo) {
    btnHeaderUndo.disabled = !canU;
    btnHeaderUndo.classList.toggle('disabled', !canU);
  }
  if (btnRedo) {
    btnRedo.disabled = !canR;
    btnRedo.classList.toggle('disabled', !canR);
  }
  if (btnHeaderRedo) {
    btnHeaderRedo.disabled = !canR;
    btnHeaderRedo.classList.toggle('disabled', !canR);
  }
}

/**
 * Cycle the eraser between whole-stroke and partial (segment-splitting) erase.
 * Bound to a second click on the already-active eraser button.
 */
export function toggleEraserMode() {
  state.eraserMode = state.eraserMode === 'partial' ? 'stroke' : 'partial';
  const partial = state.eraserMode === 'partial';
  const btn = $('btnDockEraser');
  if (btn) {
    btn.title = partial
      ? 'Eraser — Partial split (click to switch to whole stroke)'
      : 'Eraser — Whole stroke (click to switch to partial split)';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('data-eraser-mode', state.eraserMode);
    btn.classList.toggle('eraser-partial', partial);
  }
  const wet = typeof document !== 'undefined' ? document.getElementById('wet') : null;
  if (wet) wet.classList.toggle('eraser-partial', partial);
  emit('toast', {
    message: partial
      ? 'Eraser: Partial split — erases only where you touch'
      : 'Eraser: Whole stroke — erases the entire stroke',
    type: 'info',
  });
  emit('toolPropertyChanged', { eraserMode: state.eraserMode });
  return state.eraserMode;
}

function bindDockButtons() {
  // Dock Tool Buttons
  $('btnDockPan') && $('btnDockPan').addEventListener('click', () => {
    toolManager.setTool('pan');
    updateToolbarUI();
  });

  $('btnDockLasso') && $('btnDockLasso').addEventListener('click', () => {
    toolManager.setTool('lasso');
    updateToolbarUI();
  });

  $('btnDockPen') && $('btnDockPen').addEventListener('click', () => {
    if (state.activeTool === 'pen') {
      togglePropPopover();
    } else {
      toolManager.setTool('pen');
      updateToolbarUI();
    }
  });

  $('btnDockHighlighter') && $('btnDockHighlighter').addEventListener('click', () => {
    if (state.activeTool === 'highlighter') {
      togglePropPopover();
    } else {
      toolManager.setTool('highlighter');
      updateToolbarUI();
    }
  });

  $('btnDockEraser') && $('btnDockEraser').addEventListener('click', () => {
    if (state.activeTool === 'eraser') {
      toggleEraserMode();
    } else {
      toolManager.setTool('eraser');
      updateToolbarUI();
    }
  });

  $('btnDockLaser') && $('btnDockLaser').addEventListener('click', () => {
    toolManager.setTool('laser');
    updateToolbarUI();
  });

  $('btnDockShapes') && $('btnDockShapes').addEventListener('click', () => {
    if (state.activeTool === 'rect') {
      toolManager.setTool('ellipse');
      emit('toast', { message: 'Shape: Ellipse (O)', type: 'info' });
    } else if (state.activeTool === 'ellipse') {
      toolManager.setTool('line');
      emit('toast', { message: 'Shape: Line (L)', type: 'info' });
    } else {
      toolManager.setTool('rect');
      emit('toast', { message: 'Shape: Rectangle (R)', type: 'info' });
    }
    updateToolbarUI();
  });

  $('btnDockText') && $('btnDockText').addEventListener('click', () => {
    toolManager.setTool('text');
    emit('toast', { message: 'Sticky Note: Click canvas to annotate', type: 'info' });
    updateToolbarUI();
  });

  $('btnDockTextSelect') && $('btnDockTextSelect').addEventListener('click', () => {
    toolManager.setTool('textSelect');
    updateToolbarUI();
  });

  $('btnDockAddPreset') && $('btnDockAddPreset').addEventListener('click', () => togglePropPopover());
  $('btnDockStylusOptions') && $('btnDockStylusOptions').addEventListener('click', () => openSettingsModal());

  // Legacy buttons if present
  $('btnPen') && $('btnPen').addEventListener('click', () => { toolManager.setTool('pen'); updateToolbarUI(); });
  $('btnHighlighter') && $('btnHighlighter').addEventListener('click', () => { toolManager.setTool('highlighter'); updateToolbarUI(); });
  $('btnEraser') && $('btnEraser').addEventListener('click', () => { toolManager.setTool('eraser'); updateToolbarUI(); });
  $('btnPan') && $('btnPan').addEventListener('click', () => { toolManager.setTool('pan'); updateToolbarUI(); });
  $('btnLasso') && $('btnLasso').addEventListener('click', () => { toolManager.setTool('lasso'); updateToolbarUI(); });
  $('btnLaser') && $('btnLaser').addEventListener('click', () => { toolManager.setTool('laser'); updateToolbarUI(); });
  $('btnRect') && $('btnRect').addEventListener('click', () => { toolManager.setTool('rect'); updateToolbarUI(); });
  $('btnEllipse') && $('btnEllipse').addEventListener('click', () => { toolManager.setTool('ellipse'); updateToolbarUI(); });
  $('btnRuler') && $('btnRuler').addEventListener('click', () => { toolManager.setTool('ruler'); updateToolbarUI(); });
}

export function togglePropPopover() {
  const pop = $('propPopover');
  if (pop) {
    pop.classList.toggle('hidden');
    if (!pop.classList.contains('hidden')) {
      syncColorUI();
    }
  }
}

export function hidePropPopover() {
  const pop = $('propPopover');
  if (pop && !pop.classList.contains('hidden')) {
    pop.classList.add('hidden');
  }
}

function bindPropertyControls() {
  // Preset color swatches
  document.querySelectorAll('.dock-preset-chip, .swatch, .settings-color-swatch').forEach(chip => {
    chip.addEventListener('click', () => {
      const colorStr = chip.getAttribute('data-color');
      if (colorStr) {
        const rgb = hexToRgb(colorStr);
        if (rgb) toolManager.setColor(rgb);
        document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
        chip.classList.add('active');
      }
    });
  });

  // Color inputs
  $('colorPicker') && $('colorPicker').addEventListener('input', e => {
    const rgb = hexToRgb(e.target.value);
    if (rgb) toolManager.setColor(rgb);
  });

  $('popoverCustomColorPicker') && $('popoverCustomColorPicker').addEventListener('input', e => {
    const rgb = hexToRgb(e.target.value);
    if (rgb) toolManager.setColor(rgb);
  });

  // Persist a hand-picked colour into the first free custom slot once the user
  // settles on a value (change fires on picker close, not on every drag frame).
  $('popoverCustomColorPicker') && $('popoverCustomColorPicker').addEventListener('change', e => {
    const hex = String(e.target.value || '').toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(hex)) return;
    const slots = loadCustomColors();
    if (slots.includes(hex)) return;
    const free = slots.indexOf(null);
    if (free >= 0) {
      slots[free] = hex;
      persistCustomColors(slots);
      renderCustomColorSwatches();
    }
  });

  // Stroke width sliders
  const sliders = [$('propWidthSlider'), $('widthSlider'), $('popoverWidthSlider')];
  sliders.forEach(slider => {
    if (slider) {
      slider.addEventListener('input', e => {
        const w = parseFloat(e.target.value);
        if (!isNaN(w)) {
          toolManager.setWidth(w);
          if ($('widthVal')) $('widthVal').textContent = w + ' pt';
          if ($('popoverWidthVal')) $('popoverWidthVal').textContent = w + ' pt';
        }
      });
    }
  });

  // Width presets
  document.querySelectorAll('.btn-width-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const w = parseFloat(btn.getAttribute('data-width'));
      if (!isNaN(w)) {
        toolManager.setWidth(w);
        if ($('popoverWidthSlider')) $('popoverWidthSlider').value = String(w);
        if ($('popoverWidthVal')) $('popoverWidthVal').textContent = w + ' pt';
        document.querySelectorAll('.btn-width-preset').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      }
    });
  });

  // Custom colour slots: empty = save current colour, filled = apply,
  // right-click / Shift-click = free the slot.
  document.querySelectorAll('.swatch-custom').forEach(btn => {
    btn.addEventListener('click', e => {
      const slot = Number(btn.getAttribute('data-slot'));
      if (Number.isNaN(slot)) return;
      const slots = loadCustomColors();
      if (btn.classList.contains('empty')) {
        e.stopPropagation();
        slots[slot] = rgbToHex(state.color || [0.08, 0.09, 0.14]);
        persistCustomColors(slots);
        renderCustomColorSwatches();
        emit('toast', { message: 'Colour saved to custom slot', type: 'success' });
      }
    });
    btn.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      const slot = Number(btn.getAttribute('data-slot'));
      if (Number.isNaN(slot)) return;
      const slots = loadCustomColors();
      if (slots[slot]) {
        slots[slot] = null;
        persistCustomColors(slots);
        renderCustomColorSwatches();
        emit('toast', { message: 'Custom colour slot cleared', type: 'info' });
      }
    });
  });

  // Shape kind selector
  document.querySelectorAll('.btn-shape-select').forEach(btn => {
    btn.addEventListener('click', () => {
      const shape = btn.getAttribute('data-shape');
      if (!shape) return;
      // Route every shape kind through a canvas tool that the pointer pipeline
      // understands, then set the exact geometry (setTool resets shapeKind for
      // rect/ellipse, so the order here is deliberate).
      const routedTool = shape === 'ellipse' ? 'ellipse'
        : (shape === 'line' || shape === 'ruler') ? 'line'
          : 'rect';
      toolManager.setTool(routedTool);
      toolManager.setShapeKind(shape);
      updateToolbarUI();
    });
  });

  $('btnClosePropPopover') && $('btnClosePropPopover').addEventListener('click', () => {
    hidePropPopover();
  });
}

function bindUndoRedoButtons() {
  $('btnUndo') && $('btnUndo').addEventListener('click', () => commandsModule.commands.execute('edit.undo'));
  $('btnHeaderUndo') && $('btnHeaderUndo').addEventListener('click', () => commandsModule.commands.execute('edit.undo'));
  $('btnRedo') && $('btnRedo').addEventListener('click', () => commandsModule.commands.execute('edit.redo'));
  $('btnHeaderRedo') && $('btnHeaderRedo').addEventListener('click', () => commandsModule.commands.execute('edit.redo'));

  history.setUndoRedoUiCallback(() => updateUndoRedoUI());
}

function bindZoomControls() {
  $('btnZoomIn') && $('btnZoomIn').addEventListener('click', () => {
    if (_viewport) {
      const pane = (_viewport.splitMode && (state.drawingPane || _viewport.activePane)) ? (state.drawingPane || _viewport.activePane) : 'left';
      const bounds = _viewport.getPaneBounds ? _viewport.getPaneBounds(pane) : { x: 0, y: 0, width: _viewport.stageW, height: _viewport.stageH };
      _viewport.zoomIn([bounds.x + bounds.width / 2, bounds.y + bounds.height / 2], pane);
      emit('zoomChanged', { zoom: (pane === 'right' && _viewport.splitMode) ? _viewport.rightZoom : _viewport.zoom, pane });
    }
  });

  $('btnZoomOut') && $('btnZoomOut').addEventListener('click', () => {
    if (_viewport) {
      const pane = (_viewport.splitMode && (state.drawingPane || _viewport.activePane)) ? (state.drawingPane || _viewport.activePane) : 'left';
      const bounds = _viewport.getPaneBounds ? _viewport.getPaneBounds(pane) : { x: 0, y: 0, width: _viewport.stageW, height: _viewport.stageH };
      _viewport.zoomOut([bounds.x + bounds.width / 2, bounds.y + bounds.height / 2], pane);
      emit('zoomChanged', { zoom: (pane === 'right' && _viewport.splitMode) ? _viewport.rightZoom : _viewport.zoom, pane });
    }
  });

  $('btnZoomFit') && $('btnZoomFit').addEventListener('click', () => {
    if (_viewport && state.pageInfos && state.pageInfos.length) {
      const pane = (_viewport.splitMode && (state.drawingPane || _viewport.activePane)) ? (state.drawingPane || _viewport.activePane) : 'left';
      const curSheet = (pane === 'right' && _viewport.splitMode) ? (state.rightSheet || 0) : (state.leftSheet || 0);
      const pi = state.pageInfos[curSheet] || state.pageInfos[0];
      const r = _viewport.stageRect || { width: 800, height: 600 };
      const bounds = _viewport.getPaneBounds ? _viewport.getPaneBounds(pane) : { width: r.width, height: r.height };
      const availW = Math.max(100, bounds.width - 48);
      const availH = Math.max(100, bounds.height - 48);
      const pageW = pi.width_pt || 595.0;
      const pageH = pi.height_pt || 842.0;
      const pageZoom = Math.min(availW / pageW, availH / pageH);
      const widthZoom = availW / pageW;

      const currentZoom = (pane === 'right' && _viewport.splitMode) ? _viewport.rightZoom : _viewport.zoom;
      // Toggle to fitWidth if already in fitPage, allowing widescreen displays to fill the page
      if (Math.abs(currentZoom - pageZoom) < 0.05 && widthZoom > pageZoom * 1.1) {
        _viewport.fitWidth(pageW, pane);
      } else {
        _viewport.fitPage(pageW, pageH, pane);
      }
      emit('zoomChanged', { zoom: (pane === 'right' && _viewport.splitMode) ? _viewport.rightZoom : _viewport.zoom, pane });
    }
  });

  $('btnFullscreen') && $('btnFullscreen').addEventListener('click', () => toggleFullscreen());

  $('btnZoomMenu') && $('btnZoomMenu').addEventListener('click', (e) => {
    e.stopPropagation();
    const pop = $('zoomMenuPopover');
    if (pop) pop.classList.toggle('hidden');
  });

  document.querySelectorAll('.zoom-menu-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const zoomVal = btn.getAttribute('data-zoom');
      if (zoomVal === 'fit-page') {
        if (_viewport && state.pageInfos && state.pageInfos[0]) {
          _viewport.fitPage(state.pageInfos[0].width_pt, state.pageInfos[0].height_pt, 'left');
        }
      } else if (zoomVal === 'fit-width') {
        if (_viewport && state.pageInfos && state.pageInfos[0]) {
          _viewport.fitWidth(state.pageInfos[0].width_pt, 'left');
        }
      } else {
        const factor = parseFloat(zoomVal);
        if (!isNaN(factor) && _viewport) {
          _viewport.setZoom(factor, [_viewport.stageW / 2, _viewport.stageH / 2], 'left');
        }
      }
      closeZoomMenu();
    });
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#zoomMenuPopover') && !e.target.closest('#btnZoomMenu')) {
      closeZoomMenu();
    }
  });
}

export function closeZoomMenu() {
  const el = $('zoomMenuPopover');
  if (el) el.classList.add('hidden');
}

export function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

function bindModals() {
  // Settings modal
  $('btnHeaderSettings') && $('btnHeaderSettings').addEventListener('click', openSettingsModal);
  $('btnCloseSettingsModal') && $('btnCloseSettingsModal').addEventListener('click', closeSettingsModal);
  $('settingsModal') && $('settingsModal').addEventListener('click', e => {
    if (e.target === $('settingsModal')) closeSettingsModal();
  });

  document.querySelectorAll('.settings-nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      if (tab) switchSettingsTab(tab);
    });
  });

  // Go to Page modal
  $('btnPageDropdown') && $('btnPageDropdown').addEventListener('click', () => openGoToPageModal());
  $('btnCloseGoToPageModal') && $('btnCloseGoToPageModal').addEventListener('click', () => closeGoToPageModal());
  $('btnCancelGoToPage') && $('btnCancelGoToPage').addEventListener('click', () => closeGoToPageModal());

  // Shortcuts modal
  $('btnCloseShortcutsModal') && $('btnCloseShortcutsModal').addEventListener('click', () => {
    $('shortcutsModal') && $('shortcutsModal').classList.add('hidden');
  });

  // Export modal
  $('btnHeaderExport') && $('btnHeaderExport').addEventListener('click', () => {
    $('exportModal') && $('exportModal').classList.remove('hidden');
  });
  $('btnCloseExportModal') && $('btnCloseExportModal').addEventListener('click', () => {
    $('exportModal') && $('exportModal').classList.add('hidden');
  });

  const btnSave = $('btnExportIncremental');
  if (btnSave) {
    const triggerSave = () => {
      $('exportModal')?.classList.add('hidden');
      commandsModule.commands.execute('file.save');
    };
    btnSave.addEventListener('click', triggerSave);
    btnSave.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        triggerSave();
      }
    });
  }

  const btnExportNew = $('btnExportFlattened');
  if (btnExportNew) {
    const triggerExport = () => {
      $('exportModal')?.classList.add('hidden');
      // Honour the range/flatten controls above the option cards.
      if (typeof window.exportWithSelectedOptions === 'function') {
        window.exportWithSelectedOptions();
        return;
      }
      commandsModule.commands.execute('file.exportPdf');
    };
    btnExportNew.addEventListener('click', triggerExport);
    btnExportNew.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        triggerExport();
      }
    });
  }
}

export function openSettingsModal() {
  $('settingsModal') && $('settingsModal').classList.remove('hidden');
  if (typeof window.onSettingsModalOpened === 'function') {
    window.onSettingsModalOpened();
  }
}

export function closeSettingsModal() {
  $('settingsModal') && $('settingsModal').classList.add('hidden');
}

export function switchSettingsTab(tabName) {
  document.querySelectorAll('.settings-nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName);
  });
  document.querySelectorAll('.settings-tab-panel').forEach(panel => {
    const isMatch = panel.id === tabName || panel.getAttribute('data-panel') === tabName;
    panel.classList.toggle('active', isMatch);
    panel.classList.toggle('hidden', !isMatch);
  });
  if (tabName === 'tabShortcuts' && typeof window.onSettingsModalOpened === 'function') {
    window.onSettingsModalOpened();
  }
}

export function openGoToPageModal() {
  $('goToPageModal') && $('goToPageModal').classList.remove('hidden');
  const input = $('goToPageInput');
  const total = (state.pageInfos && state.pageInfos.length) ? state.pageInfos.length : 1;
  const totalEl = $('goToPageTotalDisplay');
  if (totalEl) totalEl.textContent = String(total);
  if (input) {
    input.max = String(total);
    input.value = String((state.leftSheet || 0) + 1);
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }
}

export function closeGoToPageModal() {
  $('goToPageModal') && $('goToPageModal').classList.add('hidden');
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? [
    parseInt(result[1], 16) / 255,
    parseInt(result[2], 16) / 255,
    parseInt(result[3], 16) / 255
  ] : null;
}

export function rgbToHex(rgb) {
  if (!rgb || !Array.isArray(rgb) || rgb.length < 3) return '#141724';
  return '#' + rgb.map(v => Math.round(Math.max(0, Math.min(255, v * 255))).toString(16).padStart(2, '0')).join('');
}

export function drawStrokePreview() {
  const canvas = $('strokePreviewCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const w = canvas.width;
  const h = canvas.height;
  const midY = h / 2;
  const isHighlighter = state.activeTool === 'highlighter';
  const baseW = state.baseWidth || (isHighlighter ? 16.0 : 1.6);
  const rgb = state.color || [0.08, 0.09, 0.14];
  const colorStr = `rgb(${rgb.map(v => Math.round(v * 255)).join(',')})`;

  // Paper-coloured strip keeps black ink visible on the dark inspector.
  ctx.fillStyle = '#f8fafc';
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(6, 3, w - 12, h - 6, 7);
  else ctx.rect(6, 3, w - 12, h - 6);
  ctx.fill();

  ctx.save();
  if (isHighlighter) {
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = colorStr;
    ctx.lineWidth = Math.min(h - 6, baseW);
    ctx.lineCap = 'square';
  } else {
    ctx.strokeStyle = colorStr;
    ctx.lineWidth = Math.min(h - 4, baseW);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  ctx.beginPath();
  ctx.moveTo(20, midY);
  ctx.bezierCurveTo(w * 0.35, midY - 7, w * 0.65, midY + 7, w - 20, midY);
  ctx.stroke();
  ctx.restore();
}

const CUSTOM_COLORS_KEY = 'inkwell.customColors.v1';

export function loadCustomColors() {
  const fallback = [null, null, null, null];
  try {
    const raw = localStorage.getItem(CUSTOM_COLORS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    for (let i = 0; i < 4; i++) {
      fallback[i] = (typeof parsed[i] === 'string' && /^#[0-9a-fA-F]{6}$/.test(parsed[i])) ? parsed[i].toLowerCase() : null;
    }
    return fallback;
  } catch (e) {
    console.warn('[inkwell/toolbar] Could not load custom colours:', e);
    return fallback;
  }
}

export function persistCustomColors(slots) {
  try {
    localStorage.setItem(CUSTOM_COLORS_KEY, JSON.stringify(slots));
  } catch (e) {
    console.warn('[inkwell/toolbar] Could not save custom colours:', e);
  }
}

export function renderCustomColorSwatches() {
  const slots = loadCustomColors();
  document.querySelectorAll('.swatch-custom').forEach(btn => {
    const slot = Number(btn.getAttribute('data-slot'));
    const color = slots[slot];
    btn.classList.toggle('empty', !color);
    btn.classList.toggle('filled', !!color);
    if (color) {
      btn.style.background = color;
      btn.setAttribute('data-color', color);
      btn.classList.toggle('active', color === rgbToHex(state.color || [0.08, 0.09, 0.14]));
      btn.title = `Custom colour ${slot + 1} — right-click to remove`;
      btn.innerHTML = '<span class="custom-slot-fill"></span>';
    } else {
      btn.style.background = '';
      btn.removeAttribute('data-color');
      btn.title = `Empty custom slot ${slot + 1} — click to save the current colour`;
      btn.innerHTML = '<span class="custom-plus">+</span>';
    }
  });
  // Re-apply the generic swatch click binding to freshly rendered contents by
  // delegating from the grid instead of binding per element.
  const grid = $('customSwatchesGrid');
  if (grid && !grid._inkwellDelegated) {
    grid._inkwellDelegated = true;
    grid.addEventListener('click', e => {
      const chip = e.target.closest('.swatch-custom.filled');
      if (!chip) return;
      const colorStr = chip.getAttribute('data-color');
      if (!colorStr) return;
      const rgb = hexToRgb(colorStr);
      if (rgb) {
        toolManager.setColor(rgb);
        document.querySelectorAll('.swatch').forEach(s => s.classList.toggle('active', s === chip));
      }
    });
  }
}

export function syncColorUI(rgb) {
  const color = rgb || state.color || [0.08, 0.09, 0.14];
  const hex = rgbToHex(color);

  // 1. Sync custom color picker inputs
  const customPicker = $('popoverCustomColorPicker');
  if (customPicker && customPicker.value.toLowerCase() !== hex.toLowerCase()) {
    customPicker.value = hex;
  }
  const colorPicker = $('colorPicker');
  if (colorPicker && colorPicker.value.toLowerCase() !== hex.toLowerCase()) {
    colorPicker.value = hex;
  }

  // 2. Sync curated and custom color swatches
  document.querySelectorAll('.color-swatches-grid .swatch, .swatch-custom[data-color], .dock-preset-chip, .settings-color-swatch').forEach(s => {
    const sColor = s.getAttribute('data-color');
    const isMatch = sColor && sColor.toLowerCase() === hex.toLowerCase();
    s.classList.toggle('active', !!isMatch);
  });

  // 3. Sync width sliders & labels
  const activeWidth = state.baseWidth || 1.6;
  const popSlider = $('popoverWidthSlider');
  if (popSlider) popSlider.value = String(activeWidth);
  const propSlider = $('propWidthSlider');
  if (propSlider) propSlider.value = String(activeWidth);
  const mainSlider = $('widthSlider');
  if (mainSlider) mainSlider.value = String(activeWidth);

  const popWidthVal = $('popoverWidthVal');
  if (popWidthVal) popWidthVal.textContent = activeWidth + ' pt';
  const widthVal = $('widthVal');
  if (widthVal) widthVal.textContent = activeWidth + ' pt';

  document.querySelectorAll('.btn-width-preset').forEach(b => {
    const pw = parseFloat(b.getAttribute('data-width'));
    b.classList.toggle('active', Math.abs(pw - activeWidth) < 0.1);
  });

  // 4. Update popover title according to active tool
  const isShapeTool = ['rect', 'ellipse', 'line', 'ruler', 'shapes'].includes(state.activeTool);
  const toolTitle = $('popoverToolTitle');
  if (toolTitle) {
    const toolTitles = {
      pen: 'Pen Properties',
      highlighter: 'Highlighter Properties',
      rect: 'Rectangle Properties',
      ellipse: 'Ellipse Properties',
      ruler: 'Line Properties',
      line: 'Line Properties',
      text: 'Text Note Properties',
      laser: 'Laser Properties',
      eraser: 'Eraser Properties',
      lasso: 'Lasso Properties',
    };
    if (isShapeTool && state.shapeKind) {
      const shapeNames = { rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', ruler: 'Ruler', triangle: 'Triangle', arrow: 'Arrow' };
      toolTitle.textContent = `${shapeNames[state.shapeKind] || 'Shape'} Properties`;
    } else {
      toolTitle.textContent = toolTitles[state.activeTool] || 'Tool Properties';
    }
  }

  // 5. Show the shape-kind selector only for geometry tools.
  const shapeSection = $('popoverShapeSection');
  if (shapeSection) shapeSection.style.display = isShapeTool ? '' : 'none';

  // 6. Draw live stroke preview on a paper-white strip so dark inks stay visible.
  drawStrokePreview();
}

