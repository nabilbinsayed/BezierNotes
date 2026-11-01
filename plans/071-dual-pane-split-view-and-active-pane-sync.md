# Plan 071: Dual-Pane Split View Architecture, Draggable Divider & Active Pane Synchronization

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c036ee8..HEAD -- inkwell-app/src/index.html inkwell-app/src/styles.css inkwell-app/src/js/viewport.js inkwell-app/src/js/render/compositor.js inkwell-app/src/js/render/overlays.js inkwell-app/src/js/workspace/navigation.js inkwell-app/src/js/workspace/scrollbar.js inkwell-app/src/js/ui/toolbar.js inkwell-app/src/js/ui/drawers.js inkwell-app/src/js/main.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: MED
- **Depends on**: 069
- **Category**: bug | tech-debt
- **Planned at**: commit `c036ee8`, 2026-10-30

## Why this matters

Dual-pane Split View is currently broken across eight separate interaction surfaces:
1. **`view.toggleSplit` bypasses `ViewportManager.toggleSplitMode()`**: `main.js:472` directly flips `_viewport.splitMode = !_viewport.splitMode` without initializing `rightZoom`, `rightPanX`, or `rightPanY` and without fitting both panes (`navigation.fitPageInPanes` is unused dead code).
2. **Missing `.split-divider` DOM element and hardcoded `50%` split**: `.split-divider` is styled in `styles.css:943-954` (and `.split-divider::after` in Plan 068), but no `.split-divider` element exists in `index.html`, and `viewport.js` / `compositor.js` hardcode `width / 2` instead of using a configurable `splitRatio` (`0.2..0.8`).
3. **Desynchronized active pane state (`state.drawingPane` vs `viewport.activePane`)**: `localXY` and tools never update `state.activePane` consistently, and there is no visual highlight showing which pane is active.
4. **Right-pane popovers and selection overlays appear on the left pane**: `updateTextSelectionPopover` (`main.js:962`) and `updateLassoSelectionPopover` (`main.js:1000`) hardcode `'left'` in `_viewport.worldToScreen(...)`, and `compositor.js:297` passes `state.drawingPane || 'left'` (never updated by lasso) to `overlays.drawSelectionOverlay`.
5. **Zoom, fit, and scrollbar actions hardcode `'left'`**: `view.zoomIn`, `view.zoomOut`, `view.fitPage`, `view.fitWidth`, `applyCustomZoom`, toolbar fit buttons, and scrollbar dragging all pass `'left'` instead of `_viewport.activePane || 'left'`.
6. **Split header page numbers permanently stuck at `1` and `2`**: `navigation.js:116` emits `activePagesChanged`, but nothing in `main.js` listens to it to update `#leftPanePageNum` and `#rightPanePageNum`.
7. **`centerDocument` and `fitWidth` jump back to page 1**: `viewport.js:273` resets `targetPanY = 30` instead of preserving the current reading position.
8. **Split button active state desync**: `drawers.js:119` strips `.active` from `#btnRailSplit` whenever any drawer opens, and `#btnZoomSplit` never toggles `.active`.

## Current state

- `inkwell-app/src/js/main.js:466-483`:
  ```javascript
    reg.register({
      id: 'view.toggleSplit',
      title: 'Toggle Split View',
      category: 'View',
      shortcut: 'Ctrl+\\',
      execute: () => {
        if (_viewport) {
          _viewport.splitMode = !_viewport.splitMode;
          $('btnRailSplit') && $('btnRailSplit').classList.toggle('active', _viewport.splitMode);
          const cluster = $('splitPageNavCluster');
          if (cluster) {
            if (_viewport.splitMode) cluster.classList.remove('hidden');
            else cluster.classList.add('hidden');
          }
          compositor.scheduleRedrawTiles();
          compositor.redrawAll();
        }
      },
    });
  ```
