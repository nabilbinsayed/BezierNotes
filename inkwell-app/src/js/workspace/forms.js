/**
 * Filling the PDF's own form fields (Plan 096).
 *
 * When a document has AcroForm fields, "fill mode" lays DOM controls over the
 * widgets: <input>/<textarea> for text, <select> for choices, toggle buttons
 * for checkboxes and radios. They are created in page and `/Annots` order, so
 * Tab / Shift+Tab follow the form's own order.
 *
 * The page underneath is PDFium's rendering of the last saved file, which
 * already shows saved values. A control is therefore transparent while its
 * value is the rendered one, and opaque (covering the stale rendering) while
 * it holds a value the next save will write. Every change is one undo step
 * and journalled immediately (`set_form_value`).
 */

import { state, $, emit, on } from '../core/state.js';
import * as ipc from '../core/ipc.js';
import * as history from '../core/history.js';
import * as toast from '../ui/toast.js';
import * as compositor from '../render/compositor.js';
import * as tiles from '../render/tiles.js';
import { getViewport } from '../app/viewport-ref.js';

const MIN_TARGET = 44;

let _form = { fields: [], hasScripts: false, xfa: false };
let _values = {};     // name → current value
let _rendered = {};   // name → value the page rendering shows
let _enabled = true;
const _els = [];      // { el, field, widget }

export function formFields() {
  return _form.fields;
}

export function formValue(name) {
  return _values[name];
}

export function isFillMode() {
  return _enabled && _form.fields.length > 0;
}

function layer() {
  let el = $('formLayer');
  if (!el) {
    el = document.createElement('div');
    el.id = 'formLayer';
    el.className = 'form-layer';
    const stage = $('stage');
    if (stage) stage.appendChild(el);
  }
  return el;
}

/** Load the open document's fields (after open, merge or reload). */
export async function loadForm() {
  clearForm();
  if (!ipc.getInvoke()) return null;
  let dto;
  try {
    dto = await ipc.getFormFields();
  } catch (err) {
    console.warn('[inkwell/forms] could not read form fields:', err);
    return null;
  }
  if (!dto || !Array.isArray(dto.fields) || !dto.fields.length) {
    updateChip();
    return dto;
  }
  _form = { fields: dto.fields, hasScripts: !!dto.has_scripts, xfa: !!dto.xfa };
  for (const f of dto.fields) {
    _values[f.name] = f.value;
    _rendered[f.name] = f.rendered_value;
  }
  build();
  updateChip();
  const notes = [];
  if (_form.hasScripts) notes.push("it uses scripts, so calculated fields won't update");
  if (_form.xfa) notes.push('it is an XFA form; its standard fields are fillable');
  toast.showToast(
    `This PDF has a form with ${dto.fields.length} field${dto.fields.length === 1 ? '' : 's'}: click one to fill it` +
      (notes.length ? ` (${notes.join('; ')}).` : '.'),
    'info',
  );
  return dto;
}

export function clearForm() {
  _form = { fields: [], hasScripts: false, xfa: false };
  _values = {};
  _rendered = {};
  for (const { el } of _els) el.remove();
  _els.length = 0;
  updateChip();
}

function isOn(field, value) {
  return !!value && value !== 'Off';
}

function build() {
  const root = layer();
  for (const { el } of _els) el.remove();
  _els.length = 0;
  const widgets = [];
  for (const f of _form.fields) {
    for (const w of f.widgets) widgets.push({ f, w });
  }
  widgets.sort((a, b) => (a.w.page - b.w.page) || (a.w.order - b.w.order));
  for (const { f, w } of widgets) {
    const el = makeControl(f, w);
    el.classList.add('form-field');
    el.dataset.field = f.name;
    root.appendChild(el);
    _els.push({ el, field: f, widget: w });
  }
  refreshAll();
  positionFormOverlays();
}

function makeControl(f, w) {
  if (f.kind === 'checkbox' || f.kind === 'radio') {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', f.kind);
    b.setAttribute('aria-label', f.name);
    b.className = `form-toggle form-${f.kind}`;
    b.disabled = f.read_only;
    b.addEventListener('click', () => {
      if (f.read_only) return;
      const cur = _values[f.name];
      const next = f.kind === 'radio'
        ? (w.on_state || 'On')
        : (isOn(f, cur) ? 'Off' : (w.on_state || 'Yes'));
      if (next !== cur) setValue(f, next);
    });
    return b;
  }
  if (f.kind === 'combo' || f.kind === 'list') {
    const s = document.createElement('select');
    s.setAttribute('aria-label', f.name);
    s.className = 'form-choice';
    s.disabled = f.read_only;
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '';
    s.appendChild(blank);
    for (const [ex, disp] of f.options) {
      const o = document.createElement('option');
      o.value = ex;
      o.textContent = disp;
      s.appendChild(o);
    }
    s.addEventListener('change', () => setValue(f, s.value));
    return s;
  }
  const t = document.createElement(f.multiline ? 'textarea' : 'input');
  if (!f.multiline) t.type = 'text';
  t.className = 'form-text';
  t.setAttribute('aria-label', f.name);
  t.readOnly = f.read_only;
  t.spellcheck = false;
  if (f.max_len) t.maxLength = f.max_len;
  t.style.textAlign = ['left', 'center', 'right'][f.quadding] || 'left';
  if (f.comb && f.max_len) t.classList.add('form-comb');
  let before = null;
  t.addEventListener('focus', () => { before = _values[f.name]; });
  t.addEventListener('input', () => {
    // live: keep every widget of this field in step; one undo step per edit
    _values[f.name] = t.value;
    refreshField(f.name, t);
  });
  t.addEventListener('change', () => {
    const from = before === null ? _rendered[f.name] : before;
    before = t.value;
    commit(f, from, t.value);
  });
  t.addEventListener('keydown', e => {
    if (e.key === 'Escape') t.blur();
    e.stopPropagation();
  });
  return t;
}

