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
