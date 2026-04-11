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
4. **Token Compression** — When tool output does come back, Context Mode automatically shrinks it before it enters the conversation. Passing tests get collapsed to a summary. Install progress bars disappear. Only errors and warnings are kept word-for-word.

## Installing Context Mode

### The Easiest Way — One Command

Open a terminal and run:

```bash
npx --yes --package=github:scottconverse/context-mode context-mode
```

That's it. The installer does everything automatically — you don't need to understand what it's doing, but here's what happens behind the scenes:

1. **Copies the plugin** to your Claude Code plugins folder
2. **Registers it** in your Claude Code settings so Claude knows it exists
3. **Enables it** so it loads automatically on every session
4. **Installs the database library** (better-sqlite3) that powers the knowledge base
5. **Verifies the database** can run advanced search features
6. **Probes the server** to confirm all 9 plugin tools are responding correctly
7. **Confirms success** and tells you what to do next

When it's done, you'll see a success message. At that point, **start a new Claude Code conversation** — the plugin loads automatically at session start.

### Confirming the Install Worked

In your new Claude Code session, type:

```
/ctx-doctor
```

This runs a health check. If everything is working, you'll see green checkmarks. If something is wrong, it tells you specifically what to fix.

### If the Install Fails

- Make sure Node.js 18 or newer is installed: `node --version`
- On Windows, make sure Git Bash is available
- Try running `node install.js` directly from the context-mode folder

---

## Using Context Mode

### You Don't Need to Do Anything Special
Once installed, Context Mode steers Claude toward context-saving tools through hook-driven behavioral guidance. You keep working exactly as you always have — the steering happens in the background.

### Tool Steering

Context Mode's hooks intercept tool calls and apply different policies depending on the tool:

| What Claude tried to do | What Context Mode does |
|------------------------|----------------------|
| Read a file | One-time advisory nudge suggesting `ctx_execute_file`; Read still proceeds |
| Run a Bash command (curl/wget) | **Blocked** — error message redirects to sandbox or fetch-and-index |
| Run a Bash command (git, ls, etc.) | Passes through unchanged — these are whitelisted |
| Run a Bash command (other) | One-time advisory nudge suggesting sandbox; command still proceeds |
| Run a search (Grep) | One-time advisory nudge suggesting sandbox; Grep still proceeds |
| Fetch a web page (WebFetch) | **Denied** — guidance redirects to `ctx_fetch_and_index` |
| Spawn an Agent | Routing guidance injected into the agent's prompt |

The strongest enforcement is on WebFetch (fully denied) and curl/wget (blocked). For Read, Grep, and general Bash, Context Mode nudges Claude once per session and then stays quiet. This is behavioral steering — not forced rerouting of every call.

**The Bash safe list** — not every Bash command gets sandboxed. Commands that write to your filesystem or navigate directories need to run as normal, and Context Mode knows this. The following always pass through unchanged:

- `git` — version control writes (commits, checkouts, resets)
- `mkdir`, `rm`, `mv` — file and folder operations
- `cd`, `ls`, `pwd` — navigation and listing
- `echo` — writing output to files or the terminal

Everything else runs through the sandbox.

#### Auto-Redirected Commands (New in v1.3.0)

Some commands produce so much output that they're automatically redirected through the compression pipeline. These commands are intercepted before they run and rerouted through Context Mode's sandbox, where their output is compressed before it enters the conversation:

| Command | What Happens |
|---------|-------------|
| `git log` (unbounded) | Redirected — but `git log --oneline` or `git log -n 5` pass through normally |
| `git diff` (unbounded) | Redirected — but `git diff --stat` or piped through `grep` passes through |
| `npm test` / `jest` / `vitest` | Redirected — test output compressed (passes collapsed, failures preserved) |
| `pytest` | Redirected — same compression as npm test |
| `npm install` / `npm ci` | Redirected — progress bars stripped, warnings preserved |
| `pip install` | Redirected — download progress stripped, warnings preserved |
| `cargo build` / `cargo test` | Redirected — compile steps collapsed, errors preserved |
| `docker build` | Redirected — cache lines collapsed, step output and errors preserved |
| `make` / `cmake --build` | Redirected — similar to cargo, compile noise reduced |

