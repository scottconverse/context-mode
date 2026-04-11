# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- **macOS MCP server not connecting** — the Claude desktop app on macOS reads MCP config from `~/.mcp.json`, not `~/.claude/settings.json`. The installer and plugin hooks now write/merge the context-mode entry into `~/.mcp.json` with the fully resolved node path (works with nvm, volta, etc.). Self-heals on every session start.
- **Server probe fails with nvm** — probe spawn now uses `process.execPath` (full path to running node binary) instead of bare `'node'` which isn't on PATH in nvm environments.
- **All npm commands fail with nvm on macOS** — bare `npm` isn't on PATH in nvm shell environments. All `execSync('npm ...')` calls in install.js, start.js, ensure-deps.js, and setup.js now resolve the full npm path from `dirname(process.execPath)` on non-Windows platforms.

### Added
- `hooks/core/ensure-mcp-json.js` — shared module that merges context-mode into `~/.mcp.json`, preserving other MCP servers. Called from install.js, start.js, sessionstart.js, and setup.js.

## [1.6.0] - 2026-04-11

### Added
- **Declarative routing rules** (`hooks/core/routing-rules.js`) — all 18 routing rules extracted from imperative if/else chains into a plain data structure. Each rule declares its tool, match regex, pre-processor, safety predicate, action, and doc metadata. Adding or modifying a routing rule is now a config entry, not a code change.
- **Routing condition helpers** (`hooks/core/routing-conditions.js`) — pure predicate functions (`hasFileOutput`, `isStdoutAlias`, `isSilent`, `isVerbose`, `hasLimit`, `hasShortFormat`, `hasPipe`, `hasStat`, `hasSingleFile`) extracted from routing logic and individually testable.
- **Per-rule routing test suite** (`test/routing-rules.test.js`) — ~55 vitest tests covering every routing rule and every condition predicate in isolation.
- **Version stamper** (`scripts/stamp-version.js`) — reads version from `package.json` and stamps all 6 dependent files. Validates CHANGELOG has a matching entry. Exits non-zero on failure.
- **Routing table generator** (`scripts/gen-routing-table.js`) — reads `ROUTING_RULES` and auto-injects a markdown table into `README.md` between sentinel comments. Called by `stamp-version.js` on every release.
- **Version consistency test** (section 20 in `test-e2e.js`) — 6 assertions verifying all version-bearing files match `package.json`.
- `npm run stamp` and `npm run gen-routing-table` scripts in `package.json`.
- `verify-release.sh` now runs `stamp-version.js` as step 0.

### Changed
- `hooks/core/routing.js` rewritten as a declarative engine (~160 lines) that iterates `ROUTING_RULES`. Identical routing decisions for identical inputs — no behavior change.
- `README.md` routing table auto-generated from `routing-rules.js`; static 5-row table replaced with full 18-rule table with sentinel comments.
- `README.md` test count updated to 222 E2E tests across 20 sections.
- `docs/index.html` architecture diagram, hooks row, and test count updated.
- `USER-MANUAL.md` routing table expanded to all 18 rules; inline HTTP and gradle/maven entries added.

## [1.5.1] - 2026-04-10

### Fixed
- **ctx_execute_file double-indexing** — when `intent` is provided and output exceeds the threshold, the content was indexed twice (once in the intent path, once in the compression pipeline). The compression pipeline now skips indexing if intent already handled it.
- **Miss signal KB guard scoped to current project** — the guard now checks only the current project's DB (via `CLAUDE_PROJECT_DIR` hash) instead of all DBs in the content directory. Prevents false-positive miss signals from one project's KB size enabling misses for another project.

### Added
- 2 warm file tier boundary tests (warm file at threshold with zero retention → cut; warm file with learner retention → preserved)

## [1.5.0] - 2026-04-10