- `inkwell-app/src/js/render/compositor.js:76-92`:
  ```javascript
  export function paneBounds(pane) {
    const { width, height } = _stageRect;
    if (!_viewport || !_viewport.splitMode) return { x: 0, y: 0, width, height };
    const half = width / 2;
    return pane === 'right' ? { x: half, y: 0, width: half, height } : { x: 0, y: 0, width: half, height };
  }
  export function visiblePanes() {
    return _viewport && _viewport.splitMode ? ['left', 'right'] : ['left'];
  }
  export function paneForEvent(e) {
    const r = getStageRect();
    return _viewport && _viewport.splitMode && (e.clientX - r.left > r.width / 2) ? 'right' : 'left';
  }
  ```
- `inkwell-app/src/js/ui/drawers.js:118-120`:
  ```javascript
    document.querySelectorAll('.rail-btn').forEach(btn => {
      btn.classList.remove('active');
    });
  ```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| App Smoke Tests | `cd inkwell-app && python3 test_app_smoke.py` | exit 0, all checks pass |
| Rust Workspace Tests | `cd inkwell && cargo test --workspace -- --test-threads=1` | exit 0, all tests pass |

## Scope

**In scope**:
- `inkwell-app/src/index.html`
- `inkwell-app/src/styles.css`
- `inkwell-app/src/js/viewport.js`
- `inkwell-app/src/js/render/compositor.js`
- `inkwell-app/src/js/render/overlays.js`
- `inkwell-app/src/js/workspace/navigation.js`
- `inkwell-app/src/js/workspace/scrollbar.js`
- `inkwell-app/src/js/ui/toolbar.js`
- `inkwell-app/src/js/ui/drawers.js`
- `inkwell-app/src/js/main.js`
- `inkwell-app/test_app_smoke.py`

**Out of scope**:
- Rust backend files (no backend changes required).

## Steps

### Step 1: Add `splitRatio` and pane geometry helpers to `ViewportManager` and preserve vertical scroll in `centerDocument`

1. In `inkwell-app/src/js/viewport.js`:
   - In constructor, add `this.splitRatio = 0.5;` and `this.activePane = 'left';`.
   - Add helper `getPaneBounds(pane = 'left')`:
     ```javascript
     getPaneBounds(pane = 'left') {
       if (!this.stageRect) this.updateStageRect();
       const totalW = this.stageRect ? this.stageRect.width : 800;
       const totalH = this.stageRect ? this.stageRect.height : 600;
       if (!this.splitMode) return { x: 0, y: 0, width: totalW, height: totalH };
       const splitX = Math.round(totalW * this.splitRatio);
       return pane === 'right'
         ? { x: splitX, y: 0, width: Math.max(100, totalW - splitX), height: totalH }
         : { x: 0, y: 0, width: Math.max(100, splitX), height: totalH };
     }
     paneAtScreenX(relX) {
       if (!this.splitMode) return 'left';
       const totalW = this.stageRect ? this.stageRect.width : 800;
       return relX > totalW * this.splitRatio ? 'right' : 'left';
     }
     ```
   - Replace every hardcoded `this.splitMode ? totalW / 2 : totalW` and `relX > stageRect.width / 2` in `viewport.js` (`getVisiblePages`, `toggleSplitMode`, `clampPanX`, `centerDocument`, `fitPage`, `fitWidth`, wheel/gesture/pointer handlers) with `getPaneBounds(pane)` and `paneAtScreenX(relX)`.
   - In `centerDocument(pageWidthPt, pageHeightPt, pane = 'left', preserveY = false)` (line 261), when `preserveY` is true (used by `fitWidth`), keep the current vertical pan (`const curPanY = isRight ? this.rightPanY : this.panY; this.setPan(targetPanX, curPanY, pane);`) instead of jumping back to `targetPanY = 30`.

**Verify**: `cd inkwell-app && python3 test_app_smoke.py` → exit 0.

### Step 2: Add draggable `#splitDivider` to `#stage` in `index.html` and wire `compositor.js`

1. In `inkwell-app/src/index.html`, inside `<div id="stage" class="stage">`, add:
   ```html
   <div id="splitDivider" class="split-divider hidden" role="separator" aria-orientation="vertical" aria-label="Resize split panes" tabindex="0"></div>
   ```
