# Changelog

All notable changes, generated from commit messages by `scripts/changelog.py`.

## 0.3.0 (unreleased)

### Features

- infinite canvas pages materialised as ordinary PDF pages (Plan 097) (b2a581e)
- fill PDF form fields (text, checkbox, radio, choice) (Plan 096) (0a25c2c)
- parametric vector shapes as native PDF annotations (Plan 095) (35b6c7e)
- **perf:** measured ink latency harness, HUD and CI regression gate (Plan 094) (6769304)
- cloud conflict-copy detection and CRDT union merge (Plan 092) (c841761)
- **core:** sidecar schema 2 with Lamport clocks, device ids, tombstones and page identity (Plan 091) (dea7d03)
- **app:** policy autosave, safe close, Keep mine / Save a copy, non-blocking save (Plan 090) (5f45d21)
- **pdf:** Unicode text notes as shaped vector glyph outlines (Plan 089) (f902f82)
- **pdf:** native xref-stream incremental save and bounded file growth (Plan 088) (eef445c)
- **brand:** adopt official Luxury CAD Technical logo, update app icons and assets (d0fba4c)
- **brand:** rebrand to BezierNotes, relicense under MIT, per-pane split zoom (88600be)
- **perf:** extreme rendering smoothness, O(1) inking, zero-copy tile pipeline & workflows (Plans 078-086) (3a1a92e)
- **app:** implement deep system polish, tool suite, review drawer & signatures (Plans 067-077) (d157929)
- **clipboard:** export lasso selections as lossless SVG vector curves & PNGs (Plan 065) (38da808)
- **ui:** implement visual page thumbnails, actions, reordering & bookmarks (Plan 064) (ca88776)
- **perf:** complete Plan 063 backend tile cache concurrency and memory budget (2f03fd8)
- **pdf:** complete Plan 062 PDF standards and incremental save durability (efd7bf8)
- **state:** complete Plan 061 state and transaction integrity (cc7e581)
- **inking:** complete Plan 060 inking performance and hardware stylus ergonomics (f3ee526)
- **media:** implement Plan 059 lossless media sidecar serialization and annotation isolation (3bf08b7)

### Fixes

- **build_omarchy:** install full icon set (512x512, scalable SVG) and update icon cache (e5fcb71)
- **pdf:** enforce back-to-front annotation layering order so template backgrounds do not occlude ink (c036ee8)
- **launcher:** resolve release and debug binaries across workspace targets (e602c28)

### Refactoring

- split commands.rs and main.js into focused modules (Plan 093) (e5d8b2b)

### Tests

- **pdf:** add Plan 087 conformance harness, property, golden, render-diff and torture tests (6b23687)

### Documentation

- **plans:** add wave 087-098 (format integrity, multi-device merge & v1.0) (35bc1ba)
- reframe project as PDF-first digital notebook & align with file-over-app philosophy (bc4a4b8)

### Maintenance

- **workspace:** unify root cargo workspace, enforce CSP & add Linux CI test suite (Plan 066) (e1348e4)

## 0.2.0

### Features

- release v0.2.0 — image copy-paste, static CRT packaging, and recursive PDFium discovery (12bb51f)
- **inking:** optimize smoothness and responsiveness with live smoothing, prediction, and adaptive stabilization (51381f6)

## 0.1.1

### Features

- **tools:** synchronize tool colors, add R/O/L shortcuts, and fix multi-object copy-paste (d023196)
- CLI file argument opening, frontend error bridge, and tight PDF annotation bboxes (a3f3e8d)

### Fixes

- **packaging:** use valid NSIS language identifier English instead of en-US (cdd1ec9)
- **ci:** use wildcard resource glob and cross-platform pdfium dummies in release workflow (549646e)
- **inking:** overhaul stroke rendering fidelity, fix hollow dots and normal twisting, and bump to v0.1.1 (74c3efd)
- **inking:** restore 1:1 stylus tracking and continuous cubic Bezier curve smoothness (fffb924)
- **text-select:** overhaul text selection dismissal and popover placement, mark touchpad pinch-zoom unsolved (fcc07c1)
- **packaging:** bundle PDFium runtime binaries and configure NSIS installer without .NET dependency (a793b57)
- **viewport:** enforce horizontal pan clamping in zoom and pinch handlers (bfc2181)
- **document:** isolate text layer, selection, and search state on document load (3210afc)
- **backend:** invalidate page dimensions cache on page lifecycle mutations (029225a)
- **wal:** synchronize WAL IPC mutations for image, text, and batch undo/redo events (442eb3c)
- call drawers.renderThumbnails on page insertion to restore thumbnail sync and canvas redraw (fc856d7)
- **pen:** eliminate beaded highlighter in real time and ensure stroke terminates on button release (4a7df6f)
- **render:** fix tile scale for PDF rendering, eliminate ribbon cap bites, standardize highlighter, and update dynamic shapes icon (6f2268b)
- **inking:** restore traceRibbonContour, direct pen point tracking, and lasso deselect on click/Escape (d4eb11a)
- **core:** PDF annotation integrity, undo/redo IPC sync, and durability hardening (Plan 051) (a5b3823)
- **ui:** wire modal actions, focus trapping, and accessibility polish (d57d97b)
- **viewport/render:** clamp viewport pan and tile rasterization scale, add draw epoch validation (Plan 048) (9f130de)