**When commands pass through normally:** If you pipe output through another command (like `git log | grep fix`), limit results (like `git log -n 5`), or use compact flags (like `git diff --stat`), the command runs normally without redirection. Context Mode only intercepts commands that would produce large, unbounded output.

**Routing guidance at every turn** — at the start of each prompt, Context Mode quietly injects a short routing guide into Claude's working memory. This tells Claude which tool to pick in different situations, so it stays consistent even deep into a long session. You never see this — it's invisible infrastructure.

### The "Think in Code" Directive

Context Mode ships with a set of instructions for Claude called the "Think in Code" directive. This is a file (called `CLAUDE.md`) that Claude reads at the start of every session. You don't configure it — it's part of the plugin.

The directive tells Claude: whenever you need to analyze data, count things, search content, or process information — write a short script to do the work, run it in the sandbox, and only bring back the answer. Don't read raw data into the conversation to process it mentally.

**What this means for you:** Claude becomes significantly more efficient at research and analysis tasks. Instead of reading 10 files into the conversation to find a pattern, Claude writes a 5-line script that searches all of them and returns only the result. You get the same answer with a fraction of the context used.

This happens automatically. You don't need to ask Claude to do this — the directive makes it the default behavior.

### Slash Commands

These four commands let you check in on what Context Mode is doing:

#### `/context-mode` — Load the Main Skill

The main Context Mode skill loads a decision tree, tool-selection patterns, and anti-patterns directly into Claude's working context. This is most useful at the start of a complex session or when you want Claude to be especially disciplined about tool choices.

**How to use it:** Type `/context-mode` in the Claude Code input and press Enter. Claude will acknowledge the skill and apply its guidance for the rest of the session.

#### `/ctx-stats` — See Your Savings
Run this any time to see how much context space Context Mode has saved. Here's what the output looks like:

```
# Token Savings This Session (45m)

  Compressed:    12,400 → 3,100 tokens (75.0% reduction)
  Sandboxed:     38,800 tokens kept out of context
  KB retrievals: 12 searches
  ─────────────────────────────────
  Total saved:   48,100 tokens
  Est. cost saved: $0.72 (Opus) / $0.14 (Sonnet) / $0.04 (Haiku)

## Top Compressed Outputs
  npm_test (x3): 4.2K → 0.8K (81.0%)
  git_log (x2): 3.1K → 1.2K (61.3%)
  pip_install (x1): 2.8K → 0.4K (85.7%)

## Learner
  Patterns tracked:  47 decisions
  Retrieval rate:    8/47 (17.0%)
  Miss rate:         3/47 (6.4%)
  Signal rate:       23.4% (hits + misses → retention adjustment)
  Confidence:        High
```

**What each line means:**

- **Compressed** — How many tokens went through the compression pipeline and how much smaller they got. "12,400 → 3,100" means the compressor saw 12,400 tokens of output and reduced it to 3,100.
- **Sandboxed** — Tokens that never entered the conversation at all because they were processed in the sandbox and only the result came back.
- **KB retrievals** — How many times Claude searched the knowledge base instead of re-reading raw content.
- **Total saved** — Compression savings plus sandboxed tokens combined.
- **Est. cost saved** — What those saved tokens would have cost at current pricing for each model tier.
- **Top Compressed Outputs** — Which types of tool output were compressed the most. The format is: `pattern (times seen): before → after (reduction%)`.
- **Learner** — The self-learning system tracks compression decisions and whether they were correct:
  - **Retrieval rate**: how often compressed content was later found by a search (indicates compression was too aggressive)
  - **Miss rate**: how often a search returned nothing for content that was compressed away (also indicates over-compression)
  - **Signal rate**: hits + misses combined — this drives the retention weight adjustment
  - **Confidence**: "High" means enough data has been collected for the weights to be meaningful

