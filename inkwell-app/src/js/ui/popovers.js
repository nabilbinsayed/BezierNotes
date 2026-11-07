/**
 * Floating popovers for text selection and lasso selection.
 * (Split out of main.js by Plan 093; behaviour unchanged.)
 */

import { state, $ } from '../core/state.js';
import * as commandsModule from '../core/commands.js';
import * as overlays from '../render/overlays.js';
import { getViewport } from '../app/viewport-ref.js';

export function updateTextSelectionPopover() {
  const pop = $('textSelectionPopover');
  if (!pop) return;
  const sel = state.textSelection;
  if (sel && sel.text && sel.text.trim() && (state.activeTool === 'textSelect' || state.activeTool === 'textselect') && sel.rects && sel.rects.length > 0) {
    if (getViewport()) {
      const pl = getViewport().getPageLayout(sel.sheet);
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
      const [sx, syTop] = getViewport().worldToScreen(pl.x + midX, pl.y + minY, pane);
      const [, syBottom] = getViewport().worldToScreen(pl.x + midX, pl.y + maxY, pane);

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

export function updateLassoSelectionPopover() {
  const pop = $('lassoSelectionPopover');
  if (!pop) return;
  const hasSelection = (state.selectedStrokes && state.selectedStrokes.some(s => !s.deleted)) ||
                       (state.selectedImages && state.selectedImages.some(img => !img.deleted)) ||
                       (state.selectedTextObjects && state.selectedTextObjects.some(t => !t.deleted));
  if (state.activeTool === 'lasso' && hasSelection && getViewport()) {
    const bounds = overlays.getSelectionBounds(state, getViewport());
    if (!bounds || !Number.isFinite(bounds.x0)) {
      pop.classList.add('hidden');
      return;
    }
    const midX = (bounds.x0 + bounds.x1) / 2;
    const pane = state.activePane || state.drawingPane || 'left';
    const [sx, syTop] = getViewport().worldToScreen(midX, bounds.y0, pane);
    const [, syBottom] = getViewport().worldToScreen(midX, bounds.y1, pane);

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

export function initLassoSelectionPopover() {
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
