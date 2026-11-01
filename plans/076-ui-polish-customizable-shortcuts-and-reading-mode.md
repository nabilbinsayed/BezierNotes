# Plan 076: UI Polish, Data-Driven Customizable Shortcuts, Dark Reading Mode & Real E2E Verification

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c036ee8..HEAD -- inkwell-app/src/index.html inkwell-app/src/styles.css inkwell-app/src/js/core/commands.js inkwell-app/src/js/tools/tool-manager.js inkwell-app/src/js/ui/toolbar.js inkwell-app/src/js/ui/drawers.js inkwell-app/src/js/main.js inkwell-app/test_app_smoke.py`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: 071, 072, 073, 074, 075
- **Category**: bug | ux | dx | tests
- **Planned at**: commit `c036ee8`, 2026-10-30

## Why this matters

This final wave resolves the remaining UI wiring bugs, fulfills `SPEC.md` Non-Negotiable N5 (customizable keyboard shortcuts and spring-loaded modifiers), adds Dark/Sepia PDF Reading Mode, and hardens the verification suite:
1. **Hardcoded keyboard shortcuts & single-key spring modifier (`[SPEC-01]` & `[SPEC-02]`)**:
   - `SPEC.md` Requirement #3 and Non-Negotiable N5 require user-customizable shortcuts and spring-loaded modifier keys (hold key = temporary tool, release = revert). Currently shortcuts are hardcoded in `main.js`, the Shortcuts table in Settings is static HTML, and `tool-manager.js:304` only supports holding `E` for temporary eraser (not `M` for highlighter, `V` for lasso, or `H` for pan).
2. **Unwired UI controls and modals (`[BUG-UI-03, 04, 06, 08]`, `[DEBT-01, 03]`)**:
   - `Ctrl+F` is advertised in `#btnHeaderFind`'s tooltip (`index.html:348`) but never registered in `main.js`.
   - `toolbar.js:412-413` binds `openGoToPageModal` to both `#btnPageDropdown` and its child `#pageNumDisplay`, firing twice per click.
   - `openGoToPageModal` (`toolbar.js:480-487`) never updates `goToPageInput.max` or `#goToPageTotalDisplay` from `1`.
   - Clicking `.outline-toggle` in the TOC drawer (`drawers.js:555`) returns early without toggling `.collapsed` / `.hidden`.
   - `#btnMoreAddPage` (`index.html:91`) is unwired.
   - `#confirmDeletePageModal` (`index.html:1099`) is unused while `drawers.js:322` calls blocking `window.confirm()`.
3. **No Dark / Sepia Reading Mode for PDF pages (`[DIR-06]`)**:
   - Users reading or annotating white PDFs at night in InkWell's dark UI have no way to invert or warm the PDF page background (`#tiles`) without inverting their colored ink on `#dry`.

## Current state

- `inkwell-app/src/js/ui/toolbar.js:412-413` and `480-487`:
  ```javascript
    $('btnPageDropdown') && $('btnPageDropdown').addEventListener('click', () => openGoToPageModal());
    $('pageNumDisplay') && $('pageNumDisplay').addEventListener('click', () => openGoToPageModal());
  ...
  export function openGoToPageModal() {
    const modal = $('goToPageModal');
    const input = $('goToPageInput');
    if (!modal) return;
    modal.classList.remove('hidden');
    if (input) {
      input.value = String((state.leftSheet || 0) + 1);
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    }
  }
  ```
- `inkwell-app/src/js/ui/drawers.js:554-563`:
  ```javascript
      header.addEventListener('click', e => {
        if (e.target.closest('.outline-toggle')) return;
        const page = parseInt(header.getAttribute('data-page'), 10);
        if (!isNaN(page) && _goToPageCallback) {
          _goToPageCallback(page);
        }
      });
  ```
- `inkwell-app/src/js/tools/tool-manager.js:304-323`:
  ```javascript
  export function handleSpringKeyDown(e) {
    if (e.repeat) return false;
    const key = e.key;
    if (key === 'e' || key === 'E') {
      if (state.activeTool !== 'eraser') {
        state.springKeyHeld = 'e';
        state.springToolBefore = state.activeTool;
        state.springKeyDownTime = Date.now();
        setTool('eraser', { isUserSwitch: false });
        return true;
      }
    }
    return false;
  }
  ```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| App Smoke Tests | `cd inkwell-app && python3 test_app_smoke.py` | exit 0, all checks pass |
| Rust Workspace Tests | `cd inkwell && cargo test --workspace -- --test-threads=1` | exit 0, all tests pass |
| Rust Clippy | `cd inkwell && cargo clippy --all-targets` | exit 0, 0 warnings |

## Scope

**In scope**:
- `inkwell-app/src/index.html`
- `inkwell-app/src/styles.css`
- `inkwell-app/src/js/core/commands.js`
- `inkwell-app/src/js/tools/tool-manager.js`
- `inkwell-app/src/js/ui/toolbar.js`
- `inkwell-app/src/js/ui/drawers.js`
- `inkwell-app/src/js/main.js`
- `inkwell-app/test_app_smoke.py`

**Out of scope**:
- Rust backend crates (`inkwell-core`, `inkwell-pdf`).

## Steps

### Step 1: Fix UI modal/drawer bugs (`Ctrl+F`, `#pageNumDisplay` double-bind, `openGoToPageModal`, `.outline-toggle`, `#confirmDeletePageModal`, `#btnMoreAddPage`)

