#!/usr/bin/env node

/**
 * SubagentStop hook — captures sub-agent task summary and outcome.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';

import { parseHookInput, getSessionId, getProjectDir, getSessionDBPath } from './session-helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  try {
    const input = await parseHookInput();
    const sessionId = getSessionId(input);
    const dbPath = getSessionDBPath();

    const dbDir = dirname(dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    const { SessionDB } = await import(pathToFileURL(join(__dirname, '..', 'server', 'session.js')).href);
    const db = new SessionDB(dbPath);

    try {
      db.ensureSession(sessionId, getProjectDir());

      // Extract sub-agent summary
      const description = input.description || input.task || '';
      const outcome = input.outcome || input.result || input.status || '';

      if (description || outcome) {
        db.insertEvent(sessionId, {
          type: 'subagent_complete',
          category: 'subagent',
          data: JSON.stringify({
            description: String(description).slice(0, 300),
            outcome: String(outcome).slice(0, 500)
          }),
          priority: 2
        }, 'SubagentStop');
      }
    } finally {
      db.close();
    }
  } catch (err) {
    process.stderr.write(`[context-mode:subagent-stop] ${err.message}\n`);
  }
}

main();
