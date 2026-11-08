/**
 * Wiring of chrome, panels, modals and buttons to their handlers.
 * (Split out of main.js by Plan 093; behaviour unchanged.)
 */

import { state, $, on, emit } from '../core/state.js';
import * as commandsModule from '../core/commands.js';
import * as documentOps from '../core/document.js';
import * as clipboard from '../core/clipboard.js';
import * as ipc from '../core/ipc.js';
import * as compositor from '../render/compositor.js';
import * as textTool from '../tools/text.js';
import * as navigation from '../workspace/navigation.js';
import * as textSelection from '../workspace/text-selection.js';
import * as toast from '../ui/toast.js';
import * as toolbar from '../ui/toolbar.js';
import * as drawers from '../ui/drawers.js';
import * as commandPalette from '../ui/command-palette.js';
import * as presentation from '../ui/presentation.js';
import { createNewWhiteboard, friendlyError, handlePdfLoadResult, hideOpenProgress, openFileTrigger, showOpenProgress } from '../app/document-loading.js';
import { getViewport } from '../app/viewport-ref.js';
import { exportWithSelectedOptions, refreshExportModal, syncExportCustomInputVisibility } from '../ui/export-modal.js';
import { checkForExternalChanges, keepMineExternal, reloadExternalPdf, saveCopyExternal } from '../ui/external-change.js';
import { initModalFocusTrap } from '../ui/focus-trap.js';
import { closeInsertPageModal, openInsertPageModal } from '../ui/insert-page-modal.js';
import { initLassoSelectionPopover } from '../ui/popovers.js';
import { cycleReadingMode, setReadingMode } from '../ui/reading-mode.js';
import { renderShortcutsEditor } from '../ui/shortcuts-editor.js';
import { setAutosaveEnabled } from './autosave.js';