### Added
- **Enhanced Stage 3 scoring** — multi-signal block relevance scorer replaces flat +0.8/+0.2 model. Scores based on file recency (hot/warm/cold tiers), file touch frequency (log₂ boost), stack trace detection, and function/class definition detection. Combined with learner retention weights for adaptive compression.
- **Configurable compression level** — `CONTEXT_MODE_COMPRESSION` environment variable with three presets: `conservative` (threshold 0.2), `balanced` (threshold 0.4, default), `aggressive` (threshold 0.7). Active level shown in `ctx_stats` header.
- **Miss signal minimum KB guard** — miss signals are suppressed when the knowledge base DB is under 50KB, preventing false-positive miss accumulation on fresh installs (addresses v1.4.0 review feedback).
- 5 new vitest tests for enhanced scoring (recency tiers, frequency boost, stack traces, combined signals, score cap)
- 1 new vitest test for compression level configuration

### Changed
- `scoreBlock()` rewritten with 6 scoring signals (was 2)
- `stageSessionAware()` builds enriched session file map with timestamps and touch counts (was flat string array)
- `getRecentSessionEvents()` now returns timestamp field from session_events table
- `RELEVANCE_THRESHOLD` replaced with dynamic `getRelevanceThreshold()` based on configured level

## [1.4.0] - 2026-04-10

### Added
- **Learner miss-detection** — when `ctx_search` returns no results, a miss signal is written and matched against recent compression decisions. Misses increase retention weights alongside hits, creating a symmetric feedback loop for self-correcting compression aggressiveness.
- **ctx_execute rate limiting** — sliding window throttle (5 warn / 10 block per 60s) prevents tight execution loops. Duplicate command detection returns immediately when identical code is re-submitted within the throttle window.
- `was_missed` column in `compression_log` schema (auto-migrated from v1.3.x databases)
- Miss rate and signal rate displayed in `ctx_stats` Learner section
- 2 new E2E tests (execute throttle: normal + duplicate detection)
- 6 new vitest tests (miss detection, miss weight calculation, lifetime stats)

### Changed
- Learner weight calculation now uses `(retrievalRate + missRate) * RETENTION_MULTIPLIER` instead of `retrievalRate * RETENTION_MULTIPLIER`
- PostToolUse hook writes miss signals (`miss-*.json`) when `ctx_search` returns empty results, in addition to existing retrieval signals
- `ctx_stats` Learner section now shows miss rate and combined signal rate
- `getLifetimeStats()` returns `totalMisses` alongside `totalRetrievals`

## [1.3.1] - 2026-04-10

### Fixed
- **Learner accuracy display** — `ctx_stats` was showing inverted accuracy: `was_retrieved=1` (a retrieval hit) was counted as a "miss." Renamed `totalMisses` → `totalRetrievals`, corrected the percentage display and confidence labels.
- **ctx_execute_file compression** — output from `ctx_execute_file` now goes through the same 3-stage compression pipeline as `ctx_execute` and `ctx_batch_execute`. Previously, large file-processing outputs bypassed compression entirely.
- **ctx_fetch_and_index silent failure** — when a URL fetch fails and produces no output, the tool now returns an explicit error message instead of silently indexing empty content and reporting success.

## [1.3.0] - 2026-04-10

### Added
- **Token Compression Engine** — 3-stage pipeline compresses tool output before it enters context:
  - Stage 1 (deterministic): strips ANSI escape codes, carriage return overwrites, UTF-8 BOM, trailing whitespace, and collapses duplicate blank lines
  - Stage 2 (pattern-based): 10 tool-specific matchers for jest/vitest, pytest, git log, git diff, npm install, pip install, cargo build, docker build, make/cmake, and directory listings — collapses passing tests, compile steps, and progress bars while preserving failures verbatim
  - Stage 3 (session-aware): scores content blocks by relevance to current session files and learner retention weights; low-relevance blocks are summarized
