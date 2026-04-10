#!/usr/bin/env node
import "./suppress-stderr.js";
import "./ensure-deps.js";
/**
 * UserPromptSubmit hook for context-mode session continuity.
 *
 * Captures every user prompt so the LLM can continue from the exact
 * point where the user left off after compact or session restart.
 *
 * Must be fast (<10ms). Just a single SQLite write.
 *
 * Ported from mksglu/context-mode by @mksglu, licensed under Elastic License 2.0.
 */

import { readStdin } from "./core/stdin.js";
import { getSessionId, getSessionDBPath } from "./session-helpers.js";
import { createSessionLoaders } from "./session-loaders.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB } = createSessionLoaders(HOOK_DIR);

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);

  const prompt = input.prompt ?? input.message ?? "";
  const trimmed = (prompt || "").trim();

  // Skip system-generated messages — only capture genuine user prompts
  const isSystemMessage = trimmed.startsWith("<task-notification>")
    || trimmed.startsWith("<system-reminder>")
    || trimmed.startsWith("<context_guidance>")
    || trimmed.startsWith("<tool-result>");

  if (trimmed.length > 0 && !isSystemMessage) {
    const { SessionDB } = await loadSessionDB();
    const dbPath = getSessionDBPath();
    const db = new SessionDB(dbPath);
    const sessionId = getSessionId(input);

    db.ensureSession(sessionId, process.env.CLAUDE_PROJECT_DIR || process.cwd());

    // Save the raw prompt for session continuity
    db.insertEvent(sessionId, {
      type: "user_prompt",
      category: "prompt",
      data: prompt,
      priority: 1,
    }, "UserPromptSubmit");

    db.close();
  }
} catch {
  // UserPromptSubmit must never block the session — silent fallback
}
