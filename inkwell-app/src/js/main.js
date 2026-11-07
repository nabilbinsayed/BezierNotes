/* ============================================================================
 * main.js — Main Application Bootstrap & UI Wiring for Inkwell
 * Pure lifecycle orchestrator: connects UI controls, commands, viewport & tools.
 * ========================================================================== */

import { state, $, on, emit } from './core/state.js';
import * as commandsModule from './core/commands.js';
import * as documentOps from './core/document.js';
import * as ipc from './core/ipc.js';
import * as compositor from './render/compositor.js';
import * as tiles from './render/tiles.js';
import * as overlays from './render/overlays.js';
import * as toolManager from './tools/tool-manager.js';
import * as penTool from './tools/pen.js';
import * as lassoTool from './tools/lasso.js';
import * as navigation from './workspace/navigation.js';
import * as scrollbar from './workspace/scrollbar.js';
import * as textSelection from './workspace/text-selection.js';
import * as annotations from './workspace/annotations.js';
import * as toast from './ui/toast.js';
import * as toolbar from './ui/toolbar.js';
import * as drawers from './ui/drawers.js';
import * as radialMenu from './ui/radial-menu.js';
import * as contextMenu from './ui/context-menu.js';
import * as commandPalette from './ui/command-palette.js';
import * as signature from './ui/signature.js';
import * as presentation from './ui/presentation.js';
import { preloadNoteFonts } from './core/note-font.js';
import { registerCoreCommands } from './app/commands-registry.js';
import { createNewWhiteboard, friendlyError, handlePdfLoadResult, hideOpenProgress, showOpenProgress } from './app/document-loading.js';
import { bindAllUIEvents } from './app/ui-bindings.js';
import { attachKeyboardShortcuts } from './input/keyboard.js';
import { attachPointerHandlers } from './input/pointer-router.js';
import { exportPdfWithDialog, exportWithSelectedOptions, parsePageRangeSpec } from './ui/export-modal.js';
import { checkForExternalChanges, hideExternalChangeBanner, reloadExternalPdf, showExternalChangeBanner } from './ui/external-change.js';
import { updateLassoSelectionPopover, updateTextSelectionPopover } from './ui/popovers.js';
import { cycleReadingMode, initReadingMode, setReadingMode } from './ui/reading-mode.js';
import { renderShortcutsEditor } from './ui/shortcuts-editor.js';
import { getViewport, setViewport } from './app/viewport-ref.js';

let _viewport = null;

