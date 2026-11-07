/**
 * The insert-page dialog.
 * (Split out of main.js by Plan 093; behaviour unchanged.)
 */

import { state, $ } from '../core/state.js';
import { getViewport } from '../app/viewport-ref.js';

export function openInsertPageModal() {
  const modal = $('insertPageModal');
  if (!modal) return;
  const curSheet = getViewport() ? getViewport().getActivePageInView(state.drawingPane || 'left') : 0;

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

export function closeInsertPageModal() {
  const modal = $('insertPageModal');
  if (modal) modal.classList.add('hidden');
}