**How to use it:** Type `/ctx-stats` in the Claude Code input and press Enter.

#### `/ctx-doctor` — Check That Everything Is Working
If you're not sure whether Context Mode is running correctly, this command runs a full health check and tells you exactly what's working and what isn't.

Run it when:
- Tools aren't appearing in Claude Code
- You just installed the plugin and want to confirm it worked
- Something feels off and you want a diagnosis

**How to use it:** Type `/ctx-doctor` in the Claude Code input and press Enter. Read the output — it will tell you specifically what to fix if anything is wrong.

#### `/ctx-purge` — Start Fresh
Context Mode builds up a knowledge base of everything it has indexed during your sessions. Most of the time, this is exactly what you want — it means Claude can find things it indexed earlier without re-reading them.

But sometimes you want a clean slate. Maybe you've switched projects. Maybe the indexed content is stale. `/ctx-purge` deletes everything in the knowledge base so the next session starts from scratch.

**How to use it:** Type `/ctx-purge` in the Claude Code input and press Enter. You'll be asked to confirm before anything is deleted.

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

### What Happens When Context Gets Full (Session Compaction)

Every Claude session has a context window — a limit on how much the conversation can hold. When it fills up, Claude compresses older parts of the conversation to make room. This is called compaction.

Without Context Mode, compaction can cause Claude to lose track of what it was doing. It might forget earlier decisions, re-read files it already processed, or lose the thread of a complex task.

**Context Mode handles compaction gracefully.** Here's what happens:

1. Just before compaction, Context Mode saves a snapshot of the session — what Claude was working on, what decisions had been made, what files had been indexed, and what the current priority tasks are.

2. After compaction, when the new session begins, Context Mode injects that snapshot as a structured Session Guide. Claude reads it and picks up almost exactly where it left off.

3. The routing block (the invisible tool-selection guidance) is re-injected too, so Claude's tool-routing behavior is restored immediately.

4. The knowledge base is unchanged — everything indexed before compaction is still searchable. Claude doesn't need to re-read anything.

From your perspective, compaction with Context Mode feels like a brief pause. From Claude's perspective, it's nearly seamless.

**What you might notice:** Occasionally, after compaction, Claude may say something like "resuming from session guide" or briefly recap what it was working on. This is normal — it's reading the snapshot and confirming context before continuing.

### Token Compression — Automatic Output Shrinking

Starting in version 1.3.0, Context Mode automatically compresses tool output before it enters the conversation. You don't need to do anything — this happens in the background every time Claude runs a command through the sandbox.

**What gets compressed:**

- **Test results** — When Claude runs your tests, passing tests are collapsed into a count ("42 tests passed"). Failing tests are kept exactly as they are, word for word, so Claude can diagnose the problem.
- **Install logs** — When packages are installed (npm, pip), progress bars and download status are stripped. Warnings and errors are preserved.
- **Build output** — Compiler output from tools like `cargo build`, `docker build`, and `make` gets condensed. Compile errors and warnings are kept intact.
- **Git logs and diffs** — Long commit histories and large diffs are condensed while keeping the structure readable.
- **Directory listings** — Large folder listings are trimmed to the most relevant entries.

**What is never compressed:**

Errors and warnings are sacred. If a line contains words like "error," "warning," "fail," "panic," "exception," or "traceback," that line — plus the two lines above and below it — are always preserved exactly as they appeared. Context Mode will never hide a problem from Claude.

**Small outputs are left alone:**

If the output is under 2KB (roughly 40 lines of text), Context Mode only strips invisible terminal formatting codes. It doesn't try to compress small outputs because the savings wouldn't be worth the risk of losing useful detail.

**How much does it save?**

In a typical session with test runs, installs, and builds, compression reduces token usage by 40–90% on top of the savings from sandboxing. You can see exact numbers by running `/ctx-stats`.

