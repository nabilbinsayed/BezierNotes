# Plan 087: PDF Conformance Harness, Round-Trip Property Tests & Crash Torture

| Field | Value |
|---|---|
| **Priority** | P0 |
| **Effort** | M (~600 lines, mostly tests + CI) |
| **Category** | Verification / File-Format Integrity |
| **Depends on** | — |
| **Status** | DONE (2026-11-06; see Outcome) |

## Why

The product's entire reason to exist is "annotated ink inside one ordinary PDF, fully re-editable" (`HANDOFF.md` §1). Yet none of the format tests demanded by `SPEC.md` §11 exist:

- no third-party validation (`qpdf --check`, veraPDF) of anything we write,
- no `open(save(doc)) == doc` property test,
- no golden content-stream snapshots,
- no cross-reader render diff,
- no kill-mid-write torture loop.

Plans 088 (native xref-stream writing), 089 (Unicode text appearances), 091 (sidecar v2) and 092 (merge) all rewrite the save path. They must not start until this harness can catch a regression. This plan lands first and is the safety net for the rest of the wave.

## Evidence

- `inkwell/crates/*/Cargo.toml`: no `proptest` / `quickcheck` dev-dependency.
- `.github/workflows/build.yml:51-67`: CI runs `cargo test`, clippy and the Playwright smoke suites only; no PDF validator is installed or invoked.
- `inkwell/crates/inkwell-core/src/pdf.rs:787-789`: `finish()` documents "The prefix is byte-identical to the input, always", but no test asserts it for real-world inputs.
- `SPEC.md:487-500` lists the six required test kinds.

## Scope

### Files to Create
1. `inkwell/crates/inkwell-core/tests/roundtrip_prop.rs`: proptest generator for `Document` (random sheets, strokes with pressure/tilt, images, text objects including non-ASCII, bookmarks, deletions).
2. `inkwell/crates/inkwell-core/tests/golden.rs` + `tests/golden/*.txt`: fixed stroke sets → snapshot of each emitted content stream and annotation dict (use `insta` or hand-rolled `UPDATE_GOLDEN=1`).
3. `inkwell/crates/inkwell-pdf/tests/conformance.rs`: for every fixture in `tests/fixtures/` (add: classic-xref, xref-stream, object-stream, linearized, encrypted-with-empty-user-password, signed, PDF/A-2b, tagged, form-bearing, 1000-page), save twice and assert:
   - `out.starts_with(input)` (prefix invariant, Non-Negotiable #2),
   - `qpdf --check` exits 0 (skip with a loud `eprintln!` when `qpdf` is not on PATH locally; **required** in CI),
   - `read_sidecar(out)` returns `Ok` with an equal document,
   - file growth on the 2nd save of an unchanged document ≤ the 1st save's appended bytes (feeds Plan 090's compaction).
4. `inkwell/crates/inkwell-pdf/tests/render_diff.rs`: rasterise page 1 of each output with PDFium and `mutool draw` (MuPDF); assert per-pixel mean abs difference under a threshold. Gated behind `--features render-diff` locally, always on in CI Linux.
5. `scripts/torture_save.sh` (+ `.ps1`): spawn a tiny `inkwell-core` example binary (`examples/save_loop.rs`) that saves repeatedly; `kill -9` it at random offsets 200 times; after each kill the target must open via `PdfFile::open` and `read_sidecar` ≠ `Corrupt`.

### Files to Modify
- `inkwell/crates/inkwell-core/Cargo.toml`, `inkwell/crates/inkwell-pdf/Cargo.toml`: dev-deps `proptest`, `insta` (or none).
- `.github/workflows/build.yml`: Linux job installs `qpdf`, `mupdf-tools`; runs conformance + render-diff + torture (50 iterations on PR, 200 nightly). Add veraPDF only for the PDF/A fixture, as a nightly job (it is a slow JVM download).
- `AGENTS.md` verification table: add the new commands and expected counts.

### Files NOT to Touch
- Any production write path. This plan is tests only; if a test fails, record the failure as a finding in the plan's status row and file it against 088/089/090. Do not fix production code here.

