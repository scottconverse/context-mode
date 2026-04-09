# context-mode

Context window optimization plugin for Claude Code in Cowork. Sandboxes tool output, indexes content into a local knowledge base, and tracks session state to reduce context consumption by up to 98%.

## What It Does

Long Claude Code sessions consume context rapidly. Every file read, web fetch, and shell command dumps raw output into the context window. Context-mode solves this with three capabilities:

1. **Sandbox Execution** — Runs code in isolated subprocesses, capturing only stdout. Raw file contents and command output never enter context. Supports 11 languages.
2. **Knowledge Base** — Chunks and indexes content into a local SQLite FTS5 database with BM25 + trigram dual-strategy search. Retrieves only the relevant snippets.
3. **Session Continuity** — Captures session events via hooks and rebuilds a structured Session Guide after context compaction, so Claude resumes from exactly where it left off.

## Quick Start

1. Install the plugin into your Cowork workspace
2. The plugin auto-installs dependencies on first session start
3. Use `ctx_execute`, `ctx_search`, `ctx_fetch_and_index` instead of raw tools

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
├── .mcp.json                     ← MCP server registration
├── server/
│   ├── index.js                  ← MCP server (9 tools)
│   ├── sandbox.js                ← Subprocess executor
│   ├── knowledge.js              ← SQLite FTS5 knowledge base
│   ├── session.js                ← Session event persistence
│   ├── snapshot.js               ← Compaction snapshot builder
│   └── runtime.js                ← Language runtime detection
├── hooks/
│   ├── hooks.json                ← Hook definitions
│   ├── post-tool-use.js          ← Captures events after tool calls
│   ├── pre-compact.js            ← Builds resume snapshot
│   └── session-start.js          ← Injects routing + session guide
└── skills/
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
