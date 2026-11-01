/* ============================================================================
 * main.js — Main Application Bootstrap & UI Wiring for Inkwell
 * Pure lifecycle orchestrator: connects UI controls, commands, viewport & tools.
 * ========================================================================== */

import { state, $, on, emit, escapeHtml } from './core/state.js';
import * as history from './core/history.js';
import * as commandsModule from './core/commands.js';
import * as documentOps from './core/document.js';
import * as clipboard from './core/clipboard.js';
import * as ipc from './core/ipc.js';

import * as compositor from './render/compositor.js';
import * as tiles from './render/tiles.js';
import * as overlays from './render/overlays.js';
import * as templates from './render/templates.js';

import * as toolManager from './tools/tool-manager.js';
import * as penTool from './tools/pen.js';
import * as eraserTool from './tools/eraser.js';
import * as lassoTool from './tools/lasso.js';
import * as shapesTool from './tools/shapes.js';
import * as textTool from './tools/text.js';
import * as laserTool from './tools/laser.js';

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

let _viewport = null;

export function getViewport() {
  return _viewport;
}

function handlePdfLoadResult(title, pathStr, res) {
  if (!res) return;
  const pageInfos = res.page_infos || (Array.isArray(res) ? res : []);
  const loadedStrokes = res.loaded_strokes || [];
  const loadedImages = res.loaded_images || [];
  const loadedTexts = res.loaded_texts || [];
  const outline = res.outline || [];
  const bookmarks = (res.bookmarks || []).map(b => ({
    id: b.id,
    page: b.page,
    label: b.label,
    createdAt: b.created_at || b.createdAt || Date.now(),
  }));

  state.outline = outline;
  state.bookmarks = bookmarks;
  state.currentDocPath = pathStr;
  state.currentDocTitle = title;

  documentOps.setDocument({
    pageInfos,
    strokes: loadedStrokes,
    images: loadedImages,
    textObjects: loadedTexts,
    bookmarks,
  });

  if (_viewport && pageInfos.length > 0) {
    _viewport.updateDocumentLayout(pageInfos);
    _viewport.fitPage(pageInfos[0].width_pt, pageInfos[0].height_pt, 'left');
  }

  $('welcomeDropzone') && $('welcomeDropzone').classList.add('hidden');
  navigation.goToPage(0, 'left', _viewport, false);
  scrollbar.updateDocScrollbar(_viewport);
  drawers.renderOutline();
  drawers.renderBookmarks();
  annotations.resetAnnotationsView();
  const pageBadge = $('badgeThumbnails');
  if (pageBadge) pageBadge.textContent = String(pageInfos.length || 1);
  annotations.scheduleAnnotationRefresh();
  if (typeof window.emitZoomChanged === 'function' && _viewport) {
    window.emitZoomChanged(_viewport);
  }

  const totalRecovered = (res.recovered_strokes || 0) + (res.recovered_images || 0) + (res.recovered_texts || 0);
  if (totalRecovered > 0) {
    toast.showToast(`Restored ${totalRecovered} items from crash recovery log`, 'info');
  }

  const warm = () => {
    const t0 = performance.now();
    for (const s of state.strokes || []) {
      if (!s.deleted && !s._cachedPath2D && window.Ink && typeof window.Ink.getPath2D === 'function') {
        s._cachedPath2D = window.Ink.getPath2D(s);
        if (typeof window.Ink.computeStrokeBbox === 'function') {
          s.bbox = window.Ink.computeStrokeBbox(s.points, s.base_width);
        }
        if (performance.now() - t0 > 8) {
          setTimeout(warm, 32);
          return;
        }
      }
    }
  };
  setTimeout(warm, 200);
}

async function openFileTrigger() {
  const invoke = ipc.getInvoke();
  if (invoke) {
    try {
      const res = await ipc.openPdfDialog();
      if (res && res[0]) {
        const pathStr = res[0];
        const r = res[1] || {};
        const title = pathStr.split('\\').pop().split('/').pop();
        handlePdfLoadResult(title, pathStr, r);
        return;
      }
    } catch (e) {
      if (e !== 'CANCELLED' && e !== 'No file selected') {
        console.warn('[inkwell] openPdfDialog failed, falling back to input:', e);
      }
    }
  }
  $('pdfFileInput') && $('pdfFileInput').click();
}

export function friendlyError(e) {
  if (typeof e === 'string') {
    if (/CANCELLED/i.test(e)) return null;
    if (/lock|denied|permission/i.test(e)) return 'File is locked — close it in other apps and retry.';
    if (/No document open|No PDF/i.test(e)) return 'Open a document first.';
    return e;
  }
  return (e && e.message) ? e.message : 'Unexpected error';
}

async function createNewWhiteboard() {
  try {
    const res = await ipc.newWhiteboard();
    if (res) {
      handlePdfLoadResult('Untitled Note', null, res);
      toast.showToast('Created new whiteboard PDF', 'success');
      return;
    }
  } catch (e) {
    const msg = friendlyError(e);
    if (msg) toast.showToast('Failed to create whiteboard: ' + msg, 'error');
  }
  // Immediate client fallback so document layout is active on first render
  handlePdfLoadResult('Untitled Note', null, {
    page_infos: [{ page_index: 0, width_pt: 842.0, height_pt: 595.0, template: 'blank' }],
    loaded_strokes: [],
    loaded_images: [],
    loaded_texts: [],
    outline: [],
  });
}

function prepareAllImagesForSave() {
  const templateImages = (state.pageInfos || [])
    .map((pi, idx) => (pi && pi.template && pi.template !== 'blank') ? templates.renderPageTemplateBackgroundToDataUrl(pi, idx) : null)
    .filter(Boolean);
  const nonDeletedImages = (state.images || []).filter(img => !img.deleted && (!img.id || (!img.id.startsWith('template_bg_') && !img.id.startsWith('img_template_bg_'))));
  return [...templateImages, ...nonDeletedImages];
}

function openInsertPageModal() {
  const modal = $('insertPageModal');
  if (!modal) return;
  const curSheet = _viewport ? _viewport.getActivePageInView(state.drawingPane || 'left') : 0;

  const posSel = $('insertPositionSelect');
  if (posSel) {
    if (posSel.options[0]) posSel.options[0].textContent = `After Current Page (${curSheet + 1})`;
    if (posSel.options[1]) posSel.options[1].textContent = `Before Current Page (${curSheet + 1})`;
    posSel.value = 'after_current';
  }

  const sizeSel = $('insertPaperSizeSelect');
  if (sizeSel) sizeSel.value = 'match_current';
  const customRow = $('customDimRow');
  if (customRow) customRow.classList.add('hidden');

  const portraitRadio = document.querySelector('input[name="pageOrientation"][value="portrait"]');
  if (portraitRadio) portraitRadio.checked = true;

  const templateSel = $('insertTemplateSelect');
  if (templateSel) templateSel.value = 'blank';

  modal.classList.remove('hidden');
}

