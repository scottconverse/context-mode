---
name: ctx-doctor
description: |
  Run context-mode diagnostics. Checks runtimes, hooks, FTS5,
  plugin registration, npm and marketplace versions.
  Trigger: /context-mode:ctx-doctor
user-invocable: true
---

# Context Mode Doctor

Run diagnostics and display results directly in the conversation.

## Instructions

1. Call the `ctx_doctor` MCP tool directly. It runs all checks server-side and returns a markdown checklist.
2. Display the results verbatim — they are already formatted as a checklist with `[x]` PASS, `[ ]` FAIL, `[-]` WARN.
3. **Fallback** (only if MCP tool call fails): The MCP server likely isn't running. Derive the **plugin root** from this skill's base directory (go up 2 levels — remove `/skills/ctx-doctor`), then run the installer to repair:
   ```
   node "<PLUGIN_ROOT>/install.js"
   ```
   Display the install output to the user. If all 7 steps pass and the server probe shows 9/9 tools, tell the user to run `/reload-plugins` (CLI) or start a new conversation (Cowork/desktop) to load the repaired plugin. If the install itself fails, show the error — it will say what went wrong and how to fix it.
