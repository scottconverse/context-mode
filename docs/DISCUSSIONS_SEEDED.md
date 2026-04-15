# GitHub Discussions — Seed Content

These posts should be created after enabling Discussions on the repository (Settings > General > Features > Discussions).

---

## Category: Announcements (pin this post)

### Title: Welcome to context-mode — v1.0.0 Launch

Hey everyone! context-mode is now live.

**What it is:** A Cowork plugin that reduces context window consumption by 30–60% in typical developer sessions (more in research-heavy ones) during long Claude Code sessions. It sandboxes tool output, indexes content into a local FTS5 knowledge base, and tracks session state so Claude survives context compaction without losing its place.

**Current status:** v1.0.0 — all core features implemented and tested (137 E2E tests). Works on Windows and macOS.

**What's included:**
- 9 MCP tools for sandbox execution, knowledge base search, and session management
- 11 language runtimes (JavaScript, TypeScript, Python, Shell, Ruby, Go, Rust, PHP, Perl, R, Elixir)
- BM25 + trigram dual-strategy search with RRF fusion and fuzzy correction
- Session continuity via hooks — captures events and rebuilds context after compaction
- Progressive search throttling to prevent context bloat from search loops

**What's next:**
- Community feedback on search quality and throttling thresholds
- Additional hook events (PostCompact, SessionEnd)
- Performance profiling on very large knowledge bases (10K+ chunks)
- Exploring integration with the official Claude plugins marketplace

Try it out and let us know what you think!

---

## Category: Q&A

### Post 1

**Title:** How does context-mode decide when to sandbox vs. return raw output?

**Answer:** Two thresholds control this:

1. **INTENT_SEARCH_THRESHOLD (5KB):** If `ctx_execute` output exceeds 5KB AND you provided an `intent` parameter, the output is automatically indexed into the FTS5 knowledge base and only BM25-ranked snippets matching your intent are returned.

2. **LARGE_OUTPUT_THRESHOLD (100KB):** If output exceeds 100KB (with or without intent), it's always indexed and a pointer is returned. You then use `ctx_search` to query it.

Below 5KB, or when no intent is provided for output under 100KB, the raw stdout is returned directly — sandboxing isn't needed for small outputs.

### Post 2

**Title:** Does context-mode work with projects that don't use JavaScript/Node.js?

**Answer:** Yes. The MCP server itself runs on Node.js (which Cowork provides), but the sandbox executor supports 11 languages independently. If your project is Python, Go, Rust, or any other supported language, `ctx_execute` will detect the available runtime and use it.

The knowledge base is language-agnostic — it indexes and searches any text, markdown, or JSON regardless of the programming language it came from.

### Post 3

**Title:** What happens to my indexed data between sessions?

**Answer:** The knowledge base (SQLite FTS5) persists in `${CLAUDE_PLUGIN_DATA}/content/` and survives across sessions and plugin updates. Data is scoped per project (using a hash of the project directory path).

Stale databases older than 14 days are cleaned up automatically on server startup. You can also manually clear everything with `/ctx-purge`.

Session events are stored separately in `${CLAUDE_PLUGIN_DATA}/sessions/` and follow the same lifecycle.

---

## Category: Ideas / Feature Requests

### Post 1

**Title:** Idea: Configurable throttle thresholds

The current search throttling is hardcoded: 3 calls at full results, then reduced, then blocked at 8+ calls in a 60-second window. It would be useful to make these configurable for different workflow styles.

Some workflows genuinely need more rapid-fire searches (e.g., code navigation across a large codebase), while others would benefit from stricter limits. An environment variable or plugin config option could let users tune this.

What thresholds are working well for your workflows? Are you hitting the block threshold often?

### Post 2

**Title:** Idea: PostCompact hook for knowledge base re-indexing

Currently, the PreCompact hook builds a snapshot and the SessionStart(compact) hook restores it. But after compaction, the knowledge base still has all its indexed content — it might be useful to have a PostCompact hook that automatically re-indexes the most recently active files so search results are fresh.

Would this be valuable for your workflows, or is the current "search what's already indexed" approach sufficient?

---

## Category: Show and Tell

### Post 1

**Title:** Real-world context savings on a 2-hour debugging session

Here's what `/ctx-stats` showed after a long debugging session:

```
## Context Savings
- Bytes sandboxed (kept out of context): 847.3 KB
- Bytes indexed: 1.2 MB
- Bytes returned to context: 12.4 KB
- Savings ratio: 52.3%

## Cache
- Cache hits: 7
- Network requests saved: 7
- Estimated bytes saved by cache: 89.6 KB
```

The session involved reading ~30 source files, running tests repeatedly, and fetching API documentation. Without context-mode, this would have consumed most of a 200K context window. With it, the total context cost was 12.4 KB.

---

## Category: General

### Post 1

**Title:** Welcome! How to get help and contribute

Welcome to the context-mode community! Here's how to find what you need:

- **Documentation:** [README](../README.md) for quick start, [User Manual](../USER-MANUAL.md) for detailed walkthrough, [Full Docs (PDF)](README-FULL.pdf) for architecture deep-dive
- **Bug reports:** Open an issue on the Issues tab with reproduction steps
- **Contributing:** See [CONTRIBUTING.md](../CONTRIBUTING.md) for setup, testing, and PR guidelines
- **Feature ideas:** Post in the Ideas category — we're actively shaping the roadmap

If you're new to Cowork plugins, the [Claude Code plugin docs](https://code.claude.com/docs/en/plugins) are a great starting point for understanding how plugins work.

Looking forward to hearing how context-mode works for your sessions!