2. In `inkwell-app/src/styles.css` (around line 943), update `.split-divider` so `pointer-events: auto; cursor: col-resize; z-index: 15; width: 10px; transform: translateX(-50%);` with a 44px touch hit expansion `::before`.
3. In `inkwell-app/src/js/render/compositor.js`:
   - Update `paneBounds(pane)` and `paneForEvent(e)` (lines 76–92) to delegate to `_viewport.getPaneBounds(pane)` and `_viewport.paneAtScreenX(e.clientX - r.left)`.
   - In `redrawAll()` (line 297), draw selection overlays for active pane (`state.activePane || state.drawingPane || 'left'`) and clip `drawLaserPointer` in `overlays.js` to the pane.

**Verify**: `cd inkwell-app && python3 test_app_smoke.py` → exit 0.

### Step 3: Wire `view.toggleSplit`, divider drag, active pane routing, popover pane coordinates, and split page indicators

1. In `inkwell-app/src/js/main.js`:
   - In `view.toggleSplit` (lines 470–482), call `_viewport.toggleSplitMode()`, call `navigation.fitPageInPanes(_viewport, compositor.getStageRect(), state.leftSheet || 0, state.rightSheet || 0)`, toggle `.active` on both `$('btnRailSplit')` and `$('btnZoomSplit')`, toggle `.hidden` on `$('splitDivider')` and `$('splitPageNavCluster')`, and update `#leftPanePageNum` / `#rightPanePageNum`.
   - Wire pointer dragging and double-click reset (`splitRatio = 0.5`) on `$('splitDivider')`.
   - Subscribe to `on('activePagesChanged', ({ left, right }) => { ... })` to update `#leftPanePageNum` (`left + 1`) and `#rightPanePageNum` (`right + 1`).
   - In `localXY(e)`, set `state.activePane = pane; state.drawingPane = pane; _viewport.activePane = pane;`.
   - In `updateTextSelectionPopover` (line 962) and `updateLassoSelectionPopover` (line 1000), pass `const pane = state.activePane || state.drawingPane || 'left';` to `_viewport.worldToScreen(..., pane)` instead of hardcoded `'left'`.
   - In `view.zoomIn`, `view.zoomOut`, `view.fitPage`, `view.fitWidth`, and `applyCustomZoom`, pass `const pane = (_viewport.splitMode && _viewport.activePane) ? _viewport.activePane : 'left';` and center of `compositor.paneBounds(pane)`.
2. In `inkwell-app/src/js/ui/toolbar.js` (lines 339, 341) and `inkwell-app/src/js/workspace/scrollbar.js` (line 125), pass `viewport.activePane || 'left'` instead of `'left'`.
3. In `inkwell-app/src/js/ui/drawers.js:119`, change `btn.classList.remove('active')` to `if (btn.id !== 'btnRailSplit') btn.classList.remove('active');`.

**Verify**: `cd inkwell-app && python3 test_app_smoke.py` → exit 0.

## Test plan

- Add a dedicated split-view test section in `inkwell-app/test_app_smoke.py` verifying:
  1. Toggling `view.toggleSplit` makes `#splitDivider` and `#splitPageNavCluster` visible and activates both `#btnRailSplit` and `#btnZoomSplit`.
  2. Opening a drawer while in split mode preserves `.active` on `#btnRailSplit`.
  3. Dragging `#splitDivider` updates `_viewport.splitRatio` and `compositor.paneBounds('left').width`.
  4. Navigating the right pane updates `#rightPanePageNum` via `activePagesChanged`.

## Done criteria

- [ ] `cd inkwell-app && python3 test_app_smoke.py` exits 0 with new split-view checks passing
- [ ] `#splitDivider` exists in `index.html` and is draggable in split mode
- [ ] `grep -n "worldToScreen.*'left'" inkwell-app/src/js/main.js` returns no matches
- [ ] `plans/README.md` status row updated to `DONE`

## STOP conditions

- Any existing smoke test fails after modifying `viewport.js` or `main.js`.
- The code at the locations in "Current state" doesn't match the excerpts.

## Maintenance notes

- Always query `compositor.paneBounds(pane)` or `viewport.getPaneBounds(pane)` rather than dividing stage width by 2.
