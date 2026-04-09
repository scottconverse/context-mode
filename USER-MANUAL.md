# Context Mode — User Manual

## What Is This?

Context Mode is a plugin for Claude Code (running inside Cowork) that makes long work sessions dramatically more efficient. It keeps your context window clean by processing data in the background instead of dumping it directly into the conversation.

Think of it like this: instead of Claude reading an entire 500-line file into the conversation (consuming precious context space), Context Mode reads the file in a separate process and only brings back the specific information Claude needs.

## How It Works

### The Problem
Every time Claude reads a file, runs a command, or fetches a web page, the raw output goes into the "context window" — the conversation memory Claude uses to stay on track. Over a long session, this fills up fast. When it fills up, Claude has to compress old context, and that can cause it to lose track of what it was doing.

### The Solution
Context Mode provides three things:

1. **Sandbox Execution** — Claude runs code in a separate process. Only the result comes back, not all the raw data.
2. **Knowledge Base** — Large documents get indexed into a local database. Claude searches for specific information instead of loading entire files.
3. **Session Memory** — When the context window does get compressed, Context Mode saves what Claude was doing and restores it afterward.

## Using Context Mode

### You Don't Need to Do Anything Special
Once installed, Context Mode works automatically. It registers tools that Claude can use instead of the default ones. Claude will prefer these context-saving tools when they make sense.

### Slash Commands

- **`/ctx-stats`** — Shows how much context space has been saved in this session
- **`/ctx-doctor`** — Checks that the plugin is working correctly
- **`/ctx-purge`** — Clears all indexed content (if you want a fresh start)

### What Claude Uses Internally

These are the tools Claude uses behind the scenes. You don't need to call them directly, but it helps to know what they do:

| Tool | What It Does |
|------|-------------|
| `ctx_execute` | Runs code in a sandbox — only the output comes back |
| `ctx_execute_file` | Processes files without loading their contents into context |
| `ctx_batch_execute` | Runs multiple commands at once (more efficient) |
| `ctx_index` | Stores a document in the local knowledge base |
| `ctx_search` | Searches the knowledge base for specific information |
| `ctx_fetch_and_index` | Downloads a web page and stores it for searching |
| `ctx_stats` | Reports on context savings |
| `ctx_doctor` | Checks plugin health |
| `ctx_purge` | Clears all stored content |

## When Things Go Wrong

### "better-sqlite3 verification failed"
The plugin needs a database library to work. This error means it didn't install correctly.

**Fix:** Run `node scripts/setup.js` from the context-mode directory. If that fails, try `cd .data && npm rebuild better-sqlite3`.

### Plugin tools aren't appearing
The MCP server may not have started.

**Fix:** Run `/ctx-doctor` to check. If it shows issues, restart your Cowork session.

### "BLOCKED: N search calls in Xs"
The plugin limits how many searches you can run in rapid succession to prevent context bloat.

**Fix:** Use `ctx_batch_execute` to combine multiple searches into one call. Or wait 60 seconds for the throttle window to reset.

### Context is still growing fast
Context Mode reduces context usage when Claude uses its tools, but it can't force Claude to use them. If Claude is still using raw `Read` or `Bash` calls, the savings won't apply.

**Fix:** You can remind Claude to prefer context-mode tools. The routing block injected at session start should guide this, but an explicit reminder helps.

## Glossary

- **Context Window** — The conversation memory Claude uses. It has a limited size. When it fills up, older parts get compressed.
- **Sandbox** — A separate process that runs code in isolation. It can't affect your files directly.
- **FTS5** — Full-Text Search 5, a technology built into SQLite for searching text efficiently.
- **BM25** — A ranking algorithm that determines which search results are most relevant.
- **TTL Cache** — Time-To-Live cache. Once a web page is fetched and indexed, it's cached for 24 hours so it doesn't need to be re-fetched.
- **Compaction** — When Claude's context window gets full, older messages are compressed to make room. Context Mode saves session state before this happens.
- **MCP** — Model Context Protocol, the standard way Claude Code communicates with plugins.
- **Cowork** — The Claude desktop application that runs Claude Code sessions.

## Supported Languages (for sandbox execution)

JavaScript, TypeScript, Python, Shell (Bash), Ruby, Go, Rust, PHP, Perl, R, Elixir

## Platform Support

- **Windows** — Requires Git (for Bash). Node.js must be installed.
- **macOS** — Works out of the box with system Bash.
- **Linux** — Works out of the box.
