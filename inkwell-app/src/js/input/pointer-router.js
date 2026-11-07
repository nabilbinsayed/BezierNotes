/**
 * Pointer, pen and touch routing from the wet canvas to the active tool, plus panning.
 * (Split out of main.js by Plan 093; behaviour unchanged.)
 */

import { state, $, on, emit } from '../core/state.js';
import * as compositor from '../render/compositor.js';
import * as overlays from '../render/overlays.js';
import * as toolManager from '../tools/tool-manager.js';
import * as penTool from '../tools/pen.js';
import * as eraserTool from '../tools/eraser.js';
import * as lassoTool from '../tools/lasso.js';
import * as shapesTool from '../tools/shapes.js';
import * as textTool from '../tools/text.js';
import * as laserTool from '../tools/laser.js';
import * as textSelection from '../workspace/text-selection.js';
import * as toolbar from '../ui/toolbar.js';
import * as contextMenu from '../ui/context-menu.js';
import { getViewport } from '../app/viewport-ref.js';
import { updateLassoSelectionPopover, updateTextSelectionPopover } from '../ui/popovers.js';

export let _panState = {
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

export function attachPointerHandlers(wetCanvas) {
  if (!wetCanvas) return;

  function localXY(e) {
    const pane = compositor.paneForEvent(e);
    if (state.activePane !== pane) {
      state.activePane = pane;
      state.drawingPane = pane;
      if (getViewport()) getViewport().activePane = pane;
      emit('activePaneChanged', { pane });
    }
    const stageEl = $('stage');
    const r = compositor.getStageRect() || (stageEl ? stageEl.getBoundingClientRect() : wetCanvas.getBoundingClientRect());
    const wx = getViewport().screenToWorld(e.clientX - r.left, e.clientY - r.top, pane);
    return { ptWorld: wx, pane, screenPt: [e.clientX - r.left, e.clientY - r.top] };
  }

  // Extend an active text selection to the pointer's current character. Kept
  // out of the raw-input loop: this is character-distance scanning + a full
  // redraw, so it belongs on display-aligned pointermove events only.
  function handleTextSelectDrag(ptWorld) {
    if (!getViewport()) return;
    if (state.isSelectingText && state.textSelectAnchor) {
      const pageCoord = getViewport().worldToPage(ptWorld[0], ptWorld[1]);
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
      const pageCoord = getViewport().worldToPage(ptWorld[0], ptWorld[1]);
      state.textSelectPending.px = pageCoord.px;
      state.textSelectPending.py = pageCoord.py;
    }
  }

  function isTextSelectTool() {
    const t = state.activeTool || 'pen';
    return t === 'textSelect' || t === 'textselect';
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
    const bounds = overlays.getSelectionBounds(state, getViewport());
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
      const clicked = lassoTool.findObjectAtWorld(ptWorld[0], ptWorld[1], getViewport());
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

    const pageCoord = getViewport() ? getViewport().worldToPage(ptWorld[0], ptWorld[1]) : { sheet: 0 };
    contextMenu.showContextMenu(e.clientX, e.clientY, {
      worldPt: ptWorld,
      screenPt,
      sheet: pageCoord.sheet,
      viewport: getViewport(),
    });
  }

  wetCanvas.addEventListener('contextmenu', handleCanvasContextMenu);

  const stage = $('stage');
  if (stage) {
    stage.addEventListener('contextmenu', handleCanvasContextMenu);
    stage.addEventListener('pointerdown', e => {
      const pane = compositor.paneForEvent(e);
      state.drawingPane = pane;
      state.activePane = pane;
      if (getViewport()) getViewport().activePane = pane;
      emit('activePaneChanged', { pane });
    });
  }

  wetCanvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch' && getViewport() && (getViewport().isPinching || getViewport().gestureOccurred || (getViewport().activeTouches && getViewport().activeTouches.size >= 2))) {
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
      const isRight = (pane === 'right' && getViewport() && getViewport().splitMode);
      _panState = {
        isDown: true,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startPanX: getViewport() ? (isRight ? getViewport().rightPanX : getViewport().panX) : 0,
        startPanY: getViewport() ? (isRight ? getViewport().rightPanY : getViewport().panY) : 0,
        pane,
      };
    } else if (effectiveTool === 'pen' || effectiveTool === 'highlighter') {
      penTool.onPenDown(e, ptWorld, pane, getViewport());
    } else if (effectiveTool === 'eraser') {
      eraserTool.onEraserDown(e, ptWorld, pane, getViewport());
    } else if (effectiveTool === 'lasso') {
      lassoTool.onLassoDown(e, ptWorld, screenPt, pane, getViewport());
    } else if (effectiveTool === 'rect' || effectiveTool === 'ellipse' || effectiveTool === 'ruler' || effectiveTool === 'line') {
      shapesTool.onShapeDown(e, ptWorld, pane, getViewport());
    } else if (tool === 'laser') {
      laserTool.onLaserDown(e, ptWorld, pane, getViewport());
    } else if (tool === 'text') {
      textTool.onTextToolClick(e, ptWorld, pane, getViewport());
    } else if (tool === 'textSelect' || tool === 'textselect') {
      const pageCoord = getViewport().worldToPage(ptWorld[0], ptWorld[1]);
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
    if (e.pointerType === 'touch' && getViewport() && (getViewport().isPinching || getViewport().gestureOccurred || (getViewport().activeTouches && getViewport().activeTouches.size >= 2))) {
      cancelPendingTouchStroke();
      return;
    }
    const tool = state.activeTool || 'pen';
    // Text selection is display-rate work (character scanning + full redraw):
    // ignore high-frequency raw samples and let the pointermove listener below
    // drive it once per displayed frame.
    if (e.type === 'pointerrawupdate' && (tool === 'textSelect' || tool === 'textselect')) return;
    const coalesced = (typeof e.getCoalescedEvents === 'function') ? e.getCoalescedEvents() : null;
    const events = (coalesced && coalesced.length) ? coalesced : [e];

    for (let i = 0; i < events.length; i++) {
      const subEvt = events[i];
      const { ptWorld, pane, screenPt } = localXY(subEvt);

      if (state.isErasing) {
        eraserTool.onEraserMove(subEvt, ptWorld, pane, getViewport());
      } else if (tool === 'pan') {
        if (_panState.isDown && getViewport()) {
          const dx = subEvt.clientX - _panState.startClientX;
          const dy = subEvt.clientY - _panState.startClientY;
          getViewport().setPan(_panState.startPanX + dx, _panState.startPanY + dy, _panState.pane);
          if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
            state.spaceDidPan = true;
          }
        }
      } else if (tool === 'pen' || tool === 'highlighter') {
        if (subEvt.buttons === 0) {
          if (state.cur) {
            penTool.onPenUp(subEvt, getViewport());
          }
          continue;
        }
        const isLastInBatch = (i === events.length - 1);
        penTool.onPenMove(subEvt, ptWorld, pane, getViewport(), { render: isLastInBatch, rawEvent: e });
      } else if (tool === 'eraser') {
        eraserTool.onEraserMove(subEvt, ptWorld, pane, getViewport());
      } else if (tool === 'lasso') {
        if (state.transformMode || state.lassoPath) {
          lassoTool.onLassoMove(subEvt, ptWorld, screenPt, pane, getViewport());
        } else {
          const handle = overlays.getSelectionHandleAt(screenPt[0], screenPt[1], state, getViewport(), pane);
          wetCanvas.style.cursor = handle ? handle.cursor : 'crosshair';
        }
      } else if (tool === 'rect' || tool === 'ellipse' || tool === 'ruler' || tool === 'line') {
        shapesTool.onShapeMove(subEvt, ptWorld, pane, getViewport());
      } else if (tool === 'laser') {
        laserTool.onLaserMove(subEvt, ptWorld, pane, getViewport());
      } else if (tool === 'textSelect' || tool === 'textselect') {
        handleTextSelectDrag(ptWorld);
      }
    }
  });

  // Display-aligned text-selection drags. `pointerrawupdate` fires far more
  // often than the compositor paints, so text selection runs here instead.
  if (moveEvt === 'pointerrawupdate') {
    wetCanvas.addEventListener('pointermove', e => {
      if (!isTextSelectTool()) return;
      if (e.pointerType === 'touch' && getViewport() && (getViewport().isPinching || getViewport().gestureOccurred || (getViewport().activeTouches && getViewport().activeTouches.size >= 2))) return;
      if (!state.isSelectingText && !(state.textSelectPending && state.textSelectPending.isDown)) return;
      const { ptWorld } = localXY(e);
      handleTextSelectDrag(ptWorld);
    });
  }

  wetCanvas.addEventListener('pointerup', e => {
    if (e.pointerType === 'touch' && getViewport() && (getViewport().isPinching || getViewport().gestureOccurred || (getViewport().activeTouches && getViewport().activeTouches.size >= 2))) {
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
      penTool.onPenUp(e, getViewport());
    } else if (tool === 'eraser') {
      if (!state.isErasing) eraserTool.onEraserUp();
    } else if (tool === 'lasso') {
      lassoTool.onLassoUp(e, getViewport());
      updateLassoSelectionPopover();
    } else if (tool === 'rect' || tool === 'ellipse' || tool === 'ruler' || tool === 'line') {
      shapesTool.onShapeUp(e, getViewport());
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
    lassoTool.onLassoUp(e, getViewport());
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
      penTool.onPenUp(e, getViewport());
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
