# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.1.1] - 2026-04-09

### Fixed
- PreToolUse hook (pretooluse.js) crashes on malformed stdin JSON — now wraps in try/catch and fails open
- ctx_execute_file auto-index errors silently swallowed — now logs to stderr before falling through to raw stdout
- Session DB FIFO eviction counter drift — event_count in session_meta only incremented, never decremented on eviction. Replaced with actual row count query and batch eviction to enforce the 1000-event cap correctly

## [1.1.0] - 2026-04-09

### Added
- PreToolUse routing hooks — automatically redirects Bash, Read, Grep, WebFetch, Agent through context-mode sandbox
- Main `context-mode` skill with decision tree, patterns, and anti-patterns
- UserPromptSubmit hook for session context injection
- Bootstrapper (start.js) with dependency self-healing and ABI cache
- ensure-deps.js for native dependency management
- Session continuity modules (directive, loaders)
- Routing block XML template for tool selection guidance
- Server probe in install.js (confirms 9/9 tools respond)

### Fixed
- plugin.json now declares mcpServers field (root cause of tools not loading in Cowork)
- .mcp.json uses flat format per Cowork spec
- install.js marketplace name corrected to scottconverse-context-mode
- require('os') replaced with ESM import in server/index.js

### Changed
- Hook file naming aligned with upstream (sessionstart.js, posttooluse.js, etc.)
- hooks.json expanded from 4 events to 6 events with 14 matchers
- SessionStart hook now injects routing block + session directive

## [1.0.0] - 2026-04-09

### Added
- MCP server with 9 tools: ctx_execute, ctx_execute_file, ctx_batch_execute, ctx_index, ctx_search, ctx_fetch_and_index, ctx_stats, ctx_doctor, ctx_purge
- Sandbox executor supporting 11 languages (JavaScript, TypeScript, Python, Shell, Ruby, Go, Rust, PHP, Perl, R, Elixir) with subprocess isolation, 100MB stdout hard cap, and 30s default timeout
- SQLite FTS5 knowledge base with Porter stemmer + trigram dual tokenizers, BM25 ranking (title weighted 5x), Reciprocal Rank Fusion (K=60), proximity reranking, and Levenshtein fuzzy correction
- Session event tracking via PostToolUse hook capturing 13 event categories across 4 priority levels with SHA-256 dedup and FIFO eviction (1000 events max)
- Compaction snapshot builder producing priority-tiered XML snapshots within 2KB budget for session resume
- SessionStart hook handling startup, compact resume, and continue resume modes with routing block injection
- 24-hour TTL cache for ctx_fetch_and_index with per-source metadata tracking
- Progressive search throttling (calls 1-3: 2 results, 4-8: 1 result, 9+: blocked)
- Cross-platform support for Windows and macOS (Git Bash for shell, taskkill/kill for process management)
- 3 skills: /ctx-stats, /ctx-doctor, /ctx-purge
- Context optimizer agent prompt
- 158-test E2E test suite covering all modules, MCP protocol smoke tests, plugin discoverability, spec compliance, and OSS attribution
- One-command installer (`node install.js`) — clones to cache, registers, enables, installs deps, verifies FTS5
- Ported from [mksglu/context-mode](https://github.com/mksglu/context-mode) by [@mksglu](https://github.com/mksglu) and adapted for Cowork plugin architecture
