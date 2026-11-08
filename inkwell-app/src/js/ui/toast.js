/* ============================================================================
 * ui/toast.js — Glassmorphic Toast Notification System for Inkwell
 * Displays transient user feedback with auto-dismiss, stack limits, duplicate
 * coalescing, click-to-dismiss, ARIA live regions and a visual life bar.
 * ========================================================================== */

import { $ } from '../core/state.js';

const MAX_VISIBLE = 4;
const DEFAULT_DURATION = 3200;

function ensureContainer() {
  let container = $('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('aria-atomic', 'true');
    container.setAttribute('role', 'region');
    container.setAttribute('aria-label', 'Notifications');
    document.body.appendChild(container);
  }
  return container;
}

function dismissToast(toast, immediate = false) {
  if (!toast || !toast.isConnected) return;
  if (toast._dismissTimer) {
    clearTimeout(toast._dismissTimer);
    toast._dismissTimer = null;
  }
  toast.classList.remove('show');
  toast.classList.add('toast-leaving');
  const remove = () => { if (toast.parentElement) toast.remove(); };
  if (immediate) {
    remove();
    return;
  }
  toast.addEventListener('transitionend', remove, { once: true });
  setTimeout(remove, 320);
}

function armDismiss(toast, duration) {
  if (toast._dismissTimer) clearTimeout(toast._dismissTimer);
  toast._dismissTimer = setTimeout(() => dismissToast(toast), duration);
}

/**
 * @param {string} message
 * @param {'info'|'success'|'warning'|'error'} [type]
 * @param {{actions?: {label: string, onClick: Function}[], duration?: number}} [opts]
 *   actions render as 44 px buttons; clicking one runs it and dismisses the toast.
 */
export function showToast(message, type = 'info', { actions = [], duration = null } = {}) {
  const container = ensureContainer();
  const text = String(message == null ? '' : message);
  if (!text) return null;

  // Coalesce an identical toast that is still on screen instead of stacking
  // three copies of "Colour saved" when the user clicks a few slots quickly.
  const existing = actions.length ? null : Array.from(container.children).find(t => t.dataset.message === text);
  if (existing) {
    existing.classList.remove('toast-leaving');
    existing.classList.add('show');
    armDismiss(existing, DEFAULT_DURATION);
    const bar = existing.querySelector('.toast-life');
    if (bar) {
      bar.style.animation = 'none';
      void bar.offsetWidth;
      bar.style.animation = '';
    }
    return existing;
  }

  // Cap the stack so a burst of feedback never covers the working area.
  while (container.children.length >= MAX_VISIBLE) {
    dismissToast(container.firstElementChild, true);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.dataset.message = text;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.title = 'Click to dismiss';

  const label = document.createElement('span');
  label.className = 'toast-label';
  label.textContent = text;
  const life = document.createElement('span');
  life.className = 'toast-life';
  life.setAttribute('aria-hidden', 'true');
  toast.appendChild(label);
  if (actions.length) {
    const row = document.createElement('span');
    row.className = 'toast-actions';
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-action';
      btn.textContent = a.label;
      btn.addEventListener('click', ev => {
        ev.stopPropagation();
        dismissToast(toast);
        try {
          a.onClick();
        } catch (err) {
          console.warn('[inkwell/toast] action failed:', err);
        }
      });
      row.appendChild(btn);
    }
    toast.appendChild(row);
    toast.title = '';
  }
  toast.appendChild(life);
  container.appendChild(toast);

  toast.addEventListener('click', () => dismissToast(toast));
  toast.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      dismissToast(toast);
    }
  });

  requestAnimationFrame(() => toast.classList.add('show'));
  // A toast that asks for a decision stays long enough to make it.
  armDismiss(toast, duration || (actions.length ? 20000 : DEFAULT_DURATION));
  return toast;
}