function closeInsertPageModal() {
  const modal = $('insertPageModal');
  if (modal) modal.classList.add('hidden');
}

function registerCoreCommands() {
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
    execute: async () => {
      try {
        state.isSaving = true;
        toolbar.updateSaveStatusUI('saving');
        const imagesToSave = prepareAllImagesForSave();
        const savedPath = await ipc.savePdf(state.currentDocPath, state.strokes, imagesToSave, state.textObjects);
        if (savedPath) {
          state.currentDocPath = savedPath;
          state.currentDocTitle = savedPath.split(/[\\/]/).pop();
          state.isDirty = false;
          toolbar.updateSaveStatusUI('saved');
          toast.showToast('Document saved successfully', 'success');
          return true;
        }
        return false;
      } catch (e) {
        toolbar.updateSaveStatusUI('dirty');
        const msg = friendlyError(e);
        if (msg && msg !== 'CANCELLED') toast.showToast('Save failed: ' + msg, 'error');
        return false;
      } finally {
        state.isSaving = false;
      }
    },
  });

  reg.register({
    id: 'file.exportPdf',
    title: 'Export As New Copy...',
    category: 'File',
    shortcut: 'Ctrl+Shift+S',
    execute: async () => {
      try {
        state.isSaving = true;
        toolbar.updateSaveStatusUI('saving');
        const imagesToSave = prepareAllImagesForSave();
        await ipc.savePdf(null, state.strokes, imagesToSave, state.textObjects);
        toolbar.updateSaveStatusUI('saved');
        toast.showToast('Document exported successfully', 'success');
      } catch (e) {
        const msg = friendlyError(e);
        if (msg) toast.showToast('Export failed: ' + msg, 'error');
      } finally {
        state.isSaving = false;
      }
    },
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
        : (_viewport ? _viewport.getActivePageInView(state.drawingPane || 'left') : 0);

      let targetPagePt = null;
      if (ctxTarget && ctxTarget.worldPt && _viewport) {
        const pl = _viewport.getPageLayout(activeSheet);
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
      const activeSheet = _viewport ? _viewport.getActivePageInView(state.drawingPane || 'left') : 0;
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
      lassoTool.selectAllOnCurrentPage(_viewport);
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
      const curSheet = state.drawingPane === 'right' ? state.rightSheet : state.leftSheet;
      navigation.goToPage(curSheet + 1, state.drawingPane || 'left', _viewport);
    },
  });

  reg.register({
    id: 'nav.prevPage',
    title: 'Previous Page',
    category: 'Navigation',
    shortcut: ['PageUp', 'ArrowLeft', '['],
    execute: () => {
      const curSheet = state.drawingPane === 'right' ? state.rightSheet : state.leftSheet;
      navigation.goToPage(curSheet - 1, state.drawingPane || 'left', _viewport);
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
    shortcut: 'Ctrl+\\',
    execute: () => {
      if (_viewport) {
        _viewport.toggleSplitMode();
        if (_viewport.splitMode && typeof navigation !== 'undefined' && navigation.fitPageInPanes) {
          navigation.fitPageInPanes(_viewport, compositor.getStageRect(), state.leftSheet || 0, state.rightSheet || 0);
        }
        $('btnRailSplit') && $('btnRailSplit').classList.toggle('active', _viewport.splitMode);
        $('btnZoomSplit') && $('btnZoomSplit').classList.toggle('active', _viewport.splitMode);
        const divider = $('splitDivider');
        if (divider) {
          if (_viewport.splitMode) {
            divider.classList.remove('hidden');
            divider.style.left = `${((_viewport.splitRatio || 0.5) * 100).toFixed(2)}%`;
          } else {
            divider.classList.add('hidden');
          }
        }
        const cluster = $('splitPageNavCluster');
        if (cluster) {
          if (_viewport.splitMode) cluster.classList.remove('hidden');
          else cluster.classList.add('hidden');
        }
        const leftEl = $('leftPanePageNum');
        if (leftEl) leftEl.textContent = `${(state.leftSheet || 0) + 1}`;
        const rightEl = $('rightPanePageNum');
        if (rightEl) rightEl.textContent = `${(state.rightSheet || 0) + 1}`;
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
      if (_viewport) {
        const pane = (_viewport.splitMode && _viewport.activePane) ? _viewport.activePane : 'left';
        const bounds = compositor.paneBounds(pane);
        _viewport.zoomIn([bounds.x + bounds.width / 2, bounds.y + bounds.height / 2], pane);
        if (typeof window.emitZoomChanged === 'function') window.emitZoomChanged(_viewport);
      }
    },
  });

  reg.register({
    id: 'view.zoomOut',
    title: 'Zoom Out',
    category: 'View',
    shortcut: 'Ctrl+-',
    execute: () => {
      if (_viewport) {
        const pane = (_viewport.splitMode && _viewport.activePane) ? _viewport.activePane : 'left';
        const bounds = compositor.paneBounds(pane);
        _viewport.zoomOut([bounds.x + bounds.width / 2, bounds.y + bounds.height / 2], pane);
        if (typeof window.emitZoomChanged === 'function') window.emitZoomChanged(_viewport);
      }
    },
  });

  reg.register({
    id: 'view.fitPage',
    title: 'Fit Page to Window',
    category: 'View',
    shortcut: 'Ctrl+0',
    execute: () => {
      if (_viewport && state.pageInfos && state.pageInfos[0]) {
        const pane = (_viewport.splitMode && _viewport.activePane) ? _viewport.activePane : 'left';
        _viewport.fitPage(state.pageInfos[0].width_pt, state.pageInfos[0].height_pt, pane);
        if (typeof window.emitZoomChanged === 'function') window.emitZoomChanged(_viewport);
      }
    },
  });

  reg.register({
    id: 'view.fitWidth',
    title: 'Fit Width to Window',
    category: 'View',
    shortcut: 'Ctrl+9',
    execute: () => {
      if (_viewport && state.pageInfos && state.pageInfos[0]) {
        const pane = (_viewport.splitMode && _viewport.activePane) ? _viewport.activePane : 'left';
        _viewport.fitWidth(state.pageInfos[0].width_pt, pane);
        if (typeof window.emitZoomChanged === 'function') window.emitZoomChanged(_viewport);
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

// Reading Mode: 'normal' | 'dark' | 'sepia'
function setReadingMode(mode) {
  const validModes = ['normal', 'dark', 'sepia'];
  const effectiveMode = validModes.includes(mode) ? mode : 'normal';
  state.readingMode = effectiveMode;
  try {
    localStorage.setItem('inkwell.readingMode', effectiveMode);
  } catch (_) {}

  const tiles = $('tiles');
  if (tiles) {
    tiles.classList.toggle('reading-mode-dark', effectiveMode === 'dark');
    tiles.classList.toggle('reading-mode-sepia', effectiveMode === 'sepia');
  }

  const select = $('selectReadingMode');
  if (select) select.value = effectiveMode;

  const btnLabel = $('btnMoreReadingModeLabel');
  if (btnLabel) {
    const labelMap = { normal: 'Normal', dark: 'Dark Paper', sepia: 'Sepia Paper' };
    btnLabel.textContent = `Reading Mode: ${labelMap[effectiveMode] || 'Normal'}`;
  }
}

function cycleReadingMode() {
  const current = state.readingMode || 'normal';
  const cycleMap = { normal: 'dark', dark: 'sepia', sepia: 'normal' };
  const next = cycleMap[current] || 'normal';
  setReadingMode(next);
  const labelMap = { normal: 'Normal Paper', dark: 'Dark Paper (Night)', sepia: 'Sepia Paper (Comfort)' };
  toast.showToast(`Reading Mode: ${labelMap[next]}`, 'info');
}

function initReadingMode() {
  let stored = 'normal';
  try {
    stored = localStorage.getItem('inkwell.readingMode') || 'normal';
  } catch (_) {}
  setReadingMode(stored);
}

function renderShortcutsEditor() {
  const tbody = $('shortcutsEditorTableBody');
  if (!tbody) return;

  const allCmds = commandsModule.commands.getAll().filter(cmd => cmd.title);
  allCmds.sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.title.localeCompare(b.title));

  tbody.innerHTML = allCmds.map(cmd => {
    const sc = cmd.shortcut;
    const scDisplay = sc ? (Array.isArray(sc) ? sc.join(', ') : sc) : 'None';
    return `
      <tr>
        <td style="font-weight: 500; font-size: 13px; color: var(--text-main);">${escapeHtml(cmd.title)}</td>
        <td style="color: var(--text-muted); font-size: 11px;">${escapeHtml(cmd.category || 'General')}</td>
        <td style="text-align: right;">
          <button type="button" class="shortcut-recorder-badge" data-cmd-id="${escapeHtml(cmd.id)}" title="Click to rebind shortcut">
            ${escapeHtml(scDisplay)}
          </button>
        </td>
      </tr>
    `;
  }).join('');

  let activeRecordingBtn = null;
  let keydownHandler = null;

  tbody.querySelectorAll('.shortcut-recorder-badge').forEach(badge => {
    badge.addEventListener('click', e => {
      e.stopPropagation();
      const cmdId = badge.getAttribute('data-cmd-id');
      if (!cmdId) return;

      if (activeRecordingBtn) {
        activeRecordingBtn.classList.remove('recording');
        activeRecordingBtn.textContent = activeRecordingBtn._prevText;
        if (keydownHandler) window.removeEventListener('keydown', keydownHandler, true);
      }

      activeRecordingBtn = badge;
      badge._prevText = badge.textContent.trim();
      badge.textContent = 'Press keys...';
      badge.classList.add('recording');

      keydownHandler = ev => {
        ev.preventDefault();
        ev.stopPropagation();

        if (ev.key === 'Escape') {
          badge.classList.remove('recording');
          badge.textContent = badge._prevText;
          window.removeEventListener('keydown', keydownHandler, true);
          activeRecordingBtn = null;
          return;
        }

        if (ev.key === 'Control' || ev.key === 'Alt' || ev.key === 'Shift' || ev.key === 'Meta') {
          return;
        }

        const parts = [];
        if (ev.ctrlKey || ev.metaKey) parts.push('Ctrl');
        if (ev.altKey) parts.push('Alt');
        if (ev.shiftKey) parts.push('Shift');

        let k = ev.key;
        if (k === ' ') k = 'Space';
        else if (k.length === 1) k = k.toUpperCase();
        parts.push(k);

        const chord = parts.join('+');
        commandsModule.commands.setCommandShortcut(cmdId, chord);
        window.removeEventListener('keydown', keydownHandler, true);
        activeRecordingBtn = null;
        renderShortcutsEditor();
        toast.showToast(`Bound "${chord}" to ${commandsModule.commands.get(cmdId)?.title || cmdId}`, 'success');
      };

      window.addEventListener('keydown', keydownHandler, true);
    });
  });
}

function bindAllUIEvents() {
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
        const activeSheet = _viewport ? _viewport.getActivePageInView(state.drawingPane || 'left') : 0;
        let targetPagePt = null;
        if (_viewport) {
          const pl = _viewport.getPageLayout(activeSheet);
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
          const r = await ipc.openPdf(filePath);
          handlePdfLoadResult(file.name, filePath, r);
          return;
        }
        const buf = await file.arrayBuffer();
        const bytes = Array.from(new Uint8Array(buf));
        const r2 = await ipc.openPdfBytes(file.name, bytes);
        handlePdfLoadResult(file.name, null, r2);
      } catch (err) {
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
      if (!isDraggingDivider || !_viewport) return;
      const stageRect = compositor.getStageRect() || { left: 0, width: window.innerWidth };
      const relX = e.clientX - stageRect.left;
      const totalW = stageRect.width || 800;
      const ratio = Math.max(0.2, Math.min(0.8, relX / totalW));
      _viewport.splitRatio = ratio;
      splitDivider.style.left = `${(ratio * 100).toFixed(2)}%`;
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
      if (!_viewport) return;
      _viewport.splitRatio = 0.5;
      splitDivider.style.left = '50%';
      compositor.scheduleRedrawTiles();
      compositor.redrawAll();
    });
  }

  // Navigation buttons
  $('btnNavBack') && $('btnNavBack').addEventListener('click', () => navigation.navBack(_viewport));
  $('btnNavForward') && $('btnNavForward').addEventListener('click', () => navigation.navForward(_viewport));
  $('btnHeaderPrevPage') && $('btnHeaderPrevPage').addEventListener('click', () => commandsModule.commands.execute('nav.prevPage'));
  $('btnHeaderNextPage') && $('btnHeaderNextPage').addEventListener('click', () => commandsModule.commands.execute('nav.nextPage'));
  $('btnPrev') && $('btnPrev').addEventListener('click', () => commandsModule.commands.execute('nav.prevPage'));
  $('btnNext') && $('btnNext').addEventListener('click', () => commandsModule.commands.execute('nav.nextPage'));
  $('btnCanvasPrevPage') && $('btnCanvasPrevPage').addEventListener('click', () => commandsModule.commands.execute('nav.prevPage'));
  $('btnCanvasNextPage') && $('btnCanvasNextPage').addEventListener('click', () => commandsModule.commands.execute('nav.nextPage'));
  $('btnLeftPanePrev') && $('btnLeftPanePrev').addEventListener('click', () => {
    const cur = _viewport ? _viewport.getActivePageInView('left') : 0;
    navigation.goToPage(cur - 1, 'left', _viewport);
  });
  $('btnLeftPaneNext') && $('btnLeftPaneNext').addEventListener('click', () => {
    const cur = _viewport ? _viewport.getActivePageInView('left') : 0;
    navigation.goToPage(cur + 1, 'left', _viewport);
  });
  $('btnRightPanePrev') && $('btnRightPanePrev').addEventListener('click', () => {
    const cur = _viewport ? _viewport.getActivePageInView('right') : 0;
    navigation.goToPage(cur - 1, 'right', _viewport);
  });
  $('btnRightPaneNext') && $('btnRightPaneNext').addEventListener('click', () => {
    const cur = _viewport ? _viewport.getActivePageInView('right') : 0;
    navigation.goToPage(cur + 1, 'right', _viewport);
  });
  $('btnScrollTop') && $('btnScrollTop').addEventListener('click', () => navigation.goToPage(0, 'left', _viewport));

  // Custom Zoom
  const applyCustomZoom = () => {
    const input = $('inputCustomZoom');
    if (!input || !_viewport) return;
    const val = parseFloat(input.value);
    if (!isNaN(val) && val > 0) {
      const targetZoom = Math.max(0.15, Math.min(10.0, val / 100));
      const pane = (_viewport.splitMode && _viewport.activePane) ? _viewport.activePane : 'left';
      const bounds = compositor.paneBounds(pane);
      _viewport.setZoom(targetZoom, [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2], pane);
      if (typeof window.emitZoomChanged === 'function') window.emitZoomChanged(_viewport);
      toolbar.closeZoomMenu();
    }
  };
  $('btnApplyCustomZoom') && $('btnApplyCustomZoom').addEventListener('click', applyCustomZoom);
  $('inputCustomZoom') && $('inputCustomZoom').addEventListener('keydown', e => {
    if (e.key === 'Enter') applyCustomZoom();
  });

  // Autosave delay setting
  const selAutosave = $('selectAutosaveDelay');
  if (selAutosave) {
    selAutosave.value = String(state.autosaveDelayMs || 0);
    selAutosave.addEventListener('change', () => {
      const val = parseInt(selAutosave.value, 10) || 0;
      state.autosaveDelayMs = val;
      localStorage.setItem('inkwell_autosave_delay', String(val));
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
      const curSheet = _viewport ? _viewport.getActivePageInView(state.drawingPane || 'left') : 0;
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
      if (_viewport) _viewport.updateDocumentLayout(state.pageInfos);
      navigation.goToPage(targetIndex, 'left', _viewport);
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
      navigation.goToPage(val - 1, 'left', _viewport);
    }
  });
  $('btnJumpFirstPage') && $('btnJumpFirstPage').addEventListener('click', () => {
    toolbar.closeGoToPageModal();
    navigation.goToPage(0, 'left', _viewport);
  });
  $('btnJumpLastPage') && $('btnJumpLastPage').addEventListener('click', () => {
    toolbar.closeGoToPageModal();
    if (state.pageInfos && state.pageInfos.length) {
      navigation.goToPage(state.pageInfos.length - 1, 'left', _viewport);
    }
  });

  // Clear current page ink
  const clearInk = () => {
    const activeSheet = _viewport ? _viewport.getActivePageInView(state.drawingPane || 'left') : 0;
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

      if (mode === 'highlight') {
        kind = 'highlighter';
        rgb = state.highlighterColor || [0.98, 0.88, 0.15];
        base_width = lineH * 0.95;
        y = (y0 + y1) / 2;
      } else if (mode === 'underline') {
        kind = 'pen';
        rgb = state.penColor || [0.94, 0.27, 0.27];
        base_width = Math.max(1.2, lineH * 0.08);
        y = y1 - 1;
      } else if (mode === 'strikethrough') {
        kind = 'pen';
        rgb = state.penColor || [0.94, 0.27, 0.27];
        base_width = Math.max(1.2, lineH * 0.08);
        y = (y0 + y1) / 2;
      }

      const points = [
        { x: x0, y, p: 0.5 },
        { x: (x0 + x1) / 2, y, p: 0.5 },
        { x: x1, y, p: 0.5 }
      ];

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
          const r = await ipc.openPdf(filePath);
          handlePdfLoadResult(file.name, filePath, r);
          return;
        }
        const buf = await file.arrayBuffer();
        const r2 = await ipc.openPdfBytes(file.name, Array.from(new Uint8Array(buf)));
        handlePdfLoadResult(file.name, null, r2);
      } catch (err) {
        const msg = friendlyError(err);
        if (msg) toast.showToast('Failed to open dropped PDF: ' + msg, 'error');
      }
      return;
    }

    if (file.type && file.type.startsWith('image/')) {
      try {
        const activeSheet = _viewport ? _viewport.getActivePageInView(state.drawingPane || 'left') : 0;
        let targetPagePt = null;
        if (_viewport) {
          const pl = _viewport.getPageLayout(activeSheet);
          if (pl) {
            const [wx, wy] = _viewport.screenToWorld(e.clientX, e.clientY, state.drawingPane || 'left');
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

function updateTextSelectionPopover() {
  const pop = $('textSelectionPopover');
  if (!pop) return;
  const sel = state.textSelection;
  if (sel && sel.text && sel.text.trim() && (state.activeTool === 'textSelect' || state.activeTool === 'textselect') && sel.rects && sel.rects.length > 0) {
    if (_viewport) {
      const pl = _viewport.getPageLayout(sel.sheet);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const r of sel.rects) {
        if (r.rect) {
          if (r.rect[0] < minX) minX = r.rect[0];
          if (r.rect[1] < minY) minY = r.rect[1];
          if (r.rect[2] > maxX) maxX = r.rect[2];
          if (r.rect[3] > maxY) maxY = r.rect[3];
        }
      }
      if (!Number.isFinite(minX)) {
        pop.classList.add('hidden');
        return;
      }
      const midX = (minX + maxX) / 2;
      const pane = state.activePane || state.drawingPane || 'left';
      const [sx, syTop] = _viewport.worldToScreen(pl.x + midX, pl.y + minY, pane);
      const [, syBottom] = _viewport.worldToScreen(pl.x + midX, pl.y + maxY, pane);

      if (syBottom < 30 || syTop > window.innerHeight - 30) {
        pop.classList.add('hidden');
        return;
      }

      const clampedX = Math.max(120, Math.min(window.innerWidth - 120, sx));
      if (syTop > 110) {
        pop.style.left = clampedX + 'px';
        pop.style.top = (syTop - 10) + 'px';
        pop.style.transform = 'translate(-50%, -100%)';
      } else {
        pop.style.left = clampedX + 'px';
        pop.style.top = (syBottom + 10) + 'px';
        pop.style.transform = 'translate(-50%, 0)';
      }
    }
    pop.classList.remove('hidden');
  } else {
    pop.classList.add('hidden');
  }
}

function updateLassoSelectionPopover() {
  const pop = $('lassoSelectionPopover');
  if (!pop) return;
  const hasSelection = (state.selectedStrokes && state.selectedStrokes.some(s => !s.deleted)) ||
                       (state.selectedImages && state.selectedImages.some(img => !img.deleted)) ||
                       (state.selectedTextObjects && state.selectedTextObjects.some(t => !t.deleted));
  if (state.activeTool === 'lasso' && hasSelection && _viewport) {
    const bounds = overlays.getSelectionBounds(state, _viewport);
    if (!bounds || !Number.isFinite(bounds.x0)) {
      pop.classList.add('hidden');
      return;
    }
    const midX = (bounds.x0 + bounds.x1) / 2;
    const pane = state.activePane || state.drawingPane || 'left';
    const [sx, syTop] = _viewport.worldToScreen(midX, bounds.y0, pane);
    const [, syBottom] = _viewport.worldToScreen(midX, bounds.y1, pane);

    if (syBottom < 30 || syTop > window.innerHeight - 30) {
      pop.classList.add('hidden');
      return;
    }

    const clampedX = Math.max(160, Math.min(window.innerWidth - 160, sx));
    if (syTop > 110) {
      pop.style.left = clampedX + 'px';
      pop.style.top = (syTop - 10) + 'px';
      pop.style.transform = 'translate(-50%, -100%)';
    } else {
      pop.style.left = clampedX + 'px';
      pop.style.top = (syBottom + 10) + 'px';
      pop.style.transform = 'translate(-50%, 0)';
    }
    pop.classList.remove('hidden');
  } else {
    pop.classList.add('hidden');
  }
}

function initLassoSelectionPopover() {
  $('btnLassoCopy') && $('btnLassoCopy').addEventListener('click', () => {
    commandsModule.commands.execute('edit.copy');
  });
  $('btnLassoCopySvg') && $('btnLassoCopySvg').addEventListener('click', () => {
    commandsModule.commands.execute('edit.copySvg');
  });
  $('btnLassoDuplicate') && $('btnLassoDuplicate').addEventListener('click', () => {
    commandsModule.commands.execute('edit.duplicate');
  });
  $('btnLassoDelete') && $('btnLassoDelete').addEventListener('click', () => {
    commandsModule.commands.execute('edit.delete');
  });
}

let _panState = {
  isDown: false,
  startClientX: 0,
  startClientY: 0,
  startPanX: 0,
  startPanY: 0,
  pane: 'left',
};

export function cancelPendingTouchStroke() {
  if (typeof penTool.onPenCancel === 'function') {
    penTool.onPenCancel();
  }
  state.isErasing = false;
  state.lassoPath = null;
  state.shapeStart = null;
  state.shapeEnd = null;
  _panState.isDown = false;
  compositor.clearWet();
}
window.cancelPendingTouchStroke = cancelPendingTouchStroke;

function attachPointerHandlers(wetCanvas) {
  if (!wetCanvas) return;

  function localXY(e) {
    const pane = compositor.paneForEvent(e);
    state.activePane = pane;
    state.drawingPane = pane;
    if (_viewport) _viewport.activePane = pane;
    const stageEl = $('stage');
    const r = compositor.getStageRect() || (stageEl ? stageEl.getBoundingClientRect() : wetCanvas.getBoundingClientRect());
    const wx = _viewport.screenToWorld(e.clientX - r.left, e.clientY - r.top, pane);
    return { ptWorld: wx, pane, screenPt: [e.clientX - r.left, e.clientY - r.top] };
  }

  function handleCanvasContextMenu(e) {
    // Never open the canvas object menu over floating UI chrome. Inputs keep
    // their native context menu; everything else in the stage is canvas-owned.
    const uiChrome = e.target && e.target.closest && e.target.closest(
      '#propPopover, #floatingDock, #zoomControl, #zoomMenuPopover, #textSelectionPopover, #lassoSelectionPopover, #inlineTextEditor, #presentationHud, #presentationBlank, #canvasContextMenu, #docScrollbar, .canvas-edge-nav-btn, .floating-scroll-btn, .modal-overlay, .welcome-dropzone'
    );
    if (uiChrome) {
      if (uiChrome.matches && uiChrome.matches('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
      return;
    }
    e.preventDefault();
    if (e.pointerType === 'pen' && (e.button === 2 || e.buttons === 2 || (e.buttons & 2) !== 0)) {
      return;
    }
    const { ptWorld, pane, screenPt } = localXY(e);
    const bounds = overlays.getSelectionBounds(state, _viewport);
    const hasSelection = !!((state.selectedStrokes && state.selectedStrokes.length) ||
                            (state.selectedImages && state.selectedImages.length) ||
                            (state.selectedTextObjects && state.selectedTextObjects.length));

    let isInsideExistingSelection = false;
    if (bounds && hasSelection) {
      const pad = 8;
      if (ptWorld[0] >= bounds.x0 - pad && ptWorld[0] <= bounds.x1 + pad &&
          ptWorld[1] >= bounds.y0 - pad && ptWorld[1] <= bounds.y1 + pad) {
        isInsideExistingSelection = true;
      }
    }

    if (!isInsideExistingSelection) {
      // Check if user right-clicked on an unselected object
      const clicked = lassoTool.findObjectAtWorld(ptWorld[0], ptWorld[1], _viewport);
      if (clicked) {
        toolManager.setTool('lasso', { isUserSwitch: false });
        toolbar.updateToolbarUI();
        if (clicked.type === 'stroke') {
          state.selectedStrokes = [clicked.item];
          state.selectedImages = [];
          state.selectedTextObjects = [];
        } else if (clicked.type === 'image') {
          state.selectedStrokes = [];
          state.selectedImages = [clicked.item];
          state.selectedTextObjects = [];
        } else if (clicked.type === 'text') {
          state.selectedStrokes = [];
          state.selectedImages = [];
          state.selectedTextObjects = [clicked.item];
        }
        emit('selectionChanged', { strokes: state.selectedStrokes, images: state.selectedImages, textObjects: state.selectedTextObjects });
        compositor.clearWet();
        compositor.redrawAll();
      } else {
        // Right-clicked on empty canvas: clear object selection
        if (hasSelection) {
          state.selectedStrokes = [];
          state.selectedImages = [];
          state.selectedTextObjects = [];
          emit('selectionCleared', {});
          compositor.clearWet();
          compositor.redrawAll();
        }
      }
    }

    const pageCoord = _viewport ? _viewport.worldToPage(ptWorld[0], ptWorld[1]) : { sheet: 0 };
    contextMenu.showContextMenu(e.clientX, e.clientY, {
      worldPt: ptWorld,
      screenPt,
      sheet: pageCoord.sheet,
      viewport: _viewport,
    });
  }

  wetCanvas.addEventListener('contextmenu', handleCanvasContextMenu);

  const stage = $('stage');
  if (stage) {
    stage.addEventListener('contextmenu', handleCanvasContextMenu);
  }

  wetCanvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch' && _viewport && (_viewport.isPinching || _viewport.gestureOccurred || (_viewport.activeTouches && _viewport.activeTouches.size >= 2))) {
      cancelPendingTouchStroke();
      e.preventDefault();
      return;
    }
    if (e.pointerType === 'pen') {
      state.isStylusActive = true;
      state.lastStylusTime = Date.now();
    } else if (e.pointerType === 'touch') {
      const isPalm = state.isStylusActive || (Date.now() - (state.lastStylusTime || 0) < 1000);
      if (isPalm) {
        // Touch rejected while stylus is in active handwriting session
        e.preventDefault();
        return;
      }
    }

    const isBarrelButton = (e.pointerType === 'pen' && (e.button === 2 || e.buttons === 2 || (e.buttons & 2) !== 0));
    if (e.button === 2 && !isBarrelButton) {
      // Right-click: do not initiate drawing, erasing, or lasso drag
      return;
    }
    compositor.updateStageRect();
    toolbar.hidePropPopover();
    try { wetCanvas.setPointerCapture(e.pointerId); } catch (_) {}
    const { ptWorld, pane, screenPt } = localXY(e);
    state._lastPointerScreenPt = [e.clientX, e.clientY];
    const tool = state.activeTool || 'pen';

    if (tool !== 'textSelect' && tool !== 'textselect') {
      const pop = $('textSelectionPopover');
      if (pop) pop.classList.add('hidden');
    }

    const isStylusEraser = (e && (e.buttons === 32 || e.button === 5 || isBarrelButton)) ||
      (typeof toolManager.getLiveNativeTool === 'function' && toolManager.getLiveNativeTool() === 'eraser');
    const effectiveTool = isStylusEraser ? 'eraser' : tool;

    if (effectiveTool === 'pan') {
      const isRight = (pane === 'right' && _viewport && _viewport.splitMode);
      _panState = {
        isDown: true,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startPanX: _viewport ? (isRight ? _viewport.rightPanX : _viewport.panX) : 0,
        startPanY: _viewport ? (isRight ? _viewport.rightPanY : _viewport.panY) : 0,
        pane,
      };
    } else if (effectiveTool === 'pen' || effectiveTool === 'highlighter') {
      penTool.onPenDown(e, ptWorld, pane, _viewport);
    } else if (effectiveTool === 'eraser') {
      eraserTool.onEraserDown(e, ptWorld, pane, _viewport);
    } else if (effectiveTool === 'lasso') {
      lassoTool.onLassoDown(e, ptWorld, screenPt, pane, _viewport);
    } else if (effectiveTool === 'rect' || effectiveTool === 'ellipse' || effectiveTool === 'ruler' || effectiveTool === 'line') {
      shapesTool.onShapeDown(e, ptWorld, pane, _viewport);
    } else if (tool === 'laser') {
      laserTool.onLaserDown(e, ptWorld, pane, _viewport);
    } else if (tool === 'text') {
      textTool.onTextToolClick(e, ptWorld, pane, _viewport);
    } else if (tool === 'textSelect' || tool === 'textselect') {
      const pageCoord = _viewport.worldToPage(ptWorld[0], ptWorld[1]);
      const now = Date.now();
      const cachedData = state.pageTextData && state.pageTextData[pageCoord.sheet];

      const performHit = (data) => {
        if (!data) return;
        const hit = textSelection.findCharAndOffsetAtPageCoord(pageCoord.sheet, pageCoord.px, pageCoord.py, { maxDist: 80 });
        if (hit) {
          const prevAnchor = state.textSelectAnchor;
          const isDouble = prevAnchor && (now - prevAnchor.time < 300) && (prevAnchor.sheet === pageCoord.sheet);
          const isTriple = prevAnchor && (now - prevAnchor.time < 600) && prevAnchor.clickCount === 2;
          if (isTriple) {
            state.textSelection = textSelection.expandSelectionToLine(pageCoord.sheet, hit.charIndex);
            state.textSelectAnchor = { sheet: pageCoord.sheet, charIndex: hit.charIndex, startX: e.clientX, startY: e.clientY, time: now, clickCount: 0 };
            state.isSelectingText = false;
            if (state.textSelection) state.selectedTextString = state.textSelection.text;
            compositor.redrawAll();
            updateTextSelectionPopover();
          } else if (isDouble) {
            state.textSelection = textSelection.expandSelectionToWord(pageCoord.sheet, hit.charIndex);
            state.textSelectAnchor = { sheet: pageCoord.sheet, charIndex: hit.charIndex, startX: e.clientX, startY: e.clientY, time: now, clickCount: 2 };
            state.isSelectingText = false;
            if (state.textSelection) state.selectedTextString = state.textSelection.text;
            compositor.redrawAll();
            updateTextSelectionPopover();
          } else {
            // Single click: clear any previous selection so user can unselect
            textSelection.clearTextSelection();
            state.isSelectingText = true;
            state.textSelectAnchor = { sheet: pageCoord.sheet, charIndex: hit.charIndex, startX: e.clientX, startY: e.clientY, time: now, clickCount: 1 };
            state.textSelection = textSelection.computeTextSelectionRanges(pageCoord.sheet, hit.charIndex, hit.charIndex);
            if (state.textSelection) state.selectedTextString = state.textSelection.text;
            compositor.redrawAll();
            const pop = $('textSelectionPopover');
            if (pop) pop.classList.add('hidden');
          }
        } else {
          // Clicked outside text or on blank page margin: clear selection
          textSelection.clearTextSelection();
          state.isSelectingText = false;
          state.textSelectAnchor = null;
          updateTextSelectionPopover();
        }
      };

      if (cachedData) {
        performHit(cachedData);
      } else {
        state.textSelectPending = { sheet: pageCoord.sheet, px: pageCoord.px, py: pageCoord.py, now, isDown: true, clientX: e.clientX, clientY: e.clientY };
        textSelection.ensurePageTextData(pageCoord.sheet).then(data => {
          if (state.textSelectPending && state.textSelectPending.isDown) {
            performHit(data);
          }
          state.textSelectPending = null;
        });
      }
    }  });

  const moveEvt = ('onpointerrawupdate' in window) ? 'pointerrawupdate' : 'pointermove';
  wetCanvas.addEventListener(moveEvt, e => {
    if (e.pointerType === 'touch' && _viewport && (_viewport.isPinching || _viewport.gestureOccurred || (_viewport.activeTouches && _viewport.activeTouches.size >= 2))) {
      cancelPendingTouchStroke();
      return;
    }
    const tool = state.activeTool || 'pen';
    const coalesced = (typeof e.getCoalescedEvents === 'function') ? e.getCoalescedEvents() : null;
    const events = (coalesced && coalesced.length) ? coalesced : [e];

    for (let i = 0; i < events.length; i++) {
      const subEvt = events[i];
      const { ptWorld, pane, screenPt } = localXY(subEvt);

      if (state.isErasing) {
        eraserTool.onEraserMove(subEvt, ptWorld, pane, _viewport);
      } else if (tool === 'pan') {
        if (_panState.isDown && _viewport) {
          const dx = subEvt.clientX - _panState.startClientX;
          const dy = subEvt.clientY - _panState.startClientY;
          _viewport.setPan(_panState.startPanX + dx, _panState.startPanY + dy, _panState.pane);
          if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
            state.spaceDidPan = true;
          }
        }
      } else if (tool === 'pen' || tool === 'highlighter') {
        if (subEvt.buttons === 0) {
          if (state.cur) {
            penTool.onPenUp(subEvt, _viewport);
          }
          continue;
        }
        const isLastInBatch = (i === events.length - 1);
        penTool.onPenMove(subEvt, ptWorld, pane, _viewport, { render: isLastInBatch, rawEvent: e });
      } else if (tool === 'eraser') {
        eraserTool.onEraserMove(subEvt, ptWorld, pane, _viewport);
      } else if (tool === 'lasso') {
        if (state.transformMode || state.lassoPath) {
          lassoTool.onLassoMove(subEvt, ptWorld, screenPt, pane, _viewport);
        } else {
          const handle = overlays.getSelectionHandleAt(screenPt[0], screenPt[1], state, _viewport, pane);
          wetCanvas.style.cursor = handle ? handle.cursor : 'crosshair';
        }
      } else if (tool === 'rect' || tool === 'ellipse' || tool === 'ruler' || tool === 'line') {
        shapesTool.onShapeMove(subEvt, ptWorld, pane, _viewport);
      } else if (tool === 'laser') {
        laserTool.onLaserMove(subEvt, ptWorld, pane, _viewport);
      } else if (tool === 'textSelect' || tool === 'textselect') {
        if (state.isSelectingText && state.textSelectAnchor) {
          const pageCoord = _viewport.worldToPage(ptWorld[0], ptWorld[1]);
          const anchor = state.textSelectAnchor;
          const targetSheet = pageCoord.sheet;
          textSelection.ensurePageTextData(targetSheet).then(() => {
            const hit = textSelection.findCharAndOffsetAtPageCoord(targetSheet, pageCoord.px, pageCoord.py, { maxDist: 48 });
            if (hit) {
              state.textSelection = textSelection.computeTextSelectionRanges(anchor.sheet, anchor.charIndex, hit.charIndex, targetSheet);
              if (state.textSelection) state.selectedTextString = state.textSelection.text;
              compositor.redrawAll();
            }
          });
        } else if (state.textSelectPending && state.textSelectPending.isDown) {
          const pageCoord = _viewport.worldToPage(ptWorld[0], ptWorld[1]);
          state.textSelectPending.px = pageCoord.px;
          state.textSelectPending.py = pageCoord.py;
        }
      }
    }
  });

  wetCanvas.addEventListener('pointerup', e => {
    if (e.pointerType === 'touch' && _viewport && (_viewport.isPinching || _viewport.gestureOccurred || (_viewport.activeTouches && _viewport.activeTouches.size >= 2))) {
      cancelPendingTouchStroke();
      try { wetCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
      return;
    }
    if (e.button === 2) {
      // Right-click release: handled by contextmenu event
      return;
    }
    const tool = state.activeTool || 'pen';

    if (state.isErasing) {
      eraserTool.onEraserUp();
    }
    if (tool === 'pan') {
      _panState.isDown = false;
    } else if (tool === 'pen' || tool === 'highlighter') {
      penTool.onPenUp(e, _viewport);
    } else if (tool === 'eraser') {
      if (!state.isErasing) eraserTool.onEraserUp();
    } else if (tool === 'lasso') {
      lassoTool.onLassoUp(e, _viewport);
      updateLassoSelectionPopover();
    } else if (tool === 'rect' || tool === 'ellipse' || tool === 'ruler' || tool === 'line') {
      shapesTool.onShapeUp(e, _viewport);
    } else if (tool === 'laser') {
      laserTool.onLaserUp();
    } else if (tool === 'textSelect' || tool === 'textselect') {
      if (state.textSelectPending) {
        state.textSelectPending.isDown = false;
      }
      state.isSelectingText = false;
      const anchor = state.textSelectAnchor;
      // If it was a single click without drag (distance < 5px and single character selected):
      if (anchor && anchor.clickCount === 1) {
        const dist = Math.hypot(e.clientX - (anchor.startX || e.clientX), e.clientY - (anchor.startY || e.clientY));
        if (dist < 5 && state.textSelection && state.textSelection.startCharIdx === state.textSelection.endCharIdx) {
          // Pure single click: unselect completely!
          textSelection.clearTextSelection();
        }
      }
      if (state.textSelection && state.textSelection.text && state.textSelection.text.trim()) {
        state.selectedTextString = state.textSelection.text;
        updateTextSelectionPopover();
      } else {
        textSelection.clearTextSelection();
        const pop = $('textSelectionPopover');
        if (pop) pop.classList.add('hidden');
      }
      compositor.redrawAll();
    }
    try { wetCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
  });

  wetCanvas.addEventListener('pointercancel', e => {
    _panState.isDown = false;
    penTool.onPenCancel();
    eraserTool.onEraserUp();
    lassoTool.onLassoUp(e, _viewport);
    laserTool.clearLaser();
    try { wetCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
  });

  window.cancelPendingTouchStroke = () => {
    if (state.cur) {
      penTool.onPenCancel();
    }
  };

  window.addEventListener('pointermove', e => {
    state._lastPointerScreenPt = [e.clientX, e.clientY];
  });

  window.addEventListener('pointerup', e => {
    if (e.pointerType === 'pen') {
      state.isStylusActive = false;
    }
    if (state.cur) {
      penTool.onPenUp(e, _viewport);
    }
    if (_panState.isDown) {
      _panState.isDown = false;
    }
  });

  window.addEventListener('pointercancel', () => {
    state.isStylusActive = false;
    if (state.cur) {
      penTool.onPenCancel();
    }
    _panState.isDown = false;
  });
}

function getFocusableElements(container) {
  if (!container) return [];
  const selector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(container.querySelectorAll(selector)).filter(el => {
    return el.offsetParent !== null || el.getClientRects().length > 0;
  });
}

function initModalFocusTrap() {
  const modalIds = [
    'exportModal',
    'settingsModal',
    'shortcutsModal',
    'goToPageModal',
    'insertPageModal',
    'signatureModal',
    'confirmCloseModal',
  ];

  modalIds.forEach(id => {
    const modal = $(id);
    if (!modal) return;

    // Backdrop click listener closes dialog
    modal.addEventListener('click', e => {
      if (e.target === modal) {
        modal.classList.add('hidden');
      }
    });

    // Tab key trapping within modal container
    modal.addEventListener('keydown', e => {
      if (e.key !== 'Tab') return;
      const focusables = getFocusableElements(modal);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first || !modal.contains(document.activeElement)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last || !modal.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
      }
    });

    // Set initial focus when modal opens
    if (typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver(mutations => {
        for (const m of mutations) {
          if (m.type === 'attributes' && m.attributeName === 'class') {
            if (!modal.classList.contains('hidden')) {
              setTimeout(() => {
                if (!modal.classList.contains('hidden') && !modal.contains(document.activeElement)) {
                  const auto = modal.querySelector('[autofocus]');
                  if (auto && typeof auto.focus === 'function') {
                    auto.focus();
                  } else {
                    const focusables = getFocusableElements(modal);
                    if (focusables.length > 0) focusables[0].focus();
                  }
                }
              }, 10);
            }
          }
        }
      });
      observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
    }
  });
}

function attachKeyboardShortcuts() {
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const openModals = [
        'exportModal',
        'settingsModal',
        'shortcutsModal',
        'goToPageModal',
        'insertPageModal',
        'signatureModal',
        'confirmCloseModal',
        'confirmDeletePageModal',
      ];
      for (const id of openModals) {
        const el = $(id);
        if (el && !el.classList.contains('hidden')) {
          el.classList.add('hidden');
          e.preventDefault();
          return;
        }
      }
      const propPop = $('propPopover');
      if (propPop && !propPop.classList.contains('hidden')) {
        toolbar.hidePropPopover();
        e.preventDefault();
        return;
      }
      const zoomPop = $('zoomMenuPopover');
      if (zoomPop && !zoomPop.classList.contains('hidden')) {
        toolbar.closeZoomMenu();
        e.preventDefault();
        return;
      }

      // Dismiss text selection on Escape
      if (state.textSelection || state.selectedTextString) {
        textSelection.clearTextSelection();
        const pop = $('textSelectionPopover');
        if (pop) pop.classList.add('hidden');
        compositor.redrawAll();
        e.preventDefault();
        return;
      }

      if (state.activeDrawer) {
        drawers.closeDrawer();
        e.preventDefault();
        return;
      }

      if (state.selectedStrokes?.length || state.selectedImages?.length || state.selectedTextObjects?.length) {
        state.selectedStrokes = [];
        state.selectedImages = [];
        state.selectedTextObjects = [];
        state.transformMode = null;
        state.lassoPath = null;
        emit('selectionCleared', {});
        compositor.clearWet();
        compositor.redrawAll();
        e.preventDefault();
        return;
      }
    }

    const isTyping = document.activeElement && (
      document.activeElement.tagName === 'INPUT' ||
      document.activeElement.tagName === 'TEXTAREA' ||
      document.activeElement.isContentEditable
    );
    if (isTyping) return;

    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      toolbar.openSettingsModal();
      return;
    }

    if (e.key === '?' || e.key === 'F1') {
      e.preventDefault();
      $('shortcutsModal') && $('shortcutsModal').classList.remove('hidden');
      return;
    }

    if (e.key === 'q' || e.key === 'Q') {
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const pt = state._lastPointerScreenPt || [window.innerWidth / 2, window.innerHeight / 2];
        radialMenu.showRadialMenu(pt[0], pt[1]);
        return;
      }
    }

    if (e.key === ' ' || e.code === 'Space') {
      toolManager.handleSpaceKeyDown(e);
      return;
    }

    // Spring-loaded modifier keys (e.g. holding 'e', 'm', 'v', 'h')
    if (!e.ctrlKey && !e.altKey && !e.metaKey) {
      toolManager.handleSpringKeyDown(e.key);
    }

    const cmd = commandsModule.commands.findMatchingShortcut(e);
    if (cmd) {
      e.preventDefault();
      commandsModule.commands.execute(cmd.id);
    }
  });

  window.addEventListener('keyup', e => {
    if (e.key === ' ' || e.code === 'Space') {
      toolManager.handleSpaceKeyUp(e);
      return;
    }
    toolManager.handleSpringKeyUp(e.key);
  });

  window.addEventListener('blur', () => {
    toolManager.cancelSpringKeys();
  });

  window.addEventListener('paste', async e => {
    const isTyping = document.activeElement && (
      document.activeElement.tagName === 'INPUT' ||
      document.activeElement.tagName === 'TEXTAREA' ||
      document.activeElement.isContentEditable
    );
    if (isTyping) return;

    const activeSheet = _viewport ? _viewport.getActivePageInView(state.drawingPane || 'left') : 0;
    let targetPagePt = null;
    if (_viewport) {
      const pl = _viewport.getPageLayout(activeSheet);
      if (pl) {
        const [centerWx, centerWy] = _viewport.screenToWorld(window.innerWidth / 2, window.innerHeight / 2, state.drawingPane || 'left');
        targetPagePt = {
          px: Math.max(50, Math.min(pl.width - 50, centerWx - pl.x)),
          py: Math.max(50, Math.min(pl.height - 50, centerWy - pl.y)),
        };
      }
    }

    const handled = await clipboard.handlePasteEvent(e, activeSheet, targetPagePt);
    if (handled) {
      compositor.redrawAll();
      toast.showToast('Pasted from clipboard', 'info');
    }
  });
}

