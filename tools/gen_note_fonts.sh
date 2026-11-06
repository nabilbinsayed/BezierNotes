#!/usr/bin/env bash
# Regenerate the fonts used for text-note appearances (Plan 089).
#
# The PDF writer draws notes as vector glyph outlines from these fonts, and
# the app canvas draws them with the same faces, so a note looks the same in
# BezierNotes, Acrobat, Chrome and every other reader.
#
#   Latin / Greek / Cyrillic : Inter, the app's own variable font (subset,
#                              axes kept: wght, opsz), OFL-1.1
#   Bengali                  : Noto Sans Bengali Regular/Bold, OFL-1.1
#
# Requires fonttools + brotli (pip install fonttools brotli). Output is
# committed; rerun only to change coverage.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
app_fonts="$root/inkwell-app/src/fonts"
out="$root/inkwell/crates/inkwell-core/fonts"
noto="${NOTO_DIR:-/usr/share/fonts/noto}"
mkdir -p "$out"

# Basic Latin, Latin-1, Latin Extended-A/B, IPA-free Greek and Cyrillic,
# general punctuation, super/subscripts, currency, letterlike, arrows, math.
latin="U+0000-024F,U+0370-03FF,U+0400-04FF,U+2000-206F,U+2070-209F,U+20A0-20CF,U+2100-214F,U+2190-21FF,U+2200-22FF,U+25CC,U+FEFF"
# Bengali block plus what Bengali text needs around it: ASCII, dandas (in the
# Devanagari block), ZWNJ/ZWJ, dotted circle for isolated marks.
bengali="U+0000-007F,U+0980-09FF,U+0964-0965,U+200C-200D,U+25CC"
# Keep every OpenType layout feature: Bengali shaping depends on them.
subset_opts=(--layout-features='*' --glyph-names --symbol-cmap --legacy-cmap --notdef-glyph --notdef-outline --recommended-glyphs --name-IDs='*' --name-languages='*')

# Inter stays variable: Chrome sets opsz to the font size automatically
# (font-optical-sizing: auto), so the writer must vary opsz per note too or
# Latin text drifts wider than the canvas.
for f in InterVariable InterVariable-Italic; do
  pyftsubset "$app_fonts/$f.woff2" --unicodes="$latin" "${subset_opts[@]}" --flavor= --output-file="$out/$f.ttf"
done
for f in NotoSansBengali-Regular NotoSansBengali-Bold; do
  pyftsubset "$noto/$f.ttf" --unicodes="$bengali" "${subset_opts[@]}" --output-file="$out/$f.ttf"
  # The canvas loads the identical outlines as WOFF2 (lossless for glyf).
  pyftsubset "$noto/$f.ttf" --unicodes="$bengali" "${subset_opts[@]}" --flavor=woff2 --output-file="$app_fonts/$f.woff2"
done
ls -l "$out" "$app_fonts"/NotoSansBengali-*.woff2
