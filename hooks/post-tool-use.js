#!/usr/bin/env node

/**
 * PostToolUse hook — captures session events after every tool call.
 * Must complete in <20ms. No network, no LLM calls.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';

import { parseHookInput, getSessionId, getProjectDir, getSessionDBPath } from './session-helpers.js';
import { extractEvents } from './session-extract.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  try {
    const input = await parseHookInput();
    if (!input || !input.tool_name) {
      // No tool data, nothing to capture
      process.exit(0);
    }

    const sessionId = getSessionId(input);
    const projectDir = getProjectDir();
    const dbPath = getSessionDBPath();

    // Ensure directory exists
    const dbDir = dirname(dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    // Lazy-import SessionDB to avoid loading better-sqlite3 on no-op calls
    const sessionModPath = pathToFileURL(join(__dirname, '..', 'server', 'session.js')).href;
    const { SessionDB } = await import(sessionModPath);
    const db = new SessionDB(dbPath);

    try {
      db.ensureSession(sessionId, projectDir);

      const events = extractEvents(input);
      for (const event of events) {
        db.insertEvent(sessionId, event, 'PostToolUse');
      }
    } finally {
      db.close();
    }
  } catch (err) {
    // Hooks must not crash the session — fail silently
    process.stderr.write(`[context-mode:post-tool-use] ${err.message}\n`);
  }
}

main();
