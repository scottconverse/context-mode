# context-mode Clean Re-port for Cowork

**Date:** 2026-04-09
**Status:** Design
**Approach:** Clean re-port from upstream mksglu/context-mode v1.0.75, adapted for Cowork's plugin spec

## Problem

The context-mode plugin is installed, registered, and enabled in Cowork. The MCP server works standalone (161 E2E tests pass). But the `ctx_*` tools never appear in a Cowork session because:

1. `plugin.json` is missing the `mcpServers` field — Cowork doesn't know to start the MCP server
2. `.mcp.json` used the wrong format (`mcpServers` wrapper instead of Cowork's flat format)
3. The `PreToolUse` routing hooks that make context-mode actually save context are completely missing
4. The main `context-mode` skill that teaches Claude the tool selection logic is missing
5. The bootstrapper that self-heals dependencies is missing
6. Session continuity hooks (`UserPromptSubmit`, session directive) are missing

The original port kept the server code but dropped the plugin wiring, routing hooks, and teaching skill that make it work as an integrated system.

## What We Keep

Our `server/` directory is solid — 161 tests, working MCP protocol, FTS5 knowledge base, polyglot sandbox, session DB. No changes needed.

Also kept:
- Documentation artifacts (CHANGELOG, USER-MANUAL, landing page, README-FULL)
- `install.js` (with fixes)
- `test-e2e.js` (with new tests)
- `run-hook.cmd` (Windows polyglot wrapper)
- `agents/context-optimizer.md` (our addition)
- `hooks/subagent-stop.js` (our addition, not in upstream)

## What We Port From Upstream

### A. Plugin Manifest (`plugin.json`)

Add `mcpServers`, `skills`, `hooks` fields per Cowork spec:

```json
{
  "name": "context-mode",
  "version": "1.0.0",
  "description": "Context window optimization for Cowork. Sandboxed execution, FTS5 knowledge base, automatic tool routing.",
  "author": { "name": "Scott Converse" },
  "homepage": "https://scottconverse.github.io/context-mode/",
  "repository": "https://github.com/scottconverse/context-mode",
  "license": "ELv2",
  "keywords": ["mcp", "context-window", "sandbox", "fts5", "bm25"],
  "mcpServers": {
    "context-mode": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/start.js"],
      "env": {
        "CLAUDE_PLUGIN_DATA": "${CLAUDE_PLUGIN_DATA}",
        "NODE_PATH": "${CLAUDE_PLUGIN_DATA}/node_modules"
      }
    }
  },
  "skills": "./skills/",
  "hooks": "./hooks/hooks.json"
}
```

### B. `.mcp.json`

Flat format (Cowork spec — no `mcpServers` wrapper):

```json
{
  "context-mode": {
    "command": "node",
    "args": ["${CLAUDE_PLUGIN_ROOT}/start.js"],
    "env": {
      "CLAUDE_PLUGIN_DATA": "${CLAUDE_PLUGIN_DATA}",
      "NODE_PATH": "${CLAUDE_PLUGIN_DATA}/node_modules"
    }
  }
}
```

Both `plugin.json` and `.mcp.json` declare the server. Cowork merges from both sources — belt and suspenders.

### C. Hooks System

Full 6-event registration. Upstream has 5; we add SubagentStop (our addition).

| Hook Event | Matchers | Purpose |
|------------|----------|---------|
| `PreToolUse` | Bash, Read, Grep, WebFetch, Agent, Task, 3 MCP tool names | Route data-fetching tools through sandbox |
| `PostToolUse` | (all) | Capture session events |
| `PreCompact` | (all) | Build resume snapshot |
| `SessionStart` | (all) | Inject routing block + session directive |
| `UserPromptSubmit` | (all) | Session context injection |
| `SubagentStop` | (all) | Subagent cleanup (our addition) |

PreToolUse is the core value. It intercepts:
- **Bash** — blocks curl/wget stdout floods, inline HTTP, build tools; redirects to `ctx_execute`
- **WebFetch** — denies; redirects to `ctx_fetch_and_index`
- **Read** — nudges toward `ctx_execute_file` for analysis (allows Read for files being edited)
- **Grep** — nudges toward `ctx_execute` for sandbox search
- **Agent/Task** — injects routing block into subagent prompts
- **MCP execute/execute_file/batch_execute** — security policy enforcement

Guidance nudges fire once per session (throttled via temp file markers).

### D. Core Hook Modules

Ported from upstream's `hooks/core/`:

- **`core/routing.js`** — Pure routing logic. Takes tool name + input, returns normalized decision (`deny`, `ask`, `modify`, `context`, or null passthrough). Handles curl/wget detection with heredoc/quote stripping to avoid false positives. Security policy integration.
- **`core/formatters.js`** — Cowork-specific response formatting. Converts normalized decisions to `hookSpecificOutput` JSON. We only need the `claude-code` formatter (strip the 5 other platform formatters).
- **`core/stdin.js`** — Cross-platform stdin reader using event-based flowing mode. Avoids macOS spawnSync hang and Windows EOF bugs.
- **`core/tool-naming.js`** — Maps bare tool names to Cowork convention: `mcp__plugin_context-mode_context-mode__<tool>`. We only need the `claude-code` entry (strip other platforms).

### E. Routing Block (`routing-block.js`)

XML instruction block injected by SessionStart and into Agent/Task prompts. Teaches Claude:
- Tool selection hierarchy (batch_execute > search > execute/execute_file)
- Forbidden actions (no Bash for large output, no Read for analysis, no WebFetch)
- File writing policy (always use native Write/Edit, never ctx_execute)
- Output constraints (500 word limit, artifacts to files)
- ctx slash commands (/ctx-stats, /ctx-doctor, /ctx-purge)

### F. Main `context-mode` Skill

Port `skills/context-mode/SKILL.md` + 4 reference files. This is the decision tree that teaches Claude:
- Bash whitelist (git writes, file mutations, navigation, echo — everything else through sandbox)
- When to use each tool (execute vs execute_file vs fetch_and_index vs batch_execute)
- Language selection (JS for HTTP/JSON, Python for data/CSV, shell for pipes/patterns)
- Search query strategy (BM25 OR semantics, source parameter scoping)
- Playwright integration workflow (filename param + index/execute_file)
- Anti-patterns with explanations
- Automatic triggers (test runs, log analysis, API debugging, etc.)

Reference files:
- `references/patterns-javascript.md` — JS/TS execution patterns
- `references/patterns-python.md` — Python execution patterns
- `references/patterns-shell.md` — Shell execution patterns
- `references/anti-patterns.md` — Common mistakes and fixes

### G. Bootstrapper (`start.js`)

Entry point for MCP server. Ported from upstream's `start.mjs`:

1. Set `CLAUDE_PROJECT_DIR` and `CONTEXT_MODE_PROJECT_DIR` env vars
2. Self-heal: if newer version dir exists in cache, update `installed_plugins.json`
3. Run `ensure-deps.js` — install better-sqlite3 if missing, handle ABI compatibility
4. Install pure-JS deps (turndown, turndown-plugin-gfm) if missing
5. Import and start `server/index.js`

No bundle fallback needed (we don't ship bundles). No CLI shim (we don't have a CLI).

### H. `ensure-deps.js`

Native dependency bootstrap + ABI cache:

1. Check if better-sqlite3 is installed; if not, `npm install`
2. Check if native binary exists; if not, `npm rebuild`
3. ABI compatibility: cache compiled binaries per Node ABI version. When Node version changes (mise/volta/nvm), swap in cached binary or rebuild. Prevents crashes from ABI mismatch.
4. macOS codesign after binary swap (prevents SIGKILL from hardened runtime)

Auto-runs on import. Fast path: existsSync check (~0.1ms). Slow path: npm install (first run only).

### I. `suppress-stderr.js`

Redirects `process.stderr.write` to a no-op. Prevents hook subprocess stderr (deprecation warnings, debug output) from entering Claude's context as noise.

### J. Session Continuity Modules

- **`session-helpers.js`** — Rewrite to align with upstream. Shared helpers: `readStdin`, `getSessionId`, `getSessionDBPath`, `getSessionEventsPath`, `getCleanupFlagPath`.
- **`session-directive.js`** — NEW. Builds session directive XML for compact/resume. Writes session events to file for auto-indexing.
- **`session-loaders.js`** — NEW. Lazy-loads SessionDB for hooks. Creates loader factory bound to hook directory.

## What We Adapt for Cowork

1. **All files are `.js`** (not `.mjs`) — our `package.json` has `"type": "module"`, so `.js` files are ESM
2. **Hook commands use `run-hook.cmd` wrapper** — Windows polyglot. Upstream uses bare `node` which fails on Windows where `.mjs` extension may not be associated
3. **Tool naming hardcoded to Cowork** — `mcp__plugin_context-mode_context-mode__<tool>`. Strip all other platform conventions
4. **Formatters hardcoded to Cowork** — `hookSpecificOutput` format. Strip Gemini CLI, Cursor, Codex, VS Code Copilot formatters
5. **No multi-platform adapters** — No `configs/` directory, no platform detection in routing
6. **Security module optional** — Upstream imports from `build/security.js`. We attempt dynamic import; if not available, skip security policy enforcement (graceful degradation)

## What We Discard

- Multi-platform adapter configs (`configs/` — 12 platforms)
- TypeScript source (`src/`) and build pipeline (`tsconfig.json`, `vitest.config.ts`)
- Pre-built bundles (`server.bundle.mjs`, `cli.bundle.mjs`)
- CLI entry point (`bin`)
- OpenClaw/Pi plugin files (`openclaw.plugin.json`, `.openclaw-plugin/`, `.pi/`)
- `context-mode-ops` skill (dev ops workflows — not relevant to our fork)
- `ctx-upgrade` skill (self-update mechanism — we handle updates via install.js re-run)
- Dashboard/web UI (`web/`)
- Stats tracking (`stats.json`)
- GitHub CI workflows (`.github/`)
- `.npmignore`, `bun.lock` (we use npm, not bun)
- LLM docs files (`llms.txt`, `llms-full.txt`)

## File Structure

```
context-mode/
  .claude-plugin/
    plugin.json              # WITH mcpServers, skills, hooks
    marketplace.json         # Unchanged
  .mcp.json                  # Flat format (Cowork spec)
  start.js                   # Bootstrapper entry point
  server/
    index.js                 # MCP server (existing, unchanged)
    knowledge.js             # FTS5 knowledge base (existing)
    sandbox.js               # Polyglot executor (existing)
    runtime.js               # Runtime detection (existing)
    session.js               # Session DB (existing)
    snapshot.js              # Snapshot builder (existing)
    db-base.js               # SQLite base (existing)
    utils.js                 # Utilities (existing)
    exit-classify.js         # Exit classification (existing)
  hooks/
    hooks.json               # 6 events, 14 matchers
    run-hook.cmd             # Windows polyglot (existing)
    pretooluse.js            # NEW: PreToolUse routing
    posttooluse.js           # REWRITE: align with upstream session capture
    precompact.js            # REWRITE: align with upstream snapshot
    sessionstart.js          # REWRITE: routing block + session directive
    userpromptsubmit.js      # NEW: session context injection
    subagent-stop.js         # EXISTING: our addition
    routing-block.js         # NEW: routing instruction XML
    ensure-deps.js           # NEW: native dep bootstrap + ABI cache
    suppress-stderr.js       # NEW: stderr suppression
    session-helpers.js       # REWRITE: align with upstream
    session-extract.js       # EXISTING
    session-directive.js     # NEW: session continuity
    session-loaders.js       # NEW: lazy DB loading for hooks
    core/
      routing.js             # NEW: pure routing logic
      formatters.js          # NEW: Cowork response formatting
      stdin.js               # NEW: cross-platform stdin reader
      tool-naming.js         # NEW: Cowork tool name convention
  skills/
    context-mode/
      SKILL.md               # NEW: main routing skill
      references/
        patterns-javascript.md
        patterns-python.md
        patterns-shell.md
        anti-patterns.md
    ctx-doctor/SKILL.md      # EXISTING (update)
    ctx-stats/SKILL.md       # EXISTING (update)
    ctx-purge/SKILL.md       # EXISTING (update)
  agents/
    context-optimizer.md     # EXISTING
  docs/                      # EXISTING documentation artifacts
  install.js                 # EXISTING (fix marketplace name + probe)
  test-e2e.js                # EXISTING (add new tests)
  test-mcp-client.js         # EXISTING
  package.json               # EXISTING
  scripts/                   # EXISTING
  LICENSE, README.md, CHANGELOG.md, CONTRIBUTING.md, USER-MANUAL.md
```

## Install UX

Single command: `npx github:scottconverse/context-mode`

```
  context-mode v1.0.0
  Platform: win32 (x64) | Node.js: v22.x

  [1/7] Copying plugin to cache...        done
  [2/7] Registering marketplace...         done
  [3/7] Registering plugin...              done
  [4/7] Enabling plugin...                 done
  [5/7] Installing dependencies...         done
  [6/7] Verifying FTS5...                  done
  [7/7] Server probe...                    9/9 tools responding

  Installed successfully.

  Next: restart Claude Code, then type /ctx-doctor to verify.
```

Steps:
1. **Copy to cache** — `cpSync` including dot-files, no silent failures
2. **Register marketplace** — create entry, symlink/junction (copy fallback with explicit warning)
3. **Register plugin** — `installed_plugins.json` with ID `context-mode@scottconverse-context-mode`
4. **Enable plugin** — `settings.json` `enabledPlugins`
5. **Install dependencies** — npm install in data dir, fallback to cache
6. **Verify FTS5** — in-memory SQLite + FTS5 virtual table creation
7. **Server probe** — spawn MCP server, send `initialize` + `tools/list`, confirm 9 tools, kill. Warning (not failure) if probe fails.

Upgrade: same command. Detects existing install, updates cache, preserves data dir. Bumps version in registry.

Failure UX: each step says what went wrong and what to do. Critical failures exit with message. Non-critical warn and continue.

## Bug Fixes Included

| Bug | Fix |
|-----|-----|
| `plugin.json` missing `mcpServers` | Add inline declaration pointing to `start.js` |
| `.mcp.json` wrong format | Flat format (no wrapper) per Cowork spec |
| `install.js` marketplace name `local-dev` | Change to `scottconverse-context-mode` |
| `require('os')` in ESM (`server/index.js:54`) | Replace with `import { homedir } from 'node:os'` |
| E2E tests don't validate config format | Add tests for flat .mcp.json, plugin.json fields |

## Testing Strategy

### Existing Tests (unchanged)
All 161 E2E tests continue to pass. Server code is not modified.

### New E2E Tests
- `.mcp.json` flat format validation (reject `mcpServers` wrapper)
- `plugin.json` has `mcpServers` field with correct structure
- `plugin.json` has `skills` and `hooks` fields
- PreToolUse routing: Bash with curl → modify (redirect to sandbox)
- PreToolUse routing: Bash whitelist command → passthrough
- PreToolUse routing: WebFetch → deny (redirect to ctx_fetch_and_index)
- PreToolUse routing: Read → context guidance (once per session)
- PreToolUse routing: Grep → context guidance (once per session)
- PreToolUse routing: Agent → modify (inject routing block)
- PreToolUse routing: unknown tool → passthrough
- Guidance throttle: same type fires only once
- Hook stdin/stdout JSON contract
- `ensure-deps.js` ABI detection logic
- `start.js` bootstrapper loads and starts server
- Install probe: spawn + tools/list + confirm 9 tools

### Manual Verification
- Restart Cowork session
- Confirm `ctx_*` tools appear in tool list
- Run `/ctx-doctor`
- Test PreToolUse routing: use `curl` in Bash, confirm redirect
- Test session continuity: compact and verify routing block persists

## Implementation Order

1. Plugin manifest fixes (`plugin.json`, `.mcp.json`)
2. Core hook infrastructure (`core/stdin.js`, `core/formatters.js`, `core/tool-naming.js`, `suppress-stderr.js`)
3. Routing system (`routing-block.js`, `core/routing.js`, `pretooluse.js`)
4. Session hooks (`ensure-deps.js`, `session-directive.js`, `session-loaders.js`, `sessionstart.js`, `userpromptsubmit.js`)
5. Rewrite existing hooks (`posttooluse.js`, `precompact.js`, `session-helpers.js`)
6. `hooks/hooks.json` — full 6-event registration with 15 matchers
7. Main skill (`skills/context-mode/SKILL.md` + references)
8. Bootstrapper (`start.js`)
9. `install.js` fixes (marketplace name, dot-file copy, server probe)
10. E2E test updates
11. Documentation updates (CHANGELOG, README, USER-MANUAL)

## OSS Attribution

All ported code retains attribution headers crediting upstream:
```
Ported from mksglu/context-mode (https://github.com/mksglu/context-mode)
by @mksglu, licensed under Elastic License 2.0.
```

README, landing page, CHANGELOG, and source file headers all credit the upstream project.
