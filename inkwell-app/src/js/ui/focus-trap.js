/**
 * Keyboard focus trapping inside open modals.
 * (Split out of main.js by Plan 093; behaviour unchanged.)
 */

import { $ } from '../core/state.js';

export function getFocusableElements(container) {
  if (!container) return [];
  const selector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(container.querySelectorAll(selector)).filter(el => {
    return el.offsetParent !== null || el.getClientRects().length > 0;
  });
}

export function initModalFocusTrap() {
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
