---
name: ctx-doctor
description: Diagnose the context-mode plugin environment
user-invocable: true
---

# /ctx-doctor

Run diagnostics on the context-mode plugin environment and display the results.

## What to do

Call the `ctx_doctor` MCP tool and display the results. The diagnostic checks:

- Node.js runtime version and platform
- Available language runtimes (11 languages)
- SQLite FTS5 availability (porter + trigram tokenizers)
- Hook script presence
- Data directory health
- Plugin root and data paths
