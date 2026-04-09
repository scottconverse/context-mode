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
- `hooks/` — Cowork lifecycle hooks (PostToolUse, PreCompact, SessionStart)
- `skills/` — Slash command definitions
- `agents/` — Agent prompt definitions
- `scripts/` — Setup and installation scripts

## Running Tests

```bash
# Full E2E test suite (65 tests)
node test-e2e.js

# Test MCP server startup
node server/index.js
# (Press Ctrl+C to stop)
```

## Testing Hooks

Hook scripts read JSON from stdin. Test them by piping simulated hook input:

```bash
# PostToolUse
echo '{"tool_name":"Edit","tool_input":{"path":"test.js"},"tool_output":{},"session_id":"test"}' | node hooks/post-tool-use.js

# PreCompact
echo '{"session_id":"test"}' | node hooks/pre-compact.js

# SessionStart
echo '{"source":"startup","session_id":"test"}' | node hooks/session-start.js
```

## Code Style

- ES modules (`import`/`export`)
- Private fields with `#` prefix
- Cross-platform paths via `path.join()`, never hardcoded separators
- Windows dynamic imports use `pathToFileURL()` for ESM compatibility
- No TypeScript — plain JavaScript

## Submitting Changes

1. Create a branch from `main`
2. Make your changes
3. Run `node test-e2e.js` — all 65 tests must pass
4. Submit a pull request with a clear description of what changed and why
