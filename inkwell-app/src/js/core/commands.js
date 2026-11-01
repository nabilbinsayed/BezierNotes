/* ============================================================================
 * core/commands.js — Central Command Registry & Keybindings Engine for Inkwell
 * Every user-facing action is a named command with stable ID and metadata.
 * ========================================================================== */

class CommandRegistry {
  constructor() {
    this._commands = new Map();
    this._defaultShortcuts = new Map();
    this._keymapOverrides = this.loadCustomKeybindings();
  }

  loadCustomKeybindings() {
    try {
      const stored = localStorage.getItem('inkwell.keymap');
      if (stored) {
        return JSON.parse(stored) || {};
      }
    } catch (e) {
      console.warn('[inkwell/commands] Failed to parse inkwell.keymap:', e);
    }
    return {};
  }

  saveCustomKeybindings() {
    try {
      localStorage.setItem('inkwell.keymap', JSON.stringify(this._keymapOverrides || {}));
    } catch (e) {
      console.warn('[inkwell/commands] Failed to save inkwell.keymap:', e);
    }
  }

  register(command) {
    if (!command || !command.id) {
      throw new Error('[inkwell/commands] Command must have a valid id');
    }
    const defShortcut = command.shortcut || null;
    this._defaultShortcuts.set(command.id, defShortcut);

    let effectiveShortcut = defShortcut;
    if (this._keymapOverrides && Object.prototype.hasOwnProperty.call(this._keymapOverrides, command.id)) {
      effectiveShortcut = this._keymapOverrides[command.id];
    }

    this._commands.set(command.id, {
      id: command.id,
      title: command.title || command.id,
      category: command.category || 'General',
      shortcut: effectiveShortcut,
      defaultShortcut: defShortcut,
      description: command.description || '',
      icon: command.icon || null,
      execute: command.execute || (() => {}),
      canExecute: command.canExecute || (() => true),
    });
  }

  setCommandShortcut(commandId, newShortcut) {
    const targetCmd = this._commands.get(commandId);
    if (!targetCmd) return false;

    const normNew = newShortcut ? normaliseShortcut(newShortcut) : null;

    if (normNew) {
      for (const [id, cmd] of this._commands.entries()) {
        if (id === commandId || !cmd.shortcut) continue;
        if (Array.isArray(cmd.shortcut)) {
          const filtered = cmd.shortcut.filter(s => normaliseShortcut(s) !== normNew);
          if (filtered.length !== cmd.shortcut.length) {
            cmd.shortcut = filtered.length ? filtered : null;
            this._keymapOverrides[id] = cmd.shortcut;
          }
        } else if (normaliseShortcut(cmd.shortcut) === normNew) {
          cmd.shortcut = null;
          this._keymapOverrides[id] = null;
        }
      }
    }

    targetCmd.shortcut = newShortcut || null;
    this._keymapOverrides[commandId] = targetCmd.shortcut;
    this.saveCustomKeybindings();
    return true;
  }

  resetKeybindings() {
    this._keymapOverrides = {};
    try {
      localStorage.removeItem('inkwell.keymap');
    } catch (_) {}

    for (const [id, cmd] of this._commands.entries()) {
      const def = this._defaultShortcuts.get(id) || null;
      cmd.shortcut = def;
    }
  }

  unregister(id) {
    this._commands.delete(id);
  }

  get(id) {
    return this._commands.get(id) || null;
  }

  getAll() {
    return Array.from(this._commands.values());
  }

  execute(id, ...args) {
    const cmd = this._commands.get(id);
    if (!cmd) {
      console.warn(`[inkwell/commands] Unknown command id: "${id}"`);
      return false;
    }
    if (typeof cmd.canExecute === 'function' && !cmd.canExecute()) {
      return false;
    }
    try {
      const res = cmd.execute(...args);
      return res !== undefined ? res : true;
    } catch (err) {
      console.error(`[inkwell/commands] Error executing command "${id}":`, err);
      return false;
    }
  }

  findMatchingShortcut(e) {
    // Normalise keyboard event to standard shortcut string e.g. "Ctrl+S", "Ctrl+Shift+P", "Delete", "P"
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');

    let key = e.key;
    if (key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta') {
      return null;
    }

    if (key === ' ') key = 'Space';
    else if (key.length === 1) key = key.toUpperCase();

    parts.push(key);
    const chord = parts.join('+');

    for (const cmd of this._commands.values()) {
      if (!cmd.shortcut) continue;
      const shortcuts = Array.isArray(cmd.shortcut) ? cmd.shortcut : [cmd.shortcut];
      for (const sc of shortcuts) {
        if (normaliseShortcut(sc) === normaliseShortcut(chord)) {
          return cmd;
        }
      }
    }
    return null;
  }
}

function normaliseShortcut(str) {
  if (!str) return '';
  return str.split('+')
    .map(s => s.trim().toLowerCase())
    .sort()
    .join('+');
}

export const commands = new CommandRegistry();