1. In `inkwell-app/src/js/ui/toolbar.js`:
   - Delete line 413 (`$('pageNumDisplay') && $('pageNumDisplay').addEventListener('click', ...)`).
   - In `openGoToPageModal()` (line 480), set:
     ```javascript
     const total = (state.pageInfos && state.pageInfos.length) ? state.pageInfos.length : 1;
     const totalEl = $('goToPageTotalDisplay');
     if (totalEl) totalEl.textContent = String(total);
     if (input) {
       input.max = String(total);
       input.value = String((state.leftSheet || 0) + 1);
     ```
2. In `inkwell-app/src/js/ui/drawers.js`:
   - In `renderOutlineItems` (around line 554), bind a click listener on `.outline-toggle` that calls `e.stopPropagation()`, toggles `.collapsed` on the `.outline-toggle` button, and toggles `.hidden` on the sibling `.outline-children` container.
   - In `handleDeletePage(pageIdx)` (line 322), replace blocking `window.confirm(...)` with opening `#confirmDeletePageModal` and resolving on `#btnConfirmDeletePageConfirm` / `#btnConfirmDeletePageCancel`.
3. In `inkwell-app/src/js/main.js`:
   - Register command `nav.search` with `shortcut: 'Ctrl+F'` that calls `drawers.openDrawer('search')`.
   - Wire `$('btnMoreAddPage')` to call `openInsertPageModal()`.

**Verify**: `cd inkwell-app && python3 test_app_smoke.py` → exit 0.

### Step 2: Implement customizable keyboard shortcuts (`localStorage` keymap overrides + Settings recorder) and generalized spring-loaded tool keys

1. In `inkwell-app/src/js/core/commands.js`:
   - Add `loadCustomKeybindings()` and `setCommandShortcut(commandId, newShortcut)` backed by `localStorage.getItem('inkwell.keymap')`, with conflict resolution (removing the bound key from any conflicting command) and `resetKeybindings()`.
   - When `register(cmd)` is called, apply any user override from `inkwell.keymap`.
2. In `inkwell-app/src/js/main.js`:
   - In Settings -> Shortcuts tab (`#settingsTabShortcuts`), render an interactive shortcut editor for registered commands where clicking a shortcut badge enters "Press new key..." recording mode (`keydown` captures `Ctrl/Shift/Alt + Key` and calls `commands.setCommandShortcut`), plus a "Reset to Defaults" button.
3. In `inkwell-app/src/js/tools/tool-manager.js` (`handleSpringKeyDown` / `handleSpringKeyUp`, lines 304–335):
   - Generalize spring-loaded keys to support holding `e` (`eraser`), `m` (`highlighter`), `v` (`lasso`), and `h` (`pan`): if held for `>= 220ms` and released, revert to `state.springToolBefore`; if tapped briefly (`< 220ms`), stay on the selected tool.

**Verify**: `cd inkwell-app && python3 test_app_smoke.py` → exit 0.

### Step 3: Add PDF Dark / Sepia Reading Mode toggle on `#tiles` canvas

1. In `inkwell-app/src/styles.css`:
   - Add CSS classes on `#tiles`:
     ```css
     #tiles.reading-mode-dark {
       filter: invert(0.92) hue-rotate(180deg) contrast(1.05);
     }
     #tiles.reading-mode-sepia {
       filter: sepia(0.38) brightness(0.95) contrast(0.96);
     }
     ```
   - Because this filter is applied only to `#tiles` (the base PDF bitmap canvas) and `#dry` no longer uses `mix-blend-mode: multiply` (fixed in Plan 070), vector pen ink and images on `#dry` retain their true colors while stark white PDF pages convert to comfortable dark or sepia paper!
2. In `inkwell-app/src/js/main.js` and `inkwell-app/src/index.html`:
   - Register command `view.cycleReadingMode` (`Normal` -> `Dark Paper` -> `Sepia Paper`, shortcut `Ctrl+Shift+D`), add a toggle item in `#moreOptionsMenu` and Settings -> Appearance, and persist preference in `localStorage.getItem('inkwell.readingMode')`.

**Verify**: `cd inkwell-app && python3 test_app_smoke.py` → exit 0.

## Test plan

- Expand `inkwell-app/test_app_smoke.py` to verify:
  1. `Ctrl+F` opens the Search drawer (`#drawerSearch` visible).
  2. `openGoToPageModal` sets `#goToPageTotalDisplay` and `goToPageInput.max` to `state.pageInfos.length`.
  3. Rebinding a command shortcut via `window.commands.setCommandShortcut` persists to `localStorage` and triggers the command on the new key chord.
  4. Holding a spring key (`m` for highlighter) for `> 250ms` and releasing reverts to `pen`.
  5. `view.cycleReadingMode` applies `.reading-mode-dark` and `.reading-mode-sepia` to `#tiles`.

## Done criteria

- [ ] `cd inkwell && cargo test --workspace -- --test-threads=1` exits 0
- [ ] `cd inkwell && cargo clippy --all-targets` exits 0 with 0 warnings
- [ ] `cd inkwell-app && python3 test_app_smoke.py` exits 0 with all new checks passing
- [ ] `plans/README.md` status row updated to `DONE`

## STOP conditions

- Any existing test in `test_app_smoke.py` fails.
- The code at the locations in "Current state" doesn't match the excerpts.

## Maintenance notes

- All new user-facing actions should be registered via `commands.register({ id, title, category, shortcut, execute })` so they automatically appear in the Command Palette (`Ctrl+K`) and the customizable Shortcuts Settings panel.
