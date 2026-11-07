/**
 * The customisable-shortcuts editor in Settings.
 * (Split out of main.js by Plan 093; behaviour unchanged.)
 */

import { $, escapeHtml } from '../core/state.js';
import * as commandsModule from '../core/commands.js';
import * as toast from '../ui/toast.js';

export function renderShortcutsEditor() {
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