---

## Updating Context Mode

To update to the latest version, run the same install command again:

```bash
npx --yes --package=github:scottconverse/context-mode context-mode
```

Then start a new session. Your existing data is safe — Context Mode uses schema versioning to handle upgrades automatically:

- **Your indexed content is preserved.** The knowledge base carries over between versions.
- **Your session history is preserved.** Events, snapshots, and session metadata are untouched.
- **If the new version changes the database structure,** Context Mode backs up your database first (saved as `.backup-vN` next to the original), then applies the changes. If anything goes wrong, the backup is there for recovery.
- **You don't need to do anything.** The upgrade happens silently the first time the new version opens your databases.

## When Things Go Wrong

### "better-sqlite3 verification failed"
The plugin needs a database library to work. This error means it didn't install correctly.

**Fix:** Run `node scripts/setup.js` from the context-mode directory. If that fails, try `cd .data && npm rebuild better-sqlite3`.

### Plugin tools aren't appearing
The plugin may not have installed correctly, or the MCP server may not have started.

**Fix — Step 1:** Run `/ctx-doctor` in your Claude Code session. It will tell you exactly what's wrong.

**Fix — Step 2:** If ctx-doctor shows the plugin isn't registered, navigate to the context-mode folder in a terminal and run:

```bash
node install.js
```

This re-runs the full 7-step installation. Once it completes successfully, **start a new Claude Code conversation** — the plugin does not hot-reload into an existing session. It only loads at session start.

**Fix — Step 3:** If the problem persists, check that Node.js 18+ is installed and that you're starting a completely new conversation (not resuming an old one).

### "BLOCKED: N search calls in Xs"
The plugin limits how many searches you can run in rapid succession to prevent context bloat.

**Fix:** Use `ctx_batch_execute` to combine multiple searches into one call. Or wait 60 seconds for the throttle window to reset.

### Context is still growing fast
Context Mode reduces context usage when Claude uses its tools, but it can't force Claude to use them. If Claude is still using raw `Read` or `Bash` calls, the savings won't apply.

**Fix:** You can remind Claude to prefer context-mode tools. The routing block injected at session start should guide this, but an explicit reminder helps.

### "Fetch failed: no content returned"
This means Context Mode tried to download a web page but got nothing back. The URL might be wrong, the site might be down, or it might be blocking automated requests.

**Fix:** Check that the URL is correct and accessible in a browser. If the site requires authentication or blocks bots, the content can't be fetched automatically — try copying the content manually and using `ctx_index` to store it.

---

## How It Works — Technical Appendix

This section is for technically curious users who want to understand what's happening under the hood. You don't need to read this to use Context Mode — everything described here happens automatically.

### The 3-Stage Compression Pipeline

Every piece of tool output that exceeds 2KB goes through three compression stages:

**Stage 1 — Deterministic Stripping (Lossless)**
Removes invisible noise that adds no value: ANSI color codes (the escape sequences that make terminal output colorful), carriage return overwrites (used by progress bars), UTF-8 byte order marks, trailing whitespace, and duplicate blank lines. This stage always runs, even on small outputs, because it's cheap and never loses meaningful content.

**Stage 2 — Pattern-Based Compression**
Recognizes 10 specific types of tool output and applies tailored compression rules to each:

| Pattern | What It Does |
|---------|-------------|
| npm test (jest/vitest) | Collapses passing test suites to a count; preserves failing tests verbatim |
| pytest | Same approach — passes collapsed, failures preserved |
| git log | Condenses commit entries while keeping structure |
| git diff | Reduces hunks while preserving changed lines |
| npm install | Strips progress bars and download indicators |
| pip install | Strips download progress and cache messages |
| cargo build | Collapses compile steps, preserves errors and warnings |
| docker build | Collapses cache lines and layer steps |
| make/cmake | Reduces compile noise, preserves errors |
| directory listing | Trims large listings to most relevant entries |

