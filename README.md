# context-mode

Context window optimization plugin for Claude Code in Cowork. Sandboxes tool output, indexes content into a local knowledge base, and tracks session state to reduce context consumption by up to 98%. Current version: **1.2.0**.

## What It Does

Long Claude Code sessions consume context rapidly. Every file read, web fetch, and shell command dumps raw output into the context window. Context-mode solves this with six capabilities:

1. **Automatic Tool Routing** — PreToolUse hooks intercept Bash, Read, Grep, WebFetch, and Agent calls before they execute and redirect them through the context-mode sandbox. You get the result; the raw output stays out of context. See [Automatic Tool Routing](#automatic-tool-routing) below.
2. **Sandbox Execution** — Runs code in isolated subprocesses, capturing only stdout. Raw file contents and command output never enter context. Supports 11 languages.
3. **Knowledge Base** — Chunks and indexes content into a local SQLite FTS5 database with BM25 + trigram dual-strategy search. Retrieves only the relevant snippets.
4. **Session Continuity** — Captures session events via hooks and rebuilds a structured Session Guide after context compaction, so Claude resumes from exactly where it left off. The `start.js` bootstrapper handles version self-healing, ABI dependency checks, and pure-JS package installation before starting the server on every session.
5. **Main Skill** — The `context-mode` skill provides an in-session decision tree, tool-selection patterns, and anti-patterns so Claude consistently picks the right tool.
6. **CLAUDE.md + Settings** — A `CLAUDE.md` file (shipped with the plugin) gives Claude the "Think in Code" directive and tool-selection rules. A `.claude/settings.json` ships deny/allow permission rules so Claude Code behaves safely out of the box.

## Install

**Quickest — one command:**

```bash
npx --yes --package=github:scottconverse/context-mode context-mode
```

The installer runs 7 steps automatically: copies the plugin to cache, creates a marketplace entry, registers the plugin, enables it in settings, installs native dependencies, verifies FTS5, and probes the MCP server to confirm all 9 tools respond. After it completes, start a new Claude Code session.

**In Claude Code or Cowork:**

```
/plugin marketplace add scottconverse/context-mode
/plugin install context-mode@scottconverse-context-mode
```

Start a new session. Verify with `/context-mode:ctx-doctor`.

**Manual install:**

```bash
git clone https://github.com/scottconverse/context-mode.git
cd context-mode
node install.js
```

## Quick Start

Once installed, Claude automatically prefers context-saving tools. You can also use them directly:
- `ctx_execute` — run code in a sandbox instead of reading files into context
- `ctx_search` — search indexed content instead of re-reading files
- `ctx_fetch_and_index` — fetch and index a web page instead of raw WebFetch

## Automatic Tool Routing

Context-mode registers PreToolUse hooks that intercept five built-in Claude Code tools before they execute:

| Intercepted Tool | Redirected To |
|-----------------|---------------|
| `Bash` | `ctx_execute` (sandbox) |
| `Read` | `ctx_execute_file` (sandbox) |
| `Grep` | `ctx_execute` (sandbox search) |
| `WebFetch` | `ctx_fetch_and_index` (indexed, cached) |
| `Agent` | Routed through context-mode orchestration |

**Bash whitelist** — some Bash calls are intentionally allowed through without sandboxing, because they write state or navigate rather than produce large output: `git` commands, `mkdir`, `rm`, `mv`, directory navigation (`cd`, `ls`, `pwd`), and `echo`. These pass through to the native tool unchanged.

**Why this matters** — routing happens automatically. You don't change how you work; Claude doesn't change how it calls tools. The hooks silently upgrade every eligible call to a context-saving equivalent.

**Session injection** — a UserPromptSubmit hook fires at the start of each prompt turn and injects a routing block into Claude's context. This routing block lists the decision tree Claude should follow when choosing between tools, so the model always has current guidance even in long sessions.

## Hook Events

Context-mode registers six lifecycle hook events:

| Event | Handler | Purpose |
|-------|---------|---------|
| `PreToolUse` | `pretooluse.js` | Intercepts Bash, Read, Grep, WebFetch, Agent, Task calls and redirects to context-saving equivalents |
| `PostToolUse` | `posttooluse.js` | Captures tool events for session state tracking |
| `PreCompact` | `precompact.js` | Saves a session snapshot before context compaction |
| `SessionStart` | `sessionstart.js` | Injects routing block and session guide when a session begins |
| `UserPromptSubmit` | `userpromptsubmit.js` | Re-injects the routing block at the start of each prompt turn |
| `SubagentStop` | `subagent-stop.js` | Cleanup when a subagent session ends |

All hooks are dispatched by `hooks/run-hook.cmd` using the `hooks/hooks.json` manifest.

## MCP Tools

| Tool | Purpose |
|------|---------|
| `ctx_execute` | Run code in a sandboxed subprocess (11 languages) |
| `ctx_execute_file` | Process files through a sandbox — raw content stays out of context |
| `ctx_batch_execute` | Multiple commands + searches in one call |
| `ctx_index` | Index text/markdown/JSON into the knowledge base |
| `ctx_search` | BM25 + trigram search with RRF fusion and proximity reranking |
| `ctx_fetch_and_index` | Fetch URL, convert to markdown, index. 24h TTL cache |
| `ctx_stats` | Session statistics and context savings report |
| `ctx_doctor` | Plugin environment diagnostics |
| `ctx_purge` | Delete all indexed content |

## Supported Languages

JavaScript, TypeScript, Python, Shell (Bash), Ruby, Go, Rust, PHP, Perl, R, Elixir

## Architecture

```
context-mode/
├── .claude-plugin/plugin.json    ← Cowork plugin manifest
├── .claude/settings.json         ← Shipped deny/allow permission rules
├── .mcp.json                     ← MCP server registration
├── CLAUDE.md                     ← Think in Code directive (shipped with plugin)
├── start.js                      ← Bootstrapper: version self-heal, ensure-deps, server start
├── install.js                    ← One-command installer (7-step probe)
├── server/
│   ├── index.js                  ← MCP server (9 tools)
│   ├── sandbox.js                ← Subprocess executor
│   ├── knowledge.js              ← SQLite FTS5 knowledge base
│   ├── session.js                ← Session event persistence
│   ├── snapshot.js               ← Compaction snapshot builder
│   └── runtime.js                ← Language runtime detection
├── hooks/
│   ├── hooks.json                ← 6-event hook registrations
│   ├── run-hook.cmd              ← Windows dispatcher wrapper
│   ├── core/                     ← Shared hook utilities (formatters, routing, stdin, tool-naming)
│   ├── pretooluse.js             ← Intercepts + redirects tool calls
│   ├── posttooluse.js            ← Captures events after tool calls
│   ├── precompact.js             ← Builds resume snapshot
│   ├── sessionstart.js           ← Injects routing + session guide
│   ├── userpromptsubmit.js       ← Re-injects routing block each turn
│   ├── subagent-stop.js          ← Subagent cleanup
│   └── ensure-deps.js            ← ABI check + native dep rebuild
└── skills/
    ├── context-mode/SKILL.md     ← Main skill (decision tree, tool patterns)
    ├── ctx-stats/SKILL.md
    ├── ctx-doctor/SKILL.md
    └── ctx-purge/SKILL.md
```

## Search Algorithm

The knowledge base uses a three-layer search pipeline:

1. **Porter Stemmer FTS5** — BM25 ranking with title fields weighted 5x
2. **Trigram FTS5** — Substring matching for misspellings and partial terms
3. **Levenshtein Fuzzy Correction** — Vocabulary-based correction when results are empty

Results from layers 1 and 2 are merged via **Reciprocal Rank Fusion** (K=60) and **proximity reranked** for multi-term queries.

## Progressive Search Throttling

| Calls in 60s window | Behavior |
|---------------------|----------|
| 1-3 | Full results (2 per query) |
| 4-8 | Reduced results (1 per query) + warning |
| 9+ | Blocked — use `ctx_batch_execute` instead |

## Schema Versioning

Both the knowledge base and session databases use `PRAGMA user_version` for schema version tracking. On startup, the migration runner checks the current version, runs any pending migrations in order, and validates the final schema. If a destructive migration is needed (v2+), the database is backed up automatically before changes are applied.

Existing databases from earlier versions bootstrap cleanly to v1 with no data loss — all `CREATE TABLE IF NOT EXISTS` statements are idempotent.

## Tests

```bash
node test-e2e.js
```

216 tests across 19 sections covering: utils, exit classification, runtime detection, sandbox executor, knowledge base, session DB, snapshot builder, event extraction, routing block, hook cmd wrapper, MCP protocol smoke test, plugin discoverability, spec compliance, OSS attribution, plugin manifest validation, PreToolUse routing, hooks.json validation, plugin CLAUDE.md/settings validation, and schema migration.

## Security Model

context-mode provides **process isolation**, not filesystem sandboxing. Understanding this distinction is important:

- **What the sandbox does:** Each `ctx_execute` call runs code in a separate subprocess with its own temp directory. stdout is captured and returned; raw output never enters the context window. The subprocess has a hard 100MB stdout cap and a configurable timeout (default 30s). `NODE_OPTIONS` and `ELECTRON_RUN_AS_NODE` are stripped from the subprocess environment.

- **What the sandbox does NOT do:** The subprocess runs with the same filesystem permissions as the parent Claude Code process. `ctx_execute` with `language: 'shell'` runs arbitrary commands in the project root directory. There is no filesystem access restriction, no network restriction, and no binary execution restriction. The sandbox isolates context, not capabilities.

- **Permission rules:** The shipped `.claude/settings.json` denies `sudo`, `rm -rf /`, and `.env` file reads. These are guardrails for the development environment, not a security boundary.

- **Data storage:** Databases are stored in `~/.claude/plugins/data/context-mode/` with WAL mode enabled. Schema migrations back up the database before destructive changes. No data is sent to external services — all indexing and search is local via SQLite FTS5.

## Platform Support

- Windows (requires Git Bash for shell execution)
- macOS
- Linux

## Requirements

- Node.js >= 18
- Claude Code in Cowork

## Attribution

This project is a Cowork plugin port of [mksglu/context-mode](https://github.com/mksglu/context-mode) by [@mksglu](https://github.com/mksglu), licensed under the [Elastic License 2.0](https://www.elastic.co/licensing/elastic-license). The core algorithms, database schemas, search pipeline (BM25 + trigram + RRF fusion), sandbox executor architecture, session event system, and compaction snapshot builder are ported from that project and adapted for the Cowork plugin architecture.

## License

[Elastic License 2.0](LICENSE) — same license as the upstream project.
