# Contributing to context-mode

## Setup

```bash
# Clone the repo
git clone https://github.com/scottconverse/context-mode.git
cd context-mode

# Install dependencies
npm install

# Verify setup
node test-e2e.js
```

## Requirements

- Node.js >= 18
- Python 3.x (for sandbox testing)
- Git Bash (Windows) or bash (macOS/Linux)

## Project Structure

- `server/` — MCP server and core modules (knowledge base, sandbox executor, session DB)
- `hooks/` — Cowork lifecycle hooks and routing logic
  - `hooks.json` — Hook event registrations (PreToolUse, PostToolUse, PreCompact, SessionStart, UserPromptSubmit, SubagentStop)
  - `run-hook.cmd` — Windows wrapper that dispatches hook events to the correct handler
  - `core/` — Shared hook utilities (formatters, routing logic, stdin reader, tool naming)
  - `pretooluse.js` — Intercepts tool calls and redirects to context-saving equivalents
  - `posttooluse.js` — Captures tool events for session state
  - `precompact.js` — Builds resume snapshot before context compaction
  - `sessionstart.js` — Injects routing block and session guide at session start
  - `userpromptsubmit.js` — Re-injects routing block at each prompt turn
  - `subagent-stop.js` — Cleanup when a subagent session ends
  - `ensure-deps.js` — ABI compatibility check and native dependency rebuild
- `skills/` — Slash command definitions (context-mode, ctx-doctor, ctx-stats, ctx-purge)
- `agents/` — Agent prompt definitions
- `scripts/` — Setup and installation scripts
- `start.js` — Bootstrapper: version self-heal, ensure-deps, pure-JS dependency install, then starts MCP server
- `.claude/settings.json` — Shipped permission rules (deny/allow) for Claude Code

## Running Tests

```bash
# Full E2E test suite (216 tests across 19 sections)
node test-e2e.js

# Test MCP server startup
node start.js
# (Press Ctrl+C to stop)
```

The test suite covers: utils, exit classification, runtime detection, sandbox executor, knowledge base, session DB, snapshot builder, event extraction, routing block, hook cmd wrapper, MCP protocol smoke test, plugin discoverability, spec compliance, OSS attribution, plugin manifest validation, PreToolUse routing, hooks.json validation, and plugin CLAUDE.md/settings validation.

## Testing Hooks

Hook scripts read JSON from stdin via `run-hook.cmd`. Test them by piping simulated hook input through the dispatcher:

```bash
# PreToolUse (routing)
echo '{"tool_name":"Read","tool_input":{"file_path":"test.js"},"session_id":"test"}' | node hooks/pretooluse.js

# PostToolUse
echo '{"tool_name":"Edit","tool_input":{"path":"test.js"},"tool_output":{},"session_id":"test"}' | node hooks/posttooluse.js

# PreCompact
echo '{"session_id":"test"}' | node hooks/precompact.js

# SessionStart
echo '{"source":"startup","session_id":"test"}' | node hooks/sessionstart.js

# UserPromptSubmit
echo '{"prompt":"hello","session_id":"test"}' | node hooks/userpromptsubmit.js

# SubagentStop
echo '{"session_id":"test"}' | node hooks/subagent-stop.js
```

## Hook System

The hook system is defined in `hooks/hooks.json`. Six events are registered:

| Event | Handler | Purpose |
|-------|---------|---------|
| `PreToolUse` | `pretooluse.js` | Intercepts Bash, Read, Grep, WebFetch, Agent, Task, and ctx_* tool calls and redirects to context-saving equivalents |
| `PostToolUse` | `posttooluse.js` | Captures tool call events for session state tracking |
| `PreCompact` | `precompact.js` | Builds a resume snapshot before context compaction fires |
| `SessionStart` | `sessionstart.js` | Injects routing block and session guide when a session begins |
| `UserPromptSubmit` | `userpromptsubmit.js` | Re-injects routing block at the start of each prompt turn |
| `SubagentStop` | `subagent-stop.js` | Cleanup when a subagent session ends |

All hooks are dispatched by `run-hook.cmd`, which passes the hook name as an argument and forwards stdin from Claude Code.

## hooks.json Format

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd pretooluse" }]
      }
    ]
  }
}
```

- `matcher` — tool name to intercept (empty string matches all tools)
- `command` — shell command to run; receives hook payload on stdin, returns JSON response on stdout
- `${CLAUDE_PLUGIN_ROOT}` — resolved by Cowork to the plugin's install path

## Code Style

- ES modules (`import`/`export`)
- Private fields with `#` prefix
- Cross-platform paths via `path.join()`, never hardcoded separators
- Windows dynamic imports use `pathToFileURL()` for ESM compatibility
- No TypeScript — plain JavaScript

## Submitting Changes

1. Create a branch from `main`
2. Make your changes
3. Run `node test-e2e.js` — all 216 tests must pass
4. Submit a pull request with a clear description of what changed and why
