#!/usr/bin/env bash
# Renamed to "Launch BezierNotes.sh" in 0.3.0; this wrapper goes in 0.4.0.
exec "$(dirname "${BASH_SOURCE[0]}")/Launch BezierNotes.sh" "$@"
