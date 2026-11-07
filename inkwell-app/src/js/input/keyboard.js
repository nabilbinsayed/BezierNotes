/**
 * Global keyboard shortcuts and spring-loaded keys.
 * (Split out of main.js by Plan 093; behaviour unchanged.)
 */

import { state, $, on, emit } from '../core/state.js';
import * as commandsModule from '../core/commands.js';
import * as clipboard from '../core/clipboard.js';
import * as compositor from '../render/compositor.js';
import * as toolManager from '../tools/tool-manager.js';
import * as penTool from '../tools/pen.js';
import * as textSelection from '../workspace/text-selection.js';
import * as toast from '../ui/toast.js';
import * as toolbar from '../ui/toolbar.js';
import * as drawers from '../ui/drawers.js';
import * as radialMenu from '../ui/radial-menu.js';
import { getViewport } from '../app/viewport-ref.js';

export function attachKeyboardShortcuts() {
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
      // Esc before lifting the pen reverts a Hold-to-Snap preview to freehand.
      if (state.holdSnappedShape && penTool.revertHoldSnap) {
        if (penTool.revertHoldSnap(getViewport())) {
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

    const activeSheet = getViewport() ? getViewport().getActivePageInView(state.drawingPane || 'left') : 0;
    let targetPagePt = null;
    if (getViewport()) {
      const pl = getViewport().getPageLayout(activeSheet);
      if (pl) {
        const [centerWx, centerWy] = getViewport().screenToWorld(window.innerWidth / 2, window.innerHeight / 2, state.drawingPane || 'left');
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
