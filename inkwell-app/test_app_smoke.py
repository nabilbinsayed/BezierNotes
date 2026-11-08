"""Smoke test for InkWell production desktop frontend (inkwell-app).
Consolidated verification suite for all interaction, ergonomics, and accessibility requirements:
- T1: Boot & ES Module Loading (triple canvas, stage, Tauri stub)
- T2: Tool Switching & State Machine (9 dock tools + tool history tracking)
- T3: Spacebar Quick-Toggle & Hold-to-Pan (quick tap toggle, hold pan, left-click pan)
- T4: PDF Text Selection, Highlights & Clipboard (drag selection, popover, Ctrl+C, multi-line)
- T5: Canvas Context Menu & Tool Triggering (right-click trigger, actions, click-outside dismissal)
- T6: Radial Tool Menu (.radial-item query selector & tool switching)
- T7: Command Palette (Ctrl+K opening, ArrowDown/ArrowUp navigation, Escape dismissal)
- T8: Touch Target & Accessibility Ergonomics (>=44x44px hit expansion, :focus-visible, toasts ARIA)
- T9: Navigation Rail & Drawer Panels (Thumbnails, Outline, Search, DocInfo, Page Insertion)
- T10: Synthetic Pen Input Pipeline (CDP mouse/pen input, state commit, dry canvas composite)
- T11: Zoom Controls & Percentage Readout
- T12: WAL Undo/Redo IPC Synchronization (Image, Text & Batch Mutations)
- T13: Document Text Layer Isolation & Page Shift Cache
- T14: Console Hygiene (0 errors, 0 internal warnings)
- T17-T22: Annotation review, signatures/stamps, presentation, lazy thumbnails, custom colors, shape routing, settings
"""
import math, pathlib, sys, time
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent
URL = (ROOT / "src" / "index.html").as_uri()
errors, warnings = [], []
results = []

def check(name, cond, note=""):
    results.append(bool(cond))
    status = "PASS" if cond else "FAIL"
    print(f"  [{status}] {name}" + (f"   {note}" if note else ""), flush=True)

