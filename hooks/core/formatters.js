/**
 * Cowork-specific response formatter for PreToolUse hooks.
 * Converts normalized routing decisions to hookSpecificOutput JSON.
 *
 * Ported from mksglu/context-mode (https://github.com/mksglu/context-mode)
 * by @mksglu, licensed under Elastic License 2.0.
 */

const formatter = {
  deny: (reason) => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }),
  ask: () => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
    },
  }),
  modify: (updatedInput) => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "Routed to context-mode sandbox",
      updatedInput,
    },
  }),
  context: (additionalContext) => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext,
    },
  }),
};

/**
 * Apply formatter to a normalized routing decision.
 * Returns Cowork-specific JSON response, or null for passthrough.
 */
export function formatDecision(decision) {
  if (!decision) return null;

  switch (decision.action) {
    case "deny": return formatter.deny(decision.reason);
    case "ask": return formatter.ask();
    case "modify": return formatter.modify(decision.updatedInput);
    case "context": return formatter.context(decision.additionalContext);
    default: return null;
  }
}
