# context-mode Clean Re-port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-port context-mode from upstream mksglu/context-mode v1.0.75 for Cowork, adding the missing plugin wiring, routing hooks, main skill, and bootstrapper that make it work as an integrated system.

**Architecture:** The MCP server (9 tools, FTS5 knowledge base, polyglot sandbox) is solid and unchanged. We're adding the plugin packaging layer (manifests), the hook routing layer (PreToolUse intercepts + session continuity), and the teaching layer (main skill + routing block) that make it an automatic context-saving system rather than just manual tools.

**Tech Stack:** Node.js ESM, MCP SDK, better-sqlite3 + FTS5, Cowork plugin spec

**Spec:** `docs/superpowers/specs/2026-04-09-clean-report-design.md`

**Upstream reference:** `/tmp/mksglu-context-mode/` (cloned from https://github.com/mksglu/context-mode)

---

## Task 1: Plugin Manifests (get MCP tools loading)

**Files:**
- Modify: `C:\Users\8745HX\Desktop\Claude\context-mode\.claude-plugin\plugin.json`
- Modify: `C:\Users\8745HX\Desktop\Claude\context-mode\.mcp.json`

- [ ] **Step 1: Read current plugin.json**

Read `C:\Users\8745HX\Desktop\Claude\context-mode\.claude-plugin\plugin.json` to see current state.

- [ ] **Step 2: Rewrite plugin.json with mcpServers, skills, hooks**

Replace the entire file with:

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

- [ ] **Step 3: Read current .mcp.json**

Read `C:\Users\8745HX\Desktop\Claude\context-mode\.mcp.json` to see current state (may already be flat format from earlier fix).

- [ ] **Step 4: Write .mcp.json in flat format**

Write the flat format (Cowork spec — no `mcpServers` wrapper):

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

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin/plugin.json .mcp.json
git commit -m "fix: add mcpServers to plugin.json, fix .mcp.json flat format for Cowork"
```

---

## Task 2: Core Hook Infrastructure

**Files:**
- Create: `C:\Users\8745HX\Desktop\Claude\context-mode\hooks\core\stdin.js`
- Create: `C:\Users\8745HX\Desktop\Claude\context-mode\hooks\core\tool-naming.js`
- Create: `C:\Users\8745HX\Desktop\Claude\context-mode\hooks\core\formatters.js`
- Create: `C:\Users\8745HX\Desktop\Claude\context-mode\hooks\suppress-stderr.js`

- [ ] **Step 1: Create hooks/core/ directory**

```bash
mkdir -p hooks/core
```

- [ ] **Step 2: Create hooks/core/stdin.js**

Cross-platform stdin reader. Ported from upstream `hooks/core/stdin.mjs`. Uses event-based flowing mode to avoid macOS spawnSync hang and Windows EOF bugs.

```javascript
/**
 * Shared stdin reader for all hook scripts.
 * Cross-platform (Windows/macOS/Linux) — no bash/jq dependency.
 *
 * Ported from mksglu/context-mode (https://github.com/mksglu/context-mode)
 * by @mksglu, licensed under Elastic License 2.0.
 */

export function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data.replace(/^\uFEFF/, "")));
    process.stdin.on("error", reject);
    process.stdin.resume();
  });
}
```

- [ ] **Step 3: Create hooks/core/tool-naming.js**

Cowork-only tool naming. Stripped from upstream's multi-platform version.

```javascript
/**
 * Cowork MCP tool naming convention.
 *
 * Ported from mksglu/context-mode (https://github.com/mksglu/context-mode)
 * by @mksglu, licensed under Elastic License 2.0.
 */

const COWORK_PREFIX = (tool) => `mcp__plugin_context-mode_context-mode__${tool}`;

/**
 * Get the Cowork-specific MCP tool name for a bare tool name.
 */
export function getToolName(bareTool) {
  return COWORK_PREFIX(bareTool);
}

/**
 * Create a namer function for use in routing block and guidance messages.
 * Returns (bareTool) => coworkToolName.
 */
export function createToolNamer() {
  return (bareTool) => getToolName(bareTool);
}
```

- [ ] **Step 4: Create hooks/core/formatters.js**

Cowork-only response formatter. Stripped from upstream's multi-platform version.

```javascript
/**
 * Cowork-specific response formatter for PreToolUse hooks.
 * Converts normalized routing decisions to hookSpecificOutput JSON.
 *
 * Ported from mksglu/context-mode (https://github.com/mksglu/context-mode)
 * by @mksglu, licensed under Elastic License 2.0.
 */

const formatter = {
  deny: (reason) => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }),
  ask: () => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
    },
  }),
  modify: (updatedInput) => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "Routed to context-mode sandbox",
      updatedInput,
    },
  }),
  context: (additionalContext) => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext,
    },
  }),
};

/**
 * Apply formatter to a normalized routing decision.
 * Returns Cowork-specific JSON response, or null for passthrough.
 */
export function formatDecision(decision) {
  if (!decision) return null;

  switch (decision.action) {
    case "deny": return formatter.deny(decision.reason);
    case "ask": return formatter.ask();
    case "modify": return formatter.modify(decision.updatedInput);
    case "context": return formatter.context(decision.additionalContext);
    default: return null;
  }
}
```

- [ ] **Step 5: Create hooks/suppress-stderr.js**

Prevents hook stderr from polluting Claude's context.

```javascript
/**
 * Suppress stderr output from hook subprocesses.
 * Prevents deprecation warnings and debug noise from entering context.
 *
 * Ported from mksglu/context-mode (https://github.com/mksglu/context-mode)
 * by @mksglu, licensed under Elastic License 2.0.
 */

