/**
 * Routing block — context routing instructions injected into session.
 * Guides Claude to prefer context-saving tools over raw file reads.
 */

/**
 * Generate the routing block for injection into session context.
 */
export function getRoutingBlock() {
  return `<context_mode_routing>
When working on tasks in this Cowork session, prefer these context-saving tools:

**Primary tools (use these instead of raw file reads/web fetches):**
- ctx_batch_execute: Combine multiple shell commands + search queries into ONE call. Use this for multi-step data gathering.
- ctx_search: Query the knowledge base for specific information. Content is already indexed — no need to re-read files.
- ctx_execute / ctx_execute_file: Run code in a sandbox. Only stdout is returned — raw file contents never enter context.
- ctx_fetch_and_index: Fetch and index web pages. Returns a compact summary, not the full page.
- ctx_index: Index any large text/markdown/JSON for later search.

**Routing rules:**
- For reading large files (>50 lines): use ctx_execute_file to process them in a sandbox
- For web pages: use ctx_fetch_and_index instead of WebFetch
- For multiple shell commands: use ctx_batch_execute instead of sequential Bash calls
- For analysis of output: use ctx_execute with an intent parameter to auto-index and search
- For writing/editing files: use the native Write/Edit tools (not sandboxed)
- Keep responses under 500 words. Write long content to files instead.

**Search before re-reading:** Before reading a file you've already processed, check if it's in the knowledge base with ctx_search.
</context_mode_routing>`;
}