## Steps

1. Collect fixtures. Generate the synthetic ones with `qpdf` (`--object-streams=generate`, `--linearize`, `--encrypt "" owner 256`) from the existing `uihi.pdf`-style test file so they can be committed (keep each < 200 KB; the 1000-page one is generated at test time).
2. Write the proptest strategy with bounded sizes (≤ 5 sheets, ≤ 50 strokes, ≤ 200 samples) so a run stays under 30 s.
3. Implement the conformance loop and the prefix invariant first; they are the cheapest and highest-value assertions.
4. Add golden snapshots for: single dot, two-point highlighter (regression for commit 88600be), axis-aligned rect, 700-point scribble, all four text styles.
5. Render diff, then torture script, then CI wiring.

## Verification

```bash
cd inkwell && cargo test --workspace -- --test-threads=1
cd inkwell && cargo test -p inkwell-pdf --features render-diff --test render_diff
scripts/torture_save.sh 200
```

Expected: all green **except** known failures, which are recorded as `#[ignore = "Plan 088: ..."]` with a pointer. At minimum, expect the xref-stream fixtures to show that the prefix is **not** preserved today (see Plan 088). That expected failure is the point.

## STOP Conditions
- STOP if `qpdf` itself rejects one of the *input* fixtures. Fix the fixture, not the assertion.
- STOP and report if the torture loop ever produces an unopenable file. That is a P0 data-loss bug and preempts the rest of the wave.

## Outcome (2026-11-06)

Landed:
- `inkwell-pdf/tests/conformance.rs`: 7 fixtures (`fixtures/conformance/*` from `tools/gen_conformance_fixtures.sh`, plus `irs_w9.pdf` and `arxiv_adam.pdf`) saved the way `save_pdf` saves, two sessions each, with checks for qpdf, prefix, sidecar, PDFium reopen and bounded growth. Known defects go in a `KNOWN_FAILURES` ratchet, so unexpected failures *and* fixed-but-still-listed entries both fail.
- `inkwell-core/tests/roundtrip_prop.rs`: proptest, 32 cases × 2 properties over 5-page documents (strokes, Unicode/escape-heavy text, images, templates, bookmarks); two save generations; `qpdf --check` per case when available.
- `inkwell-core/tests/golden.rs` + `tests/golden/*.txt`: 6 snapshots (dot, two-point highlighter, axis rect, 700-pt scribble, text styles, non-ASCII text) with inflated streams, the sidecar as a hash, and `/ID` + `/Length` masked.
- `inkwell-pdf/tests/render_diff.rs`: PDFium vs **Ghostscript** (MuPDF isn't packaged on the CI image) ink-mask agreement; 0.997–1.000 on 4 fixtures.
- `inkwell-core/examples/save_loop.rs` + `scripts/torture_save.sh`: 200 kills → 0 unopenable. It must run on a real disk; on tmpfs no kill lands inside a write.
- CI (Linux job): installs qpdf + ghostscript, `BEZIER_CONFORMANCE_STRICT=1`, torture 50 on PRs / 200 on main.

Findings recorded as known failures (owned by Plan 088):
- prefix lost on `xref_stream`, `objstm_multi_page`, `irs_w9` **and `linearized`** (new: `/Root` lives in the first-page trailer; `PdfFile::open` says "trailer has no /Root");
- bounded growth fails on **every** fixture: session 2 doubles the appended bytes (e.g. `classic.pdf` 15.8 KB → 31.6 KB);
- `encrypted_aes256`: qpdf reports undecryptable streams (we append plaintext objects) and an invalid trailer `/ID`.

Other findings:
- Torture: 25 of 60 kills on a real disk left `.notes.pdf.inkwell-tmp-*` siblings in the folder; added to Plan 090 §5.
- Golden `non_ascii_text.txt` records the raw UTF-8 `Tj` bytes that Plan 089 replaces.

Deferred (not done here): signed, PDF/A-2b, tagged and 1000-page fixtures; veraPDF. They are not needed until Plan 088 (signature preservation) and Plan 098 (release checklist); add them there.
