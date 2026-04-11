#!/usr/bin/env node
import "./suppress-stderr.js";
import "./ensure-deps.js";
/**
 * PostToolUse hook for context-mode session continuity.
 *
 * Captures session events from tool calls (13 categories) and stores
 * them in the per-project SessionDB for later resume snapshot building.
 *
 * Must be fast (<20ms). No network, no LLM, just SQLite writes.
 *
 * Ported from mksglu/context-mode by @mksglu, licensed under Elastic License 2.0.
 */
import { readStdin } from "./core/stdin.js";
import { getSessionId, getSessionDBPath } from "./session-helpers.js";
import { createSessionLoaders } from "./session-loaders.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve absolute path for imports — relative dynamic imports can fail
// when Claude Code invokes hooks from a different working directory.
const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB, loadExtract } = createSessionLoaders(HOOK_DIR);

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);

  const { extractEvents } = await loadExtract();
  const { SessionDB } = await loadSessionDB();

  const dbPath = getSessionDBPath();
  const db = new SessionDB(dbPath);
  const sessionId = getSessionId(input);

  // Ensure session meta exists
  db.ensureSession(sessionId, process.env.CLAUDE_PROJECT_DIR || process.cwd());

  // Extract and store events from the tool call
  const events = extractEvents(input);

  for (const event of events) {
    db.insertEvent(sessionId, event, "PostToolUse");
  }

  db.close();

  // ─── Compression learner: detect ctx_search calls ───
  const toolName = input.tool_name || input.toolName || '';
  if (toolName.includes('ctx_search') || toolName.includes('context-mode') && toolName.includes('search')) {
    try {
      const queries = input.tool_input?.queries || input.tool_input?.query;
      const queryList = Array.isArray(queries) ? queries : queries ? [queries] : [];

      if (queryList.length > 0) {
        const { writeFileSync, mkdirSync, existsSync: fsExists } = await import('node:fs');
        const { join: pjoin } = await import('node:path');
        const { homedir: hd } = await import('node:os');

        const signalDir = pjoin(hd(), '.claude', 'plugins', 'data', 'context-mode', 'signals');
        if (!fsExists(signalDir)) mkdirSync(signalDir, { recursive: true });

        // Check if search returned results
        const resultText = input.tool_result?.content?.[0]?.text || '';
        const hasResults = resultText.length > 50 && !resultText.includes('No results found');

        if (hasResults) {
          // Retrieval signal — search found something
          const signal = JSON.stringify({ queries: queryList, timestamp: Date.now() });
          const signalPath = pjoin(signalDir, `retrieval-${Date.now()}-${process.pid}.json`);
          writeFileSync(signalPath, signal, 'utf8');
        } else {
          // Miss signal — search returned nothing
          // Guard: don't write miss signals if KB is empty/tiny.
          // On a fresh install, every search returns 0 results — writing miss signals
          // would flood the learner with false positives that inflate retention weights.
          // Check: content DB file exists and is >50KB (cheap stat, no DB open).
          let kbHasContent = false;
          try {
            const { statSync, readdirSync: rds } = await import('node:fs');
            const dbDir = pjoin(hd(), '.claude', 'plugins', 'data', 'context-mode', 'content');
            if (fsExists(dbDir)) {
              const dbFiles = rds(dbDir).filter(f => f.endsWith('.db'));
              for (const dbFile of dbFiles) {
                const st = statSync(pjoin(dbDir, dbFile));
                if (st.size > 50 * 1024) { kbHasContent = true; break; }
              }
            }
          } catch {
            // If we can't check, skip the miss signal (conservative)
          }

          if (kbHasContent) {
            const signal = JSON.stringify({
              type: 'miss',
              queries: queryList,
              timestamp: Date.now(),
              resultCount: 0,
            });
            const signalPath = pjoin(signalDir, `miss-${Date.now()}-${process.pid}.json`);
            writeFileSync(signalPath, signal, 'utf8');
          }
        }
      }
    } catch {
      // Signal writing is best-effort — never block PostToolUse
    }
  }
} catch {
  // PostToolUse must never block the session — silent fallback
}

// PostToolUse hooks don't need hookSpecificOutput
