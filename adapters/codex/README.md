# Codex CLI adapter

This is a **real installer**, not a file dump.

It is JavaScript ESM, Node ≥18, same stack as `server/`, `hooks/`, `install.js`. It is **not** a port of mksglu’s TypeScript `src/adapters/codex`. Host contract comes from [OpenAI Codex hooks](https://developers.openai.com/codex/hooks) and [MCP](https://developers.openai.com/codex/mcp).

**Status (1.8.0):** installer ships. Production is still Claude Code / Cowork until the repo owner smoke-tests intercept on their Codex. Grok cannot see that machine.

## Install

```bash
npx --yes --package=github:scottconverse/context-mode context-mode --adapter codex
```

Or from a clone:

```bash
node install.js --adapter codex
```

`--adapter codex --out ./out` still runs the experimental generator. That is not this installer.

## What it writes

| Path | Why |
|---|---|
| `~/.context-mode/plugin/` | Stable copy of hooks + server (npx cache evaporates) |
| `~/.context-mode/node_modules/` | `better-sqlite3` |
| `~/.codex/hooks.json` | Official wrapped shape. PreToolUse matcher is `Bash`. Merges; does not wipe your other hooks. |
| `~/.codex/config.toml` | `[mcp_servers.context-mode]` only. Other servers stay. |
| `AGENTS.md` (cwd) and `~/.codex/AGENTS.md` | Sentinel block `<!-- context-mode:start -->` … `<!-- context-mode:end -->` |

Override homes with `CODEX_HOME` and `CONTEXT_MODE_DATA`.

## Host contract we implemented

- Events: `SessionStart`, `PreToolUse`, `PostToolUse`, `PreCompact`, `UserPromptSubmit`, `Stop`
- stdin: `{ session_id, tool_name, tool_input, hook_event_name, ... }`
- stdout: `{ hookSpecificOutput: { hookEventName, permissionDecision, updatedInput } }`
- Shell tool: `Bash` (`exec_command` / `unified_exec` canonicalize to shell)
- File edits: `apply_patch` — **not intercepted**
- MCP tools the model sees: `mcp__context-mode__ctx_*`

## Smoke test (owner)

1. Restart Codex.
2. `run ctx doctor`
3. `git log` with no `-n` / `--oneline` — expect rewrite, not a full dump.
4. `curl https://example.com` — expect redirect.

Copilot / Gemini / Cursor are **not** in this release. Order stays Codex → Copilot → Gemini CLI → Cursor last.