const _origWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = () => true;
```

- [ ] **Step 6: Commit**

```bash
git add hooks/core/stdin.js hooks/core/tool-naming.js hooks/core/formatters.js hooks/suppress-stderr.js
git commit -m "feat: add core hook infrastructure (stdin, tool-naming, formatters, suppress-stderr)"
```

---

## Task 3: Routing Block

**Files:**
- Create: `C:\Users\8745HX\Desktop\Claude\context-mode\hooks\routing-block.js`

- [ ] **Step 1: Create hooks/routing-block.js**

Port from upstream `hooks/routing-block.mjs`. This is the XML instruction block injected by SessionStart and into Agent/Task prompts. Uses our tool namer for Cowork-specific tool names.

```javascript
/**
 * Shared routing block for context-mode hooks.
 * Single source of truth — imported by pretooluse.js and sessionstart.js.
 *
 * Ported from mksglu/context-mode (https://github.com/mksglu/context-mode)
 * by @mksglu, licensed under Elastic License 2.0.
 */

import { createToolNamer } from "./core/tool-naming.js";

export function createRoutingBlock(t) {
  return `
<context_window_protection>
  <priority_instructions>
    Raw tool output floods your context window. You MUST use context-mode MCP tools to keep raw data in the sandbox.
  </priority_instructions>

  <tool_selection_hierarchy>
    1. GATHER: ${t("ctx_batch_execute")}(commands, queries)
       - Primary tool for research. Runs all commands, auto-indexes, and searches.
       - ONE call replaces many individual steps.
    2. FOLLOW-UP: ${t("ctx_search")}(queries: ["q1", "q2", ...])
       - Use for all follow-up questions. ONE call, many queries.
    3. PROCESSING: ${t("ctx_execute")}(language, code) | ${t("ctx_execute_file")}(path, language, code)
       - Use for API calls, log analysis, and data processing.
  </tool_selection_hierarchy>

  <forbidden_actions>
    - DO NOT use Bash for commands producing >20 lines of output.
    - DO NOT use Read for analysis (use execute_file). Read IS correct for files you intend to Edit.
    - DO NOT use WebFetch (use ${t("ctx_fetch_and_index")} instead).
    - Bash is ONLY for git/mkdir/rm/mv/navigation.
    - DO NOT use ${t("ctx_execute")} or ${t("ctx_execute_file")} to create, modify, or overwrite files.
      ctx_execute is for data analysis, log processing, and computation only.
  </forbidden_actions>

  <file_writing_policy>
    ALWAYS use the native Write tool to create files and Edit tool to modify files.
    NEVER use ${t("ctx_execute")}, ${t("ctx_execute_file")}, or Bash to write file content.
    This applies to all file types: code, configs, plans, specs, YAML, JSON, markdown.
  </file_writing_policy>

  <output_constraints>
    <word_limit>Keep your final response under 500 words.</word_limit>
    <artifact_policy>
      Write artifacts (code, configs, PRDs) to FILES using the native Write tool. NEVER return them as inline text.
      Use Edit tool for modifications to existing files.
      Return only: file path + 1-line description.
    </artifact_policy>
    <response_format>
      Your response must be a concise summary:
      - Actions taken (2-3 bullets)
      - File paths created/modified
      - Knowledge base source labels (so parent can search)
      - Key findings
    </response_format>
  </output_constraints>

  <ctx_commands>
    When the user says "ctx stats", "ctx-stats", "/ctx-stats", or asks about context savings:
    → Call the stats MCP tool and display the full output verbatim.

    When the user says "ctx doctor", "ctx-doctor", "/ctx-doctor", or asks to diagnose context-mode:
    → Call the doctor MCP tool, execute the returned shell command, display results as a checklist.

    When the user says "ctx purge", "ctx-purge", "/ctx-purge", or asks to wipe/reset the knowledge base:
    → Call the purge MCP tool with confirm: true. Warn the user this is irreversible.

    After /clear or /compact: knowledge base and session stats are preserved. Inform the user: "context-mode knowledge base preserved. Use ctx purge if you want to start fresh."
  </ctx_commands>
</context_window_protection>`;
}

export function createReadGuidance(t) {
  return '<context_guidance>\n  <tip>\n    If you are reading this file to Edit it, Read is the correct tool — Edit needs file content in context.\n    If you are reading to analyze or explore, use ' + t("ctx_execute_file") + '(path, language, code) instead — only your printed summary will enter the context.\n  </tip>\n</context_guidance>';
}

export function createGrepGuidance(t) {
  return '<context_guidance>\n  <tip>\n    This operation may flood your context window. To stay efficient:\n    - Use ' + t("ctx_execute") + '(language: "shell", code: "...") to run searches in the sandbox.\n    - Only your final printed summary will enter the context.\n  </tip>\n</context_guidance>';
}

export function createBashGuidance(t) {
  return '<context_guidance>\n  <tip>\n    This Bash command may produce large output. To stay efficient:\n    - Use ' + t("ctx_batch_execute") + '(commands, queries) for multiple commands\n    - Use ' + t("ctx_execute") + '(language: "shell", code: "...") to run in sandbox\n    - Only your final printed summary will enter the context.\n    - Bash is best for: git, mkdir, rm, mv, navigation, and short-output commands only.\n  </tip>\n</context_guidance>';
}

