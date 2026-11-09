#!/usr/bin/env bash
# Launch BezierNotes on Linux
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export GDK_BACKEND="${GDK_BACKEND:-wayland,x11}"
export WEBKIT_DISABLE_COMPOSITING_MODE="${WEBKIT_DISABLE_COMPOSITING_MODE:-0}"

if [ -f "$DIR/libpdfium.so" ]; then
    export PDFIUM_DLL_DIR="$DIR"
elif [ -f "$DIR/bin/libpdfium.so" ]; then
    export PDFIUM_DLL_DIR="$DIR/bin"
fi

export LD_LIBRARY_PATH="$DIR:$DIR/bin:$DIR/target/release:$DIR/target/debug:$DIR/inkwell-app/src-tauri/target/release:$DIR/inkwell-app/src-tauri/target/debug:${LD_LIBRARY_PATH:-}"

RELEASE_BIN=""
DEBUG_BIN=""

if [ -f "$DIR/target/release/inkwell-app" ]; then
    RELEASE_BIN="$DIR/target/release/inkwell-app"
elif [ -f "$DIR/inkwell-app/src-tauri/target/release/inkwell-app" ]; then
    RELEASE_BIN="$DIR/inkwell-app/src-tauri/target/release/inkwell-app"
fi

if [ -f "$DIR/target/debug/inkwell-app" ]; then
    DEBUG_BIN="$DIR/target/debug/inkwell-app"
elif [ -f "$DIR/inkwell-app/src-tauri/target/debug/inkwell-app" ]; then
    DEBUG_BIN="$DIR/inkwell-app/src-tauri/target/debug/inkwell-app"
fi

if [ -f "$DIR/beziernotes" ]; then
    exec "$DIR/beziernotes" "$@"
elif [ -f "$DIR/inkwell-app" ]; then
    exec "$DIR/inkwell-app" "$@"
elif [ -f "$DIR/Inkwell" ]; then
    exec "$DIR/Inkwell" "$@"
elif [ -n "$RELEASE_BIN" ] && [ -n "$DEBUG_BIN" ]; then
    if [ "$RELEASE_BIN" -nt "$DEBUG_BIN" ]; then
        exec "$RELEASE_BIN" "$@"
    else
        exec "$DEBUG_BIN" "$@"
    fi
elif [ -n "$RELEASE_BIN" ]; then
    exec "$RELEASE_BIN" "$@"
elif [ -n "$DEBUG_BIN" ]; then
    exec "$DEBUG_BIN" "$@"
else
    echo "BezierNotes binary not found. Build it with: cargo build --release -p inkwell-app"
    exit 1
fi