with sync_playwright() as pw:
    import shutil
    chrome_bin = shutil.which("chromium") or shutil.which("google-chrome-stable") or shutil.which("chrome")
    launch_opts = {
        "headless": True,
        "args": [
            "--allow-file-access-from-files",
            "--force-device-scale-factor=1",
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage"
        ]
    }
    if chrome_bin:
        launch_opts["executable_path"] = chrome_bin
    b = pw.chromium.launch(**launch_opts)
    ctx = b.new_context(
        viewport={"width": 1360, "height": 860},
        permissions=["clipboard-read", "clipboard-write"]
    )
    pg = ctx.new_page()

    # Enhanced Tauri invoke stub with dynamic tile rendering and rich PDF text layer
    pg.add_init_script("""
    window.__inkwell_stub = {
      render_tile: async (args) => {
        const rect = (args && args.rect) || [0, 0, 256, 256];
        const px = (args && args.px) || 256;
        const rw = Math.max(1.0, rect[2] - rect[0]);
        const rh = Math.max(1.0, rect[3] - rect[1]);
        const baseSpan = (rw <= 512.0 && rh <= 512.0) ? 512.0 : Math.max(rw, rh);
        const scale = px / baseSpan;
        const tileW = Math.round(rw * scale) || 1;
        const tileH = Math.round(rh * scale) || 1;
        const buf = new Array(tileW * tileH * 4);
        for (let y = 0; y < tileH; y++) {
          for (let x = 0; x < tileW; x++) {
            const idx = (y * tileW + x) * 4;
            const isText = (y % 32 < 4) && (x % 24 < 16);
            const val = isText ? 32 : 255;
            buf[idx] = val;
            buf[idx + 1] = val;
            buf[idx + 2] = val;
            buf[idx + 3] = 255;
          }
        }
        return buf;
      },
      get_page_text_data: async (args) => ({
        page_index: (args && args.pageIndex !== undefined) ? args.pageIndex : 0,
        text: 'Hello InkWell\\nSecond Line of PDF Text',
        lines: [
          {
            line_index: 0,
            rect: [50, 50, 200, 70],
            text: 'Hello InkWell',
            chars: [
              { c: 'H', char_index: 0, line_index: 0, rect: [50, 50, 62, 70] },
              { c: 'e', char_index: 1, line_index: 0, rect: [62, 50, 74, 70] },
              { c: 'l', char_index: 2, line_index: 0, rect: [74, 50, 80, 70] },
              { c: 'l', char_index: 3, line_index: 0, rect: [80, 50, 86, 70] },
              { c: 'o', char_index: 4, line_index: 0, rect: [86, 50, 98, 70] },
              { c: ' ', char_index: 5, line_index: 0, rect: [98, 50, 104, 70] },
              { c: 'I', char_index: 6, line_index: 0, rect: [104, 50, 110, 70] },
              { c: 'n', char_index: 7, line_index: 0, rect: [110, 50, 122, 70] },
              { c: 'k', char_index: 8, line_index: 0, rect: [122, 50, 134, 70] },
              { c: 'W', char_index: 9, line_index: 0, rect: [134, 50, 150, 70] },
              { c: 'e', char_index: 10, line_index: 0, rect: [150, 50, 162, 70] },
              { c: 'l', char_index: 11, line_index: 0, rect: [162, 50, 168, 70] },
              { c: 'l', char_index: 12, line_index: 0, rect: [168, 50, 174, 70] }
            ]
          },
          {
            line_index: 1,
            rect: [50, 80, 250, 100],
            text: 'Second Line of PDF Text',
            chars: [
              { c: 'S', char_index: 14, line_index: 1, rect: [50, 80, 62, 100] },
              { c: 'e', char_index: 15, line_index: 1, rect: [62, 80, 74, 100] },
              { c: 'c', char_index: 16, line_index: 1, rect: [74, 80, 86, 100] },
              { c: 'o', char_index: 17, line_index: 1, rect: [86, 80, 98, 100] },
              { c: 'n', char_index: 18, line_index: 1, rect: [98, 80, 110, 100] },
              { c: 'd', char_index: 19, line_index: 1, rect: [110, 80, 122, 100] }
            ]
          }
        ],
        chars: [
          { c: 'H', char_index: 0, line_index: 0, rect: [50, 50, 62, 70] },
          { c: 'e', char_index: 1, line_index: 0, rect: [62, 50, 74, 70] },
          { c: 'l', char_index: 2, line_index: 0, rect: [74, 50, 80, 70] },
          { c: 'l', char_index: 3, line_index: 0, rect: [80, 50, 86, 70] },
          { c: 'o', char_index: 4, line_index: 0, rect: [86, 50, 98, 70] },
          { c: ' ', char_index: 5, line_index: 0, rect: [98, 50, 104, 70] },
          { c: 'I', char_index: 6, line_index: 0, rect: [104, 50, 110, 70] },
          { c: 'n', char_index: 7, line_index: 0, rect: [110, 50, 122, 70] },
          { c: 'k', char_index: 8, line_index: 0, rect: [122, 50, 134, 70] },
          { c: 'W', char_index: 9, line_index: 0, rect: [134, 50, 150, 70] },
          { c: 'e', char_index: 10, line_index: 0, rect: [150, 50, 162, 70] },
          { c: 'l', char_index: 11, line_index: 0, rect: [162, 50, 168, 70] },
          { c: 'l', char_index: 12, line_index: 0, rect: [168, 50, 174, 70] },
          { c: 'S', char_index: 14, line_index: 1, rect: [50, 80, 62, 100] },
          { c: 'e', char_index: 15, line_index: 1, rect: [62, 80, 74, 100] },
          { c: 'c', char_index: 16, line_index: 1, rect: [74, 80, 86, 100] },
          { c: 'o', char_index: 17, line_index: 1, rect: [86, 80, 98, 100] },
          { c: 'n', char_index: 18, line_index: 1, rect: [98, 80, 110, 100] },
          { c: 'd', char_index: 19, line_index: 1, rect: [110, 80, 122, 100] }
        ],
        spans: []
      }),
      commit_stroke: async (args) => (args && args.clientId) ? String(args.clientId) : 's_stub_123',
      delete_stroke: async (args) => true,
      open_pdf: async (args) => ({
        page_infos: [
          { page_index: 0, width_pt: 595.0, height_pt: 842.0 },
          { page_index: 1, width_pt: 595.0, height_pt: 842.0 }
        ],
        outline: []
      }),
      create_blank_document: async (args) => ({
        page_infos: [
          { page_index: 0, width_pt: 595.0, height_pt: 842.0 },
          { page_index: 1, width_pt: 595.0, height_pt: 842.0 }
        ],
        outline: []
      }),
      search_pdf: async (args) => [],
      render_raster: async () => new Array(64 * 64 * 4).fill(255),
      get_document_outline: async () => [],
      insert_blank_page: async (args) => true,
      journal_image_mutation: async (args) => {
        window.__walImageMutations = window.__walImageMutations || [];
        window.__walImageMutations.push(args);
        return true;
      },
      journal_text_mutation: async (args) => {
        window.__walTextMutations = window.__walTextMutations || [];
        window.__walTextMutations.push(args);
        return true;
      },
      wal_flush: async () => true,
    };
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => {
        if (window.__inkwell_stub && typeof window.__inkwell_stub[cmd] === 'function') {
          return await window.__inkwell_stub[cmd](args);
        }
        return null;
      }
    };
    window.__TAURI__ = {
      core: { invoke: window.__TAURI_INTERNALS__.invoke }
    };
    """)

    pg.on("console", lambda m: (errors if m.type == "error" else
                                warnings if m.type == "warning" else []).append(m.text))
    pg.on("pageerror", lambda e: errors.append(str(e)))

    # -------------------------------------------------------------
    # T1: Boot & ES Module Loading
    # -------------------------------------------------------------
    print("\n=== T1  Boot & ES Module Loading ===", flush=True)
    pg.goto(URL)
    pg.wait_for_timeout(500)

    check("page loads with no JS errors", not errors, str(errors[:2]))
    check("triple canvases initialized",
          pg.evaluate("!!(document.getElementById('tiles') && document.getElementById('dry') && document.getElementById('wet'))"))
    check("stage element mounted",
          pg.evaluate("document.getElementById('stage').clientWidth > 400"))
    check("Tauri invoke stub connected",
          pg.evaluate("!!(window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function')"))

    # Initialize a new whiteboard document if welcome overlay is active
    welcome_btn = pg.locator("#btnWelcomeNewNote")
    if welcome_btn.count() > 0 and welcome_btn.is_visible():
        welcome_btn.click()
        pg.wait_for_timeout(300)

    # -------------------------------------------------------------
    # T2: Tool Switching & State Machine
    # -------------------------------------------------------------
    print("\n=== T2  Tool Switching & State Machine ===", flush=True)
    tool_buttons = [
        ('btnDockPen', 'pen'),
        ('btnDockHighlighter', 'highlighter'),
        ('btnDockEraser', 'eraser'),
        ('btnDockLasso', 'lasso'),
        ('btnDockTextSelect', 'textSelect'),
        ('btnDockShapes', 'rect'),
        ('btnDockText', 'text'),
        ('btnDockLaser', 'laser'),
        ('btnDockPan', 'pan'),
    ]
    tool_switch_ok = True
    for btn_id, expected_tool in tool_buttons:
        btn = pg.locator(f"#{btn_id}")
        if btn.count() != 1:
            tool_switch_ok = False
            check(f"dock button #{btn_id} exists", False, f"found count={btn.count()}")
            continue
        btn.click(force=True)
        pg.wait_for_timeout(40)
        active = pg.evaluate("window.state.activeTool")
        has_active_cls = pg.evaluate(f"document.getElementById('{btn_id}').classList.contains('active')")
        if str(active).lower() != expected_tool.lower() or not has_active_cls:
            tool_switch_ok = False
            check(f"tool switch to {expected_tool}", False, f"actual={active}, hasClass={has_active_cls}")
    if tool_switch_ok:
        check("all 9 dock tools toggle with correct state machine mapping and active CSS class", True)

    # Tool history tracking verification
    pg.evaluate("window.toolManager.setTool('pen')")
    pen_cursor = pg.evaluate("window.getComputedStyle(document.getElementById('wet')).cursor")
    check("getComputedStyle(#wet.tool-pen).cursor contains 8 8", "8 8" in pen_cursor or "8px 8px" in pen_cursor, f"cursor={pen_cursor}")

    pg.evaluate("window.toolManager.setTool('highlighter')")
    last_act_1 = pg.evaluate("window.state.lastActiveTool")
    check("tool history tracks pen as lastActiveTool after switching to highlighter", last_act_1 == "pen", f"actual={last_act_1}")

    pg.evaluate("window.toolManager.setTool('eraser')")
    last_act_2 = pg.evaluate("window.state.lastActiveTool")
    check("tool history tracks highlighter as lastActiveTool after switching to eraser", last_act_2 == "highlighter", f"actual={last_act_2}")

    # -------------------------------------------------------------
    # T3: Spacebar Quick-Toggle & Hold-to-Pan
    # -------------------------------------------------------------
    print("\n=== T3  Spacebar Quick-Toggle & Hold-to-Pan ===", flush=True)
    # 1. Quick tap (<250ms) toggles between current tool (eraser) and last active tool (highlighter)
    pg.keyboard.down("Space")
    tool_during_space = pg.evaluate("window.state.activeTool")
    check("pressing Space engages pan mode", tool_during_space == "pan", f"tool={tool_during_space}")
    pg.wait_for_timeout(50)
    pg.keyboard.up("Space")
    pg.wait_for_timeout(50)
    tool_after_tap = pg.evaluate("window.state.activeTool")
    check("quick-tap Space (<250ms) toggles to last active tool (highlighter)", tool_after_tap == "highlighter", f"tool={tool_after_tap}")

    # Second quick tap toggles back to eraser
    pg.keyboard.down("Space")
    pg.wait_for_timeout(50)
    pg.keyboard.up("Space")
    pg.wait_for_timeout(50)
    tool_after_second_tap = pg.evaluate("window.state.activeTool")
    check("second quick-tap Space toggles back to previous tool (eraser)", tool_after_second_tap == "eraser", f"tool={tool_after_second_tap}")

    # 2. Hold Space (>=250ms) and pan canvas
    box = pg.locator("#wet").bounding_box()
    cx, cy = box["x"] + 300, box["y"] + 300
    init_pan_x = pg.evaluate("window.getViewport().panX")

    pg.keyboard.down("Space")
    pg.wait_for_timeout(100)
    pg.mouse.move(cx, cy)
    pg.mouse.down()
    pg.mouse.move(cx - 100, cy)
    pg.mouse.up()
    pg.wait_for_timeout(100)
    panned_pan_x = pg.evaluate("window.getViewport().panX")
    check("dragging during Space hold updates viewport pan coordinates", panned_pan_x != init_pan_x, f"init={init_pan_x} panned={panned_pan_x}")

    pg.keyboard.up("Space")
    pg.wait_for_timeout(50)
    tool_after_hold_pan = pg.evaluate("window.state.activeTool")
    check("releasing Space after pan reverts tool to eraser", tool_after_hold_pan == "eraser", f"tool={tool_after_hold_pan}")

    # 3. Left-click drag in Pan mode updates viewport pan
    pg.evaluate("window.toolManager.setTool('pan')")
    cur_pan_x = pg.evaluate("window.getViewport().panX")
    pg.mouse.move(cx, cy)
    pg.mouse.down()
    pg.mouse.move(cx + 80, cy)
    pg.mouse.up()
    pg.wait_for_timeout(50)
    moved_pan_x = pg.evaluate("window.getViewport().panX")
    check("left-click canvas drag in Pan mode updates viewport pan", moved_pan_x != cur_pan_x, f"cur={cur_pan_x} moved={moved_pan_x}")

    # -------------------------------------------------------------
    # T4: PDF Text Selection, Highlights & Clipboard
    # -------------------------------------------------------------
    print("\n=== T4  PDF Text Selection, Highlights & Clipboard ===", flush=True)
    pg.locator("#btnDockTextSelect").click(force=True)
    pg.wait_for_timeout(50)
    check("textSelect tool is active", pg.evaluate("window.state.activeTool === 'textSelect'"))

    # Preload page text data in state
    pg.evaluate("import('./js/workspace/text-selection.js').then(ts => ts.ensurePageTextData(0))")
    pg.wait_for_timeout(100)

    # Compute screen coordinates for text on page 0 and drag select
    screen_pt = pg.evaluate("""
    (() => {
      const vp = window.getViewport();
      const pl = vp.getPageLayout(0);
      const s0 = vp.worldToScreen(pl.x + 55, pl.y + 60, 'left');
      const s1 = vp.worldToScreen(pl.x + 160, pl.y + 60, 'left');
      const stageRect = document.getElementById('wet').getBoundingClientRect();
      return {
        x0: stageRect.left + s0[0],
        y0: stageRect.top + s0[1],
        x1: stageRect.left + s1[0],
        y1: stageRect.top + s1[1]
      };
    })()
    """)
    pg.mouse.move(screen_pt["x0"], screen_pt["y0"])
    pg.mouse.down()
    pg.wait_for_timeout(50)
    pg.mouse.move(screen_pt["x1"], screen_pt["y1"])
    pg.wait_for_timeout(50)
    pg.mouse.up()
    pg.wait_for_timeout(100)

    has_sel = pg.evaluate("!!(window.state.textSelection && window.state.selectedTextString)")
    drag_text = pg.evaluate("window.state.selectedTextString || ''")
    check("canvas drag selection creates selection range and rects", has_sel and len(drag_text) > 0, f"text='{drag_text}'")

    pop_visible = pg.evaluate("!document.getElementById('textSelectionPopover').classList.contains('hidden')")
    check("selection popover appears with Copy button", pop_visible and pg.locator("#btnTextCopy").count() == 1)

    # Copy via Ctrl+C shortcut
    pg.keyboard.press("Control+c")
    pg.wait_for_timeout(100)
    copied = pg.evaluate("navigator.clipboard.readText()")
    check("Ctrl+C / clipboard copy copies selected text accurately", copied == drag_text and len(copied) > 0, f"copied='{copied}'")

    # Multi-line character indexing is respected across line breaks
    pg.evaluate("""
    import('./js/workspace/text-selection.js').then(async ts => {
      await ts.ensurePageTextData(0);
      const sel = ts.computeTextSelectionRanges(0, 0, 16);
      window.state.textSelection = sel;
      window.state.selectedTextString = sel ? sel.text : '';
    })
    """)
    pg.wait_for_timeout(100)
    sel_text = pg.evaluate("window.state.selectedTextString")
    check("multi-line character indexing is respected across line breaks",
          "Hello InkWell" in sel_text and "Sec" in sel_text, f"selected='{sel_text}'")

    # Word expansion boundary checking (multi-line isolation)
    word_expand_res = pg.evaluate("""
    import('./js/workspace/text-selection.js').then(async ts => {
      await ts.ensurePageTextData(0);
      const w0 = ts.expandSelectionToWord(0, 0);
      const w1 = ts.expandSelectionToWord(0, 8);
      const w2 = ts.expandSelectionToWord(0, 14);
      return {
        w0: w0 ? w0.text : '',
        w1: w1 ? w1.text : '',
        w2: w2 ? w2.text : ''
      };
    })
    """)
    check("expandSelectionToWord isolates word boundaries without bleeding across lines",
          word_expand_res["w0"] == "Hello" and word_expand_res["w1"] == "InkWell" and word_expand_res["w2"] == "Second",
          f"w0='{word_expand_res.get('w0')}', w1='{word_expand_res.get('w1')}', w2='{word_expand_res.get('w2')}'")

    # T4.1: Escape key dismisses text selection and closes popover
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(50)
    esc_cleared = pg.evaluate("!window.state.textSelection && !window.state.selectedTextString && document.getElementById('textSelectionPopover').classList.contains('hidden')")
    check("Escape key dismisses text selection and closes popover", esc_cleared)

    # T4.2: Single click without drag does not leave a single-character selection trapped
    pg.mouse.move(screen_pt["x0"], screen_pt["y0"])
    pg.mouse.click(screen_pt["x0"], screen_pt["y0"])
    pg.wait_for_timeout(50)
    click_not_trapped = pg.evaluate("!window.state.textSelection && document.getElementById('textSelectionPopover').classList.contains('hidden')")
    check("single click deselects and does not leave trapped character selection", click_not_trapped)

    # T4.3: Switching tools away from textSelect clears selection and hides popover
    pg.mouse.move(screen_pt["x0"], screen_pt["y0"])
    pg.mouse.down()
    pg.mouse.move(screen_pt["x1"], screen_pt["y1"])
    pg.mouse.up()
    pg.wait_for_timeout(50)
    pg.locator("#btnDockPen").click()
    pg.wait_for_timeout(50)
    tool_switch_cleared = pg.evaluate("window.state.activeTool === 'pen' && !window.state.textSelection && document.getElementById('textSelectionPopover').classList.contains('hidden')")
    check("switching tool away from textSelect clears selection and hides popover", tool_switch_cleared)
    pg.locator("#btnDockTextSelect").click()
    pg.wait_for_timeout(50)

    # -------------------------------------------------------------
    # T4.4: Plan 073 Precision Text Selection & Markup Annotations
    # -------------------------------------------------------------
    # 1. Clicking outside margin returns null without false-snapping
    margin_hit = pg.evaluate("""
    import('./js/workspace/text-selection.js').then(async ts => {
      await ts.ensurePageTextData(0);
      const hitRight = ts.findCharAndOffsetAtPageCoord(0, 350, 60);
      const hitBelow = ts.findCharAndOffsetAtPageCoord(0, 100, 150);
      return { hitRight, hitBelow };
    })
    """)
    check("margin click outside text bounds returns null without false-snapping",
          margin_hit["hitRight"] is None and margin_hit["hitBelow"] is None,
          f"res={margin_hit}")

    # 2. Cross-page selection ranges spanning sheet 0 and sheet 1
    cross_page_sel = pg.evaluate("""
    import('./js/workspace/text-selection.js').then(async ts => {
      await ts.ensurePageTextData(0);
      await ts.ensurePageTextData(1);
      const sel = ts.computeTextSelectionRanges(0, 0, 5, 1);
      return {
        hasText: !!(sel && sel.text),
        sheet0Rects: sel ? sel.rects.filter(r => r.sheet === 0).length : 0,
        sheet1Rects: sel ? sel.rects.filter(r => r.sheet === 1).length : 0,
        text: sel ? sel.text : ''
      };
    })
    """)
    check("computeTextSelectionRanges across pages returns rects on both sheets",
          cross_page_sel["hasText"] and cross_page_sel["sheet0Rects"] > 0 and cross_page_sel["sheet1Rects"] > 0,
          f"res={cross_page_sel}")

    # 3. Text markup buttons visible, functional, and undoable
    markup_res = pg.evaluate("""
    import('./js/workspace/text-selection.js').then(async ts => {
      await ts.ensurePageTextData(0);
      const sel = ts.computeTextSelectionRanges(0, 0, 10, 0);
      window.state.textSelection = sel;
      window.state.selectedTextString = sel ? sel.text : '';

      const btnHi = document.getElementById('btnTextHighlight');
      const btnUnder = document.getElementById('btnTextUnderline');
      const btnStrike = document.getElementById('btnTextStrikethrough');

      const buttonsVisible = !btnHi.classList.contains('hidden') &&
                             !btnUnder.classList.contains('hidden') &&
                             !btnStrike.classList.contains('hidden');

      const initialStrokes = (window.state.strokes || []).filter(s => !s.deleted).length;

      // Apply highlight
      window.applyTextSelectionMarkup('highlight');
      const strokesAfterHi = (window.state.strokes || []).filter(s => !s.deleted);
      const hiCount = strokesAfterHi.length - initialStrokes;
      const lastStroke = strokesAfterHi[strokesAfterHi.length - 1];

      // Undo
      const doc = await import('./js/core/document.js');
      doc.performUndo();
      const strokesAfterUndo = (window.state.strokes || []).filter(s => !s.deleted).length;

      return {
        buttonsVisible,
        hiCreated: hiCount > 0,
        strokeKind: lastStroke ? lastStroke.kind : null,
        undoSuccess: strokesAfterUndo === initialStrokes
      };
    })
    """)
    check("text markup buttons visible, generate vector strokes, and undo cleanly",
          markup_res["buttonsVisible"] and markup_res["hiCreated"] and
          markup_res["strokeKind"] == 'highlighter' and markup_res["undoSuccess"],
          f"res={markup_res}")

    # 4. Multi-line search match partitioning
    search_partition_res = pg.evaluate("""
    import('./js/ui/drawers.js').then(async drawers => {
      const searchRects = await drawers.buildSearchRects('llSec', [{ page_index: 0, snippet: 'llSec' }]);
      return {
        count: searchRects.length,
        lines: searchRects.map(r => r.lineIndex)
      };
    })
    """)
    check("buildSearchRects partitions multi-line hits into multiple per-line rects",
          search_partition_res["count"] == 2 and search_partition_res["lines"] == [0, 1],
          f"res={search_partition_res}")

    # -------------------------------------------------------------
    # T4.5: Plan 074 Undoable Page Transactions & Bookmark Durability
    # -------------------------------------------------------------
    print("\n=== T4.5 Plan 074 Undoable Page Transactions & Bookmark Durability ===", flush=True)
    page_ops_undo_res = pg.evaluate("""
    import('./js/core/document.js').then(async doc => {
      const origPages = window.state.pageInfos.length;

      // 1. Insert page & undo/redo
      const insertedIdx = doc.insertPageAtIndex(1, { page_index: 1, width_pt: 500, height_pt: 700 });
      const pagesAfterInsert = window.state.pageInfos.length;
      doc.performUndo();
      const pagesAfterUndoInsert = window.state.pageInfos.length;
      doc.performRedo();
      const pagesAfterRedoInsert = window.state.pageInfos.length;

      // Clean up the inserted page so we're back to origPages
      doc.performUndo();

      // 2. Delete page & undo/redo
      // Insert a dummy page first so we don't violate single page constraint
      doc.insertPageAtIndex(1, { page_index: 1, width_pt: 500, height_pt: 700 }, { recordHistory: false });
      const countBeforeDelete = window.state.pageInfos.length;
      doc.deletePageAtIndex(1);
      const countAfterDelete = window.state.pageInfos.length;
      doc.performUndo();
      const countAfterUndoDelete = window.state.pageInfos.length;
      doc.performRedo();
      const countAfterRedoDelete = window.state.pageInfos.length;

      // 3. Reorder page & undo/redo
      // We have countAfterRedoDelete pages. Let's insert another to have at least 2 pages.
      if (window.state.pageInfos.length < 2) {
        doc.insertPageAtIndex(1, { page_index: 1, width_pt: 500, height_pt: 700 }, { recordHistory: false });
      }
      window.state.pageInfos[0].tag = 'page0';
      window.state.pageInfos[1].tag = 'page1';
      doc.reorderPageAtIndex(0, 1);
      const orderAfterReorder = [window.state.pageInfos[0].tag, window.state.pageInfos[1].tag];
      doc.performUndo();
      const orderAfterUndoReorder = [window.state.pageInfos[0].tag, window.state.pageInfos[1].tag];
      doc.performRedo();
      const orderAfterRedoReorder = [window.state.pageInfos[0].tag, window.state.pageInfos[1].tag];

      // Clean up back to origPages
      while (window.state.pageInfos.length > origPages) {
        window.state.pageInfos.pop();
      }

      return {
        pagesAfterInsert,
        pagesAfterUndoInsert,
        pagesAfterRedoInsert,
        origPages,
        countBeforeDelete,
        countAfterDelete,
        countAfterUndoDelete,
        countAfterRedoDelete,
        orderAfterReorder,
        orderAfterUndoReorder,
        orderAfterRedoReorder
      };
    })
    """)
    check("page operations insert, delete, and reorder support full undo/redo transactions",
          page_ops_undo_res["pagesAfterInsert"] == page_ops_undo_res["origPages"] + 1 and
          page_ops_undo_res["pagesAfterUndoInsert"] == page_ops_undo_res["origPages"] and
          page_ops_undo_res["pagesAfterRedoInsert"] == page_ops_undo_res["origPages"] + 1 and
          page_ops_undo_res["countAfterDelete"] == page_ops_undo_res["countBeforeDelete"] - 1 and
          page_ops_undo_res["countAfterUndoDelete"] == page_ops_undo_res["countBeforeDelete"] and
          page_ops_undo_res["countAfterRedoDelete"] == page_ops_undo_res["countBeforeDelete"] - 1 and
          page_ops_undo_res["orderAfterReorder"] == ["page1", "page0"] and
          page_ops_undo_res["orderAfterUndoReorder"] == ["page0", "page1"] and
          page_ops_undo_res["orderAfterRedoReorder"] == ["page1", "page0"],
          f"res={page_ops_undo_res}")

    bookmark_serialize_res = pg.evaluate("""
    import('./js/core/ipc.js').then(async ipc => {
      window.state.bookmarks = [
        { id: 'bm_test_1', page: 0, label: 'Intro Page', createdAt: 123456789 },
        { id: 'bm_test_2', page: 1, label: 'Summary', createdAt: 987654321 }
      ];

      let capturedPayload = null;
      const originalInvoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
      window.__TAURI__.core.invoke = async (cmd, args) => {
        if (cmd === 'save_pdf' || cmd === 'save_pdf_dialog') {
          capturedPayload = args;
          return { success: true };
        }
        return originalInvoke ? originalInvoke(cmd, args) : null;
      };

      try {
        await ipc.savePdf('dummy_test_path.pdf');
      } finally {
        window.__TAURI__.core.invoke = originalInvoke;
      }

      return {
        captured: !!capturedPayload,
        bookmarkCount: capturedPayload && capturedPayload.bookmarks ? capturedPayload.bookmarks.length : 0,
        firstBm: capturedPayload && capturedPayload.bookmarks ? capturedPayload.bookmarks[0] : null
      };
    })
    """)
    check("savePdf serializes state.bookmarks correctly to backend IPC payload",
          bookmark_serialize_res["captured"] and bookmark_serialize_res["bookmarkCount"] == 2 and
          bookmark_serialize_res["firstBm"]["label"] == "Intro Page",
          f"res={bookmark_serialize_res}")

    # -------------------------------------------------------------
    # T4.6: Plan 075 Tool Suite (Text Note Editing, Arrow & Triangle Shapes, Page Rotation)
    # -------------------------------------------------------------
    print("\n=== T4.6 Plan 075 Tool Suite (Text Notes, Shapes & Page Rotation) ===", flush=True)
    tool_suite_res = pg.evaluate("""
    Promise.all([
      import('./js/tools/text.js'),
      import('./js/tools/shapes.js'),
      import('./js/core/document.js')
    ]).then(async ([textTool, shapesTool, docOps]) => {
      // 1. Text tool: clicking existing note does not duplicate
      if (!window.state.textObjects) window.state.textObjects = [];
      const testNote = {
        id: 'txt_test_suite_1',
        sheet: 0,
        x: 100,
        y: 100,
        text: 'Hello InkWell',
        fontSize: 16,
        color: '#141724',
        bold: false,
        italic: false,
        width: 140,
        height: 32,
        deleted: false
      };
      window.state.textObjects.push(testNote);
      const noteCountBefore = window.state.textObjects.filter(t => !t.deleted).length;

      const mockViewport = {
        worldToPage: (x, y) => ({ sheet: 0, pageX: x, pageY: y }),
        getPageLayout: (sheet) => ({ x: 0, y: 0, w: 612, h: 792, sheet }),
        worldToScreen: (wx, wy, pane) => [wx, wy],
        pageToScreen: (px, py, pane) => [px, py],
        zoom: 1.0
      };

      // Click on the existing note
      textTool.onTextToolClick({ clientX: 110, clientY: 110 }, [110, 110], 'left', mockViewport);
      const noteCountAfter = window.state.textObjects.filter(t => !t.deleted).length;
      const editorVisible = !document.getElementById('inlineTextEditor').classList.contains('hidden');
      const editorText = document.getElementById('inlineTextarea') ? document.getElementById('inlineTextarea').value : '';
      textTool.cancelEditing();

      // 2. Shapes: arrow and triangle commit valid strokes
      if (!window.state.strokes) window.state.strokes = [];
      const strokesCountBefore = (window.state.strokes || []).filter(s => !s.deleted).length;

      // Draw arrow
      window.state.shapeKind = 'arrow';
      window.state.shapeStart = [50, 50];
      window.state.shapeEnd = [150, 150];
      shapesTool.onShapeUp({}, mockViewport);

      // Draw triangle
      window.state.shapeKind = 'triangle';
      window.state.shapeStart = [200, 200];
      window.state.shapeEnd = [300, 300];
      shapesTool.onShapeUp({}, mockViewport);

      const strokesCountAfter = (window.state.strokes || []).filter(s => !s.deleted).length;

      // 3. Page rotate: rotatePageAtIndex rotates dimensions and stroke points
      const origW = window.state.pageInfos[0].width_pt;
      const origH = window.state.pageInfos[0].height_pt;
      const dummyStroke = {
        id: 'stroke_rotate_test',
        sheet: 0,
        kind: 'pen',
        rgb: [1, 0, 0],
        cssColor: '#ff0000',
        base_width: 2,
        points: [{ x: 10, y: 20, p: 0.8, w: 2 }],
        color: '#ff0000',
        width: 2,
        deleted: false
      };
      window.state.strokes.push(dummyStroke);

      docOps.rotatePageAtIndex(0, true);
      const rotW = window.state.pageInfos[0].width_pt;
      const rotH = window.state.pageInfos[0].height_pt;
      const rotPoint = { ...dummyStroke.points[0] };

      docOps.performUndo();
      const undoW = window.state.pageInfos[0].width_pt;
      const undoH = window.state.pageInfos[0].height_pt;
      const undoPoint = { ...dummyStroke.points[0] };

      // Clean up test objects so subsequent tests run on clean slate
      window.state.textObjects = (window.state.textObjects || []).filter(t => t.id !== 'txt_test_suite_1');
      window.state.strokes = (window.state.strokes || []).filter(s => s.id !== 'stroke_rotate_test');

      return {
        noteCountBefore,
        noteCountAfter,
        editorVisible,
        editorText,
        shapesAdded: strokesCountAfter - strokesCountBefore,
        origW,
        origH,
        rotW,
        rotH,
        rotPoint,
        undoW,
        undoH,
        undoPoint
      };
    })
    """)
    check("text tool edits existing note without duplicating notes",
          tool_suite_res["noteCountBefore"] == tool_suite_res["noteCountAfter"] and
          tool_suite_res["editorVisible"] and tool_suite_res["editorText"] == "Hello InkWell",
          f"res={tool_suite_res}")
    check("shapes tool successfully commits arrow and triangle vector strokes",
          tool_suite_res["shapesAdded"] == 2,
          f"added={tool_suite_res['shapesAdded']}")
    check("rotatePageAtIndex rotates page dimensions and stroke geometry with undo",
          tool_suite_res["rotW"] == tool_suite_res["origH"] and
          tool_suite_res["rotH"] == tool_suite_res["origW"] and
          abs(tool_suite_res["rotPoint"]["x"] - (tool_suite_res["origH"] - 20)) < 1e-4 and
          abs(tool_suite_res["rotPoint"]["y"] - 10) < 1e-4 and
          tool_suite_res["undoW"] == tool_suite_res["origW"] and
          tool_suite_res["undoH"] == tool_suite_res["origH"] and
          abs(tool_suite_res["undoPoint"]["x"] - 10) < 1e-4 and
          abs(tool_suite_res["undoPoint"]["y"] - 20) < 1e-4,
          f"res={tool_suite_res}")

    # -------------------------------------------------------------
    # T4.7: Plan 076 UI Polish, Customizable Shortcuts & Dark Reading Mode
    # -------------------------------------------------------------
    print("\n=== T4.7 Plan 076 UI Polish, Shortcuts & Reading Mode ===", flush=True)

    # 1. Ctrl+F opens search drawer
    pg.keyboard.press("Control+f")
    pg.wait_for_timeout(100)
    search_drawer_open = pg.evaluate("!document.getElementById('drawerSearch').classList.contains('hidden')")
    check("Ctrl+F shortcut opens Search drawer", search_drawer_open)
    pg.evaluate("window.drawers.closeDrawer()")
    pg.wait_for_timeout(50)

    # 2. openGoToPageModal sets total display and max
    goto_modal_res = pg.evaluate("""
    (() => {
      window.toolbar.openGoToPageModal();
      const modalVisible = !document.getElementById('goToPageModal').classList.contains('hidden');
      const totalDisplay = document.getElementById('goToPageTotalDisplay') ? document.getElementById('goToPageTotalDisplay').textContent : '';
      const inputMax = document.getElementById('goToPageInput') ? document.getElementById('goToPageInput').max : '';
      const pageCount = window.state.pageInfos ? window.state.pageInfos.length : 1;
      window.toolbar.closeGoToPageModal();
      return { modalVisible, totalDisplay, inputMax, expected: String(pageCount) };
    })()
    """)
    check("openGoToPageModal sets #goToPageTotalDisplay and input.max to pageInfos.length",
          goto_modal_res["modalVisible"] and
          goto_modal_res["totalDisplay"] == goto_modal_res["expected"] and
          goto_modal_res["inputMax"] == goto_modal_res["expected"],
          f"res={goto_modal_res}")

    # 3. Customizable shortcuts persistence and rebinding
    rebind_res = pg.evaluate("""
    (() => {
      const origShortcut = window.commands.get('tool.pen')?.shortcut;
      window.commands.setCommandShortcut('tool.pen', 'Ctrl+Shift+Alt+P');
      const stored = localStorage.getItem('inkwell.keymap');
      const storedObj = stored ? JSON.parse(stored) : {};
      const newShortcutInReg = window.commands.get('tool.pen')?.shortcut;

      // Revert back so we don't pollute other tests
      window.commands.setCommandShortcut('tool.pen', origShortcut);
      window.commands.resetKeybindings();

      return {
        hasStored: Object.prototype.hasOwnProperty.call(storedObj, 'tool.pen'),
        storedVal: storedObj['tool.pen'],
        newShortcutInReg
      };
    })()
    """)
    check("setCommandShortcut persists keymap override to localStorage and CommandRegistry",
          rebind_res["hasStored"] and rebind_res["storedVal"] == "Ctrl+Shift+Alt+P" and
          rebind_res["newShortcutInReg"] == "Ctrl+Shift+Alt+P",
          f"res={rebind_res}")

    # 4. Generalized spring-loaded tool key (holding m > 220ms reverts to toolBefore)
    spring_key_res = pg.evaluate("""
    (() => {
      window.toolManager.setTool('pen');
      const beforeTool = window.state.activeTool; // 'pen'

      // Simulate holding 'm' for 300ms
      window.toolManager.handleSpringKeyDown('m');
      const activeDuringHold = window.state.activeTool; // 'highlighter'

      return new Promise(resolve => {
        setTimeout(() => {
          window.toolManager.handleSpringKeyUp('m');
          const activeAfterRelease = window.state.activeTool; // should revert to 'pen'
          resolve({ beforeTool, activeDuringHold, activeAfterRelease });
        }, 250);
      });
    })()
    """)
    check("holding spring key m > 220ms temporarily switches tool and reverts on release",
          spring_key_res["beforeTool"] == "pen" and
          spring_key_res["activeDuringHold"] == "highlighter" and
          spring_key_res["activeAfterRelease"] == "pen",
          f"res={spring_key_res}")

    # 5. Reading mode cycling and canvas classes
    reading_mode_res = pg.evaluate("""
    (() => {
      const tiles = document.getElementById('tiles');
      window.setReadingMode('normal');
      const normDark = tiles.classList.contains('reading-mode-dark');
      const normSepia = tiles.classList.contains('reading-mode-sepia');

      window.commands.execute('view.cycleReadingMode'); // normal -> dark
      const darkDark = tiles.classList.contains('reading-mode-dark');
      const darkSepia = tiles.classList.contains('reading-mode-sepia');

      window.commands.execute('view.cycleReadingMode'); // dark -> sepia
      const sepiaDark = tiles.classList.contains('reading-mode-dark');
      const sepiaSepia = tiles.classList.contains('reading-mode-sepia');

      window.commands.execute('view.cycleReadingMode'); // sepia -> normal
      const backDark = tiles.classList.contains('reading-mode-dark');
      const backSepia = tiles.classList.contains('reading-mode-sepia');

      return {
        normOk: !normDark && !normSepia,
        darkOk: darkDark && !darkSepia,
        sepiaOk: !sepiaDark && sepiaSepia,
        backOk: !backDark && !backSepia
      };
    })()
    """)
    check("view.cycleReadingMode cycles #tiles between normal, reading-mode-dark, and reading-mode-sepia",
          reading_mode_res["normOk"] and reading_mode_res["darkOk"] and
          reading_mode_res["sepiaOk"] and reading_mode_res["backOk"],
          f"res={reading_mode_res}")

    # -------------------------------------------------------------
    # T5: Canvas Context Menu & Tool Triggering
    # -------------------------------------------------------------
    print("\n=== T5  Canvas Context Menu & Tool Triggering ===", flush=True)
    pg.locator("#wet").click(button="right", position={"x": 250, "y": 250})
    pg.wait_for_timeout(100)
    ctx_visible = pg.evaluate("!document.getElementById('canvasContextMenu').classList.contains('hidden')")
    ctx_items_ok = pg.evaluate("""
    !!(document.getElementById('ctxMenuCopy') &&
       document.getElementById('ctxMenuCopySvg') &&
       document.getElementById('ctxMenuCut') &&
       document.getElementById('ctxMenuPaste') &&
       document.getElementById('ctxMenuDuplicate') &&
       document.getElementById('ctxMenuDelete'))
    """)
    check("right-click on canvas opens context menu with action items", ctx_visible and ctx_items_ok)

    # Click outside dismisses context menu
    pg.mouse.click(box["x"] + 10, box["y"] + 10)
    pg.wait_for_timeout(50)
    ctx_hidden = pg.evaluate("document.getElementById('canvasContextMenu').classList.contains('hidden')")
    check("clicking outside dismisses canvas context menu", ctx_hidden)

    # Plan 065: Vector Clipping to Obsidian & LaTeX (SVG Serializer)
    svg_export_ok = pg.evaluate("""async () => {
        const { state } = await import('./js/core/state.js');
        const clipboard = await import('./js/core/clipboard.js');
        const mockStroke = {
            id: 'stk_svg_test_1',
            sheet: 0,
            kind: 'pen',
            rgb: [0.1, 0.2, 0.3],
            base_width: 2.5,
            points: [
                { x: 100, y: 100, p: 0.5, w: 2.5 },
                { x: 150, y: 120, p: 0.7, w: 3.0 },
                { x: 200, y: 160, p: 0.8, w: 3.2 }
            ],
            deleted: false
        };
        state.selectedStrokes = [mockStroke];
        state.selectedImages = [];
        state.selectedTextObjects = [];

        const svgStr = clipboard.serializeSelectionToSvg();
        if (!svgStr || !svgStr.includes('<svg') || !svgStr.includes('<path')) {
            return { ok: false, reason: 'Missing svg or path tags', svg: svgStr };
        }
        const parser = new DOMParser();
        const doc = parser.parseFromString(svgStr, 'image/svg+xml');
        const parseError = doc.querySelector('parsererror');
        if (parseError) {
            return { ok: false, reason: 'XML parse error: ' + parseError.textContent };
        }
        const pathEl = doc.querySelector('path');
        const d = pathEl ? pathEl.getAttribute('d') : null;
        if (!d || !d.startsWith('M')) {
            return { ok: false, reason: 'Invalid path d attribute: ' + d };
        }
        return { ok: true, hasSvgBtn: !!document.getElementById('btnLassoCopySvg') };
    }""")
    check("serializeSelectionToSvg produces valid, well-formed SVG vector path",
          svg_export_ok.get('ok') and svg_export_ok.get('hasSvgBtn'), str(svg_export_ok))

    # -------------------------------------------------------------
    # T6: Radial Tool Menu
    # -------------------------------------------------------------
    print("\n=== T6  Radial Tool Menu ===", flush=True)
    pg.evaluate("import('./js/ui/radial-menu.js').then(rm => rm.showRadialMenu(300, 300))")
    pg.wait_for_timeout(50)
    radial_visible = pg.evaluate("!document.getElementById('radialMenu').classList.contains('hidden')")
    check("showRadialMenu displays radial menu overlay", radial_visible)

    radial_items_count = pg.locator(".radial-item").count()
    check("query selector .radial-item finds interactive radial slots", radial_items_count >= 4, f"count={radial_items_count}")

    eraser_item = pg.locator(".radial-item[data-tool='eraser']")
    eraser_item.click(force=True)
    pg.wait_for_timeout(50)
    active_after_radial = pg.evaluate("window.state.activeTool")
    radial_closed = pg.evaluate("document.getElementById('radialMenu').classList.contains('hidden')")
    check("clicking .radial-item switches tool accurately and closes menu",
          active_after_radial == "eraser" and radial_closed, f"tool={active_after_radial}")

    # -------------------------------------------------------------
    # T7: Command Palette
    # -------------------------------------------------------------
    print("\n=== T7  Command Palette ===", flush=True)
    pg.keyboard.press("Control+K")
    pg.wait_for_timeout(100)
    cmd_open = pg.evaluate("!document.getElementById('cmdPaletteModal').classList.contains('hidden')")
    check("Ctrl+K opens command palette modal", cmd_open)

    pg.keyboard.press("ArrowDown")
    pg.wait_for_timeout(50)
    sel_idx_1 = pg.evaluate("document.querySelector('.cmd-item.selected') ? document.querySelector('.cmd-item.selected').getAttribute('data-index') : null")
    check("ArrowDown navigates selection to next command item", sel_idx_1 == "1", f"index={sel_idx_1}")

    pg.keyboard.press("ArrowUp")
    pg.wait_for_timeout(50)
    sel_idx_0 = pg.evaluate("document.querySelector('.cmd-item.selected') ? document.querySelector('.cmd-item.selected').getAttribute('data-index') : null")
    check("ArrowUp navigates selection back to top command item", sel_idx_0 == "0", f"index={sel_idx_0}")

    pg.keyboard.press("Escape")
    pg.wait_for_timeout(50)
    cmd_closed = pg.evaluate("document.getElementById('cmdPaletteModal').classList.contains('hidden')")
    check("Escape key dismisses command palette", cmd_closed)

    # -------------------------------------------------------------
    # T8: Touch Target & Accessibility Ergonomics (F13-F15)
    # -------------------------------------------------------------
    print("\n=== T8  Touch Target & Accessibility Ergonomics (F13-F15) ===", flush=True)
    # Compact button hit expansion verification
    compact_buttons = [
        ("#btnNavBack", ".header-icon-btn"),
        ("#btnNavForward", ".header-icon-btn"),
        ("#btnHeaderSave", ".header-icon-btn"),
        ("#btnHeaderPrevPage", ".nav-cluster-btn"),
        ("#btnZoomIn", ".zoom-dock-btn"),
        ("#btnNewTab", ".tab-add-btn"),
        ("#btnCloseDrawer", ".drawer-close-btn"),
    ]
    all_pseudo_ok = True
    for sel, cls in compact_buttons:
        info = pg.evaluate(f"""() => {{
            const el = document.querySelector('{sel}');
            if (!el) return null;
            const cs = window.getComputedStyle(el, '::before');
            return {{
                minWidth: cs.minWidth,
                minHeight: cs.minHeight,
                position: cs.position
            }};
        }}""")
        if not info or info['minWidth'] != '44px' or info['minHeight'] != '44px' or info['position'] != 'absolute':
            all_pseudo_ok = False
            check(f"{sel} has 44x44px pseudo hit area", False, f"info={info}")
    if all_pseudo_ok:
        check("compact buttons expand to >= 44x44px via ::before pseudo-elements", True)

    # Outer hit-test dispatch triggers click
    outer_hit_ok = pg.evaluate("""() => {
        const btn = document.querySelector('#btnHeaderSave');
        let clicked = false;
        const listener = () => { clicked = true; };
        btn.addEventListener('click', listener);
        const rect = btn.getBoundingClientRect();
        const tapX = rect.left + rect.width / 2;
        const tapY = rect.top - 3;
        const targetEl = document.elementFromPoint(tapX, tapY);
        const evt = new MouseEvent('click', { clientX: tapX, clientY: tapY, bubbles: true });
        if (targetEl) targetEl.dispatchEvent(evt);
        btn.removeEventListener('click', listener);
        return clicked;
    }""")
    check("hit-testing outer pseudo-element area triggers button click", outer_hit_ok)

    # Focus visible outline rules verification
    focus_visible_rule_exists = pg.evaluate("""() => {
        const rules = Array.from(document.styleSheets).flatMap(sheet => {
            try { return Array.from(sheet.cssRules); } catch (e) { return []; }
        });
        return rules.some(r =>
            r.selectorText &&
            r.selectorText.includes(':focus-visible') &&
            (r.style.outline.includes('3b82f6') || r.style.outline.includes('rgb(59, 130, 246)') ||
             r.style.outlineColor.includes('59, 130, 246') || r.style.outlineColor.includes('3b82f6') ||
             r.style.outline.includes('2563eb') || r.style.outline.includes('rgb(37, 99, 235)') ||
             r.style.outline.includes('7c3aed') || r.style.outline.includes('rgb(124, 58, 237)'))
        );
    }""")
    check("universal :focus-visible high-contrast outline rules present in stylesheet", focus_visible_rule_exists)

    # Glassmorphic toast ARIA attributes
    toast_aria_ok = pg.evaluate("""() => {
        window.showToast('Test status notification', 'info');
        window.showToast('Test error notification', 'error');
        const tc = document.getElementById('toastContainer');
        const toasts = document.querySelectorAll('.toast');
        const infoToast = toasts[toasts.length - 2];
        const errorToast = toasts[toasts.length - 1];
        return {
            containerAria: tc ? tc.getAttribute('aria-live') === 'polite' : false,
            infoRole: infoToast ? infoToast.getAttribute('role') === 'status' : false,
            errorRole: errorToast ? errorToast.getAttribute('role') === 'alert' : false,
        };
    }""")
    check("glassmorphic toast notifications implement ARIA polite/status/alert roles",
          toast_aria_ok['containerAria'] and toast_aria_ok['infoRole'] and toast_aria_ok['errorRole'])

    # -------------------------------------------------------------
    # T9: Navigation Rail & Drawer Panels
    # -------------------------------------------------------------
    print("\n=== T9  Navigation Rail & Drawer Panels ===", flush=True)
    drawers = ['btnRailThumbnails', 'btnRailOutline', 'btnRailSearch', 'btnRailBookmarks', 'btnRailDocInfo']
    for d in drawers:
        btn = pg.locator(f"#{d}")
        check(f"rail button #{d} exists", btn.count() == 1)
        if btn.count() > 0:
            btn.click(force=True)
            pg.wait_for_timeout(60)
    check("drawers toggle cleanly without exceptions", not errors, str(errors[:2]))

    # Page Insertion Modal & Thumbnail Synchronization
    pg.locator("#btnRailThumbnails").click(force=True)
    pg.wait_for_timeout(60)
    initial_pages = pg.evaluate("window.state.pageInfos ? window.state.pageInfos.length : 0")
    initial_thumbs = pg.locator("#thumbnailGrid .thumb-card").count()
    check("initial thumbnail cards match page count", initial_thumbs == initial_pages,
          f"pages={initial_pages} thumbs={initial_thumbs}")

    pg.locator("#btnHeaderAddPage").click(force=True)
    pg.wait_for_timeout(60)
    check("insert page modal opens", pg.evaluate("!document.getElementById('insertPageModal').classList.contains('hidden')"))
    pg.locator("#btnConfirmInsertPage").click(force=True)
    pg.wait_for_timeout(300)

    updated_pages = pg.evaluate("window.state.pageInfos ? window.state.pageInfos.length : 0")
    updated_thumbs = pg.locator("#thumbnailGrid .thumb-card").count()
    insert_error = any("Failed to insert page" in t for t in pg.locator(".toast-error").all_text_contents())

    check("page insertion increments state.pageInfos length",
          updated_pages == initial_pages + 1,
          f"before={initial_pages} after={updated_pages}")
    check("thumbnailGrid contains updated card count without TypeError",
          updated_thumbs == updated_pages and not insert_error,
          f"thumbs={updated_thumbs} pages={updated_pages} insertError={insert_error}")
    check("page insertion runs with zero console errors", not errors, str(errors[:2]))

    # Plan 064: Visual Thumbnails & Action Buttons Verification
    thumb_actions_ok = pg.evaluate("""() => {
        const cards = document.querySelectorAll('#thumbnailGrid .thumb-card');
        if (!cards.length) return false;
        return Array.from(cards).every(card => {
            const hasAct = !!card.querySelector('.thumb-card-actions');
            const hasDup = !!card.querySelector('.btn-thumb-duplicate');
            const hasDel = !!card.querySelector('.btn-thumb-del');
            const hasCanvas = !!card.querySelector('canvas.thumb-canvas');
            const isDraggable = card.getAttribute('draggable') === 'true';
            return hasAct && hasDup && hasDel && hasCanvas && isDraggable;
        });
    }""")
    check("thumbnail cards render preview canvases, action buttons, and drag attributes", thumb_actions_ok)

    # Plan 064: Bookmarks Workflow Verification
    pg.locator("#btnRailBookmarks").click(force=True)
    pg.wait_for_timeout(60)
    pg.locator("#btnAddBookmark").click(force=True)
    pg.wait_for_timeout(60)
    bm_count_after_add = pg.locator("#bookmarksList .bookmark-card").count()
    check("clicking #btnAddBookmark adds bookmark card to bookmarksList", bm_count_after_add >= 1, f"count={bm_count_after_add}")

    # Remove bookmark
    pg.locator("#bookmarksList .bookmark-delete-btn").first.click(force=True)
    pg.wait_for_timeout(60)
    bm_count_after_del = pg.locator("#bookmarksList .bookmark-card").count()
    check("clicking .bookmark-delete-btn removes bookmark from bookmarksList", bm_count_after_del == bm_count_after_add - 1, f"count={bm_count_after_del}")

    # Return to thumbnails
    pg.locator("#btnRailThumbnails").click(force=True)
    pg.wait_for_timeout(60)

    # -------------------------------------------------------------
    # T10: Synthetic Pen Input Pipeline
    # -------------------------------------------------------------
    print("\n=== T10 Synthetic Pen Input Pipeline ===", flush=True)
    pg.locator("#btnDockPen").click(force=True)
    pg.wait_for_timeout(50)

    cdp = ctx.new_cdp_session(pg)
    box = pg.locator("#wet").bounding_box()
    ox, oy = box["x"] + 100, box["y"] + 200

    cdp.send("Input.dispatchMouseEvent", {
        "type": "mousePressed", "x": ox, "y": oy, "button": "left",
        "buttons": 1, "pointerType": "pen", "force": 0.2, "clickCount": 1
    })
    for i in range(30):
        cdp.send("Input.dispatchMouseEvent", {
            "type": "mouseMoved", "x": ox + i * 8, "y": oy + 20 * math.sin(i / 5),
            "button": "left", "buttons": 1, "pointerType": "pen", "force": 0.4 + 0.5 * (i / 30)
        })
    cdp.send("Input.dispatchMouseEvent", {
        "type": "mouseReleased", "x": ox + 240, "y": oy,
        "button": "left", "buttons": 0, "pointerType": "pen", "force": 0.1
    })
    pg.wait_for_timeout(300)

    stroke_count = pg.evaluate("window.state.strokes ? window.state.strokes.length : 0")
    check("pen stroke committed to document state", stroke_count >= 1, f"strokes={stroke_count}")

    dry_pixels = pg.evaluate("document.getElementById('dry').toDataURL().length > 500")
    check("dry canvas composited ink bitmap", dry_pixels)

    # Pressure resolution & velocity dynamics verification
    browser_p = pg.evaluate("""() => {
        return window.resolvePressure({ pointerType: 'pen', pressure: 0.72 });
    }""")
    check("resolvePressure resolves browser hardware pen pressure", abs(browser_p - 0.72) < 0.01, f"p={browser_p}")

    velocity_dynamics = pg.evaluate("""() => {
        window.resetPressureDynamics();
        const pFast1 = window.resolvePressure({ clientX: 100, clientY: 100, timeStamp: 1000 });
        const pFast2 = window.resolvePressure({ clientX: 350, clientY: 100, timeStamp: 1050 });
        window.resetPressureDynamics();
        const pSlow1 = window.resolvePressure({ clientX: 100, clientY: 100, timeStamp: 2000 });
        const pSlow2 = window.resolvePressure({ clientX: 105, clientY: 100, timeStamp: 2100 });
        return { fast: pFast2, slow: pSlow2 };
    }""")
    check("velocity dynamics adjusts pressure: fast strokes taper thinner than slow strokes",
          velocity_dynamics['fast'] < velocity_dynamics['slow'],
          f"fast={velocity_dynamics['fast']:.3f} slow={velocity_dynamics['slow']:.3f}")

    page_label_check = pg.evaluate("""() => {
        const btnText = document.getElementById('btnPageDropdown').innerText.replace(/\\s+/g, ' ').trim();
        const num = document.getElementById('pageNumDisplay').textContent.trim();
        const total = document.getElementById('pageTotalDisplay').textContent.trim();
        return { btnText, num, total };
    }""")
    check("page dropdown displays clean non-duplicated 'Page X / Y' format",
          "Page Page" not in page_label_check['btnText'] and page_label_check['num'].isdigit(),
          f"text='{page_label_check['btnText']}' num={page_label_check['num']}")

    stylus_native_tool_exposed = pg.evaluate("typeof window.getLiveNativeTool === 'function'")
    check("stylus native tool accessor is exposed to window", stylus_native_tool_exposed)

    # Verify smooth cubic Bezier ribbon contour & corner preservation
    spline_contour_check = pg.evaluate("""() => {
        const pathOps = [];
        const mockTarget = {
            moveTo: (x, y) => pathOps.push(['moveTo', x, y]),
            lineTo: (x, y) => pathOps.push(['lineTo', x, y]),
            bezierCurveTo: (c1x, c1y, c2x, c2y, x, y) => pathOps.push(['bezierCurveTo', c1x, c1y, c2x, c2y, x, y]),
            arc: (x, y, r, a0, a1, ccw) => pathOps.push(['arc', x, y, r]),
            closePath: () => pathOps.push(['closePath']),
        };
        const arcPts = [
            { x: 10, y: 10, w: 2 }, { x: 30, y: 25, w: 2.5 },
            { x: 60, y: 30, w: 3 }, { x: 90, y: 20, w: 2.5 }, { x: 105, y: 5, w: 2 }
        ];
        window.Ink.traceRibbonContour(mockTarget, arcPts, 2.0);
        const hasBezier = pathOps.some(op => op[0] === 'bezierCurveTo');

        // Corner check: V shape
        const vPts = [
            { x: 10, y: 10, w: 2 }, { x: 20, y: 30, w: 2 },
            { x: 30, y: 50, w: 2 }, { x: 40, y: 30, w: 2 }, { x: 50, y: 10, w: 2 }
        ];
        const cubics = window.Ink.openPolylineToCubics(vPts);
        const vertexPreserved = cubics.length === 4 && Math.abs(cubics[1][2].y - 50) < 1e-4 && cubics[1][1].y <= 50;
        return { hasBezier, vertexPreserved, opsCount: pathOps.length };
    }""")
    check("curve interpolation emits cubic Beziers and preserves sharp vertices",
          spline_contour_check['hasBezier'] and spline_contour_check['vertexPreserved'],
          f"hasBezier={spline_contour_check['hasBezier']} vertexPreserved={spline_contour_check['vertexPreserved']}")

    # Verify solid dot marker does not emit hollow hole cutouts
    dot_marker_check = pg.evaluate("""() => {
        const pathOps = [];
        const mockTarget = {
            moveTo: (x, y) => pathOps.push(['moveTo', x, y]),
            lineTo: (x, y) => pathOps.push(['lineTo', x, y]),
            bezierCurveTo: (c1x, c1y, c2x, c2y, x, y) => pathOps.push(['bezierCurveTo', c1x, c1y, c2x, c2y, x, y]),
            arc: (x, y, r, a0, a1, ccw) => pathOps.push(['arc', x, y, r]),
            closePath: () => pathOps.push(['closePath']),
        };
        // Small 1.2px radius circular dot marker
        const dotPts = [];
        for (let i = 0; i <= 10; i++) {
            const theta = i / 10 * Math.PI * 2;
            dotPts.push({ x: 50 + 1.2 * Math.cos(theta), y: 50 + 1.2 * Math.sin(theta), w: 2.0 });
        }
        window.Ink.traceRibbonContour(mockTarget, dotPts, 2.0);
        const closeCount = pathOps.filter(op => op[0] === 'closePath').length;
        const moveCount = pathOps.filter(op => op[0] === 'moveTo').length;
        return { closeCount, moveCount };
    }""")
    check("small dot marker renders as solid contour without hollow cutout holes",
          dot_marker_check['closeCount'] == 1 and dot_marker_check['moveCount'] == 1,
          f"closeCount={dot_marker_check['closeCount']} moveCount={dot_marker_check['moveCount']}")

    # Verify turnaround normal stability (no fork/twist on hairpin turn)
    turnaround_check = pg.evaluate("""() => {
        const pathOps = [];
        const mockTarget = {
            moveTo: (x, y) => pathOps.push(['moveTo', x, y]),
            lineTo: (x, y) => pathOps.push(['lineTo', x, y]),
            bezierCurveTo: (c1x, c1y, c2x, c2y, x, y) => pathOps.push(['bezierCurveTo', c1x, c1y, c2x, c2y, x, y]),
            arc: (x, y, r, a0, a1, ccw) => pathOps.push(['arc', x, y, r]),
            closePath: () => pathOps.push(['closePath']),
        };
        const hairpinPts = [
            { x: 10, y: 100, w: 2 }, { x: 10, y: 50, w: 2 }, { x: 10, y: 20, w: 2 },
            { x: 10.2, y: 20.5, w: 2 }, { x: 10.5, y: 50, w: 2 }, { x: 10.5, y: 100, w: 2 }
        ];
        window.Ink.traceRibbonContour(mockTarget, hairpinPts, 2.0);
        let maxDev = 0;
        for (const op of pathOps) {
            if (op[0] === 'bezierCurveTo') {
                maxDev = Math.max(maxDev, Math.abs(op[1] - 10), Math.abs(op[3] - 10), Math.abs(op[5] - 10));
            }
        }
        return { maxDev, opsCount: pathOps.length };
    }""")
    check("turnaround apex normal remains bounded without split fork or twist",
          turnaround_check['maxDev'] < 5.0 and turnaround_check['opsCount'] > 0,
          f"maxDev={turnaround_check['maxDev']:.2f} opsCount={turnaround_check['opsCount']}")

    # Plan 070: #dry blend mode and zero commit-snap verification
    dry_blend_mode = pg.evaluate("window.getComputedStyle(document.getElementById('dry')).mixBlendMode")
    check("#dry computed style mixBlendMode is normal", dry_blend_mode == "normal", f"mode={dry_blend_mode}")

    stroke_snap_check = pg.evaluate("""() => {
        const vp = window.getViewport ? window.getViewport() : null;
        if (!vp || !window.penTool) return { ok: false, reason: 'missing vp or penTool' };
        const t0 = performance.now();
        window.penTool.onPenDown({ pressure: 0.5, timeStamp: t0 }, [50, 80], 'left', vp);
        for (let i = 1; i < 200; i++) {
            const x = 50 + i * 1.5;
            const y = 80 + Math.sin(i * 0.1) * 15;
            window.penTool.onPenMove(
                { pressure: 0.5, buttons: 1, timeStamp: t0 + i * 4 },
                [x, y],
                'left',
                vp,
                { render: false }
            );
        }
        const livePts = window.state.cur ? window.state.cur.points.map(p => ({ x: p.x, y: p.y })) : [];
        window.penTool.onPenUp({}, vp);
        const elapsed = performance.now() - t0;
        const committedStroke = window.state.strokes[window.state.strokes.length - 1];
        const committedPts = committedStroke ? committedStroke.points.map(p => ({ x: p.x, y: p.y })) : [];
        let maxDiff = 0;
        if (livePts.length === committedPts.length) {
            for (let i = 0; i < livePts.length; i++) {
                maxDiff = Math.max(maxDiff, Math.hypot(livePts[i].x - committedPts[i].x, livePts[i].y - committedPts[i].y));
            }
        } else {
            maxDiff = 999;
        }
        return { ok: true, maxDiff, elapsed, count: committedPts.length };
    }""")
    check("200-point stroke produces zero commit-snap and fast completion",
          stroke_snap_check.get('ok') and stroke_snap_check.get('maxDiff', 999) < 1e-4 and stroke_snap_check.get('elapsed', 999) < 150,
          f"maxDiff={stroke_snap_check.get('maxDiff')} elapsed={stroke_snap_check.get('elapsed'):.1f}ms count={stroke_snap_check.get('count')}")

    # -------------------------------------------------------------
    # T11: Zoom Controls & Percentage Readout
    # -------------------------------------------------------------
    print("\n=== T11 Zoom Controls & Percentage Readout ===", flush=True)
    btn_zoom_in = pg.locator("#btnZoomIn")
    btn_zoom_out = pg.locator("#btnZoomOut")
    check("zoom in and out buttons exist", btn_zoom_in.count() == 1 and btn_zoom_out.count() == 1)

    initial_zoom = pg.locator("#zoomLevelDisplay").text_content()
    pg.evaluate("document.getElementById('btnZoomIn').click()")
    pg.wait_for_timeout(100)
    zoom_in_text = pg.locator("#zoomLevelDisplay").text_content()
    check("zoom in updates zoom percentage readout", zoom_in_text != initial_zoom, f"initial={initial_zoom} zoomed={zoom_in_text}")

    pg.evaluate("document.getElementById('btnZoomOut').click()")
    pg.wait_for_timeout(100)
    zoom_out_text = pg.locator("#zoomLevelDisplay").text_content()
    check("zoom out restores zoom readout", zoom_out_text == initial_zoom, f"initial={initial_zoom} restored={zoom_out_text}")

    # Custom zoom input & popover dismissal
    pg.locator("#btnZoomMenu").click()
    pg.wait_for_timeout(50)
    check("zoom menu popover opens", pg.evaluate("!document.getElementById('zoomMenuPopover').classList.contains('hidden')"))

    pg.locator("#inputCustomZoom").fill("120")
    pg.locator("#btnApplyCustomZoom").click()
    pg.wait_for_timeout(100)

    custom_zoom_text = pg.locator("#zoomLevelDisplay").text_content()
    pop_closed = pg.evaluate("document.getElementById('zoomMenuPopover').classList.contains('hidden')")
    cur_zoom_val = pg.evaluate("window.getViewport().zoom")
    check("custom zoom applies 120% and closes zoom menu with zero errors",
          pop_closed and abs(cur_zoom_val - 1.2) < 0.05 and not errors,
          f"zoomText='{custom_zoom_text}', zoomVal={cur_zoom_val}, popClosed={pop_closed}")

    # Horizontal pan clamping on off-center focal zooms
    pan_clamping = pg.evaluate('''(() => {
        const vp = window.getViewport();
        // Zoom in with focal point far to the right (Step 3 verification)
        vp.setZoom(3.0, [2000, 500]);
        const panX1 = vp.panX;
        const clamped1 = vp.clampPanX(panX1, 'left');

        // Zoom out with focal point far to the left
        vp.setZoom(0.5, [-500, 0]);
        const panX2 = vp.panX;
        const clamped2 = vp.clampPanX(panX2, 'left');

        // Extreme off-center zoom with focal point far to the right
        vp.setZoom(4.0, [5000, 0]);
        const panX3 = vp.panX;
        const clamped3 = vp.clampPanX(panX3, 'left');

        // Restore viewport to normal view
        vp.fitPage(595, 842, 'left');

        return {
            zoomInOk: panX1 === clamped1,
            zoomOutOk: panX2 === clamped2,
            extremeOk: panX3 === clamped3,
            panX1, clamped1,
            panX2, clamped2,
            panX3, clamped3
        };
    })()''')
    check("horizontal pan remains bounded by clampPanX during off-center focal zooms",
          pan_clamping["zoomInOk"] and pan_clamping["zoomOutOk"] and pan_clamping["extremeOk"],
          f"results={pan_clamping}")

    # Touchpad pinch zoom test (WheelEvent with ctrlKey=true, deltaMode=0)
    pinch_res = pg.evaluate("""(() => {
        const vp = window.getViewport();
        const z0 = vp.zoom;
        // Two-finger pinch out (zoom in): deltaY is negative, deltaMode is 0 (pixel)
        window.dispatchEvent(new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            clientX: 600,
            clientY: 400,
            deltaY: -20,
            deltaMode: 0,
            ctrlKey: true
        }));
        const zIn = vp.zoom;
        // Two-finger pinch in (zoom out): deltaY is positive, deltaMode is 0 (pixel)
        window.dispatchEvent(new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            clientX: 600,
            clientY: 400,
            deltaY: 20,
            deltaMode: 0,
            ctrlKey: true
        }));
        const zOut = vp.zoom;
        return { z0, zIn, zOut, inGain: zIn / z0, outRatio: zOut / zIn };
    })()""")
    check("touchpad pinch zoom scales smoothly and reversibly",
          pinch_res["zIn"] > pinch_res["z0"] and 1.15 <= pinch_res["inGain"] <= 1.50 and abs(pinch_res["zOut"] - pinch_res["z0"]) < 0.05,
          f"z0={pinch_res['z0']:.3f}, zIn={pinch_res['zIn']:.3f}, zOut={pinch_res['zOut']:.3f}, gain={pinch_res['inGain']:.2f}")

    # -------------------------------------------------------------
    # T12: WAL Undo/Redo IPC Synchronization
    # -------------------------------------------------------------
    print("\n=== T12 WAL Undo/Redo IPC Synchronization ===", flush=True)

    # 1. Text Object Undo / Redo
    pg.evaluate("""(() => {
        window.__walTextMutations = [];
        window.documentOps.addTextObject({
            id: 'txt_test_wal_1',
            sheet: 0,
            x: 120,
            y: 150,
            text: 'WAL undo/redo test note'
        });
    })()""")
    pg.wait_for_timeout(60)

    # Undo text addition -> expect journal_text_mutation op: 'delete'
    pg.evaluate("window.documentOps.performUndo()")
    pg.wait_for_timeout(60)

    last_text_undo = pg.evaluate("""(() => {
        const list = window.__walTextMutations || [];
        return list.length > 0 ? list[list.length - 1] : null;
    })()""")
    check("text undo journals delete mutation to WAL IPC",
          last_text_undo and last_text_undo.get("op") == "delete" and last_text_undo.get("textId") == "txt_test_wal_1",
          f"last_text_undo={last_text_undo}")

    # Redo text addition -> expect journal_text_mutation op: 'upsert'
    pg.evaluate("window.documentOps.performRedo()")
    pg.wait_for_timeout(60)

    last_text_redo = pg.evaluate("""(() => {
        const list = window.__walTextMutations || [];
        return list.length > 0 ? list[list.length - 1] : null;
    })()""")
    check("text redo journals upsert mutation to WAL IPC",
          last_text_redo and last_text_redo.get("op") == "upsert" and last_text_redo.get("text", {}).get("id") == "txt_test_wal_1",
          f"last_text_redo={last_text_redo}")

    # 2. Image Object Undo / Redo
    pg.evaluate("""(() => {
        window.__walImageMutations = [];
        window.documentOps.addImage({
            id: 'img_test_wal_1',
            sheet: 0,
            x: 200,
            y: 200,
            width: 100,
            height: 80,
            dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
        });
    })()""")
    pg.wait_for_timeout(60)

    # Undo image addition -> expect journal_image_mutation op: 'delete'
    pg.evaluate("window.documentOps.performUndo()")
    pg.wait_for_timeout(60)

    last_image_undo = pg.evaluate("""(() => {
        const list = window.__walImageMutations || [];
        return list.length > 0 ? list[list.length - 1] : null;
    })()""")
    check("image undo journals delete mutation to WAL IPC",
          last_image_undo and last_image_undo.get("op") == "delete" and last_image_undo.get("imageId") == "img_test_wal_1",
          f"last_image_undo={last_image_undo}")

    # Redo image addition -> expect journal_image_mutation op: 'upsert'
    pg.evaluate("window.documentOps.performRedo()")
    pg.wait_for_timeout(60)

    last_image_redo = pg.evaluate("""(() => {
        const list = window.__walImageMutations || [];
        return list.length > 0 ? list[list.length - 1] : null;
    })()""")
    check("image redo journals upsert mutation to WAL IPC",
          last_image_redo and last_image_redo.get("op") == "upsert" and last_image_redo.get("image", {}).get("id") == "img_test_wal_1",
          f"last_image_redo={last_image_redo}")

    # 3. Batch Delete Objects Undo / Redo
    pg.evaluate("""(() => {
        window.__walImageMutations = [];
        window.__walTextMutations = [];
        window.documentOps.deleteObjectsBatch({
            strokes: [],
            images: [{ id: 'img_batch_1', sheet: 0, x: 50, y: 50, width: 40, height: 40 }],
            textObjects: [{ id: 'txt_batch_1', sheet: 0, x: 60, y: 60, text: 'batch item' }]
        });
    })()""")
    pg.wait_for_timeout(60)

    # Undo batch delete -> expect upsert for image and text
    pg.evaluate("window.documentOps.performUndo()")
    pg.wait_for_timeout(60)

    batch_undo_img = pg.evaluate("window.__walImageMutations ? window.__walImageMutations.slice(-1)[0] : null")
    batch_undo_txt = pg.evaluate("window.__walTextMutations ? window.__walTextMutations.slice(-1)[0] : null")
    check("batch deletion undo journals upsert mutations to WAL IPC",
          batch_undo_img and batch_undo_img.get("op") == "upsert" and
          batch_undo_txt and batch_undo_txt.get("op") == "upsert",
          f"img={batch_undo_img} txt={batch_undo_txt}")

    # Redo batch delete -> expect delete for image and text
    pg.evaluate("window.documentOps.performRedo()")
    pg.wait_for_timeout(60)

    batch_redo_img = pg.evaluate("window.__walImageMutations ? window.__walImageMutations.slice(-1)[0] : null")
    batch_redo_txt = pg.evaluate("window.__walTextMutations ? window.__walTextMutations.slice(-1)[0] : null")
    check("batch deletion redo journals delete mutations to WAL IPC",
          batch_redo_img and batch_redo_img.get("op") == "delete" and batch_redo_img.get("imageId") == "img_batch_1" and
          batch_redo_txt and batch_redo_txt.get("op") == "delete" and batch_redo_txt.get("textId") == "txt_batch_1",
          f"img={batch_redo_img} txt={batch_redo_txt}")

    # 4. Transform Objects Undo / Redo
    pg.evaluate("""(() => {
        window.__walImageMutations = [];
        window.__walTextMutations = [];
        window.documentOps.commitTransform({
            initialStrokes: [],
            initialImages: [{ id: 'img_tr_1', x: 10, y: 10, width: 50, height: 50 }],
            initialTextObjects: [{ id: 'txt_tr_1', x: 20, y: 20, fontSize: 16 }],
            finalStrokes: [],
            finalImages: [{ id: 'img_tr_1', x: 100, y: 100, width: 80, height: 80 }],
            finalTextObjects: [{ id: 'txt_tr_1', x: 120, y: 120, fontSize: 20 }]
        });
    })()""")
    pg.wait_for_timeout(60)

    # Undo transform -> expect initial values upserted
    pg.evaluate("window.documentOps.performUndo()")
    pg.wait_for_timeout(60)

    tr_undo_img = pg.evaluate("window.__walImageMutations ? window.__walImageMutations.slice(-1)[0] : null")
    tr_undo_txt = pg.evaluate("window.__walTextMutations ? window.__walTextMutations.slice(-1)[0] : null")
    check("transform undo journals initial state upserts to WAL IPC",
          tr_undo_img and tr_undo_img.get("op") == "upsert" and tr_undo_img.get("image", {}).get("x") == 10 and
          tr_undo_txt and tr_undo_txt.get("op") == "upsert" and tr_undo_txt.get("text", {}).get("x") == 20,
          f"img={tr_undo_img} txt={tr_undo_txt}")

    # Redo transform -> expect final values upserted
    pg.evaluate("window.documentOps.performRedo()")
    pg.wait_for_timeout(60)

    tr_redo_img = pg.evaluate("window.__walImageMutations ? window.__walImageMutations.slice(-1)[0] : null")
    tr_redo_txt = pg.evaluate("window.__walTextMutations ? window.__walTextMutations.slice(-1)[0] : null")
    check("transform redo journals final state upserts to WAL IPC",
          tr_redo_img and tr_redo_img.get("op") == "upsert" and tr_redo_img.get("image", {}).get("x") == 100 and
          tr_redo_txt and tr_redo_txt.get("op") == "upsert" and tr_redo_txt.get("text", {}).get("x") == 120,
          f"img={tr_redo_img} txt={tr_redo_txt}")

    # 5. Batch Delete Forward Mutation
    pg.evaluate("""(() => {
        window.__walImageMutations = [];
        window.__walTextMutations = [];
        window.documentOps.deleteObjectsBatch({
            strokes: [],
            images: [{ id: 'img_fwd_del_1', sheet: 0, x: 50, y: 50, width: 40, height: 40 }],
            textObjects: [{ id: 'txt_fwd_del_1', sheet: 0, x: 60, y: 60, text: 'fwd item' }]
        });
    })()""")
    pg.wait_for_timeout(60)

    fwd_del_img = pg.evaluate("window.__walImageMutations ? window.__walImageMutations.slice(-1)[0] : null")
    fwd_del_txt = pg.evaluate("window.__walTextMutations ? window.__walTextMutations.slice(-1)[0] : null")
    check("forward batch deletion journals delete mutations to WAL IPC",
          fwd_del_img and fwd_del_img.get("op") == "delete" and fwd_del_img.get("imageId") == "img_fwd_del_1" and
          fwd_del_txt and fwd_del_txt.get("op") == "delete" and fwd_del_txt.get("textId") == "txt_fwd_del_1",
          f"img={fwd_del_img} txt={fwd_del_txt}")

    # 6. Transform Stroke Metadata Preservation
    pg.evaluate("""(() => {
        window.__committedStrokes = [];
        const originalStroke = {
            id: 'st_tr_meta_1',
            sheet: 1,
            kind: 'highlighter',
            rgb: [1.0, 0.9, 0.2],
            base_width: 8.0,
            points: [{ x: 10, y: 10, p: 0.5 }, { x: 20, y: 20, p: 0.5 }]
        };
        window.state.strokes.push(originalStroke);
        window.documentOps.commitTransform({
            initialStrokes: [originalStroke],
            initialImages: [],
            initialTextObjects: [],
            finalStrokes: [{
                ...originalStroke,
                points: [{ x: 50, y: 50, p: 0.5 }, { x: 60, y: 60, p: 0.5 }]
            }],
            finalImages: [],
            finalTextObjects: []
        });
    })()""")
    pg.wait_for_timeout(60)

    # Undo transform on stroke
    pg.evaluate("window.documentOps.performUndo()")
    pg.wait_for_timeout(60)

    tr_meta_stroke = pg.evaluate("""(() => {
        const s = window.state.strokes.find(st => st.id === 'st_tr_meta_1');
        return s ? { sheet: s.sheet, kind: s.kind, rgb: s.rgb, base_width: s.base_width, p0: s.points[0] } : null;
    })()""")
    check("transform undo cleanly restores stroke metadata (sheet, kind, rgb, base_width)",
          tr_meta_stroke and tr_meta_stroke["sheet"] == 1 and tr_meta_stroke["kind"] == "highlighter" and
          abs(tr_meta_stroke["base_width"] - 8.0) < 0.01 and tr_meta_stroke["p0"]["x"] == 10,
          f"stroke={tr_meta_stroke}")

    # -------------------------------------------------------------
    # T13: Document Text Layer Isolation & Page Shift Cache
    # -------------------------------------------------------------
    print("\n=== T13 Document Text Layer Isolation & Page Shift Cache ===", flush=True)
    # 1. Page text cache shifting on page insertion
    pg.evaluate("""(() => {
        window.state.pageTextData = {
            0: { page_index: 0, text: 'Page 0 text' },
            1: { page_index: 1, text: 'Page 1 text' }
        };
        window.state.pageTextSpans = {
            0: [{ text: 'Page 0 span', rect: [0, 0, 10, 10], page_index: 0 }],
            1: [{ text: 'Page 1 span', rect: [0, 0, 10, 10], page_index: 1 }]
        };
        window.documentOps.insertPageAtIndex(0, { page_index: 0, width_pt: 612, height_pt: 792 });
    })()""")
    pg.wait_for_timeout(60)

    shift_ok = pg.evaluate("""(() => {
        const d0 = window.state.pageTextData[0];
        const d1 = window.state.pageTextData[1];
        const d2 = window.state.pageTextData[2];
        const s0 = window.state.pageTextSpans[0];
        const s1 = window.state.pageTextSpans[1];
        const s2 = window.state.pageTextSpans[2];
        return d0 === undefined && d1?.text === 'Page 0 text' && d2?.text === 'Page 1 text' &&
               s0 === undefined && s1?.[0]?.text === 'Page 0 span' && s2?.[0]?.text === 'Page 1 span';
    })()""")
    check("inserting a page at index 0 shifts pageTextData and pageTextSpans", shift_ok)

    # 2. Text layer, selection, and search isolation on setDocument
    pg.evaluate("""(() => {
        window.state.pageTextData = { 0: { page_index: 0, text: 'Old doc text' } };
        window.state.pageTextSpans = { 0: [{ text: 'Old doc span' }] };
        window.state.pageTextLoading = { 0: Promise.resolve() };
        window.state.selectedTextSpans = [{ text: 'Old span' }];
        window.state.selectedTextString = 'Old span';
        window.state.textSelection = { sheet: 0, startCharIdx: 0, endCharIdx: 8, text: 'Old span' };
        window.state.textSelectAnchor = { sheet: 0, charIndex: 0 };
        window.state.textSelectPending = { sheet: 0 };
        window.state.isSelectingText = true;
        window.state.searchQuery = 'search term';
        window.state.searchResults = [{ sheet: 0, rects: [] }];
        window.state.activeSearchMatch = 1;
        window.state.isSearching = true;

        window.documentOps.setDocument({
            pageInfos: [
                { page_index: 0, width_pt: 612, height_pt: 792 },
                { page_index: 1, width_pt: 612, height_pt: 792 }
            ],
            strokes: []
        });
    })()""")
    pg.wait_for_timeout(60)

    doc_reset_res = pg.evaluate("""(() => {
        return {
            textDataEmpty: Object.keys(window.state.pageTextData || {}).length === 0,
            textSpansEmpty: Object.keys(window.state.pageTextSpans || {}).length === 0,
            textLoadingEmpty: Object.keys(window.state.pageTextLoading || {}).length === 0,
            selSpansEmpty: (window.state.selectedTextSpans || []).length === 0,
            selStringEmpty: window.state.selectedTextString === '',
            textSelNull: window.state.textSelection === null,
            textAnchorNull: window.state.textSelectAnchor === null,
            textPendingNull: window.state.textSelectPending === null,
            isSelectingFalse: window.state.isSelectingText === false,
            searchQueryEmpty: window.state.searchQuery === '',
            searchResultsEmpty: (window.state.searchResults || []).length === 0,
            activeSearchZero: window.state.activeSearchMatch === 0,
            isSearchingFalse: window.state.isSearching === false,
        };
    })()""")
    check("setDocument clears pageTextData and pageTextSpans cache",
          doc_reset_res["textDataEmpty"] and doc_reset_res["textSpansEmpty"] and doc_reset_res["textLoadingEmpty"],
          f"data={doc_reset_res}")
    check("setDocument clears textSelection and selection state",
          doc_reset_res["textSelNull"] and doc_reset_res["selStringEmpty"] and doc_reset_res["selSpansEmpty"] and doc_reset_res["isSelectingFalse"])
    check("setDocument clears searchResults and search query",
          doc_reset_res["searchResultsEmpty"] and doc_reset_res["searchQueryEmpty"] and doc_reset_res["isSearchingFalse"] and doc_reset_res["activeSearchZero"])

    # -------------------------------------------------------------
    # T15: Dual-Pane Split View Architecture & Synchronization
    # -------------------------------------------------------------
    print("\n=== T15 Dual-Pane Split View Architecture ===", flush=True)

    # 1. Toggling view.toggleSplit makes #splitDivider and #splitPageNavCluster visible and activates both buttons
    split_initial = pg.evaluate("""(() => {
        window.commands.execute('view.toggleSplit');
        const divider = document.getElementById('splitDivider');
        const cluster = document.getElementById('splitPageNavCluster');
        const btnRail = document.getElementById('btnRailSplit');
        const btnZoom = document.getElementById('btnZoomSplit');
        return {
            splitMode: window.getViewport().splitMode,
            dividerVisible: divider && !divider.classList.contains('hidden'),
            clusterVisible: cluster && !cluster.classList.contains('hidden'),
            railActive: btnRail && btnRail.classList.contains('active'),
            zoomActive: btnZoom && btnZoom.classList.contains('active'),
            zoom: window.getViewport().zoom,
            rightSheet: window.state.rightSheet,
        };
    })()""")
    check("toggling view.toggleSplit activates split mode, displays divider and buttons",
          split_initial["splitMode"] and split_initial["dividerVisible"] and split_initial["clusterVisible"] and
          split_initial["railActive"] and split_initial["zoomActive"],
          f"res={split_initial}")
    check("split toggle on page 1 sets viewport.zoom to a finite number and state.rightSheet == 1",
          math.isfinite(split_initial["zoom"]) and split_initial["zoom"] > 0 and split_initial["rightSheet"] == 1,
          f"res={split_initial}")

    # 2. Opening a drawer while in split mode preserves .active on #btnRailSplit
    drawer_split_ok = pg.evaluate("""(() => {
        window.drawers.openDrawer('thumbnails');
        const btnRail = document.getElementById('btnRailSplit');
        const stillActive = btnRail && btnRail.classList.contains('active');
        window.drawers.closeDrawer();
        return stillActive;
    })()""")
    check("opening a drawer in split mode preserves .active on #btnRailSplit", drawer_split_ok)

    # 3. Dragging #splitDivider updates _viewport.splitRatio and compositor.paneBounds('left').width
    divider_drag_ok = pg.evaluate("""(() => {
        const divider = document.getElementById('splitDivider');
        const stage = document.getElementById('stage');
        const rect = stage.getBoundingClientRect();
        // Simulate dragging to 60%
        const targetX = rect.left + rect.width * 0.6;
        divider.dispatchEvent(new PointerEvent('pointerdown', { clientX: rect.left + rect.width * 0.5, bubbles: true }));
        divider.dispatchEvent(new PointerEvent('pointermove', { clientX: targetX, bubbles: true }));
        divider.dispatchEvent(new PointerEvent('pointerup', { clientX: targetX, bubbles: true }));

        const ratioAfterDrag = window.getViewport().splitRatio;
        const leftWidthAfterDrag = window.compositor.paneBounds('left').width;
        const expectedW = Math.round(rect.width * 0.6);

        // Test double-click reset to 0.5
        divider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        const ratioAfterDblClick = window.getViewport().splitRatio;

        return {
            dragRatioNear60: Math.abs(ratioAfterDrag - 0.6) < 0.05,
            widthMatchesDrag: Math.abs(leftWidthAfterDrag - expectedW) < 5,
            resetToHalf: ratioAfterDblClick === 0.5
        };
    })()""")
    check("dragging #splitDivider updates splitRatio and left pane bounds, dblclick resets to 0.5",
          divider_drag_ok["dragRatioNear60"] and divider_drag_ok["widthMatchesDrag"] and divider_drag_ok["resetToHalf"],
          f"res={divider_drag_ok}")

    # 4. Navigating panes and per-pane independent zoom
    split_nav_zoom_ok = pg.evaluate("""(() => {
        if (!window.getViewport().splitMode) {
            window.commands.execute('view.toggleSplit'); // ensure split mode is on
        }
        const vp = window.getViewport();
        const leftEl = document.getElementById('leftPanePageNum');
        const rightEl = document.getElementById('rightPanePageNum');
        const hlLeft = document.getElementById('paneHighlightLeft');
        const hlRight = document.getElementById('paneHighlightRight');

        // Test pointerdown pane activation
        const stage = document.getElementById('stage');
        const r = stage.getBoundingClientRect();
        stage.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + r.width * 0.75, clientY: r.top + 50, bubbles: true }));
        const activePaneAfterClick = window.state.drawingPane;
        const rightHlActive = hlRight && hlRight.classList.contains('pane-active');

        // Set 4 pages so we can navigate
        window.documentOps.setDocument({
            pageInfos: [
                { page_index: 0, width_pt: 612, height_pt: 792 },
                { page_index: 1, width_pt: 612, height_pt: 792 },
                { page_index: 2, width_pt: 612, height_pt: 792 },
                { page_index: 3, width_pt: 612, height_pt: 792 }
            ],
            strokes: []
        });
        if (!window.getViewport().splitMode) {
            window.commands.execute('view.toggleSplit');
        }

        // Test right pane navigation button
        const btnRightNext = document.getElementById('btnRightPaneNext');
        if (btnRightNext) btnRightNext.click();
        const rightBadgeAfterNext = rightEl ? rightEl.textContent : '';

        // Test per-pane independent zoom
        const zoomLeftBefore = vp.zoom;
        const btnRightZoomIn = document.getElementById('btnRightZoomIn');
        if (btnRightZoomIn) btnRightZoomIn.click();
        const zoomLeftAfterRightZoom = vp.zoom;
        const zoomRightAfterZoom = vp.rightZoom;
        const leftZoomUnaffected = (zoomLeftBefore === zoomLeftAfterRightZoom);
        const rightZoomIncreased = (zoomRightAfterZoom > zoomLeftBefore);

        // Test btnRightZoomFit fits right pane without resetting left zoom
        const btnRightZoomFit = document.getElementById('btnRightZoomFit');
        if (btnRightZoomFit) btnRightZoomFit.click();
        const zoomLeftAfterRightFit = vp.zoom;
        const leftZoomStillUnaffected = (zoomLeftBefore === zoomLeftAfterRightFit);

        // Test split thumbnail integration and active card highlighting
        window.drawers.renderThumbnails();
        const card0 = document.querySelector('.thumb-card[data-page="0"]');
        const card2 = document.querySelector('.thumb-card[data-page="2"]');
        const card0IsLeft = card0 && card0.classList.contains('active-left');
        const card2IsRight = card2 && card2.classList.contains('active-right');

        // Test thumbnail click targeting active pane (right pane active)
        const card3 = document.querySelector('.thumb-card[data-page="3"]');
        if (card3) card3.click();
        const rightSheetAfterThumbClick = window.state.rightSheet;
        const leftSheetAfterThumbClick = window.state.leftSheet;

        // Toggle split off and restore original 2-page document fixture
        window.commands.execute('view.toggleSplit');
        const splitOff = !window.getViewport().splitMode;
        const dividerHidden = document.getElementById('splitDivider').classList.contains('hidden');

        window.documentOps.setDocument({
            pageInfos: [
                { page_index: 0, width_pt: 612, height_pt: 792 },
                { page_index: 1, width_pt: 612, height_pt: 792 }
            ],
            strokes: []
        });

        return {
            activePaneAfterClick,
            rightHlActive,
            rightBadgeAfterNext,
            leftZoomUnaffected,
            rightZoomIncreased,
            leftZoomStillUnaffected,
            card0IsLeft,
            card2IsRight,
            rightSheetAfterThumbClick,
            leftSheetAfterThumbClick,
            splitOff,
            dividerHidden
        };
    })()""")
    check("clicking stage right pane activates drawingPane and pane highlight",
          split_nav_zoom_ok["activePaneAfterClick"] == 'right' and split_nav_zoom_ok["rightHlActive"],
          f"res={split_nav_zoom_ok}")
    check("navigating right pane updates #rightPanePageNum badge to page 3",
          split_nav_zoom_ok["rightBadgeAfterNext"] == '3',
          f"res={split_nav_zoom_ok}")
    check("per-pane zoom in and fit buttons isolate zoom to target pane without altering other pane",
          split_nav_zoom_ok["leftZoomUnaffected"] and split_nav_zoom_ok["rightZoomIncreased"] and split_nav_zoom_ok["leftZoomStillUnaffected"],
          f"res={split_nav_zoom_ok}")
    check("split view highlights left and right page cards with distinct active-left and active-right indicators",
          split_nav_zoom_ok["card0IsLeft"] and split_nav_zoom_ok["card2IsRight"],
          f"res={split_nav_zoom_ok}")
    check("clicking a thumbnail card navigates the currently active pane in split view",
          split_nav_zoom_ok["rightSheetAfterThumbClick"] == 3 and split_nav_zoom_ok["leftSheetAfterThumbClick"] == 0,
          f"res={split_nav_zoom_ok}")

    # 5. Trackpad gesturestart / gesturechange updates zoom without throwing relY ReferenceError
    gesture_res = pg.evaluate("""(() => {
        const vp = window.getViewport();
        const initialZoom = vp.zoom;
        const gStart = new Event('gesturestart', { bubbles: true, cancelable: true });
        gStart.clientX = 300;
        gStart.clientY = 300;
        window.dispatchEvent(gStart);

        const gChange = new Event('gesturechange', { bubbles: true, cancelable: true });
        gChange.clientX = 300;
        gChange.clientY = 300;
        gChange.scale = 1.5;
        window.dispatchEvent(gChange);

        const zoomed = vp.zoom;

        const gEnd = new Event('gestureend', { bubbles: true, cancelable: true });
        window.dispatchEvent(gEnd);

        // Reset zoom back to initial
        vp.setZoom(initialZoom, [300, 300], 'left');

        return {
            initialZoom,
            zoomed,
            zoomIncreased: zoomed > initialZoom * 1.4,
            hasCancelFunc: typeof window.cancelPendingTouchStroke === 'function'
        };
    })()""")
    check("trackpad gesturestart/change zooms cleanly without relY ReferenceError",
          gesture_res["zoomIncreased"] and gesture_res["hasCancelFunc"],
          f"res={gesture_res}")

    # 6. Two-finger touch pinch zooms viewport and commits zero strokes to document
    touch_pinch_res = pg.evaluate("""(() => {
        const vp = window.getViewport();
        const stage = document.getElementById('stage');
        const wetCanvas = document.getElementById('wet');
        const initialStrokes = (window.state.strokes || []).length;
        const initialZoom = vp.zoom;

        // Finger 1 down on wetCanvas
        wetCanvas.dispatchEvent(new PointerEvent('pointerdown', {
            pointerId: 101, pointerType: 'touch', clientX: 200, clientY: 200, bubbles: true
        }));

        // Finger 2 down on wetCanvas (triggers pinch arbitration)
        wetCanvas.dispatchEvent(new PointerEvent('pointerdown', {
            pointerId: 102, pointerType: 'touch', clientX: 300, clientY: 200, bubbles: true
        }));

        const isPinchingDuring = vp.isPinching;

        // Move fingers apart
        window.dispatchEvent(new PointerEvent('pointermove', {
            pointerId: 101, pointerType: 'touch', clientX: 150, clientY: 200, bubbles: true
        }));
        window.dispatchEvent(new PointerEvent('pointermove', {
            pointerId: 102, pointerType: 'touch', clientX: 350, clientY: 200, bubbles: true
        }));

        const zoomAfterPinch = vp.zoom;

        // Release fingers
        window.dispatchEvent(new PointerEvent('pointerup', {
            pointerId: 101, pointerType: 'touch', clientX: 150, clientY: 200, bubbles: true
        }));
        window.dispatchEvent(new PointerEvent('pointerup', {
            pointerId: 102, pointerType: 'touch', clientX: 350, clientY: 200, bubbles: true
        }));

        const strokesAfter = (window.state.strokes || []).length;
        const finalPinching = vp.isPinching;

        // Reset zoom
        vp.setZoom(initialZoom, [200, 200], 'left');

        return {
            isPinchingDuring,
            zoomIncreased: zoomAfterPinch > initialZoom * 1.5,
            zeroStrokesCommitted: strokesAfter === initialStrokes,
            pinchCleanedUp: !finalPinching
        };
    })()""")
    check("two-finger touch pinch scales viewport and commits zero unwanted strokes",
          touch_pinch_res["isPinchingDuring"] and touch_pinch_res["zoomIncreased"] and
          touch_pinch_res["zeroStrokesCommitted"] and touch_pinch_res["pinchCleanedUp"],
          f"res={touch_pinch_res}")

    # -------------------------------------------------------------
    # T16: Regression & Edge Case Hardening (Waves 069-076)
    # -------------------------------------------------------------
    print("\n=== T16 Regression & Edge Case Hardening (Waves 069-076) ===", flush=True)

    # 1. Chisel stroke tool path delegation
    chisel_path_res = pg.evaluate("""(() => {
        const s = {
            id: 'test_chisel_1',
            tool: 'chisel',
            kind: 'chisel',
            base_width: 12,
            points: [{ x: 30, y: 30, p: 0.5 }, { x: 70, y: 70, p: 0.8 }, { x: 110, y: 80, p: 0.6 }]
        };
        const p2d = window.Ink && typeof window.Ink.getPath2D === 'function' ? window.Ink.getPath2D(s) : null;
        return {
            hasGetPath2D: !!(window.Ink && typeof window.Ink.getPath2D === 'function'),
            isPath2D: p2d instanceof Path2D
        };
    })()""")
    check("chisel stroke tool delegates correctly to getChiselPath2D returning Path2D instance",
          chisel_path_res["hasGetPath2D"] and chisel_path_res["isPath2D"],
          f"res={chisel_path_res}")

    # 2. Escape key dismisses confirmDeletePageModal
    modal_esc_res = pg.evaluate("""(async () => {
        const modal = document.getElementById('confirmDeletePageModal');
        const drawers = await import('./js/ui/drawers.js');
        if (!modal || typeof drawers.confirmDeletePageDialog !== 'function') {
            return { modalFound: false, hasFunc: !!(drawers && drawers.confirmDeletePageDialog) };
        }
        const dialogPromise = drawers.confirmDeletePageDialog(1);
        const isOpen = !modal.classList.contains('hidden');

        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const resolvedResult = await dialogPromise;
        const isClosed = modal.classList.contains('hidden');

        return {
            modalFound: true,
            hasFunc: true,
            isOpen,
            resolvedResult,
            isClosed
        };
    })()""")
    check("Escape key dismisses confirmDeletePageModal and resolves dialog to false",
          modal_esc_res.get("modalFound") and modal_esc_res.get("isOpen") and
          modal_esc_res.get("resolvedResult") is False and modal_esc_res.get("isClosed"),
          f"res={modal_esc_res}")

    # 3. Page layout coordinate aliases and dimensions
    pl_coords_res = pg.evaluate("""(() => {
        const vp = window.getViewport();
        const pl = vp.pageLayouts && vp.pageLayouts[0];
        if (!pl) return { hasLayout: false };
        return {
            hasLayout: true,
            hasWidth: typeof pl.width === 'number' && !isNaN(pl.width) && pl.width > 0,
            hasHeight: typeof pl.height === 'number' && !isNaN(pl.height) && pl.height > 0,
            hasW: typeof pl.w === 'number' && !isNaN(pl.w) && pl.w > 0,
            hasH: typeof pl.h === 'number' && !isNaN(pl.h) && pl.h > 0,
            wEqualsWidth: pl.w === pl.width,
            hEqualsHeight: pl.h === pl.height
        };
    })()""")
    check("viewport pageLayouts provides consistent width/w and height/h dimensions for coordinate arithmetic",
          pl_coords_res.get("hasLayout") and pl_coords_res.get("hasWidth") and
          pl_coords_res.get("hasW") and pl_coords_res.get("wEqualsWidth") and
          pl_coords_res.get("hEqualsHeight"),
          f"res={pl_coords_res}")

    # -------------------------------------------------------------
    # T17: Annotation Review & Markdown Summary
    # -------------------------------------------------------------
    print("\n=== T17 Annotation Review & Markdown Summary ===", flush=True)

    # Earlier isolation tests reduce the document to a single page; restore a
    # second page so cross-page review and presentation paging are testable.
    pg.evaluate("""(async () => {
        const doc = await import('./js/core/document.js');
        if ((window.state.pageInfos || []).length < 2) {
            doc.insertPageAtIndex(1, { page_index: 1, width_pt: 595, height_pt: 842 }, { recordHistory: false });
            if (window.getViewport()) window.getViewport().updateDocumentLayout(window.state.pageInfos);
        }
    })()""")
    pg.wait_for_timeout(150)

    # Seed one deterministic text note and one extra ink stroke.
    pg.evaluate("""(async () => {
        const doc = await import('./js/core/document.js');
        doc.addObjectsBatch({
            strokes: [{
                id: 'ink_t17_1', sheet: 0, kind: 'pen', rgb: [0.18, 0.25, 0.55], base_width: 2.2,
                points: [{x: 120, y: 520, p: 0.7}, {x: 210, y: 545, p: 0.7}, {x: 300, y: 530, p: 0.7}],
                deleted: false
            }],
            textObjects: [
                {id: 'note_t17_1', sheet: 0, x: 120, y: 600, text: 'T17 unique review note about eigenvalues', fontSize: 16, color: '#141724', bold: false, italic: false, width: 260, height: 30},
                {id: 'note_t17_2', sheet: 1, x: 140, y: 260, text: 'Second page reminder for T17', fontSize: 16, color: '#1d4ed8', bold: false, italic: false, width: 240, height: 30}
            ]
        });
    })()""")
    pg.wait_for_timeout(250)

    total_annotations = pg.evaluate("window.annotationsPanel.annotationCount()")
    pg.evaluate("window.drawers.openDrawer('annotations')")
    pg.wait_for_timeout(300)
    drawer_cards = pg.locator("#annotationList .annotation-card").count()
    badge_text = pg.inner_text("#badgeAnnotations")
    check("annotation review lists every annotation and keeps the rail badge in sync",
          drawer_cards == total_annotations and badge_text == str(total_annotations),
          f"cards={drawer_cards} total={total_annotations} badge={badge_text}")

    pg.locator('#annotationFilterChips .annotation-filter-chip[data-filter="note"]').click()
    pg.wait_for_timeout(150)
    note_categories = pg.eval_on_selector_all("#annotationList .annotation-card", "els => [...new Set(els.map(e => e.dataset.category))]")
    note_cards = pg.locator("#annotationList .annotation-card").count()
    check("annotation type filter isolates text notes", note_categories == ["note"] and note_cards >= 2, f"cats={note_categories} n={note_cards}")

    pg.locator('#annotationFilterChips .annotation-filter-chip[data-filter="all"]').click()
    pg.fill("#annotationSearchInput", "eigenvalues")
    pg.wait_for_timeout(220)
    search_cards = pg.locator("#annotationList .annotation-card").count()
    search_text = pg.inner_text("#annotationList")
    check("annotation search matches note content", search_cards == 1 and "eigenvalues" in search_text, f"n={search_cards}")
    pg.fill("#annotationSearchInput", "")
    pg.wait_for_timeout(180)

    # Jump-to selects the underlying object and navigates to its page.
    pg.locator('.annotation-card[data-annotation-id="note_t17_2"]').click()
    pg.wait_for_timeout(250)
    focus_res = pg.evaluate("({ sel: window.state.selectedTextObjects.map(t => t.id), page: window.state.leftSheet, tool: window.state.activeTool })")
    check("clicking a review item jumps to the page and selects the object",
          focus_res["sel"] == ["note_t17_2"] and focus_res["page"] == 1 and focus_res["tool"] == "lasso",
          f"res={focus_res}")

    # Edit button opens the inline text editor for a review note.
    pg.eval_on_selector('.annotation-card[data-annotation-id="note_t17_1"] .annotation-edit', "el => el.click()")
    pg.wait_for_timeout(250)
    edit_res = pg.evaluate("""(() => ({
        visible: !document.getElementById('inlineTextEditor').classList.contains('hidden'),
        value: document.getElementById('inlineTextarea').value
    }))()""")
    pg.evaluate("import('./js/tools/text.js').then(t => t.cancelEditing())")
    pg.wait_for_timeout(100)
    check("review notes expose an inline editor with the original text",
          edit_res["visible"] and "eigenvalues" in edit_res["value"], f"res={edit_res}")

    # Markdown summary copy path.
    pg.locator("#btnAnnotationSummary").click()
    pg.wait_for_timeout(250)
    summary = pg.evaluate("navigator.clipboard.readText()")
    check("copy summary exports a page-grouped Markdown digest",
          summary.startswith("# Annotations") and "## Page 1" in summary and "eigenvalues" in summary,
          f"len={len(summary)}")

    # Delete from the review list, then undo restores it.
    count_before_delete = pg.evaluate("window.annotationsPanel.annotationCount()")
    pg.eval_on_selector('.annotation-card[data-annotation-id="note_t17_2"] .annotation-delete', "el => el.click()")
    pg.wait_for_timeout(250)
    count_after_delete = pg.evaluate("window.annotationsPanel.annotationCount()")
    pg.evaluate("window.commands.execute('edit.undo')")
    pg.wait_for_timeout(250)
    count_after_undo = pg.evaluate("window.annotationsPanel.annotationCount()")
    check("deleting a review item is undoable",
          count_after_delete == count_before_delete - 1 and count_after_undo == count_before_delete,
          f"before={count_before_delete} after={count_after_delete} undo={count_after_undo}")
    pg.evaluate("window.drawers.closeDrawer()")
    pg.wait_for_timeout(150)

    # -------------------------------------------------------------
    # T18: Signature & Stamp Studio
    # -------------------------------------------------------------
    print("\n=== T18 Signature & Stamp Studio ===", flush=True)
    pg.locator("#btnDockSignature").click()
    pg.wait_for_timeout(250)
    pad_box = pg.locator("#signaturePad").bounding_box()
    pg.mouse.move(pad_box["x"] + 70, pad_box["y"] + 140)
    pg.mouse.down()
    for i in range(26):
        pg.mouse.move(pad_box["x"] + 70 + i * 13, pad_box["y"] + 140 - 30 * math.sin(i / 3.2))
    pg.mouse.up()
    pg.wait_for_timeout(150)
    placeholder_hidden = pg.evaluate("document.getElementById('sigPadPlaceholder').classList.contains('hidden')")
    pg.locator("#btnSigInsert").click()
    pg.wait_for_timeout(650)
    sig_res = pg.evaluate("""(() => {
        const imgs = window.state.images || [];
        const sig = imgs[imgs.length - 1] || null;
        return {
            found: !!sig && String(sig.id).startsWith('signature_'),
            kind: sig ? sig.kind : null,
            selected: (window.state.selectedImages || []).length === 1,
            modalClosed: document.getElementById('signatureModal').classList.contains('hidden'),
            saved: window.signatureStudio.getSavedSignatureCount()
        };
    })()""")
    check("drawn signature inserts as a real PDF image, selects it, and is saved locally",
          placeholder_hidden and sig_res["found"] and sig_res["kind"] == "signature" and
          sig_res["selected"] and sig_res["modalClosed"] and sig_res["saved"] >= 1,
          f"res={sig_res}")

    pg.locator("#btnDockSignature").click()
    pg.wait_for_timeout(200)
    pg.locator('.sig-tab[data-sig-tab="stamp"]').click()
    pg.wait_for_timeout(200)
    stamp_cards = pg.locator(".sig-stamp-card").count()
    pg.locator(".sig-stamp-card").first.click()
    pg.locator("#btnSigInsert").click()
    pg.wait_for_timeout(500)
    stamp_res = pg.evaluate("""(() => {
        const imgs = window.state.images || [];
        const stamp = imgs[imgs.length - 1] || null;
        const anno = window.annotationsPanel.collectAnnotations().filter(a => a.category === 'image');
        return {
            found: !!stamp && String(stamp.id).startsWith('stamp_'),
            label: stamp ? stamp.label : null,
            kind: stamp ? stamp.kind : null,
            imageAnnotations: anno.length
        };
    })()""")
    check("stamp presets insert as labelled PDF images and appear in the review list",
          stamp_cards == 8 and stamp_res["found"] and stamp_res["kind"] == "stamp" and
          stamp_res["label"] == "APPROVED" and stamp_res["imageAnnotations"] >= 2,
          f"cards={stamp_cards} res={stamp_res}")

    # -------------------------------------------------------------
    # T19: Presentation Mode
    # -------------------------------------------------------------
    print("\n=== T19 Presentation Mode ===", flush=True)
    pg.evaluate("window.navigation.goToPage(0, 'left', window.getViewport(), false)")
    pg.wait_for_timeout(120)
    pg.keyboard.press("F5")
    pg.wait_for_timeout(650)
    present_on = pg.evaluate("""(() => ({
        flag: window.state.presentationMode,
        bodyClass: document.body.classList.contains('presentation-mode'),
        hud: !document.getElementById('presentationHud').classList.contains('hidden'),
        headerHidden: document.getElementById('topHeader').offsetParent === null,
        railHidden: document.getElementById('navRail').offsetParent === null,
        label: document.getElementById('presentPageLabel').textContent
    }))()""")
    check("presentation mode hides chrome, fits the page and shows the stage HUD",
          present_on["flag"] and present_on["bodyClass"] and present_on["hud"] and
          present_on["headerHidden"] and present_on["railHidden"], f"res={present_on}")

    pg.keyboard.press("ArrowRight")
    pg.wait_for_timeout(500)
    after_next = pg.evaluate("({ page: window.state.leftSheet, label: document.getElementById('presentPageLabel').textContent })")
    check("presentation arrow keys page the document and keep the HUD honest",
          after_next["page"] == 1 and after_next["label"].startswith("2 /"), f"res={after_next}")

    pg.keyboard.press("b")
    pg.wait_for_timeout(200)
    blank_on = pg.evaluate("document.body.classList.contains('presentation-blank') && !document.getElementById('presentationBlank').classList.contains('hidden')")
    pg.keyboard.press("b")
    pg.wait_for_timeout(150)
    blank_off = pg.evaluate("!document.body.classList.contains('presentation-blank')")
    check("presentation blank-screen cut toggles both ways", blank_on and blank_off, f"on={blank_on} off={blank_off}")

    pg.keyboard.press("Escape")
    pg.wait_for_timeout(450)
    present_off = pg.evaluate("""(() => ({
        flag: window.state.presentationMode,
        bodyClass: document.body.classList.contains('presentation-mode'),
        hudHidden: document.getElementById('presentationHud').classList.contains('hidden'),
        tool: window.state.activeTool
    }))()""")
    check("Escape exits presentation and restores the working stage",
          not present_off["flag"] and not present_off["bodyClass"] and present_off["hudHidden"] and
          present_off["tool"] in ("pen", "lasso", "highlighter", "eraser", "text", "laser", "rect", "ellipse", "line"),
          f"res={present_off}")

    # -------------------------------------------------------------
    # T20: Lazy Thumbnails & Annotation Badges
    # -------------------------------------------------------------
    print("\n=== T20 Lazy Thumbnails & Annotation Badges ===", flush=True)
    pg.evaluate("window.drawers.openDrawer('thumbnails')")
    pg.wait_for_timeout(700)
    thumb_res = pg.evaluate("""(() => {
        const pages = (window.state.pageInfos || []).length;
        const cards = document.querySelectorAll('#thumbnailGrid .thumb-card').length;
        const canvases = document.querySelectorAll('#thumbnailGrid .thumb-card canvas.thumb-canvas').length;
        const rendered = document.querySelectorAll('#thumbnailGrid .thumb-card.thumb-rendered').length;
        const railBadge = document.getElementById('badgeThumbnails').textContent;
        const annoBadges = document.querySelectorAll('#thumbnailGrid .thumb-anno-count').length;
        return { pages, cards, canvases, rendered, railBadge, annoBadges };
    })()""")
    check("thumbnail rail renders all cards with deferred canvas painting",
          thumb_res["cards"] == thumb_res["pages"] and thumb_res["canvases"] == thumb_res["pages"] and
          thumb_res["rendered"] >= 1 and thumb_res["annoBadges"] == thumb_res["pages"],
          f"res={thumb_res}")
    check("thumbnail rail badge reports the true page count", thumb_res["railBadge"] == str(thumb_res["pages"]), f"res={thumb_res}")
    thumb_pixel_res = pg.evaluate("""(() => {
        const canvas = document.querySelector('#thumbnailGrid .thumb-card.thumb-rendered canvas.thumb-canvas');
        if (!canvas) return { ok: false, reason: 'no rendered canvas' };
        const ctx = canvas.getContext('2d');
        if (!ctx) return { ok: false, reason: 'no 2d context' };
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let firstR = data[0], firstG = data[1], firstB = data[2];
        let nonUniform = false;
        for (let i = 4; i < data.length; i += 4) {
            if (data[i] !== firstR || data[i+1] !== firstG || data[i+2] !== firstB) {
                nonUniform = true;
                break;
            }
        }
        return { ok: nonUniform, width: canvas.width, height: canvas.height };
    })()""")
    check("thumbnail canvas has non-uniform pixels after render",
          thumb_pixel_res["ok"] and thumb_pixel_res["width"] == 240,
          f"res={thumb_pixel_res}")
    thumb_template_res = pg.evaluate("""(async () => {
        const offCanvas = document.createElement('canvas');
        offCanvas.width = 240;
        offCanvas.height = 340;
        // Verify true offscreen canvas renders without needing document.body.appendChild
        await window.drawers.drawThumbnailCanvas(offCanvas, 999, { width_pt: 595, height_pt: 842, template: 'dark' });
        const ctx = offCanvas.getContext('2d');
        const data = ctx.getImageData(0, 0, offCanvas.width, offCanvas.height).data;
        const isDarkSlate = data[0] === 15 && data[1] === 23 && data[2] === 42;
        return { ok: isDarkSlate, r: data[0], g: data[1], b: data[2], isConnected: offCanvas.isConnected };
    })()""")
    check("thumbnail canvas renders dark stationery template on standalone offscreen canvas",
          thumb_template_res["ok"] and not thumb_template_res["isConnected"],
          f"res={thumb_template_res}")
    pg.evaluate("window.drawers.closeDrawer()")
    pg.wait_for_timeout(150)

    # -------------------------------------------------------------
    # T21: Custom Color Slots & Property Popover Gating
    # -------------------------------------------------------------
    print("\n=== T21 Custom Colors & Property Popover ===", flush=True)
    pg.evaluate("localStorage.removeItem('inkwell.customColors.v1')")
    pg.locator("#btnDockAddPreset").click()
    pg.wait_for_timeout(200)
    pg.locator('.swatch[data-color="#dc2626"]').click()
    pg.locator('.swatch-custom[data-slot="0"]').click()
    pg.wait_for_timeout(150)
    saved_slots = pg.evaluate("JSON.parse(localStorage.getItem('inkwell.customColors.v1') || '[]')")
    pg.locator('.swatch[data-color="#16a34a"]').click()
    pg.locator('.swatch-custom.filled[data-slot="0"]').click()
    pg.wait_for_timeout(150)
    applied = pg.evaluate("window.state.color")
    pg.locator('.swatch-custom[data-slot="0"]').click(button="right")
    pg.wait_for_timeout(150)
    cleared_slots = pg.evaluate("JSON.parse(localStorage.getItem('inkwell.customColors.v1') || '[]')")
    check("custom colour slots save, re-apply and clear duplicate colours",
          saved_slots[0] == "#dc2626" and abs(applied[0] - 0.8627) < 0.01 and cleared_slots[0] is None,
          f"saved={saved_slots} applied={applied} cleared={cleared_slots}")
    pg.locator("#btnClosePropPopover").click()
    pg.wait_for_timeout(100)

    # Shape-kind selector must route triangle/arrow through a live canvas tool.
    pg.locator("#btnDockShapes").click()
    pg.locator("#btnDockAddPreset").click()
    pg.wait_for_timeout(200)
    shape_section_visible = pg.evaluate("getComputedStyle(document.getElementById('popoverShapeSection')).display !== 'none'")
    pg.locator('.btn-shape-select[data-shape="arrow"]').click()
    pg.wait_for_timeout(200)
    arrow_state = pg.evaluate("({ tool: window.state.activeTool, kind: window.state.shapeKind, title: document.getElementById('popoverToolTitle').textContent })")
    pg.locator("#btnClosePropPopover").click()
    before_arrow_strokes = pg.evaluate("(window.state.strokes || []).filter(s => !s.deleted).length")
    wet = pg.locator("#wet").bounding_box()
    pg.mouse.move(wet["x"] + 250, wet["y"] + 250)
    pg.mouse.down()
    pg.mouse.move(wet["x"] + 380, wet["y"] + 315, steps=6)
    pg.mouse.up()
    pg.wait_for_timeout(350)
    after_arrow_strokes = pg.evaluate("(window.state.strokes || []).filter(s => !s.deleted).length")
    check("arrow/triangle shape selector routes to the canvas pipeline and draws",
          shape_section_visible and arrow_state["tool"] == "rect" and arrow_state["kind"] == "arrow" and
          "Arrow" in arrow_state["title"] and after_arrow_strokes == before_arrow_strokes + 1,
          f"state={arrow_state} before={before_arrow_strokes} after={after_arrow_strokes}")

    pg.locator("#btnDockPen").click()
    pg.locator("#btnDockAddPreset").click()
    pg.wait_for_timeout(150)
    pen_section_hidden = pg.evaluate("getComputedStyle(document.getElementById('popoverShapeSection')).display === 'none'")
    pg.locator("#btnClosePropPopover").click()
    check("shape-kind selector is hidden for non-shape tools", pen_section_hidden)

    # -------------------------------------------------------------
    # T22: Settings Engine Panel Nesting
    # -------------------------------------------------------------
    print("\n=== T22 Settings Engine Panel ===", flush=True)
    pg.evaluate("window.toolbar.openSettingsModal(); window.toolbar.switchSettingsTab('tabPerformance')")
    pg.wait_for_timeout(250)
    settings_res = pg.evaluate("""(() => ({
        selectVisible: !!document.getElementById('selectReadingMode').offsetParent,
        cards: document.querySelectorAll('#tabPerformance .settings-card').length,
        panelVisible: !document.getElementById('tabPerformance').classList.contains('hidden')
    }))()""")
    check("engine settings panel keeps valid card nesting and a visible reading-mode selector",
          settings_res["selectVisible"] and settings_res["cards"] >= 4 and settings_res["panelVisible"],
          f"res={settings_res}")
    pg.evaluate("window.toolbar.closeSettingsModal()")
    pg.wait_for_timeout(100)

    # -------------------------------------------------------------
    # T23: Rendering Smoothness (Plan 079 dry page cache, Plan 080 wet chunking)
    # -------------------------------------------------------------
    print("\n=== T23 Offscreen Dry Cache & Incremental Wet Stroke ===", flush=True)
    dry_cache_res = pg.evaluate("""() => {
      const vp = window.getViewport();
      vp.zoom = 1.0;
      // Isolate the cache test from annotations left by earlier sections.
      window.state.images = [];
      window.state.textObjects = [];
      window.state.strokes = [];
      window.state._strokesBySheet = null;
      for (let k = 0; k < 300; k++) {
        const pts = [];
        for (let i = 0; i < 12; i++) pts.push({ x: 40 + i * 4, y: 60 + k * 2, p: 0.7, w: 1.6 });
        window.state.strokes.push({
          id: 'perf_' + k, kind: 'pen', rgb: [0.05, 0.05, 0.1], cssColor: '#111',
          base_width: 1.6, sheet: 0, deleted: false, points: pts,
          bbox: window.Ink.computeStrokeBbox(pts, 1.6),
        });
      }
      window.state._strokesBySheet = null;
      window.compositor.invalidateDryPageCache();
      // Warm-up frame establishes the settled scale; the next one caches.
      window.compositor.redrawAll();
      window.compositor.redrawAll();
      const rendersSettled = window.compositor.getDryPageRenderCount();
      const cacheSize = window.compositor.getDryPageCacheSize();
      vp.panX -= 30; vp.panY -= 20;
      const t0 = performance.now();
      for (let i = 0; i < 5; i++) { window.compositor.redrawAll(); vp.panX -= 2; }
      const panCost = (performance.now() - t0) / 5;
      const rendersAfterPan = window.compositor.getDryPageRenderCount();
      const dryLen = document.getElementById('dry').toDataURL().length;

      // A stroke that spills into the page margin must fall back to the exact
      // vector path (the cached bitmap is page-sized), and still paint.
      const marginPts = [
        { x: 40, y: 800, p: 0.7, w: 1.6 },
        { x: 40, y: 860, p: 0.7, w: 1.6 },
      ];
      window.state.strokes.push({
        id: 'perf_margin', kind: 'pen', rgb: [0.5, 0.05, 0.05], cssColor: '#8a0d0d',
        base_width: 1.6, sheet: 0, deleted: false, points: marginPts,
        bbox: window.Ink.computeStrokeBbox(marginPts, 1.6),
      });
      window.state._strokesBySheet = null;
      window.compositor.redrawAll();
      const rendersAfterMargin = window.compositor.getDryPageRenderCount();
      const dryLenAfterMargin = document.getElementById('dry').toDataURL().length;
      const marginCacheable = window.compositor.isPageCacheable(0);
      return {
        rendersSettled, rendersAfterPan, cacheSize, panCost, dryLen,
        rendersAfterMargin, dryLenAfterMargin, marginCacheable,
        strokes: window.state.strokes.length,
      };
    }""")
    check("pan frames blit the cached #dry page bitmap instead of re-rasterizing ink",
          dry_cache_res["cacheSize"] >= 2 and
          dry_cache_res["rendersAfterPan"] == dry_cache_res["rendersSettled"] and
          dry_cache_res["rendersAfterMargin"] == dry_cache_res["rendersAfterPan"] and
          dry_cache_res["marginCacheable"] is False and
          dry_cache_res["dryLen"] > 5000 and
          dry_cache_res["dryLenAfterMargin"] > 5000,
          f"res={dry_cache_res}")

    wet_chunk_res = pg.evaluate("""() => {
      const vp = window.getViewport();
      window.state.strokes = [];
      window.state._strokesBySheet = null;
      window.compositor.invalidateDryPageCache();
      window.compositor.redrawAll();
      const pl = vp.getPageLayout(0);
      const t0 = performance.now();
      window.penTool.onPenDown({ pressure: 0.6, timeStamp: t0 }, [pl.x + 60, pl.y + 300], 'left', vp);
      const N = 700;
      for (let i = 1; i < N; i++) {
        const wx = pl.x + 60 + i * 0.45;
        const wy = pl.y + 300 + Math.sin(i * 0.05) * 12;
        window.penTool.onPenMove(
          { pressure: 0.6, buttons: 1, timeStamp: t0 + i * 3 }, [wx, wy], 'left', vp, { render: false }
        );
      }
      window.penTool.renderActiveWetStroke('left', vp);
      const chunks = window.state.cur ? window.state.cur._wetChunks.length : -1;
      const chunkedIndex = window.state.cur ? window.state.cur._wetChunkedIndex : -1;
      // Contiguity: every sampled stroke point must be painted on the wet layer.
      const wctx = window.compositor.getContexts().wctx;
      const img = wctx.getImageData(0, 0, wctx.canvas.width, wctx.canvas.height).data;
      const W = wctx.canvas.width, H = wctx.canvas.height;
      let misses = 0, sampled = 0;
      const allPts = window.state.cur.points;
      for (let i = 0; i < allPts.length; i += 17) {
        const [px, py] = vp.worldToScreen(pl.x + allPts[i].x, pl.y + allPts[i].y, 'left');
        sampled++;
        let hit = false;
        for (let dy = -5; dy <= 5 && !hit; dy++) {
          for (let dx = -5; dx <= 5 && !hit; dx++) {
            const xx = Math.round(px + dx), yy = Math.round(py + dy);
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            if (img[(yy * W + xx) * 4 + 3] > 8) hit = true;
          }
        }
        if (!hit) misses++;
      }
      const live = window.state.cur.points.map(p => ({ x: p.x, y: p.y }));
      window.penTool.onPenUp({}, vp);
      const committed = window.state.strokes[window.state.strokes.length - 1];
      const cpts = committed ? committed.points.map(p => ({ x: p.x, y: p.y })) : [];
      let maxDiff = 0;
      if (cpts.length === live.length) {
        for (let i = 0; i < live.length; i++) {
          maxDiff = Math.max(maxDiff, Math.hypot(live[i].x - cpts[i].x, live[i].y - cpts[i].y));
        }
      } else maxDiff = 999;
      return { chunks, chunkedIndex, misses, sampled, maxDiff, points: cpts.length };
    }""")
    check("long wet stroke freezes into Path2D chunks that stay gap-free and commit-exact",
          wet_chunk_res["chunks"] >= 20 and
          wet_chunk_res["chunkedIndex"] >= wet_chunk_res["points"] - 40 and
          wet_chunk_res["misses"] == 0 and
          wet_chunk_res["maxDiff"] < 1e-4,
          f"res={wet_chunk_res}")

    dry_invalidate_res = pg.evaluate("""import('./js/core/document.js').then((docOps) => {
      const stroke = window.state.strokes.find(s => !s.deleted);
      const rendersBefore = window.compositor.getDryPageRenderCount();
      docOps.deleteStrokes([stroke.id], { recordHistory: false });
      const sizeAfterMutation = window.compositor.getDryPageCacheSize();
      window.compositor.redrawAll();
      return {
        sizeAfterMutation,
        sizeAfterRedraw: window.compositor.getDryPageCacheSize(),
        rerendered: window.compositor.getDryPageRenderCount() > rendersBefore,
      };
    })""")
    check("document mutations invalidate the cached #dry page bitmaps",
          dry_invalidate_res["sizeAfterMutation"] == 0 and
          dry_invalidate_res["rerendered"] and
          dry_invalidate_res["sizeAfterRedraw"] >= 1,
          f"res={dry_invalidate_res}")

    # -------------------------------------------------------------
    # T24: Spatial AABB Acceleration (Plan 082)
    # -------------------------------------------------------------
    print("\n=== T24 Lasso AABB Pre-Filtering ===", flush=True)
    lasso_aabb_res = pg.evaluate("""import('./js/tools/lasso.js').then((lassoTool) => {
      const vp = window.getViewport();
      vp.zoom = 1.0;
      const pl = vp.getPageLayout(0);
      const pl1 = vp.getPageLayout(1);
      window.state.strokes = [];
      window.state.images = (window.state.images || []).filter(i => i.deleted);
      window.state.textObjects = (window.state.textObjects || []).filter(t => t.deleted);
      window.state.selectedStrokes = [];
      window.state.selectedImages = [];
      window.state.selectedTextObjects = [];
      const makeStroke = (id, sheet, x, y, lx, ly) => {
        const pts = [
          { x: x, y: y, p: 0.7, w: 1.6 },
          { x: x + lx, y: y + ly, p: 0.7, w: 1.6 },
        ];
        return {
          id, kind: 'pen', rgb: [0.05, 0.05, 0.1], cssColor: '#111', base_width: 1.6,
          sheet, deleted: false, points: pts, bbox: window.Ink.computeStrokeBbox(pts, 1.6),
        };
      };
      // 300 strokes scattered across page 0, 60 on page 1
      for (let k = 0; k < 300; k++) {
        const col = k % 20, row = Math.floor(k / 20);
        window.state.strokes.push(makeStroke('aabb0_' + k, 0, 40 + col * 25, 40 + row * 26, 14, 6));
      }
      for (let k = 0; k < 60; k++) {
        window.state.strokes.push(makeStroke('aabb1_' + k, 1, 40 + (k % 10) * 30, 40 + Math.floor(k / 10) * 30, 14, 6));
      }
      window.state._strokesBySheet = null;

      // Lasso a box around the first two rows of page 0 only.
      const box = [pl.x + 20, pl.y + 20, pl.x + 550, pl.y + 90];
      const down = [box[0], box[1]];
      lassoTool.onLassoDown({}, down, vp.worldToScreen(down[0], down[1], 'left'), 'left', vp);
      const ring = [
        [box[2], box[1]], [box[2], box[3]], [box[0], box[3]], [box[0], box[1]],
      ];
      const t0 = performance.now();
      for (const p of ring) {
        lassoTool.onLassoMove({}, p, vp.worldToScreen(p[0], p[1], 'left'), 'left', vp);
      }
      lassoTool.onLassoUp({}, vp);
      const elapsed = performance.now() - t0;

      const sel = window.state.selectedStrokes;
      const wrongSheet = sel.filter(s => s.sheet !== 0).length;
      const outside = sel.filter(s => {
        const b = s.bbox;
        return pl.x + b[2] < box[0] || pl.x + b[0] > box[2] ||
               pl.y + b[3] < box[1] || pl.y + b[1] > box[3];
      }).length;
      const expectedMin = 20 * 2; // two full rows of 20 strokes
      return { selected: sel.length, wrongSheet, outside, elapsed, expectedMin, total: window.state.strokes.length };
    })""")
    check("lasso selects only strokes whose AABB intersects the polygon (no cross-page leakage)",
          lasso_aabb_res["selected"] >= lasso_aabb_res["expectedMin"] and
          lasso_aabb_res["selected"] < lasso_aabb_res["total"] and
          lasso_aabb_res["wrongSheet"] == 0 and
          lasso_aabb_res["outside"] == 0,
          f"res={lasso_aabb_res}")

    selection_bounds_res = pg.evaluate("""() => {
      const vp = window.getViewport();
      const pl = vp.getPageLayout(0);
      const t0 = performance.now();
      let b = null;
      for (let i = 0; i < 50; i++) b = window.overlays.getSelectionBounds(window.state, vp);
      const elapsed = (performance.now() - t0) / 50;
      let expectedX0 = Infinity;
      let expectedY0 = Infinity;
      for (const s of window.state.selectedStrokes) {
        expectedX0 = Math.min(expectedX0, pl.x + s.bbox[0]);
        expectedY0 = Math.min(expectedY0, pl.y + s.bbox[1]);
      }
      return { hasBounds: !!b, x0: b ? b.x0 : null, y0: b ? b.y0 : null, expectedX0, expectedY0, elapsed };
    }""")
    check("selection bounds come from cached stroke bboxes without per-point scans",
          selection_bounds_res["hasBounds"] and
          abs(selection_bounds_res["x0"] - selection_bounds_res["expectedX0"]) < 0.01 and
          abs(selection_bounds_res["y0"] - selection_bounds_res["expectedY0"]) < 0.01,
          f"res={selection_bounds_res}")

    # -------------------------------------------------------------
    # T25: Hold-to-Snap Smart Shape Recognition (Plan 083)
    # -------------------------------------------------------------
    print("\n=== T25 Hold-to-Snap Shape Recognition ===", flush=True)
    shape_recog_res = pg.evaluate("""() => {
      const jitter = (i) => Math.sin(i * 2.7) * 1.1;
      const line = [];
      for (let i = 0; i < 40; i++) line.push({ x: 40 + i * 6, y: 200 + jitter(i) });
      const rect = [];
      const addEdge = (x0, y0, x1, y1, steps) => {
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          if (rect.length && i === 0) continue;
          rect.push({ x: x0 + t * (x1 - x0) + jitter(i) * 0.6, y: y0 + t * (y1 - y0) + jitter(i + 3) * 0.6 });
        }
      };
      addEdge(100, 100, 260, 100, 12);
      addEdge(260, 100, 260, 220, 12);
      addEdge(260, 220, 100, 220, 12);
      addEdge(100, 220, 100, 100, 12);
      const circle = [];
      for (let i = 0; i <= 64; i++) {
        const th = (i / 64) * Math.PI * 2;
        circle.push({ x: 300 + Math.cos(th) * 70 + jitter(i) * 1.4, y: 300 + Math.sin(th) * 70 + jitter(i + 2) * 1.4 });
      }
      const tri = [];
      const verts = [[100, 500], [200, 500], [150, 400], [100, 500]];
      for (let e = 0; e < 3; e++) {
        for (let i = e === 0 ? 0 : 1; i <= 14; i++) {
          const t = i / 14;
          tri.push({
            x: verts[e][0] + t * (verts[e + 1][0] - verts[e][0]) + jitter(i) * 0.8,
            y: verts[e][1] + t * (verts[e + 1][1] - verts[e][1]) + jitter(i + 5) * 0.8,
          });
        }
      }
      const scribble = [];
      for (let i = 0; i < 60; i++) scribble.push({ x: 60 + i * 3, y: 380 + Math.sin(i * 0.55) * 40 });

      const recognize = window.Ink.recognizeFreehandShape;
      const rLine = recognize(line, 2);
      const rRect = recognize(rect, 2);
      const rCircle = recognize(circle, 2);
      const rTri = recognize(tri, 2);
      const rScribble = recognize(scribble, 2);
      const allFinite = (r) => r && r.points && r.points.length >= 2 && r.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y));
      return {
        line: rLine && rLine.kind, lineOk: allFinite(rLine),
        rect: rRect && rRect.kind, rectOk: allFinite(rRect),
        circle: rCircle && rCircle.kind, circleOk: allFinite(rCircle),
        triangle: rTri && rTri.kind, triangleOk: allFinite(rTri),
        scribble: rScribble ? rScribble.kind : null,
      };
    }""")
    check("recognizeFreehandShape classifies line, rectangle, circle and triangle with valid point arrays",
          shape_recog_res["line"] == "line" and shape_recog_res["lineOk"] and
          shape_recog_res["rect"] == "rect" and shape_recog_res["rectOk"] and
          shape_recog_res["circle"] == "ellipse" and shape_recog_res["circleOk"] and
          shape_recog_res["triangle"] == "triangle" and shape_recog_res["triangleOk"] and
          shape_recog_res["scribble"] is None,
          f"res={shape_recog_res}")

    pg.evaluate("""() => {
      window.state.activeTool = 'pen';
      window.state.smartShapeHoldEnabled = true;
      window.state.strokes = [];
      window.state._strokesBySheet = null;
      const vp = window.getViewport();
      const pl = vp.getPageLayout(0);
      window.__snapT0 = performance.now();
      window.penTool.onPenDown(
        { pressure: 0.6, timeStamp: window.__snapT0 }, [pl.x + 80, pl.y + 400], 'left', vp
      );
      for (let i = 1; i < 30; i++) {
        window.penTool.onPenMove(
          { pressure: 0.6, buttons: 1, timeStamp: window.__snapT0 + i * 8 },
          [pl.x + 80 + i * 6, pl.y + 400 + Math.sin(i * 1.7) * 1.2],
          'left', vp, { render: true }
        );
      }
      window.__snapRawCount = window.state.cur.points.length;
      window.__snapRawPts = window.state.cur.points.map(p => ({ x: p.x, y: p.y }));
    }""")
    pg.wait_for_timeout(650)
    snap_res = pg.evaluate("""() => {
      const snapped = window.state.holdSnappedShape;
      const cur = window.state.cur;
      const pts = cur ? cur.points : [];
      const p0 = pts[0] || null;
      const pN = pts[pts.length - 1] || null;
      let maxDev = 0;
      if (p0 && pN) {
        const dx = pN.x - p0.x, dy = pN.y - p0.y;
        const len = Math.hypot(dx, dy) || 1;
        for (const p of pts) {
          const d = Math.abs((p.x - p0.x) * dy - (p.y - p0.y) * dx) / len;
          maxDev = Math.max(maxDev, d);
        }
      }
      const reverted = window.penTool.revertHoldSnap(window.getViewport());
      const afterRevert = window.penTool && window.state.cur ? window.state.cur.points.length : 0;
      const rawRestored = !!window.state.cur &&
        window.state.cur.points.length === window.__snapRawCount;
      // Re-snap: rebuild the dwell and let the timer fire again.
      return {
        kind: snapped ? snapped.kind : null,
        pointCount: pts.length,
        maxDev,
        reverted,
        afterRevert,
        rawRestored,
        rawCount: window.__snapRawCount,
        holdActive: !!snapped,
      };
    }""")
    check("380 ms stationary hold snaps the live freehand stroke to a straight line",
          snap_res["holdActive"] and snap_res["kind"] == "line" and
          snap_res["maxDev"] < 0.01 and snap_res["pointCount"] <= 24 and
          snap_res["rawCount"] > 20,
          f"res={snap_res}")
    check("reverting a snap restores the exact raw freehand samples",
          snap_res["reverted"] and snap_res["rawRestored"] and
          snap_res["afterRevert"] == snap_res["rawCount"],
          f"res={snap_res}")
    pg.evaluate("""() => {
      if (window.state.cur) {
        window.penTool.onPenUp({}, window.getViewport());
      }
    }""")

    # -------------------------------------------------------------
    # T26: Dual-Mode Eraser — partial vector splitting (Plan 084)
    # -------------------------------------------------------------
    print("\n=== T26 Whole-Stroke vs Partial Split Eraser ===", flush=True)
    split_unit_res = pg.evaluate("""import('./js/tools/eraser.js').then((eraserTool) => {
      const mk = (pts) => ({
        id: 'split_probe', kind: 'pen', rgb: [0.1, 0.1, 0.1], base_width: 2,
        sheet: 0, deleted: false, points: pts,
        bbox: window.Ink.computeStrokeBbox(pts, 2),
      });
      const linePts = [];
      for (let i = 0; i <= 40; i++) linePts.push({ x: 100 + i * 5, y: 200, p: 0.8, w: 2 });
      const two = eraserTool.splitStrokeByCircle(mk(linePts), 200, 200, 12);
      const none = eraserTool.splitStrokeByCircle(mk(linePts), 200, 200, 500);
      const whole = eraserTool.splitStrokeByCircle(mk([{ x: 0, y: 0 }, { x: 1, y: 1 }]), 0.5, 0.5, 3);
      return {
        twoCount: two ? two.length : -1,
        twoKinds: two ? two.map(f => f.kind) : [],
        twoVec: two ? two.every(f => Array.isArray(f.points) && f.points.length >= 2 && !!(f._cachedPath2D || typeof Path2D === 'undefined')) : false,
        gapOk: two && two.length === 2
          ? (Math.hypot(two[0].points[two[0].points.length - 1].x - 188, 0) < 2.5 &&
             Math.hypot(two[1].points[0].x - 212, 0) < 2.5)
          : false,
        noneCount: none ? none.length : -1,
        wholeCount: whole ? whole.length : -1,
      };
    })""")
    check("splitStrokeByCircle yields exact-boundary vector fragments and full coverage erases everything",
          split_unit_res["twoCount"] == 2 and split_unit_res["twoVec"] and
          split_unit_res["gapOk"] and split_unit_res["noneCount"] == 0 and
          split_unit_res["wholeCount"] == 0,
          f"res={split_unit_res}")

    pg.locator("#btnDockEraser").click()
    pg.wait_for_timeout(60)
    first_mode = pg.evaluate("window.state.eraserMode")
    pg.locator("#btnDockEraser").click()
    pg.wait_for_timeout(60)
    second_mode = pg.evaluate("window.state.eraserMode")
    eraser_btn_state = pg.evaluate("""(() => {
      const b = document.getElementById('btnDockEraser');
      return { title: b.title, partialClass: b.classList.contains('eraser-partial'), mode: b.dataset.eraserMode };
    })()""")
    check("clicking the active eraser toggles whole-stroke ↔ partial split with a clear indicator",
          first_mode == "stroke" and second_mode == "partial" and
          eraser_btn_state["partialClass"] and eraser_btn_state["mode"] == "partial" and
          "Partial" in eraser_btn_state["title"],
          f"first={first_mode} second={second_mode} btn={eraser_btn_state}")

    partial_erase_res = pg.evaluate("""import('./js/tools/eraser.js').then((eraserTool) => {
      const vp = window.getViewport();
      const pl = vp.getPageLayout(0);
      window.state.eraserMode = 'partial';
      window.state.eraserRadius = 14;
      window.state.strokes = [];
      window.state._strokesBySheet = null;
      const pts = [];
      for (let i = 0; i <= 60; i++) pts.push({ x: 60 + i * 5, y: 300, p: 0.8, w: 2.4 });
      const original = {
        id: 'partial_probe', kind: 'pen', rgb: [0.1, 0.1, 0.1], base_width: 2.4,
        sheet: 0, deleted: false, points: pts, bbox: window.Ink.computeStrokeBbox(pts, 2.4),
      };
      window.state.strokes.push(original);
      window.state._strokesBySheet = null;

      const wx = pl.x + 210;
      const wy = pl.y + 300;
      eraserTool.onEraserDown({}, [wx, wy], 'left', vp);
      eraserTool.onEraserUp();

      const live = window.state.strokes.filter(s => !s.deleted);
      return {
        liveCount: live.length,
        allVector: live.every(s => Array.isArray(s.points) && s.points.length >= 2),
        originalDeleted: original.deleted,
      };
    })""")
    undo_res = pg.evaluate("""import('./js/core/document.js').then((docOps) => {
      const before = window.state.strokes.filter(s => !s.deleted).length;
      docOps.performUndo();
      const afterUndo = window.state.strokes.filter(s => !s.deleted);
      docOps.performRedo();
      const afterRedo = window.state.strokes.filter(s => !s.deleted).length;
      return {
        before,
        afterUndo: afterUndo.length,
        restoredPoints: afterUndo.length === 1 ? afterUndo[0].points.length : -1,
        afterRedo,
      };
    })""")
    check("partial erase splits one stroke into two vector fragments with atomic undo/redo",
          partial_erase_res["liveCount"] == 2 and partial_erase_res["allVector"] and
          undo_res["before"] == 2 and undo_res["afterUndo"] == 1 and
          undo_res["restoredPoints"] >= 60 and undo_res["afterRedo"] == 2,
          f"erase={partial_erase_res} undo={undo_res}")
    pg.evaluate("window.state.eraserMode = 'stroke'")

    # -------------------------------------------------------------
    # T27: Smart PDF Export — page ranges & flatten (Plan 085)
    # -------------------------------------------------------------
    print("\n=== T27 Smart PDF Export (Ranges & Flatten) ===", flush=True)
    range_parse_res = pg.evaluate("""(() => {
      const p = window.parsePageRangeSpec;
      return {
        basic: p('1-3, 5, 8-10', 12),
        reversed: p('5-3', 10),
        clamped: p('0, 9-40', 10),
        dedup: p('2,2,2-3', 5),
        junk: p('abc, 4x, ,', 10),
        empty: p('', 10),
        oneBased: p('1', 3),
      };
    })()""")
    check("parsePageRangeSpec handles ranges, reversals, clamping, dedupe and junk input",
          range_parse_res["basic"] == [0, 1, 2, 4, 7, 8, 9] and
          range_parse_res["reversed"] == [2, 3, 4] and
          range_parse_res["clamped"] == [8, 9] and
          range_parse_res["dedup"] == [1, 2] and
          range_parse_res["junk"] == [] and
          range_parse_res["empty"] == [] and
          range_parse_res["oneBased"] == [0],
          f"res={range_parse_res}")

    export_ui_res = pg.evaluate("""(() => {
      window.toolbar.openSettingsModal && window.toolbar.closeSettingsModal();
      document.getElementById('exportModal').classList.remove('hidden');
      document.getElementById('btnHeaderExport').click();
      const sel = document.getElementById('exportRangeMode');
      const input = document.getElementById('exportCustomRangeInput');
      sel.value = 'custom';
      sel.dispatchEvent(new Event('change'));
      const customVisible = !input.classList.contains('hidden');
      const annotatedLabel = sel.querySelector('option[value="annotated"]').textContent;
      const hint = document.getElementById('exportRangeHint').textContent;
      const btn = document.getElementById('exportConfirmBtn');
      const btnBox = btn.getBoundingClientRect();
      const flatten = document.getElementById('exportFlattenCheckbox');
      sel.value = 'all';
      sel.dispatchEvent(new Event('change'));
      const customHidden = input.classList.contains('hidden');
      return {
        customVisible, customHidden, annotatedLabel, hint,
        btnHeight: btnBox.height, hasFlatten: !!flatten,
        options: [...sel.options].map(o => o.value),
      };
    })()""")
    check("export modal exposes range modes, custom input, flatten toggle and a 44px export button",
          export_ui_res["customVisible"] and export_ui_res["customHidden"] and
          export_ui_res["hasFlatten"] and export_ui_res["btnHeight"] >= 44 and
          export_ui_res["options"] == ["all", "annotated", "current", "custom"] and
          "Annotated Pages Only" in export_ui_res["annotatedLabel"] and
          "page" in export_ui_res["hint"],
          f"res={export_ui_res}")

    export_call_res = pg.evaluate("""(async () => {
      const originalInvoke = window.__TAURI__.core.invoke;
      let captured = null;
      window.__TAURI__.core.invoke = async (cmd, args) => {
        if (cmd === 'export_pdf_custom_dialog') {
          captured = { cmd, args };
          return '/tmp/exported.pdf';
        }
        return originalInvoke(cmd, args);
      };
      const pathBefore = window.state.currentDocPath;
      const payloadBefore = window.state.pdfBytes;
      let ok = false;
      try {
        ok = await window.exportPdfWithDialog({ selectedPages: [0, 2], flatten: true });
      } finally {
        window.__TAURI__.core.invoke = originalInvoke;
      }
      const pathAfter = window.state.currentDocPath;
      const payloadAfter = window.state.pdfBytes;
      return {
        ok,
        cmd: captured ? captured.cmd : null,
        selectedPages: captured ? captured.args.selectedPages : null,
        flatten: captured ? captured.args.flatten : null,
        hasStrokes: !!(captured && Array.isArray(captured.args.strokes)),
        pathUnchanged: pathBefore === pathAfter,
        payloadUnchanged: payloadBefore === payloadAfter,
      };
    })()""")
    check("export dispatches selectedPages/flatten without mutating the live session",
          export_call_res["ok"] and export_call_res["cmd"] == "export_pdf_custom_dialog" and
          export_call_res["selectedPages"] == [0, 2] and export_call_res["flatten"] is True and
          export_call_res["hasStrokes"] and export_call_res["pathUnchanged"] and
          export_call_res["payloadUnchanged"],
          f"res={export_call_res}")
    pg.evaluate("document.getElementById('exportModal').classList.add('hidden')")

    # -------------------------------------------------------------
    # T28: External file watcher & non-destructive reload (Plan 086)
    # -------------------------------------------------------------
    print("\n=== T28 External File Change Guard ===", flush=True)
    external_res = pg.evaluate("""(async () => {
      const originalInvoke = window.__TAURI__.core.invoke;
      let openCalled = false;
      window.__TAURI__.core.invoke = async (cmd, args) => {
        if (cmd === 'check_external_file_change') return true;
        if (cmd === 'open_pdf') {
          openCalled = true;
          return {
            page_infos: [
              { page_index: 0, width_pt: 612.0, height_pt: 792.0, template: 'blank' },
              { page_index: 1, width_pt: 612.0, height_pt: 792.0, template: 'blank' },
            ],
            loaded_strokes: [],
            loaded_images: [],
            loaded_texts: [],
            outline: [],
            bookmarks: [],
          };
        }
        return originalInvoke(cmd, args);
      };

      window.state.currentDocPath = '/tmp/inkwell-reload-test.pdf';
      window.state.strokes = [{
        id: 'reload_keep_me', kind: 'pen', rgb: [0.2, 0.1, 0.4], cssColor: '#332f66',
        base_width: 2, sheet: 0, deleted: false,
        points: [{ x: 30, y: 40, p: 0.7, w: 2 }, { x: 90, y: 60, p: 0.7, w: 2 }],
        bbox: window.Ink.computeStrokeBbox([{ x: 30, y: 40, p: 0.7, w: 2 }, { x: 90, y: 60, p: 0.7, w: 2 }], 2),
      }];

      const detected = await window.checkForExternalChanges();
      const banner = document.getElementById('externalChangeBanner');
      const bannerVisible = !banner.classList.contains('hidden');
      const btn = document.getElementById('btnReloadExternalPdf');
      const btnHeight = btn ? btn.getBoundingClientRect().height : 0;

      const reloaded = await window.reloadExternalPdf();
      const strokesAfter = window.state.strokes.filter(s => !s.deleted).map(s => s.id);
      const pagesAfter = (window.state.pageInfos || []).length;
      const pageWidth = (window.state.pageInfos || [{}])[0].width_pt;
      const bannerHiddenAfter = banner.classList.contains('hidden');
      const dirty = window.state.isDirty;

      window.__TAURI__.core.invoke = originalInvoke;
      window.state.currentDocPath = null;
      return {
        detected, bannerVisible, btnHeight, openCalled, reloaded,
        strokesAfter, pagesAfter, pageWidth, bannerHiddenAfter, dirty,
      };
    })()""")
    check("external change detection shows a 44px non-destructive reload banner",
          external_res["detected"] and external_res["bannerVisible"] and
          external_res["btnHeight"] >= 44,
          f"res={external_res}")
    check("reload adopts the new base PDF while preserving unsaved annotations",
          external_res["openCalled"] and external_res["reloaded"] and
          external_res["strokesAfter"] == ["reload_keep_me"] and
          external_res["pagesAfter"] == 2 and abs(external_res["pageWidth"] - 612.0) < 0.01 and
          external_res["bannerHiddenAfter"] and external_res["dirty"],
          f"res={external_res}")

    # -------------------------------------------------------------
    # T30: Policy autosave, edits during a save, change-on-disk choices,
    #      set-aside changes (Plan 090)
    # -------------------------------------------------------------
    print("\n=== T30 Autosave & Safe Save ===", flush=True)
    autosave_res = pg.evaluate("""(async () => {
      const autosave = await import('./js/app/autosave.js');
      const ext = await import('./js/ui/external-change.js');
      const stub = window.__inkwell_stub;
      const saved = [];   // [{cmd, args}]
      const ticks = [];
      stub.autosave_tick = async (a) => {
        ticks.push(a);
        // Mirror FlushPolicy (unit-tested in Rust): idle 20 s, focus, 180 s.
        if (!a.dirty) return null;
        if (a.focusLost) return 'focus';
        if (a.sinceInputS >= 20) return 'idle';
        if (a.sinceFlushS >= 180) return 'interval';
        return null;
      };
      stub.save_pdf = async (a) => { saved.push({ cmd: 'save_pdf', args: a }); return a.outPathStr; };
      stub.save_pdf_dialog = async (a) => { saved.push({ cmd: 'save_pdf_dialog', args: a }); return '/tmp/notes (BezierNotes copy).pdf'; };

      window.state.currentDocPath = '/tmp/notes.pdf';
      window.state.autosaveEnabled = true;
      window.state.externalChangePending = false;
      document.querySelectorAll('.modal-overlay').forEach(m => m.classList.add('hidden'));
      const dirty = () => { window.state.isDirty = true; };
      const out = {};

      // 1. Recent edit: the policy says wait.
      dirty(); autosave._ageForTest(2000);
      out.recentNoSave = (await autosave.autosaveTick(false)) === null && saved.length === 0;

      // 2. 20 s idle: one silent save, no success toast.
      const toastsBefore = document.querySelectorAll('.toast').length;
      dirty(); autosave._ageForTest(21000);
      out.idleReason = await autosave.autosaveTick(false);
      out.idleSaved = saved.length === 1 && saved[0].cmd === 'save_pdf';
      out.idleSilent = !Array.from(document.querySelectorAll('.toast')).slice(toastsBefore)
        .some(t => /saved successfully/i.test(t.textContent));
      out.cleanAfter = window.state.isDirty === false;

      // 3. Focus loss saves even right after an edit.
      dirty(); autosave._ageForTest(1000);
      out.focusReason = await autosave.autosaveTick(true);

      // 4. Never mid-stroke, never with a modal open, never while the file
      //    changed on disk is unresolved.
      const n = saved.length;
      dirty(); autosave._ageForTest(60000);
      window.state.cur = { points: [] };
      out.noSaveMidStroke = (await autosave.autosaveTick(true)) === null;
      window.state.cur = null;
      const modal = document.getElementById('insertPageModal');
      modal.classList.remove('hidden');
      out.noSaveWithModal = (await autosave.autosaveTick(true)) === null;
      modal.classList.add('hidden');
      window.state.externalChangePending = true;
      out.noSaveWhilePending = (await autosave.autosaveTick(true)) === null;
      out.blockedNoWrites = saved.length === n;

      // 5. Banner: three 44 px choices; Keep mine resolves and autosave resumes.
      ext.showExternalChangeBanner();
      const ids = ['btnReloadExternalPdf', 'btnKeepMineExternal', 'btnSaveCopyExternal'];
      out.bannerButtons = ids.map(id => {
        const b = document.getElementById(id);
        return !!b && b.getBoundingClientRect().height >= 44;
      });
      out.noDismissX = !document.getElementById('btnDismissExternalChange');
      document.getElementById('btnKeepMineExternal').click();
      out.keepMineResolved = window.state.externalChangePending === false
        && document.getElementById('externalChangeBanner').classList.contains('hidden');
      out.resumed = (await autosave.autosaveTick(true)) === 'focus';

      // 6. Save a copy: Save As prefilled with "(BezierNotes copy)", then resolved.
      window.state.currentDocPath = '/tmp/notes.pdf';
      window.state.externalChangePending = true;
      ext.showExternalChangeBanner();
      out.copyOk = await ext.saveCopyExternal();
      const last = saved[saved.length - 1];
      out.copyDialog = last.cmd === 'save_pdf_dialog' && last.args.defaultName === 'notes (BezierNotes copy).pdf';
      out.copyResolved = window.state.externalChangePending === false;
      window.state.currentDocPath = '/tmp/notes.pdf';

      // 7. An edit made while a save is running keeps the document dirty, and
      //    the save carries the journal number its snapshot reflects.
      const ipc = await import('./js/core/ipc.js');
      let release;
      stub.save_pdf = (a) => new Promise(res => { saved.push({ cmd: 'save_pdf', args: a }); release = () => res(a.outPathStr); });
      dirty();
      const seqAtStart = ipc.currentJournalSeq();
      const p = window.commands.execute('file.save');
      await new Promise(r => setTimeout(r, 0));
      window.documentOps.addStroke({ id: 'during_save', kind: 'pen', rgb: [0, 0, 0], base_width: 2, sheet: 0,
        points: [{ x: 10, y: 10, p: 0.5 }, { x: 40, y: 20, p: 0.5 }] }, { recordHistory: false });
      release();
      out.manualOk = await p;
      out.dirtyAfterConcurrentEdit = window.state.isDirty === true;
      out.snapshotSeq = saved[saved.length - 1].args.journalSeq === seqAtStart;

      // 8. Journal calls carry increasing sequence numbers.
      const seqs = [];
      const realCommit = stub.commit_stroke;
      stub.commit_stroke = async (a) => { seqs.push(a.seq); return realCommit(a); };
      await ipc.commitStroke(0, 'pen', [0, 0, 0], 2, [{ x: 1, y: 1, p: 0.5 }], 'j1');
      await ipc.commitStroke(0, 'pen', [0, 0, 0], 2, [{ x: 2, y: 2, p: 0.5 }], 'j2');
      stub.commit_stroke = realCommit;
      out.seqsIncrease = seqs.length === 2 && seqs[1] === seqs[0] + 1;

      // 9. Changes set aside by "Don't Save" are offered, and Restore reopens
      //    with restoreShelved.
      const opened = [];
      const realOpen = stub.open_pdf;
      stub.open_pdf = async (a) => { opened.push(a); return Object.assign(await realOpen(a), { shelved_journal_entries: a.restoreShelved ? 0 : 3 }); };
      const loading = await import('./js/app/document-loading.js');
      const res = await ipc.openPdf('/tmp/notes.pdf');
      loading.handlePdfLoadResult('notes.pdf', '/tmp/notes.pdf', res);
      const offer = Array.from(document.querySelectorAll('.toast')).find(t => /chose not to save 3 changes/.test(t.textContent));
      const restoreBtn = offer && offer.querySelector('.toast-action');
      out.offerShown = !!restoreBtn && restoreBtn.getBoundingClientRect().height >= 44;
      if (restoreBtn) restoreBtn.click();
      await new Promise(r => setTimeout(r, 50));
      out.restoreReopened = opened.length === 2 && opened[1].restoreShelved === true;
      stub.open_pdf = realOpen;
      window.state.isDirty = false;
      return out;
    })()""")
    a = autosave_res
    check("autosave waits while you are still editing", a["recentNoSave"], f"res={a}")
    check("autosave saves silently after 20 s idle and marks the document clean",
          a["idleReason"] == "idle" and a["idleSaved"] and a["idleSilent"] and a["cleanAfter"], f"res={a}")
    check("switching away saves at once", a["focusReason"] == "focus", f"res={a}")
    check("no autosave mid-stroke, with a modal open, or while a changed file is unresolved",
          a["noSaveMidStroke"] and a["noSaveWithModal"] and a["noSaveWhilePending"] and a["blockedNoWrites"], f"res={a}")
    check("change-on-disk banner offers Reload / Keep mine / Save a copy at 44 px, no bare dismiss",
          all(a["bannerButtons"]) and a["noDismissX"], f"res={a}")
    check("Keep mine resolves the banner and autosave resumes", a["keepMineResolved"] and a["resumed"], f"res={a}")
    check("Save a copy opens Save As prefilled with '(BezierNotes copy)' and resolves",
          a["copyOk"] and a["copyDialog"] and a["copyResolved"], f"res={a}")
    check("an edit made during a save keeps the document dirty; the save carries its snapshot journal seq",
          a["manualOk"] and a["dirtyAfterConcurrentEdit"] and a["snapshotSeq"], f"res={a}")
    check("journalled calls carry increasing sequence numbers", a["seqsIncrease"], f"res={a}")
    check("set-aside changes are offered with a 44 px Restore that reopens with restoreShelved",
          a["offerShown"] and a["restoreReopened"], f"res={a}")

    # -------------------------------------------------------------
    # T29: Text-note fonts match the PDF writer (Plan 089)
    # -------------------------------------------------------------
    print("\n=== T29 Text Note Fonts ===", flush=True)
    font_res = pg.evaluate("""(async () => {
      const mod = await import('./js/core/note-font.js');
      await Promise.all(['400 16px "Noto Sans Bengali"', '700 16px "Noto Sans Bengali"', '400 16px Inter']
        .map(f => document.fonts.load(f, 'অa')));
      const c = document.createElement('canvas').getContext('2d');
      c.font = mod.noteFont(18, false, false);
      // Width Chromium gives with the bundled fonts; the Rust writer's
      // text_shape tests pin the same number.
      const w = c.measureText('বাংলা গণিত: ক্ষ ক্ত স্ত্র কি কৌ').width;
      return {
        stack: mod.NOTE_FONT_FAMILY,
        bengali: document.fonts.check('16px "Noto Sans Bengali"', 'অ'),
        bengaliBold: document.fonts.check('bold 16px "Noto Sans Bengali"', 'অ'),
        width: w,
        editorFont: getComputedStyle(document.querySelector('.inline-text-input') || document.body).fontFamily,
      };
    })()""")
    check("note font stack puts Noto Sans Bengali after Inter",
          font_res["stack"].startswith('Inter, "Noto Sans Bengali"'), f"stack={font_res['stack']}")
    check("bundled Noto Sans Bengali regular and bold load in the webview",
          font_res["bengali"] and font_res["bengaliBold"], f"res={font_res}")
    check("canvas Bangla line width matches the PDF writer's shaping (205.17 pt +-0.5%)",
          abs(font_res["width"] - 205.171) / 205.171 < 0.005, f"width={font_res['width']:.3f}")
    check("inline note editor uses the same font stack",
          "Noto Sans Bengali" in font_res["editorFont"], f"editor={font_res['editorFont']}")

    # -------------------------------------------------------------
    # T14: Console Hygiene
    # -------------------------------------------------------------
    print("\n=== T14 Console Hygiene ===", flush=True)
    check("zero console errors throughout session", not errors, str(errors[:3]))
    inkwell_warnings = [w for w in warnings if "[inkwell/" in w]
    check("zero internal inkwell warnings", not inkwell_warnings, str(inkwell_warnings[:3]))

    b.close()

print(f"\n{'='*62}\n  {sum(results)}/{len(results)} checks passed\n{'='*62}", flush=True)
sys.exit(0 if all(results) else 1)