// Default exports using Cowork tool namer
const _t = createToolNamer();
export const ROUTING_BLOCK = createRoutingBlock(_t);
export const READ_GUIDANCE = createReadGuidance(_t);
export const GREP_GUIDANCE = createGrepGuidance(_t);
export const BASH_GUIDANCE = createBashGuidance(_t);
```

- [ ] **Step 2: Commit**

```bash
git add hooks/routing-block.js
git commit -m "feat: add routing block (XML instruction template for tool selection)"
```

---

## Task 4: Core Routing Logic

**Files:**
- Create: `C:\Users\8745HX\Desktop\Claude\context-mode\hooks\core\routing.js`

- [ ] **Step 1: Create hooks/core/routing.js**

Port from upstream `hooks/core/routing.mjs`. Pure routing logic — takes tool name + input, returns normalized decision. Stripped of multi-platform aliases and security module (optional import with graceful degradation).

This is the largest single file in the port. Read the upstream file at `/tmp/mksglu-context-mode/hooks/core/routing.mjs` and port it with these changes:
- Import `createToolNamer` from `./tool-naming.js` (not `../core/tool-naming.mjs`)
- Import routing blocks from `../routing-block.js` (not `../routing-block.mjs`)
- Remove multi-platform TOOL_ALIASES — keep only the canonical names (Bash, Read, Grep, WebFetch, Agent, Task)
- Remove `initSecurity` and security module imports — security is optional and not available in our fork
- Keep all curl/wget detection, heredoc stripping, quote stripping, build tool detection
- Keep guidance throttle with temp file markers
- Keep Agent/Task routing block injection
- Keep MCP tool security checks (but make security evaluation no-op when module unavailable)
- The `routePreToolUse` function signature changes: remove `platform` param (always Cowork)

The full file is ~250 lines. Read the upstream source and adapt per the above.

- [ ] **Step 2: Test routing logic manually**

```bash
cd C:/Users/8745HX/Desktop/Claude/context-mode && node -e "
import { routePreToolUse } from './hooks/core/routing.js';
// curl should be blocked
const r1 = routePreToolUse('Bash', { command: 'curl https://example.com' });
console.log('curl:', r1?.action);
// git should pass
const r2 = routePreToolUse('Bash', { command: 'git status' });
console.log('git:', r2);
// WebFetch should be denied
const r3 = routePreToolUse('WebFetch', { url: 'https://docs.example.com' });
console.log('WebFetch:', r3?.action);
"
```

Expected:
```
curl: modify
git: null (or context on first call)
WebFetch: deny
```

- [ ] **Step 3: Commit**

```bash
git add hooks/core/routing.js
git commit -m "feat: add core routing logic (PreToolUse decisions for Bash/Read/Grep/WebFetch/Agent)"
```

---

## Task 5: PreToolUse Hook

**Files:**
- Create: `C:\Users\8745HX\Desktop\Claude\context-mode\hooks\pretooluse.js`

- [ ] **Step 1: Create hooks/pretooluse.js**

Port from upstream `hooks/pretooluse.mjs`. Stripped of self-heal block (we handle that in `start.js`) and multi-platform detection.

```javascript
#!/usr/bin/env node
import "./suppress-stderr.js";
/**
 * PreToolUse hook for context-mode (Cowork)
 * Redirects data-fetching tools to context-mode MCP tools.
 *
 * Ported from mksglu/context-mode (https://github.com/mksglu/context-mode)
 * by @mksglu, licensed under Elastic License 2.0.
 */

import { readStdin } from "./core/stdin.js";
import { routePreToolUse } from "./core/routing.js";
import { formatDecision } from "./core/formatters.js";

const raw = await readStdin();
const input = JSON.parse(raw);
const tool = input.tool_name ?? "";
const toolInput = input.tool_input ?? {};

const decision = routePreToolUse(tool, toolInput, process.env.CLAUDE_PROJECT_DIR);
const response = formatDecision(decision);
if (response !== null) {
  process.stdout.write(JSON.stringify(response) + "\n");
}
```

- [ ] **Step 2: Commit**

```bash
git add hooks/pretooluse.js
git commit -m "feat: add PreToolUse hook (routes Bash/Read/Grep/WebFetch/Agent through sandbox)"
```

---

## Task 6: Ensure-deps and Suppress-stderr

**Files:**
- Create: `C:\Users\8745HX\Desktop\Claude\context-mode\hooks\ensure-deps.js`

- [ ] **Step 1: Create hooks/ensure-deps.js**

Port from upstream `hooks/ensure-deps.mjs`. Handles native dep installation and ABI compatibility for better-sqlite3.

Read the upstream file at `/tmp/mksglu-context-mode/hooks/ensure-deps.mjs` and port it exactly, changing only:
- File extension references (`.mjs` → `.js`)
- Import paths adjusted for our directory structure
- Keep `ensureDeps()`, `ensureNativeCompat()`, `codesignBinary()` functions
- Keep auto-run on import at bottom

- [ ] **Step 2: Commit**

```bash
git add hooks/ensure-deps.js
git commit -m "feat: add ensure-deps (native dependency bootstrap + ABI cache)"
```

---

## Task 7: Session Continuity Modules

**Files:**
- Modify: `C:\Users\8745HX\Desktop\Claude\context-mode\hooks\session-helpers.js`
- Create: `C:\Users\8745HX\Desktop\Claude\context-mode\hooks\session-directive.js`
- Create: `C:\Users\8745HX\Desktop\Claude\context-mode\hooks\session-loaders.js`

- [ ] **Step 1: Read current session-helpers.js**

Read `C:\Users\8745HX\Desktop\Claude\context-mode\hooks\session-helpers.js` to understand what we have.

- [ ] **Step 2: Update session-helpers.js**

Our existing `session-helpers.js` already has `readStdin`, `getSessionId`, `getSessionDBPath`, `getSessionEventsPath`. Add the missing `getCleanupFlagPath` function. Keep our existing functions intact — they work well. The `readStdin` in this file is used by our existing hooks; the new `core/stdin.js` is used by new hooks. Both can coexist.

Add after the `getSessionEventsPath` function:

```javascript
/**
 * Get the cleanup flag path (marks fresh session starts).
 */
