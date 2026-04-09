#!/usr/bin/env node

/**
 * PreCompact hook — builds and stores a resume snapshot
 * before context compaction occurs.
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

    // Load modules
    const { SessionDB } = await import(pathToFileURL(join(__dirname, '..', 'server', 'session.js')).href);
    const { buildResumeSnapshot } = await import(pathToFileURL(join(__dirname, '..', 'server', 'snapshot.js')).href);

    const db = new SessionDB(dbPath);

    try {
      // Get all session events
      const events = db.getEvents(sessionId);

      if (events.length === 0) {
        // Nothing to snapshot
        console.log(JSON.stringify({}));
        return;
      }

      // Get session stats for compact count
      const stats = db.getSessionStats(sessionId);
      const compactCount = stats ? stats.compact_count : 0;

      // Build snapshot
      const snapshot = buildResumeSnapshot(events, { compactCount });

      // Store snapshot and increment compact count
      db.upsertResume(sessionId, snapshot, events.length);
      db.incrementCompactCount(sessionId);

      process.stderr.write(
        `[context-mode:pre-compact] Snapshot saved: ${Buffer.byteLength(snapshot, 'utf8')} bytes, ` +
        `${events.length} events, compact #${compactCount + 1}\n`
      );
    } finally {
      db.close();
    }

    // PreCompact doesn't need hookSpecificOutput
    console.log(JSON.stringify({}));
  } catch (err) {
    process.stderr.write(`[context-mode:pre-compact] ${err.message}\n`);
    console.log(JSON.stringify({}));
  }
}

main();
