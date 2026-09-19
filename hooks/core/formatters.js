/**
 * Platform-aware response formatters for PreToolUse hooks.
 *
 * Internal normalized decision shape (from routing.js):
 *   { action: 'deny', reason?: string }
 *   { action: 'ask' }
 *   { action: 'modify', updatedInput: object }
 *   { action: 'context', additionalContext: string }
 *   null (passthrough)
 *
 * Each platform returns the exact wire shape its host expects.
 */

import { getAdapter } from '../../adapters/catalog.js';

// ── Claude / Cowork (original hookSpecificOutput shape) ────────────────────
function formatClaude(decision) {
  if (!decision) return null;

  switch (decision.action) {
    case "deny":
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: decision.reason,
        },
      };
    case "ask":
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
        },
      };
    case "modify":
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "Routed to context-mode sandbox",
          updatedInput: decision.updatedInput,
        },
      };
    case "context":
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: decision.additionalContext,
        },
      };
    default:
      return null;
  }
}

// ── Cursor (flat shapes, per upstream contract) ────────────────────────────
function formatCursor(decision) {
  if (!decision) return null;

  switch (decision.action) {
    case "deny":
      return {
        permission: "deny",
        user_message: decision.reason ?? "Blocked by context-mode",
      };
    case "ask":
      return {
        permission: "ask",
      };
    case "modify":
      return {
        updated_input: decision.updatedInput,
      };
    case "context":
      return {
        agent_message: decision.additionalContext ?? "",
      };
    default:
      return null;
  }
}

// ── Generic fallback formatter for unknown platforms ────────────────────────
function formatGeneric(decision) {
  // Default to Claude shape for unknown platforms
  return formatClaude(decision);
}

// Registry of formatters by platform id (and aliases)
const FORMATTERS = {
  'claude-code': formatClaude,
  'claude-cowork': formatClaude,
  'cursor': formatCursor,
  // Add more as real adapters are implemented
};

/**
 * Apply the correct formatter for the given platform.
 * Falls back to Claude shape if unknown platform.
 *
 * @param {object|null} decision - normalized decision from routePreToolUse
 * @param {string} [platformId] - e.g. 'claude-code', 'cursor'
 */
export function formatDecision(decision, platformId = 'claude-code') {
  if (!decision) return null;

  const formatter = FORMATTERS[platformId] || formatGeneric;
  return formatter(decision);
}

// For tests and introspection
export const __formatters = { formatClaude, formatCursor };
