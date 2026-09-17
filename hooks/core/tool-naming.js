/**
 * Host-aware MCP tool naming.
 *
 * Claude Code / Cowork plugins expose tools as
 *   mcp__plugin_context-mode_context-mode__ctx_execute
 * Codex (and most stdio MCP hosts) expose tools as
 *   mcp__<server>__<tool>  →  mcp__context-mode__ctx_execute
 *
 * Ported Cowork prefix from mksglu/context-mode (Elastic-2.0).
 * Codex prefix is from OpenAI's documented mcp__server__tool matcher names.
 */

const COWORK_PREFIX = (tool) => `mcp__plugin_context-mode_context-mode__${tool}`;
const CODEX_PREFIX = (tool) => `mcp__context-mode__${tool}`;

/**
 * MCP tool name the host actually sees for a bare ctx_* tool.
 */
export function mcpToolName(bareTool, platformId) {
  const p = platformId || process.env.CONTEXT_MODE_PLATFORM || 'claude-code';
  if (p === 'codex') return CODEX_PREFIX(bareTool);
  return COWORK_PREFIX(bareTool);
}

/**
 * Get the Cowork-specific MCP tool name for a bare tool name.
 * Kept for callers that are Claude-only.
 */
export function getToolName(bareTool) {
  return COWORK_PREFIX(bareTool);
}

/**
 * Create a namer function for use in routing block and guidance messages.
 * Honors CONTEXT_MODE_PLATFORM so Codex intercept messages name Codex tools.
 */
export function createToolNamer(platformId) {
  const p = platformId || process.env.CONTEXT_MODE_PLATFORM || 'claude-code';
  return (bareTool) => mcpToolName(bareTool, p);
}