### Performance

- **inking:** streamline inking pipeline, spatial eraser, lasso matrix transforms, and scrollbar reflows (Plan 050) (a0778b5)

### Tests

- **fixtures:** track inkwell/fixtures/lecture.pdf for CI integration tests (bd18cc4)

### Documentation

- **plans:** add plans 052-056 and update implementation plans index (984fa24)
- **plans:** document Wave 1 audit plans 048-051 (0c4fb0b)

### Other

- Fix smoothening: revert over-correction, restore responsive Streamline (0.55→0.92 lerp) (6178dab)

## 0.1.0

### Features

- setup automated cross-platform release pipeline and documentation (a3ef42e)
- complete modular frontend migration, interactive performance wave, and test baseline (cdebad6)
- **stylus:** implement native Linux evdev pressure sensitivity & fix PDF export alignment (a558142)
- **ux:** optimize scrolling, touchpad pinch-zoom, and header controls, deflate PDF file size (2bc7f71)
- centered preferences modal, stroke width fixes, autosave stability and split view optimizations (b1291dc)
- page management suite, note templates, navigation, and audit plans 032-036 (0f034f5)
- complete performance optimization, security hardening, multi-tab sync, and UX ergonomics (Plans 020-026) (8337e2c)
- multi-page continuous scrolling, outline navigation, unified lasso/move tool & image PDF embedding (13fadb9)
- complete UI/UX overhaul, radial menu, chisel highlighter, blank whiteboard notes, and save durability (4ad1c82)
- overhaul UI/UX, page navigation suite, drawers, and export dialog (4cdb538)
- **ui:** Spacebar spring panning, Fit Page, Fullscreen toggle, auto-recenter on sidebar collapse, and adjacent page pre-fetching (2967f7d)
- **ui:** compact icon-only toolbar, floating zoom control, and sidebar collapse fix (38bd780)
- tile grid rendering, split view polish, and codex handoff plan (5af0855)
- add professional README, Lasso Select tool, modern UI controls, PDFium multi-page extraction, and improve skill (bde838f)
- complete T1 (PDFium integration), T2 (Tauri shell wiring), and T3 (vector tools & erasing) (d444f9c)

### Fixes

- **ci:** use pdfium-win-x64.tgz and node 22 for windows runner (df5dab5)
- **pdf/viewport:** fix color channel fidelity and multi-touch pinch zoom (bac2a5b)
- **viewport:** preserve continuous scroll position during drawer transitions and chapter jumps (1154947)
- **ui:** initialize canvas contexts before createTab; stop switchTab clobbering loaded PDF (2efb201)
- **ui:** repair fatal app.js syntax error; restore buttons, PDF load and stability (268bb12)
- **build:** add frontend asset paths to cargo:rerun-if-changed in build.rs to enforce binary re-embedding (9e93aba)
- **ui:** implement centered book-spread layout for dual-pane view and eliminate canvas tile seam artifacts (+0.6px overlap) (be3d397)
- **ui:** re-fit and center pages on sidebar collapse animation frame; replace harsh red border line with dark subtle border (03774ce)
- **js:** resolve syntax error in app.js updateStats closure (8130077)

### Performance

- optimize inking pipeline, tile caching, IPC parameters, and viewport pacing (111e333)

### Documentation

- update banner image in README (e640c9f)
- add Plan 012 for Cline execution (6897684)
- add Work In Progress caution banner to README (02adaa1)

### Maintenance

- ignore test PDF files (db1c3a4)
- save progress, audit plans, and application updates (366b074)

### Other

- Decouple highlighter text snap, track text selection overhaul in Plan 037 (UNFIXED) (aef1b6a)
- linux compatibility added (2ab9852)
- Optimize viewport responsiveness, add clampPanX, and streamline gesture handling (40e9cb4)
- Fix color rendering, page duplication, background PDF export, hand pan, and multi-touch pinch zoom (0db4df8)
- docs & feat: update modern 3-column UI, open PDF header action, welcome dropzone, and plans 018-019 tracking (8fb5c07)
- perf & ui: PDFium tile bitmap caching, zero-copy RGBA, stroke Path2D caching, non-blocking WAL, WCAG 44px touch target polish (96d1ded)
- Fix tile delivery, split view, and ink redraw cost (80d21c6)
- Improve PDF tile handling and ink smoothing (fe56191)
- Initial commit: InkWell architecture, core crate, PDFium crate, and Tauri app (1ab64e0)