function setValue(f, value) {
  const from = _values[f.name];
  _values[f.name] = value;
  commit(f, from, value);
}

/** Record and journal a value change made in the UI. */
function commit(f, from, to) {
  if (from === to) return;
  history.pushTransaction({ type: 'form_value', name: f.name, before: from, after: to });
  applyValue(f.name, to, 'form_value');
}

/** Set a value from undo/redo or the UI: journal it and refresh the controls. */
export function applyValue(name, value, reason = 'form_value') {
  _values[name] = value;
  ipc.setFormValue(name, value).catch(err => {
    console.warn('[inkwell/forms] form value journal error:', err);
    toast.showToast('A form value may not persist: ' + err, 'error');
  });
  refreshField(name);
  state.isDirty = true;
  state.editSeq = (state.editSeq || 0) + 1;
  emit('documentChanged', { type: reason, payload: { name } });
}

function refreshField(name, except = null) {
  for (const it of _els) {
    if (it.field.name === name && it.el !== except) refreshControl(it);
  }
  for (const it of _els) {
    if (it.field.name === name) markPending(it);
  }
}

function refreshAll() {
  for (const it of _els) {
    refreshControl(it);
    markPending(it);
  }
}

function refreshControl({ el, field, widget }) {
  const v = _values[field.name] ?? '';
  if (field.kind === 'checkbox') {
    el.setAttribute('aria-checked', isOn(field, v) && (!widget.on_state || widget.on_state === v || field.widgets.length === 1) ? 'true' : 'false');
  } else if (field.kind === 'radio') {
    el.setAttribute('aria-checked', v && v === widget.on_state ? 'true' : 'false');
  } else if (field.kind === 'combo' || field.kind === 'list') {
    el.value = field.options.some(([ex]) => ex === v) ? v : '';
  } else if (el.value !== v) {
    el.value = v;
  }
}

function markPending({ el, field }) {
  el.classList.toggle('pending', (_values[field.name] ?? '') !== (_rendered[field.name] ?? ''));
}

/** After a save: the page rendering now shows every value. */
export function noteSaved() {
  if (!_form.fields.length) return;
  _rendered = { ..._values };
  if (typeof tiles.clearTileCache === 'function') tiles.clearTileCache();
  compositor.scheduleRedrawTiles();
  // keep pending covers until the new tiles have had a moment to arrive
  setTimeout(refreshAll, 400);
}

/** Follow pan and zoom (called from the viewport's change callback). */
export function positionFormOverlays() {
  const vp = getViewport();
  const root = $('formLayer');
  if (!root) return;
  root.classList.toggle('hidden', !isFillMode() || !vp);
  if (!isFillMode() || !vp) return;
  const pane = 'left';
  const z = vp.zoom;
  for (const { el, field, widget } of _els) {
    const pl = vp.getPageLayout(widget.page);
    if (!pl) {
      el.style.display = 'none';
      continue;
    }
    const [sx, sy] = vp.worldToScreen(pl.x + widget.x, pl.y + widget.y, pane);
    const w = widget.w * z;
    const h = widget.h * z;
    el.style.display = '';
    if (field.kind === 'checkbox' || field.kind === 'radio') {
      // the visible box is the widget; the hit area grows to 44 px
      const hw = Math.max(MIN_TARGET, w);
      const hh = Math.max(MIN_TARGET, h);
      el.style.left = `${sx - (hw - w) / 2}px`;
      el.style.top = `${sy - (hh - h) / 2}px`;
      el.style.width = `${hw}px`;
      el.style.height = `${hh}px`;
      el.style.setProperty('--box', `${Math.max(6, Math.min(w, h))}px`);
    } else {
      el.style.left = `${sx}px`;
      el.style.top = `${sy}px`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      const size = field.font_size > 0 ? field.font_size : Math.min(12, (widget.h - 4) / 1.35);
      el.style.fontSize = `${Math.max(4, size) * z}px`;
      el.style.color = `rgb(${field.color.map(c => Math.round(c * 255)).join(',')})`;
      if (field.comb && field.max_len) el.style.letterSpacing = `${Math.max(0, (w / field.max_len) - size * z * 0.6)}px`;
    }
  }
}

function updateChip() {
  const chip = $('formChip');
  if (!chip) return;
  const n = _form.fields.length;
  chip.classList.toggle('hidden', n === 0);
  const btn = $('btnToggleFormFill');
  if (btn) {
    btn.textContent = _enabled ? `Filling form · ${n} field${n === 1 ? '' : 's'}` : `Form · ${n} field${n === 1 ? '' : 's'} (fill off)`;
    btn.setAttribute('aria-pressed', _enabled ? 'true' : 'false');
  }
}

export function toggleFillMode(force) {
  _enabled = force === undefined ? !_enabled : !!force;
  updateChip();
  positionFormOverlays();
  return _enabled;
}

export function initForms() {
  const btn = $('btnToggleFormFill');
  if (btn) btn.addEventListener('click', () => toggleFillMode());
  on('documentSaved', () => noteSaved());
}
