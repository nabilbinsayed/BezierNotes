/**
 * Registration of every palette/shortcut command with the command registry.
 * (Split out of main.js by Plan 093; behaviour unchanged.)
 */

import { state, $, on } from '../core/state.js';
import * as history from '../core/history.js';
import * as commandsModule from '../core/commands.js';
import * as documentOps from '../core/document.js';
import * as clipboard from '../core/clipboard.js';
import * as ipc from '../core/ipc.js';
import * as compositor from '../render/compositor.js';
import * as toolManager from '../tools/tool-manager.js';
import * as lassoTool from '../tools/lasso.js';
import * as navigation from '../workspace/navigation.js';
import * as textSelection from '../workspace/text-selection.js';
import * as annotations from '../workspace/annotations.js';
import * as toast from '../ui/toast.js';
import * as toolbar from '../ui/toolbar.js';
import * as drawers from '../ui/drawers.js';
import * as contextMenu from '../ui/context-menu.js';
import * as commandPalette from '../ui/command-palette.js';
import * as signature from '../ui/signature.js';
import * as presentation from '../ui/presentation.js';
import { createNewWhiteboard, friendlyError, openFileTrigger } from '../app/document-loading.js';
import { getViewport } from '../app/viewport-ref.js';
import { exportPdfWithDialog, prepareAllImagesForSave } from '../ui/export-modal.js';
import { openInsertPageModal } from '../ui/insert-page-modal.js';
import { cycleReadingMode } from '../ui/reading-mode.js';
import { hideExternalChangeBanner } from '../ui/external-change.js';
import { noteFlushed } from './autosave.js';

// A manual Ctrl+S may overlap an autosave; the backend orders them.
let _savesInFlight = 0;