If the output doesn't match any known pattern, this stage is skipped entirely.

**Stage 3 — Session-Aware Relevance (Lossy)**
Splits the output into blocks and scores each one for relevance to the current session. Blocks that mention files you've been working on score higher. Blocks containing error keywords are always preserved. Low-relevance blocks are cut and replaced with a note like "42 lines in 3 blocks summarized (indexed, use ctx_search to query)." The cut content is still in the knowledge base — Claude can search for it if needed later.

### Error Safety Invariant

The compression pipeline enforces one absolute rule: **lines containing error-related keywords are never compressed.** The protected keywords are:

`error`, `Error`, `ERROR`, `fail`, `FAIL`, `warning`, `Warning`, `WARN`, `panic`, `exception`, `traceback`, `TypeError`, `ReferenceError`, `SyntaxError`, `ENOENT`, `EPERM`, `EACCES`

When one of these keywords appears on a line, that line and the two lines above and below it are marked as protected. No compression stage will touch them. This means Claude always sees the full context of any error, even in heavily compressed output.

### Self-Learning Feedback Loop

Context Mode tracks its own compression decisions and learns from them:

1. **Compression decision** — When Stage 3 cuts a block, it logs the decision with a content hash
2. **Retrieval signal** — If Claude later searches for that content (via `ctx_search`), a signal file is written noting the retrieval
3. **Weight adjustment** — Periodically, the learner reads these signals and adjusts retention weights per tool pattern. If compressed content gets retrieved often, the weight increases (meaning future output from that tool will be compressed less aggressively). If compressed content is rarely retrieved, the weight stays low or decreases.
4. **Decay** — Signals older than 7 days are pruned so the learner adapts to changing work patterns

The learner's weights are cached for 5 minutes and stored in a SQLite database alongside the knowledge base.

### The 2KB Threshold

Outputs smaller than 2,048 bytes only get Stage 1 processing (ANSI stripping). The reasoning: small outputs don't consume much context, and aggressive compression on a 30-line output risks losing detail that matters. The 2KB threshold is where the cost-benefit tips toward compression.

---

## Glossary

- **BM25** — A ranking algorithm that determines which search results are most relevant.
- **Compaction** — When Claude's context window gets full, older messages are compressed to make room. Context Mode saves session state before this happens.
- **Compression** — The process of shrinking tool output before it enters the conversation. Context Mode uses a 3-stage pipeline: stripping invisible formatting, applying pattern-specific rules, and filtering by session relevance.
- **Context Window** — The conversation memory Claude uses. It has a limited size. When it fills up, older parts get compressed.
- **Cowork** — The Claude desktop application that runs Claude Code sessions.
- **FTS5** — Full-Text Search 5, a technology built into SQLite for searching text efficiently.
- **MCP** — Model Context Protocol, the standard way Claude Code communicates with plugins.
- **Pipeline** — A series of processing steps that data passes through in order. Context Mode's compression pipeline has three stages.
- **Retention Score** — A number that controls how aggressively the compressor filters content for a given tool pattern. Higher scores mean more content is kept. The self-learning system adjusts these automatically.
- **Retrieval Rate** — The percentage of compressed content that Claude later searches for. A high retrieval rate means the compressor was cutting things Claude actually needed.
- **Sandbox** — A separate process that runs code in isolation. It can't affect your files directly.
- **Token** — The smallest unit of text that Claude processes. Roughly 4 characters or 3/4 of a word. Context windows are measured in tokens.
- **TTL Cache** — Time-To-Live cache. Once a web page is fetched and indexed, it's cached for 24 hours so it doesn't need to be re-fetched.

## Supported Languages (for sandbox execution)

JavaScript, TypeScript, Python, Shell (Bash), Ruby, Go, Rust, PHP, Perl, R, Elixir

## Platform Support

- **Windows** — Requires Git (for Bash). Node.js must be installed.
- **macOS** — Works out of the box with system Bash.
- **Linux** — Works out of the box.