export function getCleanupFlagPath() {
  const projectDir = getProjectDir();
  const hash = createHash('sha256').update(projectDir).digest('hex').slice(0, 16);
  const dir = getSessionDBDir();
  return join(dir, `${hash}-cleanup.flag`);
}
```

Also export `getSessionDBDir` (currently private) so `session-loaders.js` can use it if needed.

- [ ] **Step 3: Create hooks/session-directive.js**

Port from upstream `hooks/session-directive.mjs`. Builds session directive XML for compact/resume.

Read the upstream file at `/tmp/mksglu-context-mode/hooks/session-directive.mjs` and port it. This module:
- Reads session events from DB
- Writes them to a markdown file for auto-indexing by the MCP server
- Builds XML directive strings for compact/resume injection
- Uses `createToolNamer` for Cowork tool names in directive text

- [ ] **Step 4: Create hooks/session-loaders.js**

Port from upstream `hooks/session-loaders.mjs`. Lazy-loads SessionDB for hooks.

Read the upstream file at `/tmp/mksglu-context-mode/hooks/session-loaders.mjs` and port it. This module:
- Creates a factory function that dynamically imports SessionDB from `../server/session.js`
- Returns `{ loadSessionDB }` bound to the hook directory
- Uses `pathToFileURL` for Windows compatibility

- [ ] **Step 5: Commit**

```bash
git add hooks/session-helpers.js hooks/session-directive.js hooks/session-loaders.js
git commit -m "feat: add session continuity modules (directive, loaders, cleanup flag)"
```

---

## Task 8: Rewrite SessionStart Hook

**Files:**
- Modify: `C:\Users\8745HX\Desktop\Claude\context-mode\hooks\session-start.js` → rename to `hooks\sessionstart.js`

- [ ] **Step 1: Read current session-start.js**

Read `C:\Users\8745HX\Desktop\Claude\context-mode\hooks\session-start.js` to understand current state.

- [ ] **Step 2: Read upstream sessionstart.mjs**

Read `/tmp/mksglu-context-mode/hooks/sessionstart.mjs` for reference.

- [ ] **Step 3: Create hooks/sessionstart.js (replacing session-start.js)**

Port from upstream. Key changes from our current version:
- Import and inject `ROUTING_BLOCK` from `routing-block.js` on every session start
- Handle all 4 source types: startup, compact, resume, clear
- On startup: cleanup old sessions, capture CLAUDE.md rules, cleanup old plugin cache dirs
- On compact: write session events file, build session directive
- On resume: load latest events, build session directive
- On clear: no action (ctx_purge is the only wipe mechanism)
- Output `hookSpecificOutput` with `additionalContext` containing the routing block + any session directive

Read the upstream file and port it with these adaptations:
- Import from our local modules (`./routing-block.js`, `./session-helpers.js`, etc.)
- Import `ensure-deps.js` and `suppress-stderr.js` at top
- Use `createToolNamer()` (no platform argument — always Cowork)
- Remove old `session-start.js` after creating the new one

- [ ] **Step 4: Delete old session-start.js and shell wrapper**

```bash
git rm hooks/session-start.js hooks/session-start.sh 2>/dev/null
```

- [ ] **Step 5: Commit**

```bash
git add hooks/sessionstart.js
git commit -m "feat: rewrite SessionStart hook with routing block injection + session continuity"
```

---

## Task 9: UserPromptSubmit Hook

**Files:**
- Create: `C:\Users\8745HX\Desktop\Claude\context-mode\hooks\userpromptsubmit.js`

- [ ] **Step 1: Read upstream userpromptsubmit.mjs**

Read `/tmp/mksglu-context-mode/hooks/userpromptsubmit.mjs` for reference.

- [ ] **Step 2: Create hooks/userpromptsubmit.js**

Port from upstream. This hook fires on every user prompt submission and injects session context. Read the upstream and adapt:
- Import from our local modules
- Import `suppress-stderr.js` at top
- Use Cowork output format (`hookSpecificOutput`)

- [ ] **Step 3: Commit**

```bash
git add hooks/userpromptsubmit.js
git commit -m "feat: add UserPromptSubmit hook (session context injection)"
```

---

## Task 10: Rewrite PostToolUse and PreCompact Hooks

**Files:**
- Modify: `C:\Users\8745HX\Desktop\Claude\context-mode\hooks\post-tool-use.js` → rename to `hooks\posttooluse.js`
- Modify: `C:\Users\8745HX\Desktop\Claude\context-mode\hooks\pre-compact.js` → rename to `hooks\precompact.js`

- [ ] **Step 1: Read upstream posttooluse.mjs and precompact.mjs**

Read both upstream files for reference.

- [ ] **Step 2: Read our current post-tool-use.js and pre-compact.js**

Read both to understand what we have and what needs to change.

- [ ] **Step 3: Create hooks/posttooluse.js (replacing post-tool-use.js)**

Align with upstream's session capture pattern. Key changes:
- Add `import "./suppress-stderr.js"` at top
- Add `import "./ensure-deps.js"` at top (ensures better-sqlite3 available)
- Use `readStdin` from `core/stdin.js` instead of our `parseHookInput`
- Keep session event extraction via `session-extract.js`
- Add error logging to debug file (best effort, never blocks)

- [ ] **Step 4: Create hooks/precompact.js (replacing pre-compact.js)**

Align with upstream's snapshot pattern. Key changes:
- Add `suppress-stderr.js` and `ensure-deps.js` imports
- Use `readStdin` from `core/stdin.js`
- Add session events file writing via `session-directive.js`
- Build and store resume snapshot

- [ ] **Step 5: Delete old files and shell wrappers**

```bash
git rm hooks/post-tool-use.js hooks/post-tool-use.sh hooks/pre-compact.js hooks/pre-compact.sh 2>/dev/null
```

- [ ] **Step 6: Commit**

```bash
git add hooks/posttooluse.js hooks/precompact.js
git commit -m "feat: rewrite PostToolUse and PreCompact hooks (align with upstream session capture)"
```

---

## Task 11: hooks.json — Full 6-Event Registration

**Files:**
- Modify: `C:\Users\8745HX\Desktop\Claude\context-mode\hooks\hooks.json`

- [ ] **Step 1: Read current hooks.json**

Read `C:\Users\8745HX\Desktop\Claude\context-mode\hooks\hooks.json` to see current state.

- [ ] **Step 2: Rewrite hooks.json with all 6 events**

```json
{
  "description": "context-mode hooks — PreToolUse routing, PostToolUse session capture, PreCompact snapshot, SessionStart context injection, UserPromptSubmit session context, SubagentStop cleanup",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd pretooluse" }]
      },
      {
        "matcher": "WebFetch",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd pretooluse" }]
      },
      {
        "matcher": "Read",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd pretooluse" }]
      },
      {
        "matcher": "Grep",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd pretooluse" }]
      },
      {
        "matcher": "Agent",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd pretooluse" }]
      },
      {
        "matcher": "Task",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd pretooluse" }]
      },
      {
        "matcher": "mcp__plugin_context-mode_context-mode__ctx_execute",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd pretooluse" }]
      },
      {
        "matcher": "mcp__plugin_context-mode_context-mode__ctx_execute_file",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd pretooluse" }]
      },
      {
        "matcher": "mcp__plugin_context-mode_context-mode__ctx_batch_execute",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd pretooluse" }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd posttooluse" }]
      }
    ],
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd precompact" }]
      }
    ],
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd sessionstart" }]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd userpromptsubmit" }]
      }
    ],
    "SubagentStop": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd subagent-stop" }]
      }
    ]
  }
}
```

- [ ] **Step 3: Update run-hook.cmd**

Read `C:\Users\8745HX\Desktop\Claude\context-mode\hooks\run-hook.cmd` and verify it can handle the new hook names (`pretooluse`, `posttooluse`, `precompact`, `sessionstart`, `userpromptsubmit`, `subagent-stop`). The current implementation takes the hook name as an argument and runs `node hooks/<name>.js`, so it should work with the new names. Verify and fix if needed.

- [ ] **Step 4: Delete orphaned shell wrapper scripts**

```bash
git rm hooks/subagent-stop.sh 2>/dev/null
```

- [ ] **Step 5: Commit**

```bash
git add hooks/hooks.json hooks/run-hook.cmd
git commit -m "feat: register all 6 hook events with 14 matchers"
```

---

## Task 12: Main context-mode Skill

**Files:**
- Create: `C:\Users\8745HX\Desktop\Claude\context-mode\skills\context-mode\SKILL.md`
- Create: `C:\Users\8745HX\Desktop\Claude\context-mode\skills\context-mode\references\patterns-javascript.md`
- Create: `C:\Users\8745HX\Desktop\Claude\context-mode\skills\context-mode\references\patterns-python.md`
- Create: `C:\Users\8745HX\Desktop\Claude\context-mode\skills\context-mode\references\patterns-shell.md`
- Create: `C:\Users\8745HX\Desktop\Claude\context-mode\skills\context-mode\references\anti-patterns.md`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p skills/context-mode/references
```

