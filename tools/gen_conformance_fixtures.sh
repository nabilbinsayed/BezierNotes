#!/usr/bin/env bash
# Regenerate the Plan 087 conformance fixtures from committed source PDFs.
# Requires qpdf >= 11. Output is committed; rerun only when adding a fixture.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/inkwell/fixtures"
out="$src/conformance"
mkdir -p "$out"

# Classic xref table, single page (the format our writer handles natively today).
cp "$src/lecture.pdf" "$out/classic.pdf"

# Cross-reference stream + object streams: what pdflatex, Word and Chrome emit.
qpdf --object-streams=generate "$src/lecture.pdf" "$out/xref_stream.pdf"

# Multi-page with object streams, so page-tree objects live inside /ObjStm.
qpdf --object-streams=generate "$src/corpus/sample_multi_page.pdf" "$out/objstm_multi_page.pdf"

# Linearized ("fast web view"): first-page xref plus main xref.
qpdf --linearize "$src/corpus/sample_multi_page.pdf" "$out/linearized.pdf"

# AES-256 encrypted with an empty user password (opens without prompting).
qpdf --encrypt "" owner-secret 256 -- "$src/lecture.pdf" "$out/encrypted_aes256.pdf"

# Hybrid: classic table that also points at an xref stream via /XRefStm.
# qpdf has no direct switch for this, so it is omitted until Plan 088 needs it.

for f in "$out"/*.pdf; do
  qpdf --check "$f" >/dev/null || { echo "input fixture fails qpdf --check: $f" >&2; exit 1; }
done
ls -l "$out"
