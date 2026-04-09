---
name: ctx-stats
description: Show context savings statistics for the current session
user-invocable: true
---

# /ctx-stats

Display a formatted report of context window savings for the current Cowork session.

## What to do

Call the `ctx_stats` MCP tool and display the results to the user. The report includes:

- Per-tool call counts and bytes returned
- Total bytes kept out of context (sandboxed)
- Total bytes indexed in the knowledge base
- Context savings ratio (percentage)
- Cache performance (hits, network requests saved)
