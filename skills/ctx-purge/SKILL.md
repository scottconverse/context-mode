---
name: ctx-purge
description: Delete all indexed knowledge base content for the current project
user-invocable: true
---

# /ctx-purge

Permanently delete all indexed content from the knowledge base for the current project.

## What to do

1. Confirm with the user that they want to purge all indexed content
2. Call the `ctx_purge` MCP tool with `confirm: true`
3. Report the result

This action is irreversible. All indexed documents, web pages, and execution output will be removed from the local SQLite database. Session events are not affected.