export function bindAllUIEvents() {
  // Reading mode triggers
  $('btnMorePresentation') && $('btnMorePresentation').addEventListener('click', () => {
    const menu = $('moreOptionsMenu');
    if (menu) menu.classList.add('hidden');
    presentation.enterPresentation();
  });
  $('btnMoreReadingMode') && $('btnMoreReadingMode').addEventListener('click', () => {
    $('moreOptionsMenu') && $('moreOptionsMenu').classList.add('hidden');
    cycleReadingMode();
  });
  $('selectReadingMode') && $('selectReadingMode').addEventListener('change', e => {
    setReadingMode(e.target.value);
  });
  $('btnResetShortcuts') && $('btnResetShortcuts').addEventListener('click', () => {
    commandsModule.commands.resetKeybindings();
    renderShortcutsEditor();
    toast.showToast('Shortcuts reset to defaults', 'info');
  });

  // File Open triggers
  $('btnHeaderOpen') && $('btnHeaderOpen').addEventListener('click', openFileTrigger);
  $('btnWelcomeOpen') && $('btnWelcomeOpen').addEventListener('click', openFileTrigger);
  $('btnOpen') && $('btnOpen').addEventListener('click', openFileTrigger);

  // File New triggers
  $('btnHeaderNewNote') && $('btnHeaderNewNote').addEventListener('click', createNewWhiteboard);
  $('btnWelcomeNewNote') && $('btnWelcomeNewNote').addEventListener('click', createNewWhiteboard);
  $('btnMoreNewNote') && $('btnMoreNewNote').addEventListener('click', () => {
    $('moreOptionsMenu') && $('moreOptionsMenu').classList.add('hidden');
    createNewWhiteboard();
  });
  $('btnMoreInsertImage') && $('btnMoreInsertImage').addEventListener('click', () => {
    $('moreOptionsMenu') && $('moreOptionsMenu').classList.add('hidden');
    const input = $('imageFileInput');
    if (input) {
      input.value = '';
      input.click();
    }
  });

  const imageFileInput = $('imageFileInput');
  if (imageFileInput) {
    imageFileInput.addEventListener('change', async e => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const activeSheet = getViewport() ? getViewport().getActivePageInView(state.drawingPane || 'left') : 0;
        let targetPagePt = null;
        if (getViewport()) {
          const pl = getViewport().getPageLayout(activeSheet);
          if (pl) {
            const pw = pl.width || pl.w || 595.0;
            const ph = pl.height || pl.h || 842.0;
            targetPagePt = { px: Math.max(0, pw / 2 - 100), py: Math.max(0, ph / 2 - 100) };
          }
        }
        const dataUrl = await clipboard.blobToDataUrl(file);
        if (dataUrl) {
          const pastedImg = await clipboard.pasteImageDataUrl(dataUrl, activeSheet, targetPagePt);
          if (pastedImg) {
            compositor.redrawAll();
            toast.showToast('Inserted image', 'info');
          }
        }
      } catch (err) {
        console.warn('[inkwell/main] Failed to insert image:', err);
        toast.showToast('Failed to insert image', 'error');
      }
    });
  }

  // Save triggers
  $('btnHeaderSave') && $('btnHeaderSave').addEventListener('click', () => commandsModule.commands.execute('file.save'));
  $('btnExportShare') && $('btnExportShare').addEventListener('click', () => commandsModule.commands.execute('file.save'));

  // Window Controls (minimize, maximize, close)
  $('btnWinMin') && $('btnWinMin').addEventListener('click', () => ipc.minimizeWindow().catch(() => {}));
  $('btnWinMax') && $('btnWinMax').addEventListener('click', () => ipc.toggleMaximizeWindow().catch(() => {}));
  $('btnWinClose') && $('btnWinClose').addEventListener('click', () => ipc.closeWindow().catch(() => {}));

  // File Input handler
  const fileInput = $('pdfFileInput');
  if (fileInput) {
    fileInput.addEventListener('change', async e => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const filePath = file.path || file.webkitRelativePath;
        if (filePath) {
          showOpenProgress('Reading document…');
          const r = await ipc.openPdf(filePath);
          showOpenProgress('Preparing page layout…');
          handlePdfLoadResult(file.name, filePath, r);
          return;
        }
        const buf = await file.arrayBuffer();
        const bytes = Array.from(new Uint8Array(buf));
        showOpenProgress('Reading document…');
        const r2 = await ipc.openPdfBytes(file.name, bytes);
        showOpenProgress('Preparing page layout…');
        handlePdfLoadResult(file.name, null, r2);
      } catch (err) {
        hideOpenProgress();
        const msg = friendlyError(err);
        if (msg) toast.showToast('Failed to open PDF: ' + msg, 'error');
      }
    });
  }

  // Split View triggers
  const onSplitToggle = () => commandsModule.commands.execute('view.toggleSplit');
  $('btnRailSplit') && $('btnRailSplit').addEventListener('click', onSplitToggle);
  $('btnSplit') && $('btnSplit').addEventListener('click', onSplitToggle);
  $('btnZoomSplit') && $('btnZoomSplit').addEventListener('click', onSplitToggle);

  function updatePaneHighlights() {
    const hlLeft = $('paneHighlightLeft');
    const hlRight = $('paneHighlightRight');
    if (!hlLeft || !hlRight) return;
    if (!getViewport() || !getViewport().splitMode) {
      hlLeft.classList.add('hidden');
      hlRight.classList.add('hidden');
      hlLeft.classList.remove('pane-active');
      hlRight.classList.remove('pane-active');
      return;
    }
    hlLeft.classList.remove('hidden');
    hlRight.classList.remove('hidden');
    const ratio = getViewport().splitRatio || 0.5;
    hlLeft.style.left = '0%';
    hlLeft.style.width = `${(ratio * 100).toFixed(2)}%`;
    hlRight.style.left = `${(ratio * 100).toFixed(2)}%`;
    hlRight.style.width = `${((1 - ratio) * 100).toFixed(2)}%`;

    const active = state.drawingPane || 'left';
    hlLeft.classList.toggle('pane-active', active === 'left');
    hlRight.classList.toggle('pane-active', active === 'right');

    const cluster = $('splitPageNavCluster');
    if (cluster) {
      const subclusters = cluster.querySelectorAll('.pane-nav-subcluster');
      if (subclusters.length >= 2) {
        subclusters[0].classList.toggle('active', active === 'left');
        subclusters[1].classList.toggle('active', active === 'right');
      }
    }
  }
  window.updatePaneHighlights = updatePaneHighlights;

  // Split Divider Dragging and Double-Click Reset
  const splitDivider = $('splitDivider');
  if (splitDivider) {
    let isDraggingDivider = false;
    splitDivider.addEventListener('pointerdown', e => {
      e.preventDefault();
      isDraggingDivider = true;
      try { splitDivider.setPointerCapture(e.pointerId); } catch (_) {}
    });
    splitDivider.addEventListener('pointermove', e => {
      if (!isDraggingDivider || !getViewport()) return;
      const stageRect = compositor.getStageRect() || { left: 0, width: window.innerWidth };
      const relX = e.clientX - stageRect.left;
      const totalW = stageRect.width || 800;
      const ratio = Math.max(0.2, Math.min(0.8, relX / totalW));
      getViewport().splitRatio = ratio;
      splitDivider.style.left = `${(ratio * 100).toFixed(2)}%`;
      updatePaneHighlights();
      compositor.scheduleRedrawTiles();
      compositor.redrawAll();
    });
    const stopDividerDrag = e => {
      if (isDraggingDivider) {
        isDraggingDivider = false;
        try { splitDivider.releasePointerCapture(e.pointerId); } catch (_) {}
      }
    };
    splitDivider.addEventListener('pointerup', stopDividerDrag);
    splitDivider.addEventListener('pointercancel', stopDividerDrag);
    splitDivider.addEventListener('dblclick', () => {
      if (!getViewport()) return;
      getViewport().splitRatio = 0.5;
      splitDivider.style.left = '50%';
      updatePaneHighlights();
      compositor.scheduleRedrawTiles();
      compositor.redrawAll();
    });
  }

  // Navigation buttons
  $('btnNavBack') && $('btnNavBack').addEventListener('click', () => navigation.navBack(getViewport()));
  $('btnNavForward') && $('btnNavForward').addEventListener('click', () => navigation.navForward(getViewport()));
  $('btnHeaderPrevPage') && $('btnHeaderPrevPage').addEventListener('click', () => commandsModule.commands.execute('nav.prevPage'));
  $('btnHeaderNextPage') && $('btnHeaderNextPage').addEventListener('click', () => commandsModule.commands.execute('nav.nextPage'));
  $('btnPrev') && $('btnPrev').addEventListener('click', () => commandsModule.commands.execute('nav.prevPage'));
  $('btnNext') && $('btnNext').addEventListener('click', () => commandsModule.commands.execute('nav.nextPage'));
  $('btnCanvasPrevPage') && $('btnCanvasPrevPage').addEventListener('click', () => commandsModule.commands.execute('nav.prevPage'));
  $('btnCanvasNextPage') && $('btnCanvasNextPage').addEventListener('click', () => commandsModule.commands.execute('nav.nextPage'));
  $('btnLeftPanePrev') && $('btnLeftPanePrev').addEventListener('click', () => {
    const cur = getViewport() ? getViewport().getActivePageInView('left') : 0;
    navigation.goToPage(cur - 1, 'left', getViewport());
  });
  $('btnLeftPaneNext') && $('btnLeftPaneNext').addEventListener('click', () => {
    const cur = getViewport() ? getViewport().getActivePageInView('left') : 0;
    navigation.goToPage(cur + 1, 'left', getViewport());
  });
  $('btnRightPanePrev') && $('btnRightPanePrev').addEventListener('click', () => {
    const cur = getViewport() ? getViewport().getActivePageInView('right') : 0;
    navigation.goToPage(cur - 1, 'right', getViewport());
  });
  $('btnRightPaneNext') && $('btnRightPaneNext').addEventListener('click', () => {
    const cur = getViewport() ? getViewport().getActivePageInView('right') : 0;
    navigation.goToPage(cur + 1, 'right', getViewport());
  });

  // Dual-Pane Cluster Per-Pane Zoom Controls
  $('btnLeftZoomOut') && $('btnLeftZoomOut').addEventListener('click', () => {
    if (getViewport()) {
      const bounds = compositor.paneBounds('left');
      getViewport().zoomOut([bounds.x + bounds.width / 2, bounds.y + bounds.height / 2], 'left');
      emit('zoomChanged', { zoom: getViewport().zoom, pane: 'left' });
    }
  });
  $('btnLeftZoomIn') && $('btnLeftZoomIn').addEventListener('click', () => {
    if (getViewport()) {
      const bounds = compositor.paneBounds('left');
      getViewport().zoomIn([bounds.x + bounds.width / 2, bounds.y + bounds.height / 2], 'left');
      emit('zoomChanged', { zoom: getViewport().zoom, pane: 'left' });
    }
  });
  $('btnLeftZoomFit') && $('btnLeftZoomFit').addEventListener('click', () => {
    if (getViewport()) {
      compositor.updateStageRect();
      navigation.fitPageInPanes(
        getViewport(),
        compositor.getStageRect(),
        state.pageInfos ? state.pageInfos[state.leftSheet || 0] : null,
        getViewport().splitMode && state.pageInfos ? state.pageInfos[state.rightSheet || 0] : null,
        'left'
      );
      emit('zoomChanged', { zoom: getViewport().zoom, pane: 'left' });
    }
  });

  $('btnRightZoomOut') && $('btnRightZoomOut').addEventListener('click', () => {
    if (getViewport()) {
      const bounds = compositor.paneBounds('right');
      getViewport().zoomOut([bounds.x + bounds.width / 2, bounds.y + bounds.height / 2], 'right');
      emit('zoomChanged', { zoom: getViewport().rightZoom, pane: 'right' });
    }
  });

  $('btnRightZoomIn') && $('btnRightZoomIn').addEventListener('click', () => {
    if (getViewport()) {
      const bounds = compositor.paneBounds('right');
      getViewport().zoomIn([bounds.x + bounds.width / 2, bounds.y + bounds.height / 2], 'right');
      emit('zoomChanged', { zoom: getViewport().rightZoom, pane: 'right' });
    }
  });

  $('btnRightZoomFit') && $('btnRightZoomFit').addEventListener('click', () => {
    if (getViewport()) {
      compositor.updateStageRect();
      navigation.fitPageInPanes(
        getViewport(),
        compositor.getStageRect(),
        state.pageInfos ? state.pageInfos[state.leftSheet || 0] : null,
        state.pageInfos ? state.pageInfos[state.rightSheet || 0] : null,
        'right'
      );
      emit('zoomChanged', { zoom: getViewport().rightZoom, pane: 'right' });
    }
  });

  const splitClusterEl = $('splitPageNavCluster');
  if (splitClusterEl) {
    const subclusters = splitClusterEl.querySelectorAll('.pane-nav-subcluster');
    if (subclusters[0]) {
      subclusters[0].addEventListener('click', e => {
        if (e.target.closest('button')) return;
        state.activePane = 'left';
        state.drawingPane = 'left';
        if (getViewport()) getViewport().activePane = 'left';
        emit('activePaneChanged', { pane: 'left' });
      });
    }
    if (subclusters[1]) {
      subclusters[1].addEventListener('click', e => {
        if (e.target.closest('button')) return;
        state.activePane = 'right';
        state.drawingPane = 'right';
        if (getViewport()) getViewport().activePane = 'right';
        emit('activePaneChanged', { pane: 'right' });
      });
    }
  }

  $('btnScrollTop') && $('btnScrollTop').addEventListener('click', () => navigation.goToPage(0, 'left', getViewport()));

  // Custom Zoom
  const applyCustomZoom = () => {
    const input = $('inputCustomZoom');
    if (!input || !getViewport()) return;
    const val = parseFloat(input.value);
    if (!isNaN(val) && val > 0) {
      const targetZoom = Math.max(0.15, Math.min(10.0, val / 100));
      const pane = (getViewport().splitMode && getViewport().activePane) ? getViewport().activePane : 'left';
      const bounds = compositor.paneBounds(pane);
      getViewport().setZoom(targetZoom, [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2], pane);
      if (typeof window.emitZoomChanged === 'function') window.emitZoomChanged(getViewport());
      toolbar.closeZoomMenu();
    }
  };
  $('btnApplyCustomZoom') && $('btnApplyCustomZoom').addEventListener('click', applyCustomZoom);
  $('inputCustomZoom') && $('inputCustomZoom').addEventListener('keydown', e => {
    if (e.key === 'Enter') applyCustomZoom();
  });

  // Smart Ink: hold-to-snap shape recognition
  const smartShapeToggle = $('cSmartShapeHold');
  if (smartShapeToggle) {
    smartShapeToggle.checked = state.smartShapeHoldEnabled !== false;
    smartShapeToggle.addEventListener('change', () => {
      state.smartShapeHoldEnabled = smartShapeToggle.checked;
      try {
        localStorage.setItem('inkwell.smartShapeHold', smartShapeToggle.checked ? '1' : '0');
      } catch (_) {}
    });
  }

  // Smart PDF export controls (range filter + flatten)
  const exportRangeMode = $('exportRangeMode');
  if (exportRangeMode) {
    exportRangeMode.addEventListener('change', () => {
      syncExportCustomInputVisibility();
      const input = $('exportCustomRangeInput');
      if (input && exportRangeMode.value === 'custom') input.focus();
    });
  }
  const exportConfirmBtn = $('exportConfirmBtn');
  if (exportConfirmBtn) {
    exportConfirmBtn.addEventListener('click', () => { exportWithSelectedOptions(); });
  }
  $('btnHeaderExport') && $('btnHeaderExport').addEventListener('click', refreshExportModal);
  const exportRangeInput = $('exportCustomRangeInput');
  if (exportRangeInput) {
    exportRangeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        exportWithSelectedOptions();
      }
    });
  }

  // External file change guard (cloud sync / other editors)
  const reloadExternalBtn = $('btnReloadExternalPdf');
  if (reloadExternalBtn) {
    reloadExternalBtn.addEventListener('click', () => { reloadExternalPdf(); });
  }
  // No plain dismiss: autosave stays paused until one of the three choices.
  const keepMineBtn = $('btnKeepMineExternal');
  if (keepMineBtn) {
    keepMineBtn.addEventListener('click', () => { keepMineExternal(); });
  }
  const saveCopyBtn = $('btnSaveCopyExternal');
  if (saveCopyBtn) {
    saveCopyBtn.addEventListener('click', () => { saveCopyExternal(); });
  }
  window.addEventListener('focus', () => { checkForExternalChanges(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkForExternalChanges();
  });
  // Cloud clients can rewrite the file while the window stays focused, so poll
  // a cheap metadata stamp every 30 s (skipped while hidden or saving).
  if (typeof setInterval === 'function') {
    setInterval(() => { checkForExternalChanges(); }, 30000);
  }

  // Autosave on/off (Plan 090: timing comes from the backend FlushPolicy)
  const selAutosave = $('selectAutosaveDelay');
  if (selAutosave) {
    selAutosave.value = state.autosaveEnabled ? 'on' : 'off';
    selAutosave.addEventListener('change', () => {
      setAutosaveEnabled(selAutosave.value !== 'off');
      toolbar.updateSaveStatusUI(state.isSaving ? 'saving' : (state.isDirty ? 'dirty' : 'saved'));
    });
  }

  // Modals & Popovers
  $('btnCmdPalette') && $('btnCmdPalette').addEventListener('click', () => commandPalette.openCommandPalette());
  $('btnMorePalette') && $('btnMorePalette').addEventListener('click', () => {
    $('moreOptionsMenu') && $('moreOptionsMenu').classList.add('hidden');
    commandPalette.openCommandPalette();
  });
  $('btnMoreFullscreen') && $('btnMoreFullscreen').addEventListener('click', () => {
    $('moreOptionsMenu') && $('moreOptionsMenu').classList.add('hidden');
    toolbar.toggleFullscreen();
  });

  $('btnMoreAddPage') && $('btnMoreAddPage').addEventListener('click', () => {
    $('moreOptionsMenu') && $('moreOptionsMenu').classList.add('hidden');
    openInsertPageModal();
  });
  $('btnHeaderAddPage') && $('btnHeaderAddPage').addEventListener('click', openInsertPageModal);
  $('btnAddPage') && $('btnAddPage').addEventListener('click', openInsertPageModal);
  $('btnInsertBlank') && $('btnInsertBlank').addEventListener('click', openInsertPageModal);
  $('btnCloseInsertPageModal') && $('btnCloseInsertPageModal').addEventListener('click', closeInsertPageModal);
  $('btnCancelInsertPage') && $('btnCancelInsertPage').addEventListener('click', closeInsertPageModal);
  $('insertPageModal') && $('insertPageModal').addEventListener('click', e => {
    if (e.target === $('insertPageModal')) closeInsertPageModal();
  });

  $('insertPaperSizeSelect') && $('insertPaperSizeSelect').addEventListener('change', e => {
    const customRow = $('customDimRow');
    if (customRow) {
      if (e.target.value === 'custom') {
        customRow.classList.remove('hidden');
      } else {
        customRow.classList.add('hidden');
      }
    }
  });

  $('insertPageForm') && $('insertPageForm').addEventListener('submit', async e => {
    e.preventDefault();
    closeInsertPageModal();
    try {
      const curSheet = getViewport() ? getViewport().getActivePageInView(state.drawingPane || 'left') : 0;
      const totalPages = state.pageInfos ? state.pageInfos.length : 0;
      const curPageInfo = (state.pageInfos && state.pageInfos[curSheet]) || { width_pt: 595.0, height_pt: 842.0 };

      // 1. Resolve base width and height in points
      const sizePreset = $('insertPaperSizeSelect') ? $('insertPaperSizeSelect').value : 'match_current';
      let width = 595.0;
      let height = 842.0;

      switch (sizePreset) {
        case 'match_current':
          width = curPageInfo.width_pt || 595.0;
          height = curPageInfo.height_pt || 842.0;
          break;
        case 'a4':
          width = 595.0; height = 842.0;
          break;
        case 'letter':
          width = 612.0; height = 792.0;
          break;
        case 'a3':
          width = 842.0; height = 1191.0;
          break;
        case 'legal':
          width = 612.0; height = 1008.0;
          break;
        case 'widescreen':
          width = 960.0; height = 540.0;
          break;
        case 'custom': {
          const wInput = parseFloat($('customPageWidth') ? $('customPageWidth').value : '595');
          const hInput = parseFloat($('customPageHeight') ? $('customPageHeight').value : '842');
          width = !isNaN(wInput) && wInput >= 72 ? wInput : 595.0;
          height = !isNaN(hInput) && hInput >= 72 ? hInput : 842.0;
          break;
        }
      }

      // 2. Resolve orientation
      const orientation = document.querySelector('input[name="pageOrientation"]:checked')?.value || 'portrait';
      if (orientation === 'landscape' && width < height) {
        const tmp = width; width = height; height = tmp;
      } else if (orientation === 'portrait' && width > height) {
        const tmp = width; width = height; height = tmp;
      }

      // 3. Resolve template
      const template = $('insertTemplateSelect') ? $('insertTemplateSelect').value : 'blank';

      // 4. Resolve target insertion index
      const posChoice = $('insertPositionSelect') ? $('insertPositionSelect').value : 'after_current';
      let targetIndex = curSheet + 1;
      if (posChoice === 'before_current') {
        targetIndex = curSheet;
      } else if (posChoice === 'document_start') {
        targetIndex = 0;
      } else if (posChoice === 'document_end') {
        targetIndex = totalPages;
      }

      // 5. Execute insertion
      await ipc.insertBlankPage(targetIndex, width, height);
      const newPageInfo = {
        page_index: targetIndex,
        width_pt: width,
        height_pt: height,
        template,
      };
      documentOps.insertPageAtIndex(targetIndex, newPageInfo);
      if (getViewport()) getViewport().updateDocumentLayout(state.pageInfos);
      navigation.goToPage(targetIndex, 'left', getViewport());
      drawers.renderThumbnails();
      compositor.redrawAll();

      const templateName = $('insertTemplateSelect') && $('insertTemplateSelect').selectedOptions[0]
        ? $('insertTemplateSelect').selectedOptions[0].textContent
        : template;
      toast.showToast(`Inserted page ${targetIndex + 1} (${templateName})`, 'success');
    } catch (err) {
      const msg = friendlyError(err);
      if (msg) toast.showToast('Failed to insert page: ' + msg, 'error');
    }
  });

  // Go To Page form
  $('goToPageForm') && $('goToPageForm').addEventListener('submit', e => {
    e.preventDefault();
    toolbar.closeGoToPageModal();
    const input = $('goToPageInput');
    const val = input ? parseInt(input.value, 10) : 1;
    if (!isNaN(val) && val >= 1) {
      navigation.goToPage(val - 1, 'left', getViewport());
    }
  });
  $('btnJumpFirstPage') && $('btnJumpFirstPage').addEventListener('click', () => {
    toolbar.closeGoToPageModal();
    navigation.goToPage(0, 'left', getViewport());
  });
  $('btnJumpLastPage') && $('btnJumpLastPage').addEventListener('click', () => {
    toolbar.closeGoToPageModal();
    if (state.pageInfos && state.pageInfos.length) {
      navigation.goToPage(state.pageInfos.length - 1, 'left', getViewport());
    }
  });

  // Clear current page ink
  const clearInk = () => {
    const activeSheet = getViewport() ? getViewport().getActivePageInView(state.drawingPane || 'left') : 0;
    documentOps.clearPageInk(activeSheet);
    compositor.redrawAll();
    toast.showToast(`Cleared ink on page ${activeSheet + 1}`, 'info');
  };
  $('btnMoreClearInk') && $('btnMoreClearInk').addEventListener('click', () => {
    $('moreOptionsMenu') && $('moreOptionsMenu').classList.add('hidden');
    clearInk();
  });
  $('btnDocInfoClearInk') && $('btnDocInfoClearInk').addEventListener('click', clearInk);
  $('btnDocInfoExport') && $('btnDocInfoExport').addEventListener('click', () => commandsModule.commands.execute('file.save'));
  $('btnDocInfoInsertPage') && $('btnDocInfoInsertPage').addEventListener('click', () => openInsertPageModal());
  $('btnDocInfoNewWhiteboard') && $('btnDocInfoNewWhiteboard').addEventListener('click', () => createNewWhiteboard());

  // Text selection popover actions
  $('btnTextCopy') && $('btnTextCopy').addEventListener('click', () => {
    if (textSelection.copySelectedPdfText()) {
      toast.showToast('Copied text to clipboard', 'info');
    }
    const pop = $('textSelectionPopover');
    if (pop) pop.classList.add('hidden');
  });

  function applyTextSelectionMarkup(mode) {
    if (!state.textSelection || !state.textSelection.rects || !state.textSelection.rects.length) return;
    const createdStrokes = [];
    const timestamp = Date.now();

    for (let i = 0; i < state.textSelection.rects.length; i++) {
      const r = state.textSelection.rects[i];
      if (!r || !r.rect) continue;
      const [x0, y0, x1, y1] = r.rect;
      const lineH = Math.max(8, y1 - y0);
      const sheet = r.sheet !== undefined ? r.sheet : (state.textSelection.sheet || 0);

      let kind = 'pen';
      let rgb = [0.94, 0.27, 0.27];
      let base_width = 2.0;
      let y = (y0 + y1) / 2;

      let points = [];
      if (mode === 'highlight') {
        kind = 'highlighter';
        rgb = state.highlighterColor || [0.98, 0.88, 0.15];
        base_width = lineH;
        y = (y0 + y1) / 2;
        points = [
          { x: x0, y, p: 0.8, w: base_width },
          { x: x1, y, p: 0.8, w: base_width }
        ];
      } else if (mode === 'underline') {
        kind = 'pen';
        rgb = state.penColor || [0.94, 0.27, 0.27];
        base_width = Math.max(1.5, lineH * 0.08);
        y = y1 - 1;
        points = [
          { x: x0, y, p: 0.8, w: base_width },
          { x: x1, y, p: 0.8, w: base_width }
        ];
      } else if (mode === 'strikethrough') {
        kind = 'pen';
        rgb = state.penColor || [0.94, 0.27, 0.27];
        base_width = Math.max(1.5, lineH * 0.08);
        y = (y0 + y1) / 2;
        points = [
          { x: x0, y, p: 0.8, w: base_width },
          { x: x1, y, p: 0.8, w: base_width }
        ];
      }

      const stroke = {
        id: `markup_${mode}_${timestamp}_${i}_${Math.random().toString(36).substring(2, 7)}`,
        sheet,
        kind,
        rgb,
        base_width,
        points,
        deleted: false
      };
      if (window.Ink && typeof window.Ink.computeStrokeBbox === 'function') {
        stroke.bbox = window.Ink.computeStrokeBbox(stroke.points, stroke.base_width);
      }
      createdStrokes.push(stroke);
    }

    if (createdStrokes.length) {
      documentOps.addObjectsBatch({ strokes: createdStrokes });
      textSelection.clearTextSelection();
      const pop = $('textSelectionPopover');
      if (pop) pop.classList.add('hidden');
      compositor.redrawAll();
    }
  }
  window.applyTextSelectionMarkup = applyTextSelectionMarkup;

  $('btnTextHighlight') && $('btnTextHighlight').addEventListener('click', () => applyTextSelectionMarkup('highlight'));
  $('btnTextUnderline') && $('btnTextUnderline').addEventListener('click', () => applyTextSelectionMarkup('underline'));
  $('btnTextStrikethrough') && $('btnTextStrikethrough').addEventListener('click', () => applyTextSelectionMarkup('strikethrough'));

  $('btnTextSearch') && $('btnTextSearch').addEventListener('click', () => {
    const text = state.selectedTextString || (state.textSelection && state.textSelection.text);
    if (text) {
      drawers.openSearchWithQuery(text.trim());
    }
    const pop = $('textSelectionPopover');
    if (pop) pop.classList.add('hidden');
  });

  $('btnHeaderFind') && $('btnHeaderFind').addEventListener('click', () => {
    drawers.openDrawer('search');
    const input = $('drawerSearchInput');
    if (input) input.focus();
  });

  // Sticky note inline text editor
  const textarea = $('inlineTextarea');
  if (textarea) {
    textarea.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        textTool.cancelEditing();
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        textTool.commitEditing();
      }
    });
    textarea.addEventListener('blur', () => {
      textTool.commitEditing();
    });
  }

  const tb = $('inlineTextToolbar');
  if (tb) {
    tb.addEventListener('mousedown', (e) => e.preventDefault());
    tb.addEventListener('pointerdown', (e) => e.preventDefault());
  }

  // Drag and Drop PDF
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', async e => {
    e.preventDefault();
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;

    if (file.name.toLowerCase().endsWith('.pdf')) {
      try {
        const filePath = file.path;
        if (filePath) {
          showOpenProgress('Reading document…');
          const r = await ipc.openPdf(filePath);
          showOpenProgress('Preparing page layout…');
          handlePdfLoadResult(file.name, filePath, r);
          return;
        }
        const buf = await file.arrayBuffer();
        showOpenProgress('Reading document…');
        const r2 = await ipc.openPdfBytes(file.name, Array.from(new Uint8Array(buf)));
        showOpenProgress('Preparing page layout…');
        handlePdfLoadResult(file.name, null, r2);
      } catch (err) {
        hideOpenProgress();
        const msg = friendlyError(err);
        if (msg) toast.showToast('Failed to open dropped PDF: ' + msg, 'error');
      }
      return;
    }

    if (file.type && file.type.startsWith('image/')) {
      try {
        const activeSheet = getViewport() ? getViewport().getActivePageInView(state.drawingPane || 'left') : 0;
        let targetPagePt = null;
        if (getViewport()) {
          const pl = getViewport().getPageLayout(activeSheet);
          if (pl) {
            const [wx, wy] = getViewport().screenToWorld(e.clientX, e.clientY, state.drawingPane || 'left');
            targetPagePt = { px: wx - pl.x, py: wy - pl.y };
          }
        }
        const dataUrl = await clipboard.blobToDataUrl(file);
        if (dataUrl) {
          const pastedImg = await clipboard.pasteImageDataUrl(dataUrl, activeSheet, targetPagePt);
          if (pastedImg) {
            compositor.redrawAll();
            toast.showToast('Pasted dropped image', 'info');
          }
        }
      } catch (err) {
        console.warn('[inkwell/main] Failed to paste dropped image:', err);
      }
    }
  });

  // Modal focus trapping and backdrop dismissal
  initModalFocusTrap();
  initLassoSelectionPopover();
}
