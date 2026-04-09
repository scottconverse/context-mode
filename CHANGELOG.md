# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
- 147-test E2E test suite covering all modules, MCP protocol smoke tests, plugin discoverability, and spec compliance
- Ported from [mksglu/context-mode](https://github.com/mksglu/context-mode) by [@mksglu](https://github.com/mksglu) and adapted for Cowork plugin architecture
