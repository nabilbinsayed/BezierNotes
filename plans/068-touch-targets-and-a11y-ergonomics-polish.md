# Plan 068: Touch Targets & A11Y Ergonomics Polish

**Status**: `DONE`  
**Priority**: `P1`  
**Scope**: `inkwell-app/src/styles.css`, `inkwell-app/src/index.html`

## Context & Motivation

CDP runtime inspection discovered interactive controls with effective tap target dimensions below 44x44px and elements lacking accessible labels:
1. **[A11Y-01] Sub-44px Controls**: Compact buttons (thumbnail actions, search execute, bookmarks action, window controls, selection actions, zoom readout, floating scroll button, doc action buttons) lacked hit-expansion pseudo-elements.
2. **[A11Y-02] Missing Accessible Names**: Drawer search input, search submit button, and bookmark triggers lacked explicit `aria-label` definitions.
3. **[UIUX-01] Split View Divider Grip**: Split view dual-pane mode lacked a visual indicator affordance on the divider.

## Changes Made

- **`inkwell-app/src/styles.css`**:
  - Expanded `position: relative` and `::before` pseudo-element hit-expansion (44x44px minimum) to cover `.btn-thumb-act`, `.btn-search-exec`, `.btn-add-bookmark-action`, `.btn-primary-accent`, `.btn-secondary-pill`, `.page-dropdown-btn`, `.win-control-btn`, `.sel-action-btn`, `.zoom-display-btn`, `.floating-scroll-btn`, and `.btn-doc-action`.
  - Added visual center grip pill affordance to `.split-divider::after`.
- **`inkwell-app/src/index.html`**:
  - Added `aria-label="Search document text"` to `#drawerSearchInput`.
  - Added `aria-label="Find search matches"` to `#btnExecuteSearch`.
  - Added `aria-label="Bookmark current page"` to `#btnAddBookmark`.
  - Added descriptive `aria-label`s to `#btnDocInfoExport`, `#btnDocInfoInsertPage`, `#btnDocInfoNewWhiteboard`, and `#btnDocInfoClearInk`.

## Verification

- `cd inkwell-app && py -3 scratch/test_audit_devtools.py`: 0 sub-44px touch target violations, 0 missing accessible names, 0 console errors.
- `cd inkwell-app && py -3 test_app_smoke.py`: 82/82 checks pass.