window.addEventListener('DOMContentLoaded', async () => {
  const tilesCanvas = $('tiles');
  const dryCanvas = $('dry');
  const wetCanvas = $('wet');

  if (typeof window.ViewportManager === 'function') {
    _viewport = new window.ViewportManager(() => {
      navigation.syncActivePagesFromViewport(_viewport);
      compositor.scheduleRedrawTiles();
      compositor.scheduleRedrawAll();
      scrollbar.updateDocScrollbar(_viewport);
      updateTextSelectionPopover();
      updateLassoSelectionPopover();
    });
    setViewport(_viewport);
    _viewport.attachListeners($('stage'));
  }

  compositor.initCompositor({ tilesCanvas, dryCanvas, wetCanvas, viewport: _viewport });
  // Notes drawn before the web fonts load use a fallback face; repaint once they arrive.
  preloadNoteFonts(() => {
    compositor.invalidateDryPageCache();
    compositor.redrawAll();
  });
  compositor.resize();

  drawers.setGoToPageCallback((pageIdx, pane) => {
    if (_viewport) _viewport.updateDocumentLayout(state.pageInfos);
    navigation.goToPage(pageIdx, pane, _viewport);
  });
  drawers.initDrawers();
  annotations.initAnnotations(_viewport);
  signature.initSignatureStudio();
  presentation.initPresentation();

  registerCoreCommands();
  toolbar.initToolbar(_viewport);
  scrollbar.initDocScrollbar(_viewport);
  radialMenu.initRadialMenu();
  contextMenu.initContextMenu();
  commandPalette.initCommandPalette();

  bindAllUIEvents();
  initReadingMode();
  window.onSettingsModalOpened = () => renderShortcutsEditor();
  attachPointerHandlers(wetCanvas);
  attachKeyboardShortcuts();
  toolManager.initStylusIntegration();

  window.addEventListener('resize', () => {
    compositor.resize();
    updatePaneHighlights();
  });
  window.addEventListener('scroll', () => compositor.updateStageRect(), { passive: true });

  const stageEl = $('stage');
  if (typeof ResizeObserver !== 'undefined' && stageEl) {
    new ResizeObserver(() => {
      compositor.resize();
      updatePaneHighlights();
    }).observe(stageEl);
  }

  // Passive state listeners
  on('toast', payload => toast.showToast(payload.message, payload.type));
  on('toolChanged', payload => {
    toolbar.updateToolbarUI();
    if (payload && (payload.tool === 'textSelect' || payload.tool === 'textselect' || payload.tool === 'highlighter')) {
      textSelection.preloadNearbyPageText(state.leftSheet, _viewport);
    }
    if (payload && payload.tool !== 'lasso') {
      state.lassoPath = null;
    }
    if (payload && payload.tool !== 'textSelect' && payload.tool !== 'textselect') {
      textSelection.clearTextSelection();
      const pop = $('textSelectionPopover');
      if (pop) pop.classList.add('hidden');
    }
    updateLassoSelectionPopover();
    compositor.clearWet();
    compositor.redrawAll();
  });
  on('historyChanged', () => toolbar.updateUndoRedoUI());
  on('pageChanged', payload => {
    const pageDisplay = $('pageNumDisplay');
    if (pageDisplay) {
      pageDisplay.textContent = `${payload.pageIndex + 1}`;
    }
    const totalDisplay = $('pageTotalDisplay');
    if (totalDisplay) {
      totalDisplay.textContent = `${payload.totalPages || 1}`;
    }
    if (payload.pane === 'right') {
      const rightEl = $('rightPanePageNum');
      if (rightEl) rightEl.textContent = `${payload.pageIndex + 1}`;
    } else {
      const leftEl = $('leftPanePageNum');
      if (leftEl) leftEl.textContent = `${payload.pageIndex + 1}`;
    }
    scrollbar.updateDocScrollbar(_viewport);
  });
  on('activePagesChanged', ({ left, right }) => {
    presentation.updatePresentationHud();
    const leftEl = $('leftPanePageNum');
    if (leftEl) leftEl.textContent = `${(left !== undefined ? left : 0) + 1}`;
    const rightEl = $('rightPanePageNum');
    if (rightEl) rightEl.textContent = `${(right !== undefined ? right : 0) + 1}`;
    if (state.activeDrawer === 'thumbnails') {
      drawers.updateThumbnailActiveCards();
    }
  });
  on('activePaneChanged', () => {
    updatePaneHighlights();
    if (state.activeDrawer === 'thumbnails') {
      drawers.updateThumbnailActiveCards();
    }
  });
  on('zoomChanged', payload => {
    const el = $('zoomLevelDisplay');
    if (el && payload && typeof payload.zoom === 'number') {
      el.textContent = Math.round(payload.zoom * 100) + '%';
    }
  });
  on('selectionChanged', () => {
    updateTextSelectionPopover();
    updateLassoSelectionPopover();
  });
  on('selectionCleared', () => {
    updateTextSelectionPopover();
    updateLassoSelectionPopover();
  });
  on('documentChanged', evt => {
    toolbar.updateSaveStatusUI('dirty');
    annotations.scheduleAnnotationRefresh();
    const pagesBadge = $('badgeThumbnails');
    if (pagesBadge) pagesBadge.textContent = String((state.pageInfos || []).length || 1);
    if (state.activeDrawer === 'thumbnails' && !state._thumbBadgeTimer) {
      state._thumbBadgeTimer = setTimeout(() => {
        state._thumbBadgeTimer = null;
        drawers.refreshThumbnailBadges();
      }, 450);
    }
    if (state.autosaveDelayMs > 0 && state.currentDocPath && !state.isSaving) {
      if (state.autosaveTimer) clearTimeout(state.autosaveTimer);
      state.autosaveTimer = setTimeout(() => {
        if (state.isDirty && !state.isSaving) {
          commandsModule.commands.execute('file.save');
        }
      }, state.autosaveDelayMs);
    }

    if (!evt) return;
    const type = evt.type;
    const data = evt.payload || {};

    if (type === 'undo_add_stroke') {
      if (data.stroke && data.stroke.id) {
        ipc.deleteStroke(data.stroke.id).catch(err => {
          console.warn('[inkwell/main] undo_add_stroke deleteStroke error:', err);
        });
      }
    } else if (type === 'undo_erase_strokes') {
      if (Array.isArray(data.strokes)) {
        for (const s of data.strokes) {
          if (s) {
            ipc.commitStroke(s.sheet, s.kind || s.tool || 'pen', s.rgb, s.base_width || s.baseWidth || 1.6, s.points, s.id).catch(err => {
              console.warn('[inkwell/main] undo_erase_strokes commitStroke error:', err);
            });
          }
        }
      }
      // Fragments created by a partial erase must be withdrawn from the journal.
      for (const f of (data.addedStrokes || [])) {
        if (f && f.id) {
          ipc.deleteStroke(f.id).catch(err => {
            console.warn('[inkwell/main] undo_erase_strokes deleteStroke (fragment) error:', err);
          });
        }
      }
    } else if (type === 'redo_add_stroke') {
      if (data.stroke) {
        const s = data.stroke;
        ipc.commitStroke(s.sheet, s.kind || s.tool || 'pen', s.rgb, s.base_width || s.baseWidth || 1.6, s.points, s.id).catch(err => {
          console.warn('[inkwell/main] redo_add_stroke commitStroke error:', err);
        });
      }
    } else if (type === 'redo_erase_strokes') {
      if (Array.isArray(data.strokes)) {
        for (const s of data.strokes) {
          if (s && s.id) {
            ipc.deleteStroke(s.id).catch(err => {
              console.warn('[inkwell/main] redo_erase_strokes deleteStroke error:', err);
            });
          }
        }
      }
      // Re-apply the split fragments that the original erase produced.
      for (const f of (data.addedStrokes || [])) {
        if (f) {
          ipc.commitStroke(f.sheet ?? 0, f.kind || 'pen', f.rgb, f.base_width || f.baseWidth || 1.6, f.points, f.id).catch(err => {
            console.warn('[inkwell/main] redo_erase_strokes commitStroke (fragment) error:', err);
          });
        }
      }
    } else if (type === 'undo_add_image' || type === 'redo_delete_image') {
      if (data.image) ipc.journalImageMutation('delete', data.image);
    } else if (type === 'undo_delete_image' || type === 'redo_add_image') {
      if (data.image) ipc.journalImageMutation('upsert', data.image);
    } else if (type === 'undo_add_text_object' || type === 'redo_delete_text_object') {
      if (data.textObj) ipc.journalTextMutation('delete', data.textObj);
    } else if (type === 'undo_delete_text_object' || type === 'redo_add_text_object') {
      if (data.textObj) ipc.journalTextMutation('upsert', data.textObj);
    } else if (type === 'add_objects' || type === 'undo_delete_objects' || type === 'redo_add_objects') {
      for (const s of (data.strokes || [])) {
        if (s) ipc.commitStroke(s.sheet ?? 0, s.kind || s.tool || 'pen', s.rgb, s.base_width || s.baseWidth || 1.6, s.points, s.id);
      }
      for (const img of (data.images || [])) {
        if (img) ipc.journalImageMutation('upsert', img);
      }
      for (const t of (data.textObjects || [])) {
        if (t) ipc.journalTextMutation('upsert', t);
      }
    } else if (type === 'delete_objects' || type === 'redo_delete_objects' || type === 'undo_add_objects') {
      for (const s of (data.strokes || [])) {
        if (s && s.id) ipc.deleteStroke(s.id);
      }
      for (const img of (data.images || [])) {
        if (img) ipc.journalImageMutation('delete', img);
      }
      for (const t of (data.textObjects || [])) {
        if (t) ipc.journalTextMutation('delete', t);
      }
    } else if (type === 'transform_objects') {
      for (const s of (data.strokes || [])) {
        if (s) ipc.commitStroke(s.sheet ?? 0, s.kind || s.tool || 'pen', s.rgb, s.base_width || s.baseWidth || 1.6, s.points, s.id);
      }
      for (const img of (data.images || [])) {
        if (img) ipc.journalImageMutation('upsert', img);
      }
      for (const t of (data.textObjects || [])) {
        if (t) ipc.journalTextMutation('upsert', t);
      }
    } else if (type === 'undo_transform_objects' || type === 'redo_transform_objects') {
      const isUndo = type === 'undo_transform_objects';
      const strokeList = isUndo ? data.initialStrokes : data.finalStrokes;
      const imageList = isUndo ? data.initialImages : data.finalImages;
      const textList = isUndo ? data.initialTextObjects : data.finalTextObjects;

      for (const s of (strokeList || [])) {
        if (s) ipc.commitStroke(s.sheet ?? 0, s.kind || s.tool || 'pen', s.rgb, s.base_width || s.baseWidth || 1.6, s.points, s.id);
      }
      for (const img of (imageList || [])) {
        if (img) ipc.journalImageMutation('upsert', img);
      }
      for (const t of (textList || [])) {
        if (t) ipc.journalTextMutation('upsert', t);
      }
    } else if (type === 'undo_insert_page' || type === 'redo_delete_page') {
      const pIdx = data.pageIndex !== undefined ? data.pageIndex : data.targetIndex;
      if (pIdx !== undefined) {
        ipc.deletePage(pIdx).catch(err => console.warn('[inkwell/main] deletePage ipc error:', err));
      }
      if (_viewport) _viewport.updateDocumentLayout(state.pageInfos);
      drawers.renderThumbnails();
      compositor.redrawAll();
    } else if (type === 'undo_duplicate_page') {
      const pIdx = data.targetIndex !== undefined ? data.targetIndex : data.pageIndex;
      if (pIdx !== undefined) {
        ipc.deletePage(pIdx).catch(err => console.warn('[inkwell/main] deletePage ipc error:', err));
      }
      if (_viewport) _viewport.updateDocumentLayout(state.pageInfos);
      drawers.renderThumbnails();
      compositor.redrawAll();
    } else if (type === 'undo_delete_page' || type === 'redo_insert_page') {
      const pi = data.pageInfo || {};
      const pIdx = data.pageIndex !== undefined ? data.pageIndex : 0;
      ipc.insertBlankPage(pIdx, pi.width_pt || 595.0, pi.height_pt || 842.0).catch(err => console.warn('[inkwell/main] insertBlankPage ipc error:', err));
      if (data.strokes) {
        for (const s of data.strokes) {
          if (s) ipc.commitStroke(s.sheet ?? 0, s.kind || s.tool || 'pen', s.rgb, s.base_width || s.baseWidth || 1.6, s.points, s.id).catch(e => {});
        }
      }
      if (data.images) {
        for (const img of data.images) {
          if (img) ipc.journalImageMutation('upsert', img);
        }
      }
      if (data.textObjects) {
        for (const t of data.textObjects) {
          if (t) ipc.journalTextMutation('upsert', t);
        }
      }
      if (_viewport) _viewport.updateDocumentLayout(state.pageInfos);
      drawers.renderThumbnails();
      drawers.renderBookmarks();
      compositor.redrawAll();
    } else if (type === 'redo_duplicate_page') {
      const pi = data.pageInfo || {};
      const pIdx = data.targetIndex !== undefined ? data.targetIndex : 0;
      ipc.insertBlankPage(pIdx, pi.width_pt || 595.0, pi.height_pt || 842.0).catch(err => console.warn('[inkwell/main] redo duplicate insertBlankPage ipc error:', err));
      if (data.clonedStrokes) {
        for (const s of data.clonedStrokes) {
          if (s) ipc.commitStroke(s.sheet ?? 0, s.kind || s.tool || 'pen', s.rgb, s.base_width || s.baseWidth || 1.6, s.points, s.id).catch(e => {});
        }
      }
      if (data.clonedImages) {
        for (const img of data.clonedImages) {
          if (img) ipc.journalImageMutation('upsert', img);
        }
      }
      if (data.clonedTexts) {
        for (const t of data.clonedTexts) {
          if (t) ipc.journalTextMutation('upsert', t);
        }
      }
      if (_viewport) _viewport.updateDocumentLayout(state.pageInfos);
      drawers.renderThumbnails();
      compositor.redrawAll();
    } else if (type === 'undo_reorder_page' || type === 'redo_reorder_page') {
      ipc.reorderPages(data.fromIndex, data.toIndex).catch(err => console.warn('[inkwell/main] reorderPages ipc error:', err));
      if (_viewport) _viewport.updateDocumentLayout(state.pageInfos);
      drawers.renderThumbnails();
      compositor.redrawAll();
    } else if (type === 'rotate_page' || type === 'undo_rotate_page' || type === 'redo_rotate_page') {
      if (type !== 'rotate_page') {
        ipc.rotatePage(data.pageIndex, data.clockwise).catch(err => console.warn('[inkwell/main] rotatePage ipc error:', err));
      }
      if (_viewport) _viewport.updateDocumentLayout(state.pageInfos);
      drawers.renderThumbnails();
      compositor.scheduleRedrawTiles();
      compositor.redrawAll();
    }
  });

  // Quit with unsaved changes Tauri event listener
  if (typeof window !== 'undefined' && window.__TAURI__?.event?.listen) {
    window.__TAURI__.event.listen('app-save-and-close', async () => {
      try {
        const saved = await commandsModule.commands.execute('file.save');
        if (saved) {
          if (window.forceCloseWindow) await window.forceCloseWindow();
          else window.close();
        }
      } catch (e) {
        const msg = friendlyError(e);
        if (msg) toast.showToast('Could not save on exit: ' + msg, 'error');
      }
    });

    // A damaged PDF had to be rewritten to save into it; say where the
    // untouched original went.
    window.__TAURI__.event.listen('pdf-repaired', (event) => {
      const backup = String(event?.payload || '');
      const name = backup.split(/[\\/]/).pop() || 'a backup copy';
      toast.showToast(`This PDF was damaged and has been repaired on save. The original is kept as ${name}`, 'warning');
    });
  }

  // Global compatibility bridges
  window.state = state;
  window.commands = commandsModule.commands;
  window.toolManager = toolManager;
  window.documentOps = Object.assign({}, documentOps, {
    addTextObject: (textObj, opts) => documentOps.upsertTextObject(textObj, { recordHistory: true, isNew: true, ...opts }),
    addImage: (imageObj, opts) => documentOps.upsertImage(imageObj, { recordHistory: true, isNew: true, ...opts }),
  });
  window.compositor = compositor;
  window.overlays = overlays;
  window.lassoTool = lassoTool;
  window.penTool = penTool;
  window.toolbar = toolbar;
  window.drawers = drawers;
  window.annotationsPanel = annotations;
  window.signatureStudio = signature;
  window.presentation = presentation;
  window.navigation = navigation;
  window.emit = emit;
  window.getViewport = getViewport;
  window.undo = () => commandsModule.commands.execute('edit.undo');
  window.redo = () => commandsModule.commands.execute('edit.redo');
  window.showToast = toast.showToast;
  window.forceCloseWindow = () => ipc.invokeTauri('force_close_window');
  window.parsePageRangeSpec = parsePageRangeSpec;
  window.checkForExternalChanges = checkForExternalChanges;
  window.reloadExternalPdf = reloadExternalPdf;
  window.showExternalChangeBanner = showExternalChangeBanner;
  window.hideExternalChangeBanner = hideExternalChangeBanner;
  window.exportPdfWithDialog = exportPdfWithDialog;
  window.exportWithSelectedOptions = exportWithSelectedOptions;
  window.scheduleRedrawTiles = compositor.scheduleRedrawTiles;
  window.scheduleRedrawAll = compositor.scheduleRedrawAll;
  window.redrawAll = compositor.redrawAll;
  window.emitZoomChanged = (vp) => {
    if (!vp) return;
    const z = vp.splitMode && vp.activePane === 'right' ? vp.rightZoom : vp.zoom;
    emit('zoomChanged', { zoom: z });
  };
  window.cycleReadingMode = cycleReadingMode;
  window.setReadingMode = setReadingMode;

  window.addEventListener('pointerdown', e => {
    const ctxM = $('canvasContextMenu');
    if (ctxM && !ctxM.contains(e.target) && !ctxM.classList.contains('hidden')) {
      contextMenu.hideContextMenu();
    }
    const propPop = $('propPopover');
    const dockBtn = $('btnDockAddPreset');
    if (propPop && !propPop.classList.contains('hidden')) {
      if (!propPop.contains(e.target) && (!dockBtn || !dockBtn.contains(e.target))) {
        toolbar.hidePropPopover();
      }
    }
  }, true);

  // Check for initial file passed via CLI argument
  (async () => {
    try {
      const initFile = await ipc.invokeTauri('get_initial_file');
      if (initFile) {
        console.log('[inkwell] Opening initial file from CLI:', initFile);
        showOpenProgress('Reading document…');
        const r = await ipc.openPdf(initFile);
        const title = initFile.split('\\').pop().split('/').pop();
        showOpenProgress('Preparing page layout…');
        handlePdfLoadResult(title, initFile, r);
        hideOpenProgress();
        return;
      }
    } catch (e) {
      hideOpenProgress();
      console.warn('[inkwell] Failed to check initial file:', e);
    }
    // Auto-initialize a blank note on startup if no document is loaded
    if (!state.currentDocPath && (!state.pageInfos || state.pageInfos.length === 0)) {
      createNewWhiteboard();
    }
  })();
});
