# Adapters

**Honest status (v1.7.1).** This directory is a **catalog plus a file generator**. It is not 22 native host plugins.

v1.7.0 (designed and shipped by **Grok / xAI Grok Build**, 2026-09-17) published this table as if each row were a working adapter. What exists:

- `catalog.js` — host names, tool-name maps, hook-event names, instruction filenames
- `generate.js` / `cli.js` — writes markdown + MCP snippets + optional `hooks.json` to `--out`
- `hooks/dispatch.js` — maps foreign tool names onto the existing Claude routing table

Claude Code / Cowork remains the only production install (`node install.js` with no flags). `--adapter` does not install a Cursor/Codex/Copilot/Gemini plugin. Compliance % values below are **estimates**, not measured hit-rates. Nobody ran those hosts for 1.7.0.

Planned: real JavaScript adapters in this repo’s stack (same as `server/`, `hooks/`, `install.js`), host by host: **Codex → Copilot → Gemini CLI → Cursor last.** Instruction-only hosts (Grok, Zed, Continue, Aider, …) will stay MCP + a decision tree, labeled that way.

Current version is stamped from `package.json` (generated `adapter.json` and instruction files carry it).

## Catalog (22 names — not 22 products)

| id | name | hooks listed | compliance (estimate) | status |
|---|---|---|---|---|
| `claude-code` | Claude Code | 4 | 98% | **production** |
| `claude-cowork` | Claude Cowork | 5 | 98% | **production** |
| `cursor` | Cursor | 3 | 85% | catalog only; planned last |
| `grok` | Grok / Grok Build | 0 | 60% | instruction-only (no host hooks) |
| `codex` | Codex CLI | 5 | 95% | catalog only; next native JS adapter |
| `copilot` | VS Code Copilot | 5 | 90% | catalog only; planned |
| `copilot-cli` | GitHub Copilot CLI | 5 | 90% | catalog only |
| `copilot-jetbrains` | JetBrains Copilot | 5 | 80% | catalog only |
| `opencode` | OpenCode | 3 | 88% | catalog only |
| `gemini-cli` | Gemini CLI | 4 | 90% | catalog only; planned |
| `antigravity` | Antigravity IDE | 0 | 60% | instruction-only |
| `zed` | Zed | 0 | 60% | instruction-only |
| `continue` | Continue | 0 | 55% | instruction-only |
| `windsurf` | Windsurf | 0 | 55% | instruction-only |
| `aider` | Aider | 0 | 50% | instruction-only |
| `openclaw` | OpenClaw | 4 | 92% | catalog only |
| `kilo` | KiloCode | 3 | 88% | catalog only |
| `kiro` | Kiro | 2 | 75% | catalog only |
| `qwen` | Qwen Code | 4 | 95% | catalog only |
| `kimi` | Kimi Code | 5 | 90% | catalog only |
| `pi` | Pi / Oh My Pi | 0 | 55% | instruction-only |
| `generic` | Any MCP client | 0 | 50% | instruction-only |

## Generate (experimental)

```bash
node adapters/cli.js --list
node adapters/cli.js --adapter grok --out ./out
npx --yes --package=github:scottconverse/context-mode context-mode --adapter generic --out ./out
```

Each run writes files for you to copy. That is not an installer.

## Runtime

Set these when launching the MCP server:

| env | purpose |
|---|---|
| `CONTEXT_MODE_PLATFORM` | adapter id (`claude-code`, `grok`, …) |
| `CONTEXT_MODE_DATA` | data directory (default `~/.context-mode`) |
| `CONTEXT_MODE_PROJECT_DIR` | project root (falls back to `CLAUDE_PROJECT_DIR`) |

`CLAUDE_PLUGIN_DATA` / `CLAUDE_PLUGIN_ROOT` still work. Claude Code and Cowork keep the original marketplace installer.

See [CHANGELOG 1.7.1](../CHANGELOG.md#171---2026-09-17).
