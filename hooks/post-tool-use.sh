#!/usr/bin/env bash
# PostToolUse hook wrapper (macOS/Linux/Git Bash)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/post-tool-use.js"
