#!/usr/bin/env node
import "./suppress-stderr.js";
/**
 * PreToolUse hook for context-mode (Cowork)
 * Redirects data-fetching tools to context-mode MCP tools.
 *
 * Ported from mksglu/context-mode (https://github.com/mksglu/context-mode)
 * by @mksglu, licensed under Elastic License 2.0.
 */

import { readStdin } from "./core/stdin.js";
import { routePreToolUse } from "./core/routing.js";
import { formatDecision } from "./core/formatters.js";

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);
  const tool = input.tool_name ?? "";
  const toolInput = input.tool_input ?? {};

  const decision = routePreToolUse(tool, toolInput, process.env.CLAUDE_PROJECT_DIR);
  const response = formatDecision(decision);
  if (response !== null) {
    process.stdout.write(JSON.stringify(response) + "\n");
  }
} catch (err) {
  // Malformed stdin or routing error — fail open (allow tool to proceed unchanged)
  process.stderr.write(`[context-mode] pretooluse error: ${err.message}\n`);
}