- **Self-Learning Compression** — feedback loop tracks compressed content that Claude later retrieves via `ctx_search`. Retention weights adjust per tool pattern: high retrieval rates increase retention, low rates increase compression. 7-day decay window, 5-minute weight cache.
- **9 new PreToolUse routing matchers** — git log, git diff, npm test/jest/vitest, pytest, npm install/ci, pip install, cargo build/test, docker build, make/cmake. Each has smart pass-through conditions (e.g., `git log --oneline` and `git log -n 5` pass through; unbounded `git log` redirects through compressor).
- **Rewritten `ctx_stats`** — now shows token savings with compression breakdown by tool pattern, estimated cost savings for Opus/Sonnet/Haiku pricing, learner accuracy metrics, and lifetime aggregate statistics.
- **PostToolUse retrieval signals** — detects `ctx_search` calls and writes signal files consumed by the learner to detect retrieval patterns.
- **SessionStart learner cleanup** — prunes compression_log and compression_stats older than 7 days during session startup.
- **Periodic stats flush** — compression statistics flush to SQLite every 5 minutes and on shutdown.
- 76 new tests: 32 compressor tests (3 stages + error invariant), 13 learner tests (schema, weights, retrieval, decay, lifetime), 31 routing tests (9 new matchers + 4 regression)
- 13 test fixtures: real-world captured output for jest, pytest, git log, git diff, cargo, docker, make, npm install, pip install, directory listings

### Changed
- `ctx_execute` and `ctx_batch_execute` now compress output through the 3-stage pipeline before returning to context
- PreToolUse routing expanded from 14 to 23 matchers
- `ctx_stats` completely rewritten with token-based metrics and cost estimates (replaces byte-based report)
- Error invariant: lines containing error/warning/fail/panic/exception/traceback keywords are never compressed, with 2-line context protection above and below

## [1.2.1] - 2026-04-10

### Fixed
- CI: `run-hook.cmd` missing execute permission — all Linux/macOS CI jobs were failing with "Permission denied"
- start.js: `break` statement inside try/catch (not a loop) replaced with flag-based control flow for lockfile skip logic
- ctx_fetch_and_index: replaced `__CM_CT__:` stdout marker with JSON envelope `{ct, body}` to eliminate marker collision risk with page content
- db-base.js: better-sqlite3 error message now points to `install.js` (was `setup.js`)
- db-base.js: replaced CPU-spinning busy-wait with `Atomics.wait()` for SQLITE_BUSY retry backoff
- migrate.js: backup now covers pre-existing unversioned databases (user_version=0 with existing tables)
- knowledge.js: tightened `#classifyChunk` bracket regex to matched-pair pattern, reducing false positives on prose
- start.js: O_EXCL lockfile around `installed_plugins.json` read-modify-write to prevent concurrent-session race
- start.js: stale lockfile TTL — locks older than 30s are reclaimed via stat/unlink/retry
- sandbox.js: shell `executeFile` path quoting — escape backslashes and double quotes in FILES array construction

### Added
- CI workflow (`.github/workflows/ci.yml`): 3×3 matrix — Node 18/20/22 × ubuntu/macos/windows
- `npm test` script in package.json (runs E2E + adversarial suites)
- Security Model section in README — clarifies process isolation vs. filesystem sandboxing
- Windows `ctx_doctor` diagnostic: warns when Git Bash is missing with install link
- db-base.js: logs which path `better-sqlite3` was resolved from on startup
- Git tags and GitHub Releases for all 5 versions (v1.0.0–v1.2.1)
- CI/license/Node badges in README
- Dependabot configured for weekly npm dependency updates
- Adversarial test Phase 11: Lockfile Concurrency (4 tests — acquire/reject/release/stale TTL)
- Total tests: 278 (216 E2E + 62 adversarial)

### Changed
- README: "up to 98%" claim qualified with ctx_stats reference
- db-base.js: dependency search order documented and reordered (CLAUDE_PLUGIN_DATA first)
- CI: `actions/setup-node` upgraded v4 → v5 (eliminates Node 20 deprecation warnings)

## [1.2.0] - 2026-04-09

### Added
- Schema versioning and migration system (server/migrate.js) — uses PRAGMA user_version for zero-overhead version tracking
- Ordered migration runner with automatic backup before destructive changes
- Startup schema validation for both knowledge and session databases
- 9 new E2E tests covering: fresh DB, pre-existing unversioned DB bootstrap, no-op on current, multi-step migrations, backup creation/validity, rollback on failure, validation, ContentStore/SessionDB data preservation across reopens

### Changed
- knowledge.js: schema creation refactored from #createSchema() into versioned migration v1
- session.js: same refactoring pattern — schema is now migration v1
- Total E2E tests: 216 (up from 207)

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