// ---- Application Bootstrap Lifecycle ----

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
    _viewport.attachListeners($('stage'));
  }

  compositor.initCompositor({ tilesCanvas, dryCanvas, wetCanvas, viewport: _viewport });
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

  window.addEventListener('resize', () => compositor.resize());
  window.addEventListener('scroll', () => compositor.updateStageRect(), { passive: true });

  const stageEl = $('stage');
  if (typeof ResizeObserver !== 'undefined' && stageEl) {
    new ResizeObserver(() => compositor.resize()).observe(stageEl);
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
    scrollbar.updateDocScrollbar(_viewport);
  });
  on('activePagesChanged', ({ left, right }) => {
    presentation.updatePresentationHud();
    const leftEl = $('leftPanePageNum');
    if (leftEl) leftEl.textContent = `${(left !== undefined ? left : 0) + 1}`;
    const rightEl = $('rightPanePageNum');
    if (rightEl) rightEl.textContent = `${(right !== undefined ? right : 0) + 1}`;
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
        const r = await ipc.openPdf(initFile);
        const title = initFile.split('\\').pop().split('/').pop();
        handlePdfLoadResult(title, initFile, r);
        return;
      }
    } catch (e) {
      console.warn('[inkwell] Failed to check initial file:', e);
    }
    // Auto-initialize a blank note on startup if no document is loaded
    if (!state.currentDocPath && (!state.pageInfos || state.pageInfos.length === 0)) {
      createNewWhiteboard();
    }
  })();
});
