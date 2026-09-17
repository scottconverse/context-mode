# Adapters

context-mode's compressor, knowledge base, sandbox, and session snapshot are
host-agnostic. An **adapter** is the thin binding that teaches the core a host's
tool names, hook events, instruction filename, and MCP config path.

Current version is stamped from `package.json` (the generated `adapter.json`
and instruction files always carry it).

## 22 hosts

| id | name | hooks | compliance |
|---|---|---|---|
| `claude-code` | Claude Code | 4 | 98% |
| `claude-cowork` | Claude Cowork | 5 | 98% |
| `cursor` | Cursor | 3 | 85% |
| `grok` | Grok / Grok Build | 0 | 60% |
| `codex` | Codex CLI | 5 | 95% |
| `copilot` | VS Code Copilot | 5 | 90% |
| `copilot-cli` | GitHub Copilot CLI | 5 | 90% |
| `copilot-jetbrains` | JetBrains Copilot | 5 | 80% |
| `opencode` | OpenCode | 3 | 88% |
| `gemini-cli` | Gemini CLI | 4 | 90% |
| `antigravity` | Antigravity IDE | 0 | 60% |
| `zed` | Zed | 0 | 60% |
| `continue` | Continue | 0 | 55% |
| `windsurf` | Windsurf | 0 | 55% |
| `aider` | Aider | 0 | 50% |
| `openclaw` | OpenClaw | 4 | 92% |
| `kilo` | KiloCode | 3 | 88% |
| `kiro` | Kiro | 2 | 75% |
| `qwen` | Qwen Code | 4 | 95% |
| `kimi` | Kimi Code | 5 | 90% |
| `pi` | Pi / Oh My Pi | 0 | 55% |
| `generic` | Any MCP client | 0 | 50% |

Hook-capable hosts intercept oversized tool calls. Instruction-only hosts
(`mcp-only`, `skills`) rely on the generated decision tree. Compliance is the
expected routing hit-rate when the adapter is installed as specified — not a
benchmark of the core.

## Generate

```bash
node adapters/cli.js --list
node adapters/cli.js --adapter grok --out ./out
npx --yes --package=github:scottconverse/context-mode context-mode --adapter cursor
```

Each run writes:

- `README.md` — host-specific install notes
- `adapter.json` — machine-readable binding (includes the stamped version)
- the host instruction file (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, …)
- `mcp.json` / `config.toml` / `zed-settings.json`
- `hooks.json` when the host exposes hooks
- a skill file when `hookParadigm` is `skills`

## Runtime

Set these when launching the MCP server:

| env | purpose |
|---|---|
| `CONTEXT_MODE_PLATFORM` | adapter id (`grok`, `cursor`, `claude-code`, …) |
| `CONTEXT_MODE_DATA` | data directory (default `~/.context-mode`) |
| `CONTEXT_MODE_PROJECT_DIR` | project root (falls back to `CLAUDE_PROJECT_DIR`) |

`CLAUDE_PLUGIN_DATA` / `CLAUDE_PLUGIN_ROOT` still work. Claude Code and Cowork
keep the original marketplace installer — this directory is additive.

Hook hosts call `node hooks/dispatch.js <platform> <event>`. The dispatcher
canonicalizes tool names (`run_terminal_command` → `shell` → `Bash`) so the
v1.6 routing table does not need a copy per host.
