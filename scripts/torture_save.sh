#!/usr/bin/env bash
# Plan 087 / SPEC §11 sync torture test: kill -9 the saver mid-write N times.
# After every kill the target must open with intact ink.
#
#   scripts/torture_save.sh [iterations=200]
set -euo pipefail

iters="${1:-200}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/inkwell"
cargo build -q --release -p inkwell-core --example save_loop
bin="$root/inkwell/target/release/examples/save_loop"
[ -x "$bin" ] || bin="$root/target/release/examples/save_loop"

# On the real disk, not tmpfs: fsync must cost something or the kill never
# lands inside a write.
mkdir -p "$root/inkwell/target"
work="$(mktemp -d "$root/inkwell/target/torture.XXXXXX")"
trap 'rm -rf "$work"' EXIT
target="$work/notes.pdf"
cp "$root/inkwell/fixtures/corpus/arxiv_attention.pdf" "$target"

fail=0
leftovers=0
for i in $(seq 1 "$iters"); do
  "$bin" "$root/inkwell/fixtures/corpus/arxiv_attention.pdf" "$target" &
  pid=$!
  # 10-400 ms: early kills land in the first write, late ones mid-stream.
  sleep "0.$(printf '%03d' $(( (RANDOM % 390) + 10 )))"
  kill -9 "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true

  if ! out="$("$bin" --check "$target")"; then
    echo "iteration $i: $out" >&2
    fail=$((fail + 1))
  fi
  # A killed atomic_write leaves its sibling temp file behind; a sync client
  # would upload it. The app sweeps them on open and after each save (Plan
  # 090): run the same sweep and require that nothing survives it.
  n=$("$bin" --sweep "$target")
  leftovers=$((leftovers + n))
  if [ -n "$(find "$work" -maxdepth 1 -name '.notes.pdf.inkwell-tmp-*')" ]; then
    echo "iteration $i: orphaned temp survived the sweep" >&2
    fail=$((fail + 1))
  fi
done

echo "torture: $iters kills, $fail failures, $leftovers orphaned temps swept, last: $("$bin" --check "$target")"
[ "$fail" -eq 0 ]
