#!/usr/bin/env bash
# SessionStart hook wrapper (macOS/Linux/Git Bash)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/session-start.js"
