#!/usr/bin/env bash
# One version for the whole product (Plan 098). VERSION holds it; this writes
# it into every manifest. SemVer: MAJOR.MINOR.PATCH[-pre].
#
#   scripts/bump_version.sh            # sync manifests to VERSION
#   scripts/bump_version.sh 0.4.0      # set VERSION, then sync
#   scripts/bump_version.sh --check    # exit 1 if any manifest disagrees (CI)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FILES=(Cargo.toml inkwell/Cargo.toml inkwell-app/src-tauri/Cargo.toml inkwell-app/src-tauri/tauri.conf.json inkwell-app/package.json)

current() {
  # (tr: some manifests have CRLF line endings)
  case "$1" in
    *.toml) tr -d '\r' < "$1" | sed -n 's/^version = "\([^"]*\)"/\1/p' | head -1 ;;
    *.json) tr -d '\r' < "$1" | sed -n 's/^  "version": "\([^"]*\)",/\1/p' | head -1 ;;
  esac
}

if [ "${1:-}" = "--check" ]; then
  want="$(tr -d '[:space:]' < VERSION)"
  bad=0
  for f in "${FILES[@]}"; do
    got="$(current "$f")"
    if [ "$got" != "$want" ]; then echo "$f: $got (VERSION says $want)"; bad=1; fi
  done
  [ $bad -eq 0 ] && echo "all manifests at $want"
  exit $bad
fi

if [ -n "${1:-}" ]; then
  if ! [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
    echo "not a SemVer version: $1" >&2; exit 2
  fi
  echo "$1" > VERSION
fi
v="$(tr -d '[:space:]' < VERSION)"
for f in "${FILES[@]}"; do
  case "$f" in
    *.toml) sed -i "0,/^version = \"[^\"]*\"/s//version = \"$v\"/" "$f" ;;
    *.json) sed -i "0,/^  \"version\": \"[^\"]*\",/s//  \"version\": \"$v\",/" "$f" ;;
  esac
done
echo "version $v"