- [ ] **Step 2: Read upstream SKILL.md**

Read `/tmp/mksglu-context-mode/skills/context-mode/SKILL.md` — this was already captured during exploration. Port it with these adaptations:
- Remove Playwright-specific sections (we don't have Playwright MCP as a dependency — keep the general pattern but note it's for when Playwright is available)
- Remove agent-browser references (not available in our fork)
- Keep all other content: decision tree, tool selection table, language selection, search strategy, automatic triggers, anti-patterns, examples, critical rules

- [ ] **Step 3: Create SKILL.md**

Write the full skill file adapted from upstream. Include the frontmatter with description and trigger keywords.

- [ ] **Step 4: Read upstream reference files**

Read all 4 files from `/tmp/mksglu-context-mode/skills/context-mode/references/`:
- `patterns-javascript.md`
- `patterns-python.md`
- `patterns-shell.md`
- `anti-patterns.md`

- [ ] **Step 5: Create reference files**

Port each reference file. These are standalone pattern guides — minimal adaptation needed. Just ensure they reference our tool names correctly.

- [ ] **Step 6: Commit**

```bash
git add skills/context-mode/
git commit -m "feat: add main context-mode skill (decision tree, patterns, anti-patterns)"
```

---

## Task 13: Bootstrapper (start.js)

