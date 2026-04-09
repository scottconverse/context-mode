#!/usr/bin/env bash
# SubagentStop hook wrapper (macOS/Linux/Git Bash)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/subagent-stop.js"