export function registerCoreCommands() {
  const reg = commandsModule.commands;

  // File commands
  reg.register({
    id: 'file.open',
    title: 'Open PDF Document',
    category: 'File',
    shortcut: 'Ctrl+O',
    execute: () => openFileTrigger(),
  });

  reg.register({
    id: 'file.newWhiteboard',
    title: 'New Whiteboard',
    category: 'File',
    shortcut: 'Ctrl+N',
    execute: () => createNewWhiteboard(),
  });

  reg.register({
    id: 'file.save',
    title: 'Save Document',
    category: 'File',
    shortcut: 'Ctrl+S',
    // opts.silent: autosave (no toast, never resolves the change-on-disk banner).
    // opts.saveAsCopyName: Save As with this name prefilled (banner "Save a copy").
    execute: async ({ silent = false, reason = 'manual', saveAsCopyName = null } = {}) => {
      // A manual save is the user choosing their version over a changed file.
      if (!silent && !saveAsCopyName && state.externalChangePending) {
        state.externalChangePending = false;
        hideExternalChangeBanner();
      }
      // Edits made while this save runs keep the document dirty (and stay in
      // the journal: the backend trims only what this snapshot covers).
      const editSeqAtSnapshot = state.editSeq;
      _savesInFlight += 1;
      try {
        state.isSaving = true;
        toolbar.updateSaveStatusUI('saving');
        const imagesToSave = prepareAllImagesForSave();
        const target = saveAsCopyName ? null : state.currentDocPath;
        const savedPath = await ipc.savePdf(target, state.strokes, imagesToSave, state.textObjects, { defaultName: saveAsCopyName });
        if (savedPath) {
          state.currentDocPath = savedPath;
          state.currentDocTitle = savedPath.split(/[\\/]/).pop();
          state.isDirty = state.editSeq !== editSeqAtSnapshot;
          state.lastSavedAt = Date.now();
          state.lastSaveReason = reason;
          noteFlushed(reason);
          toolbar.updateSaveStatusUI(state.isDirty ? 'dirty' : 'saved');
          if (!silent) toast.showToast('Document saved successfully', 'success');
          return true;
        }
        return false;
      } catch (e) {
        toolbar.updateSaveStatusUI('dirty');
        const msg = friendlyError(e);
        if (msg && msg !== 'CANCELLED') {
          toast.showToast((silent ? 'Autosave failed: ' : 'Save failed: ') + msg, 'error');
        }
        return false;
      } finally {
        _savesInFlight -= 1;
        state.isSaving = _savesInFlight > 0;
      }
    },
  });

  reg.register({
    id: 'file.exportPdf',
    title: 'Export As New Copy...',
    category: 'File',
    shortcut: 'Ctrl+Shift+S',
    // Non-destructive: writes a copy through the export pipeline, so the live
    // document path, base bytes, WAL and dirty flag are left untouched.
    execute: () => exportPdfWithDialog({ selectedPages: null, flatten: false }),
  });

  reg.register({
    id: 'file.insertBlankPage',
    title: 'Insert Blank Page...',
    category: 'File',
    shortcut: 'Ctrl+Shift+N',
    execute: () => {
      openInsertPageModal();
    },
  });

  // Edit commands
  reg.register({
    id: 'edit.undo',
    title: 'Undo',
    category: 'Edit',
    shortcut: 'Ctrl+Z',
    canExecute: () => history.canUndo(),
    execute: () => {
      documentOps.performUndo();
      compositor.redrawAll();
      toolbar.updateUndoRedoUI();
    },
  });

  reg.register({
    id: 'edit.redo',
    title: 'Redo',
    category: 'Edit',
    shortcut: ['Ctrl+Y', 'Ctrl+Shift+Z'],
    canExecute: () => history.canRedo(),
    execute: () => {
      documentOps.performRedo();
      compositor.redrawAll();
      toolbar.updateUndoRedoUI();
    },
  });

  reg.register({
    id: 'edit.copy',
    title: 'Copy Selection',
    category: 'Edit',
    shortcut: 'Ctrl+C',
    execute: () => {
      if ((state.activeTool === 'textSelect' || state.activeTool === 'textselect') && state.selectedTextString && textSelection.copySelectedPdfText()) {
        return;
      }
      if (clipboard.copySelection()) {
        toast.showToast('Copied to clipboard', 'info');
      }
    },
  });

  reg.register({
    id: 'edit.copySvg',
    title: 'Copy Selection as SVG (Obsidian / Vector)',
    category: 'Edit',
    shortcut: 'Ctrl+Alt+C',
    execute: () => {
      clipboard.copySelectionAsSvg();
    },
  });

  reg.register({
    id: 'edit.cut',
    title: 'Cut Selection',
    category: 'Edit',
    shortcut: 'Ctrl+X',
    execute: () => {
      if (clipboard.cutSelection()) {
        compositor.redrawAll();
        toast.showToast('Cut to clipboard', 'info');
      }
    },
  });

  reg.register({
    id: 'edit.paste',
    title: 'Paste',
    category: 'Edit',
    shortcut: 'Ctrl+V',
    execute: async () => {
      const ctxTarget = contextMenu.getLastContextMenuTarget();
      const activeSheet = (ctxTarget && typeof ctxTarget.sheet === 'number')
        ? ctxTarget.sheet
        : (getViewport() ? getViewport().getActivePageInView(state.drawingPane || 'left') : 0);

      let targetPagePt = null;
      if (ctxTarget && ctxTarget.worldPt && getViewport()) {
        const pl = getViewport().getPageLayout(activeSheet);
        if (pl) {
          targetPagePt = {
            px: ctxTarget.worldPt[0] - pl.x,
            py: ctxTarget.worldPt[1] - pl.y,
          };
        }
      }

      const pasted = await clipboard.pasteFromSystemClipboard(activeSheet, targetPagePt);
      if (pasted) {
        compositor.redrawAll();
        toast.showToast('Pasted from clipboard', 'info');
      } else if (clipboard.hasClipboardContent()) {
        if (clipboard.pasteClipboard(activeSheet, 16, targetPagePt)) {
          compositor.redrawAll();
          toast.showToast('Pasted objects', 'info');
        }
      }
      if (ctxTarget) {
        contextMenu.clearLastContextMenuTarget();
      }
    },
  });

  reg.register({
    id: 'edit.duplicate',
    title: 'Duplicate Selection',
    category: 'Edit',
    shortcut: 'Ctrl+D',
    execute: () => {
      const activeSheet = getViewport() ? getViewport().getActivePageInView(state.drawingPane || 'left') : 0;
      if (clipboard.duplicateSelection(activeSheet)) {
        compositor.redrawAll();
      }
    },
  });

  reg.register({
    id: 'edit.delete',
    title: 'Delete Selection',
    category: 'Edit',
    shortcut: ['Delete', 'Backspace'],
    execute: () => {
      if (clipboard.deleteSelection()) {
        compositor.redrawAll();
      }
    },
  });

  reg.register({
    id: 'edit.selectAll',
    title: 'Select All on Page',
    category: 'Edit',
    shortcut: 'Ctrl+A',
    execute: () => {
      lassoTool.selectAllOnCurrentPage(getViewport());
    },
  });

  // Tool commands
  reg.register({ id: 'tool.pen', title: 'Fountain Pen', category: 'Tools', shortcut: 'P', execute: () => { toolManager.setTool('pen'); toolbar.updateToolbarUI(); } });
  reg.register({ id: 'tool.highlighter', title: 'Highlighter', category: 'Tools', shortcut: 'M', execute: () => { toolManager.setTool('highlighter'); toolbar.updateToolbarUI(); } });
  reg.register({ id: 'tool.eraser', title: 'Eraser', category: 'Tools', shortcut: 'E', execute: () => { toolManager.setTool('eraser'); toolbar.updateToolbarUI(); } });
  reg.register({ id: 'tool.lasso', title: 'Lasso Select', category: 'Tools', shortcut: 'V', execute: () => { toolManager.setTool('lasso'); toolbar.updateToolbarUI(); } });
  reg.register({ id: 'tool.rect', title: 'Rectangle Shape', category: 'Tools', shortcut: 'R', execute: () => { toolManager.setTool('rect'); toolbar.updateToolbarUI(); } });
  reg.register({ id: 'tool.ellipse', title: 'Ellipse Shape', category: 'Tools', shortcut: 'O', execute: () => { toolManager.setTool('ellipse'); toolbar.updateToolbarUI(); } });
  reg.register({ id: 'tool.line', title: 'Line / Ruler', category: 'Tools', shortcut: 'L', execute: () => { toolManager.setTool('line'); toolbar.updateToolbarUI(); } });
  reg.register({ id: 'tool.shapes', title: 'Shapes Toggle', category: 'Tools', execute: () => {
    if (state.activeTool === 'rect') toolManager.setTool('ellipse');
    else if (state.activeTool === 'ellipse') toolManager.setTool('line');
    else toolManager.setTool('rect');
    toolbar.updateToolbarUI();
  } });
  reg.register({ id: 'tool.text', title: 'Sticky Note', category: 'Tools', shortcut: 'T', execute: () => { toolManager.setTool('text'); toolbar.updateToolbarUI(); } });
  reg.register({ id: 'tool.textSelect', title: 'Text Selection', category: 'Tools', shortcut: 'S', execute: () => { toolManager.setTool('textSelect'); toolbar.updateToolbarUI(); } });
  reg.register({ id: 'tool.laser', title: 'Laser Pointer', category: 'Tools', shortcut: 'K', execute: () => { toolManager.setTool('laser'); toolbar.updateToolbarUI(); } });
  reg.register({ id: 'tool.pan', title: 'Hand / Pan Canvas', category: 'Tools', shortcut: 'H', execute: () => { toolManager.setTool('pan'); toolbar.updateToolbarUI(); } });
  reg.register({ id: 'tool.palette', title: 'Ink Color & Width Palette', category: 'Tools', shortcut: 'C', execute: () => { toolbar.togglePropPopover(); } });
  reg.register({ id: 'tool.signature', title: 'Signature & Stamp Studio', category: 'Tools', shortcut: 'I', execute: () => signature.openSignatureStudio('draw') });

  // Navigation commands
  reg.register({
    id: 'nav.nextPage',
    title: 'Next Page',
    category: 'Navigation',
    shortcut: ['PageDown', 'ArrowRight', ']'],
    execute: () => {
      const isRight = getViewport() && getViewport().splitMode && (state.drawingPane === 'right');
      const curSheet = isRight ? (state.rightSheet || 0) : (state.leftSheet || 0);
      navigation.goToPage(curSheet + 1, isRight ? 'right' : 'left', getViewport());
    },
  });

  reg.register({
    id: 'nav.prevPage',
    title: 'Previous Page',
    category: 'Navigation',
    shortcut: ['PageUp', 'ArrowLeft', '['],
    execute: () => {
      const isRight = getViewport() && getViewport().splitMode && (state.drawingPane === 'right');
      const curSheet = isRight ? (state.rightSheet || 0) : (state.leftSheet || 0);
      navigation.goToPage(curSheet - 1, isRight ? 'right' : 'left', getViewport());
    },
  });

  reg.register({
    id: 'nav.goToPage',
    title: 'Go to Page...',
    category: 'Navigation',
    shortcut: 'Ctrl+G',
    execute: () => {
      toolbar.openGoToPageModal();
    },
  });

  reg.register({
    id: 'nav.search',
    title: 'Find in Document',
    category: 'Navigation',
    shortcut: 'Ctrl+F',
    execute: () => {
      drawers.openDrawer('search');
      const input = $('drawerSearchInput');
      if (input) {
        requestAnimationFrame(() => {
          input.focus();
          input.select();
        });
      }
    },
  });

  // View commands
  reg.register({
    id: 'view.toggleSplit',
    title: 'Toggle Split View',
    category: 'View',
    shortcut: ['Ctrl+\\', 'Alt+S'],
    execute: () => {
      if (getViewport()) {
        const entering = !getViewport().splitMode;
        let targetRightSheet = state.rightSheet || 0;
        if (entering) {
          const n = (state.pageInfos && state.pageInfos.length) || 1;
          targetRightSheet = Math.min(n - 1, (state.leftSheet || 0) + 1);
          state.rightSheet = targetRightSheet;
        } else {
          state.drawingPane = 'left';
        }
        getViewport().toggleSplitMode();
        state.splitMode = getViewport().splitMode;
        if (entering) {
          state.rightSheet = targetRightSheet;
        }
        compositor.updateStageRect();
        const stageR = compositor.getStageRect();
        if (typeof navigation !== 'undefined' && navigation.fitPageInPanes) {
          if (getViewport().splitMode) {
            navigation.fitPageInPanes(
              getViewport(),
              stageR,
              state.pageInfos ? state.pageInfos[state.leftSheet || 0] : null,
              state.pageInfos ? state.pageInfos[targetRightSheet] : null
            );
          } else {
            navigation.fitPageInPanes(
              getViewport(),
              stageR,
              state.pageInfos ? state.pageInfos[state.leftSheet || 0] : null,
              null
            );
          }
        }
        if (typeof navigation !== 'undefined' && navigation.syncActivePagesFromViewport) {
          navigation.syncActivePagesFromViewport(getViewport());
        }
        $('btnRailSplit') && $('btnRailSplit').classList.toggle('active', getViewport().splitMode);
        $('btnZoomSplit') && $('btnZoomSplit').classList.toggle('active', getViewport().splitMode);
        const divider = $('splitDivider');
        if (divider) {
          if (getViewport().splitMode) {
            divider.classList.remove('hidden');
            divider.style.left = `${((getViewport().splitRatio || 0.5) * 100).toFixed(2)}%`;
          } else {
            divider.classList.add('hidden');
          }
        }
        const cluster = $('splitPageNavCluster');
        if (cluster) {
          if (getViewport().splitMode) cluster.classList.remove('hidden');
          else cluster.classList.add('hidden');
        }
        const leftEl = $('leftPanePageNum');
        if (leftEl) leftEl.textContent = `${(state.leftSheet || 0) + 1}`;
        const rightEl = $('rightPanePageNum');
        if (rightEl) rightEl.textContent = `${(state.rightSheet || 0) + 1}`;
        updatePaneHighlights();
        compositor.scheduleRedrawTiles();
        compositor.redrawAll();
      }
    },
  });

  reg.register({
    id: 'view.toggleFullscreen',
    title: 'Toggle Fullscreen',
    category: 'View',
    shortcut: 'F11',
    execute: () => toolbar.toggleFullscreen(),
  });

  reg.register({
    id: 'view.presentation',
    title: 'Presentation Mode',
    category: 'View',
    shortcut: 'F5',
    execute: () => presentation.togglePresentation(),
  });

  reg.register({
    id: 'view.zoomIn',
    title: 'Zoom In',
    category: 'View',
    shortcut: ['Ctrl+=', 'Ctrl+Shift+=', 'Ctrl++'],
    execute: () => {
      if (getViewport()) {
        const pane = (getViewport().splitMode && (state.drawingPane || getViewport().activePane)) ? (state.drawingPane || getViewport().activePane) : 'left';
        const bounds = compositor.paneBounds(pane);
        getViewport().zoomIn([bounds.x + bounds.width / 2, bounds.y + bounds.height / 2], pane);
        if (typeof window.emitZoomChanged === 'function') window.emitZoomChanged(getViewport());
      }
    },
  });

  reg.register({
    id: 'view.zoomOut',
    title: 'Zoom Out',
    category: 'View',
    shortcut: 'Ctrl+-',
    execute: () => {
      if (getViewport()) {
        const pane = (getViewport().splitMode && (state.drawingPane || getViewport().activePane)) ? (state.drawingPane || getViewport().activePane) : 'left';
        const bounds = compositor.paneBounds(pane);
        getViewport().zoomOut([bounds.x + bounds.width / 2, bounds.y + bounds.height / 2], pane);
        if (typeof window.emitZoomChanged === 'function') window.emitZoomChanged(getViewport());
      }
    },
  });

  reg.register({
    id: 'view.fitPage',
    title: 'Fit Page to Window',
    category: 'View',
    shortcut: 'Ctrl+0',
    execute: () => {
      if (getViewport() && state.pageInfos && state.pageInfos.length) {
        const pane = (getViewport().splitMode && (state.drawingPane || getViewport().activePane)) ? (state.drawingPane || getViewport().activePane) : 'left';
        const curSheet = (pane === 'right' && getViewport().splitMode) ? (state.rightSheet || 0) : (state.leftSheet || 0);
        const pi = state.pageInfos[curSheet] || state.pageInfos[0];
        getViewport().fitPage(pi.width_pt, pi.height_pt, pane);
        if (typeof window.emitZoomChanged === 'function') window.emitZoomChanged(getViewport());
      }
    },
  });

  reg.register({
    id: 'view.fitWidth',
    title: 'Fit Width to Window',
    category: 'View',
    shortcut: 'Ctrl+9',
    execute: () => {
      if (getViewport() && state.pageInfos && state.pageInfos.length) {
        const pane = (getViewport().splitMode && (state.drawingPane || getViewport().activePane)) ? (state.drawingPane || getViewport().activePane) : 'left';
        const curSheet = (pane === 'right' && getViewport().splitMode) ? (state.rightSheet || 0) : (state.leftSheet || 0);
        const pi = state.pageInfos[curSheet] || state.pageInfos[0];
        getViewport().fitWidth(pi.width_pt, pane);
        if (typeof window.emitZoomChanged === 'function') window.emitZoomChanged(getViewport());
      }
    },
  });

  reg.register({
    id: 'view.cycleReadingMode',
    title: 'Cycle PDF Reading Mode (Normal / Dark / Sepia)',
    category: 'View',
    shortcut: 'Ctrl+Shift+D',
    execute: () => cycleReadingMode(),
  });

  reg.register({
    id: 'view.toggleAnnotations',
    title: 'Annotations & Review Panel',
    category: 'View',
    shortcut: 'Ctrl+Shift+A',
    execute: () => drawers.toggleDrawer('annotations'),
  });

  // Modal commands
  reg.register({
    id: 'modal.commandPalette',
    title: 'Command Palette',
    category: 'General',
    shortcut: ['Ctrl+K', 'Ctrl+Shift+P'],
    execute: () => commandPalette.openCommandPalette(),
  });

  reg.register({
    id: 'modal.preferences',
    title: 'Preferences',
    category: 'General',
    shortcut: 'Ctrl+,',
    execute: () => toolbar.openSettingsModal(),
  });

  reg.register({
    id: 'modal.shortcuts',
    title: 'Keyboard Shortcuts',
    category: 'General',
    shortcut: ['?', 'F1'],
    execute: () => {
      $('shortcutsModal') && $('shortcutsModal').classList.remove('hidden');
    },
  });
}
