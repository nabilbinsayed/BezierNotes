/**
 * Dark / sepia / normal PDF reading modes.
 * (Split out of main.js by Plan 093; behaviour unchanged.)
 */

import { state, $ } from '../core/state.js';
import * as tiles from '../render/tiles.js';
import * as toast from '../ui/toast.js';

// Reading Mode: 'normal' | 'dark' | 'sepia'
export function setReadingMode(mode) {
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

export function cycleReadingMode() {
  const current = state.readingMode || 'normal';
  const cycleMap = { normal: 'dark', dark: 'sepia', sepia: 'normal' };
  const next = cycleMap[current] || 'normal';
  setReadingMode(next);
  const labelMap = { normal: 'Normal Paper', dark: 'Dark Paper (Night)', sepia: 'Sepia Paper (Comfort)' };
  toast.showToast(`Reading Mode: ${labelMap[next]}`, 'info');
}

export function initReadingMode() {
  let stored = 'normal';
  try {
    stored = localStorage.getItem('inkwell.readingMode') || 'normal';
  } catch (_) {}
  setReadingMode(stored);
}
