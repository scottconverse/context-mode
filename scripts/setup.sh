#!/usr/bin/env bash
# Setup script wrapper for context-mode plugin (macOS/Linux/Git Bash)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.." || exit 1
exec node scripts/setup.js "$@"