**Files:**
- Create: `C:\Users\8745HX\Desktop\Claude\context-mode\start.js`

- [ ] **Step 1: Read upstream start.mjs**

Already captured. Port with these changes:
- Entry point is `./server/index.js` (not `server.bundle.mjs`)
- No bundle fallback (we don't ship bundles)
- No CLI shim creation (we don't have a CLI)
- No TypeScript build fallback (we use plain JS)
- Keep: env var setup, version self-heal, ensure-deps import, pure-JS dep install

- [ ] **Step 2: Create start.js**

```javascript
#!/usr/bin/env node
/**
 * context-mode bootstrapper for Cowork.
 * Entry point for the MCP server.
 *
 * Ported from mksglu/context-mode (https://github.com/mksglu/context-mode)
 * by @mksglu, licensed under Elastic License 2.0.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const originalCwd = process.cwd();
process.chdir(__dirname);

if (!process.env.CLAUDE_PROJECT_DIR) {
  process.env.CLAUDE_PROJECT_DIR = originalCwd;
}

if (!process.env.CONTEXT_MODE_PROJECT_DIR) {
  process.env.CONTEXT_MODE_PROJECT_DIR = originalCwd;
}

// Self-heal: if a newer version dir exists, update registry so next session uses it
const cacheMatch = __dirname.match(
  /^(.*[\/\\]plugins[\/\\]cache[\/\\][^\/\\]+[\/\\][^\/\\]+[\/\\])([^\/\\]+)$/,
);
if (cacheMatch) {
  try {
    const cacheParent = cacheMatch[1];
    const myVersion = cacheMatch[2];
    const dirs = readdirSync(cacheParent).filter((d) =>
      /^\d+\.\d+\.\d+/.test(d),
    );
    if (dirs.length > 1) {
      dirs.sort((a, b) => {
        const pa = a.split(".").map(Number);
        const pb = b.split(".").map(Number);
        for (let i = 0; i < 3; i++) {
          if ((pa[i] ?? 0) !== (pb[i] ?? 0))
            return (pa[i] ?? 0) - (pb[i] ?? 0);
        }
        return 0;
      });
      const newest = dirs[dirs.length - 1];
      if (newest && newest !== myVersion) {
        const ipPath = resolve(
          homedir(),
          ".claude",
          "plugins",
          "installed_plugins.json",
        );
        const ip = JSON.parse(readFileSync(ipPath, "utf-8"));
        for (const [key, entries] of Object.entries(ip.plugins || {})) {
          if (!key.toLowerCase().includes("context-mode")) continue;
          for (const entry of entries) {
            entry.installPath = resolve(cacheParent, newest);
            entry.version = newest;
            entry.lastUpdated = new Date().toISOString();
          }
        }
        writeFileSync(
          ipPath,
          JSON.stringify(ip, null, 2) + "\n",
          "utf-8",
        );
      }
    }
  } catch {
    /* best effort — don't block server startup */
  }
}

// Ensure native dependencies + ABI compatibility
import "./hooks/ensure-deps.js";

// Install pure-JS deps used by server
for (const pkg of ["turndown", "turndown-plugin-gfm"]) {
  if (!existsSync(resolve(__dirname, "node_modules", pkg))) {
    try {
      execSync(`npm install ${pkg} --no-package-lock --no-save --silent`, {
        cwd: __dirname,
        stdio: "pipe",
        timeout: 120000,
      });
    } catch { /* best effort */ }
  }
}

// Start the MCP server
await import("./server/index.js");
```

- [ ] **Step 3: Test bootstrapper starts server**

```bash
cd C:/Users/8745HX/Desktop/Claude/context-mode && timeout 5 node start.js 2>&1 || true
```

Expected: should print `[context-mode] MCP server v1.0.0 started (win32)` and wait for stdin.

- [ ] **Step 4: Commit**

```bash
git add start.js
git commit -m "feat: add bootstrapper (env setup, version self-heal, dep management, server start)"
```

---

## Task 14: Fix install.js

**Files:**
- Modify: `C:\Users\8745HX\Desktop\Claude\context-mode\install.js`

- [ ] **Step 1: Read current install.js**

Read `C:\Users\8745HX\Desktop\Claude\context-mode\install.js` to see current state.

- [ ] **Step 2: Fix marketplace name**

Change `MARKETPLACE_NAME` from `'local-dev'` to `'scottconverse-context-mode'`.

- [ ] **Step 3: Fix cpSync dot-file handling**

Verify the `SKIP` filter doesn't exclude `.mcp.json` or `.claude-plugin/`. Add explicit check after copy that `.mcp.json` exists in the destination. If not, copy it explicitly with `copyFileSync`.

- [ ] **Step 4: Add server probe (step 7)**

After the FTS5 verification, add a server probe step:
- Spawn `node start.js` as a child process
- Send MCP `initialize` request via stdin
- Send `tools/list` request
- Parse response, confirm 9 tools
- Kill the process
- Report result

The probe uses the MCP JSON-RPC protocol over stdio. The request format is:

```javascript
// Initialize
{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "probe", "version": "1.0.0"}}}

// List tools
{"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
```

Wrap in a 10-second timeout. On success: `"9/9 tools responding"`. On failure: `"probe failed — run /ctx-doctor after restart"` (warning, not error).

- [ ] **Step 5: Update version references**

Ensure `VERSION` is read from `package.json` (already is). Ensure the install output shows the correct version.

- [ ] **Step 6: Test install.js**

```bash
cd C:/Users/8745HX/Desktop/Claude/context-mode && node install.js
```

Expected: all 7 steps pass, 9/9 tools responding.

- [ ] **Step 7: Commit**

```bash
git add install.js
git commit -m "fix: install.js marketplace name, dot-file copy, add server probe"
```

---

## Task 15: Fix server/index.js ESM bug

**Files:**
- Modify: `C:\Users\8745HX\Desktop\Claude\context-mode\server\index.js`

- [ ] **Step 1: Read the relevant lines**

Read `C:\Users\8745HX\Desktop\Claude\context-mode\server\index.js` lines 1-20 and 50-62.

- [ ] **Step 2: Fix require('os') in ESM**

The file already has `import { homedir as osHomedir } from 'node:os'` added earlier in this session. Verify line 54 uses `osHomedir()` instead of `require('os').homedir()`. If the earlier fix is already applied, this is a no-op.

- [ ] **Step 3: Run existing E2E tests to confirm nothing broke**

```bash
cd C:/Users/8745HX/Desktop/Claude/context-mode && node test-e2e.js 2>&1 | tail -5
```

Expected: `E2E RESULTS: 161 passed, 0 failed`

- [ ] **Step 4: Commit (if changes were needed)**

```bash
git add server/index.js
git commit -m "fix: replace require('os') with ESM import in server/index.js"
```

---

## Task 16: E2E Test Updates

**Files:**
- Modify: `C:\Users\8745HX\Desktop\Claude\context-mode\test-e2e.js`

- [ ] **Step 1: Read current test-e2e.js**

Read `C:\Users\8745HX\Desktop\Claude\context-mode\test-e2e.js` to understand structure and find where to add tests.

- [ ] **Step 2: Add plugin manifest tests**

Add to the "Plugin Discoverability" section:

```javascript
// .mcp.json flat format validation
const mcpJson = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf-8'));
mcpJson['context-mode'] ? PASS('.mcp.json flat format') : FAIL('.mcp.json missing context-mode key');
!mcpJson.mcpServers ? PASS('.mcp.json no wrapper') : FAIL('.mcp.json has mcpServers wrapper — Cowork needs flat format');

// plugin.json mcpServers field
const pluginJson = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf-8'));
pluginJson.mcpServers?.['context-mode'] ? PASS('plugin.json has mcpServers') : FAIL('plugin.json missing mcpServers');
pluginJson.skills ? PASS('plugin.json has skills') : FAIL('plugin.json missing skills');
pluginJson.hooks ? PASS('plugin.json has hooks') : FAIL('plugin.json missing hooks');
```

- [ ] **Step 3: Add PreToolUse routing tests**

Add a new section "15. PreToolUse Routing":

```javascript
// Import routing logic
const { routePreToolUse } = await import('./hooks/core/routing.js');

// curl → modify
const curlResult = routePreToolUse('Bash', { command: 'curl https://example.com' });
curlResult?.action === 'modify' ? PASS('curl → modify') : FAIL(`curl → ${curlResult?.action}`);

// git status → passthrough or guidance
const gitResult = routePreToolUse('Bash', { command: 'git status' });
(gitResult === null || gitResult?.action === 'context') ? PASS('git → passthrough/guidance') : FAIL(`git → ${gitResult?.action}`);

// WebFetch → deny
const wfResult = routePreToolUse('WebFetch', { url: 'https://docs.example.com' });
wfResult?.action === 'deny' ? PASS('WebFetch → deny') : FAIL(`WebFetch → ${wfResult?.action}`);

// Read → context guidance
const readResult = routePreToolUse('Read', { file_path: '/tmp/test.js' });
(readResult === null || readResult?.action === 'context') ? PASS('Read → guidance') : FAIL(`Read → ${readResult?.action}`);

// Agent → modify (inject routing block)
const agentResult = routePreToolUse('Agent', { prompt: 'do something' });
agentResult?.action === 'modify' ? PASS('Agent → modify') : FAIL(`Agent → ${agentResult?.action}`);
agentResult?.updatedInput?.prompt?.includes('context_window_protection') ? PASS('Agent prompt has routing block') : FAIL('Agent prompt missing routing block');

// Unknown tool → passthrough
const unknownResult = routePreToolUse('SomeTool', {});
unknownResult === null ? PASS('unknown → passthrough') : FAIL(`unknown → ${unknownResult?.action}`);
```

- [ ] **Step 4: Add hooks.json validation tests**

```javascript
// hooks.json has all 6 events
const hooksJson = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf-8'));
const hookEvents = Object.keys(hooksJson.hooks || {});
hookEvents.includes('PreToolUse') ? PASS('hook: PreToolUse') : FAIL('missing PreToolUse');
hookEvents.includes('PostToolUse') ? PASS('hook: PostToolUse') : FAIL('missing PostToolUse');
hookEvents.includes('PreCompact') ? PASS('hook: PreCompact') : FAIL('missing PreCompact');
hookEvents.includes('SessionStart') ? PASS('hook: SessionStart') : FAIL('missing SessionStart');
hookEvents.includes('UserPromptSubmit') ? PASS('hook: UserPromptSubmit') : FAIL('missing UserPromptSubmit');
hookEvents.includes('SubagentStop') ? PASS('hook: SubagentStop') : FAIL('missing SubagentStop');

// PreToolUse has 9 matchers
const preToolMatchers = hooksJson.hooks.PreToolUse || [];
preToolMatchers.length === 9 ? PASS('PreToolUse: 9 matchers') : FAIL(`PreToolUse: ${preToolMatchers.length} matchers`);
```

- [ ] **Step 5: Run full test suite**

```bash
cd C:/Users/8745HX/Desktop/Claude/context-mode && node test-e2e.js 2>&1 | tail -5
```

Expected: all tests pass (161 existing + ~20 new).

- [ ] **Step 6: Commit**

```bash
git add test-e2e.js
git commit -m "test: add manifest, routing, and hooks validation tests"
```

---

## Task 17: Update Existing Skills

**Files:**
- Modify: `C:\Users\8745HX\Desktop\Claude\context-mode\skills\ctx-doctor\SKILL.md`
- Modify: `C:\Users\8745HX\Desktop\Claude\context-mode\skills\ctx-stats\SKILL.md`
- Modify: `C:\Users\8745HX\Desktop\Claude\context-mode\skills\ctx-purge\SKILL.md`

- [ ] **Step 1: Read upstream skill files for comparison**

Read the upstream versions at `/tmp/mksglu-context-mode/skills/ctx-doctor/SKILL.md`, `ctx-stats/SKILL.md`, `ctx-purge/SKILL.md`.

- [ ] **Step 2: Read our current skill files**

Read our versions and compare. Update if upstream has improvements we should adopt.

- [ ] **Step 3: Update skills as needed**

Apply any improvements from upstream. At minimum, ensure the descriptions and trigger keywords are comprehensive.

- [ ] **Step 4: Commit**

```bash
git add skills/ctx-doctor/SKILL.md skills/ctx-stats/SKILL.md skills/ctx-purge/SKILL.md
git commit -m "chore: update ctx-doctor, ctx-stats, ctx-purge skills from upstream"
```

---

## Task 18: Propagate to Plugin Cache + Verify

**Files:**
- Various files in `C:\Users\8745HX\.claude\plugins\cache\scottconverse-context-mode\context-mode\1.0.0\`

- [ ] **Step 1: Run install.js to propagate everything to cache**

```bash
cd C:/Users/8745HX/Desktop/Claude/context-mode && node install.js
```

Expected: all 7 steps pass, including server probe (9/9 tools).

- [ ] **Step 2: Verify cache has all new files**

```bash
ls C:/Users/8745HX/.claude/plugins/cache/scottconverse-context-mode/context-mode/1.0.0/hooks/core/
ls C:/Users/8745HX/.claude/plugins/cache/scottconverse-context-mode/context-mode/1.0.0/skills/context-mode/
ls C:/Users/8745HX/.claude/plugins/cache/scottconverse-context-mode/context-mode/1.0.0/start.js
cat C:/Users/8745HX/.claude/plugins/cache/scottconverse-context-mode/context-mode/1.0.0/.claude-plugin/plugin.json
cat C:/Users/8745HX/.claude/plugins/cache/scottconverse-context-mode/context-mode/1.0.0/.mcp.json
```

Expected: all files present, manifests correct.

- [ ] **Step 3: Run full E2E suite from cache directory**

```bash
cd C:/Users/8745HX/.claude/plugins/cache/scottconverse-context-mode/context-mode/1.0.0 && node test-e2e.js 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 4: Commit final state**

```bash
cd C:/Users/8745HX/Desktop/Claude/context-mode
git add -A
git commit -m "chore: propagate all changes to plugin cache, verify installation"
```

---

## Task 19: Documentation Updates

**Files:**
- Modify: `C:\Users\8745HX\Desktop\Claude\context-mode\CHANGELOG.md`
- Modify: `C:\Users\8745HX\Desktop\Claude\context-mode\README.md`
- Modify: `C:\Users\8745HX\Desktop\Claude\context-mode\USER-MANUAL.md`

- [ ] **Step 1: Update CHANGELOG.md**

Add entry for the re-port:

```markdown
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
- plugin.json now declares mcpServers field (root cause of tools not loading)
- .mcp.json uses flat format per Cowork spec
- install.js marketplace name corrected to scottconverse-context-mode
- require('os') replaced with ESM import in server/index.js

### Changed
- Hook file naming aligned with upstream (sessionstart.js, posttooluse.js, etc.)
- hooks.json expanded from 4 events to 6 events with 14 matchers
- SessionStart hook now injects routing block + session directive
```

- [ ] **Step 2: Update README.md**

Add section on automatic routing and the PreToolUse system. Update feature list to include routing hooks and main skill.

- [ ] **Step 3: Update USER-MANUAL.md**

Add section explaining the automatic routing behavior: what gets intercepted, what passes through, how to use /ctx-doctor, /ctx-stats, /ctx-purge.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md README.md USER-MANUAL.md
git commit -m "docs: update changelog, readme, user manual for v1.1.0 re-port"
```

---

## Task 20: Manual Verification

This task cannot be done by a subagent — it requires restarting the Cowork session.

- [ ] **Step 1: Ask user to restart Cowork session**

The user needs to restart Claude Code / Cowork to pick up the new plugin registration.

- [ ] **Step 2: After restart, verify tools appear**

In the new session, check if `ctx_*` tools are available. They should appear as MCP tools.

- [ ] **Step 3: Run /ctx-doctor**

Type `/ctx-doctor` in the new session. Should show all systems green.

- [ ] **Step 4: Test PreToolUse routing**

Try running `curl https://example.com` via Bash. The PreToolUse hook should intercept and redirect to a context-mode sandbox message.

- [ ] **Step 5: Test session continuity**

Use `/compact` or let the session compact naturally. After compaction, verify the routing block is still active (try another Bash command).

- [ ] **Step 6: Report results**

Document what worked and what didn't. Fix any issues found.
