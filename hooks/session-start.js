#!/usr/bin/env node

/**
 * SessionStart hook — handles startup, compact resume, and continue resume.
 *
 * Three modes based on input.source:
 *   "startup" — Fresh session. Cleanup old sessions, capture rules, inject routing.
 *   "compact" — After compaction. Load snapshot, inject session guide.
 *   "resume"  — Continue session. Load events, inject context.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

import {
  parseHookInput, getSessionId, getProjectDir,
  getSessionDBPath, getSessionEventsPath
} from './session-helpers.js';
import { getRoutingBlock } from './routing-block.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  try {
    const input = await parseHookInput();
    const source = input.source || 'startup';
    const sessionId = getSessionId(input);
    const projectDir = getProjectDir();
    const dbPath = getSessionDBPath();

    const dbDir = dirname(dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    const { SessionDB } = await import(pathToFileURL(join(__dirname, '..', 'server', 'session.js')).href);
    const db = new SessionDB(dbPath);

    try {
      db.ensureSession(sessionId, projectDir);

      if (source === 'startup') {
        await handleStartup(db, sessionId, projectDir);
      } else if (source === 'compact') {
        await handleCompact(db, sessionId);
      } else if (source === 'resume') {
        await handleResume(db, sessionId);
      }
    } finally {
      db.close();
    }
  } catch (err) {
    process.stderr.write(`[context-mode:session-start] ${err.message}\n`);
    // Output empty response on error
    console.log(JSON.stringify({}));
  }
}

// ─── Startup Handler ──────────────────────────────────────────────────────────

async function handleStartup(db, sessionId, projectDir) {
  // Cleanup old sessions (>7 days)
  db.cleanupOldSessions(7);

  // Capture CLAUDE.md rules files as events
  const ruleFiles = [
    join(homedir(), '.claude', 'CLAUDE.md'),
    join(projectDir, 'CLAUDE.md'),
    join(projectDir, '.claude', 'CLAUDE.md')
  ];

  for (const rulePath of ruleFiles) {
    if (existsSync(rulePath)) {
      try {
        const content = readFileSync(rulePath, 'utf8');
        db.insertEvent(sessionId, {
          type: 'rule_content',
          category: 'rule',
          data: `Rules from ${rulePath}: ${content.slice(0, 500)}`,
          priority: 1
        }, 'SessionStart');
      } catch { /* ignore read errors */ }
    }
  }

  // Inject routing block
  const routingBlock = getRoutingBlock();
  emitHookOutput(routingBlock);
}

// ─── Compact Handler ──────────────────────────────────────────────────────────

async function handleCompact(db, sessionId) {
  // Load resume snapshot
  const resume = db.getResume(sessionId);

  if (!resume) {
    // No snapshot available — inject routing block only
    emitHookOutput(getRoutingBlock());
    return;
  }

  // Mark snapshot as consumed
  db.markResumeConsumed(sessionId);

  // Write events to markdown file for auto-indexing
  const eventsPath = getSessionEventsPath();
  try {
    const events = db.getEvents(sessionId);
    const md = eventsToMarkdown(events);
    writeFileSync(eventsPath, md, 'utf8');
  } catch { /* ignore */ }

  // Build session directive
  const sessionDirective = `
<session_knowledge>
Context was compacted. Here is your session state:

${resume.snapshot}

Use ctx_search(queries: [...], source: "session-events") to retrieve full details for any section above.
The knowledge base retains all previously indexed content — search it before re-reading files.
</session_knowledge>`;

  emitHookOutput(getRoutingBlock() + '\n\n' + sessionDirective);
}

// ─── Resume Handler ───────────────────────────────────────────────────────────

async function handleResume(db, sessionId) {
  // Load events and write to markdown for indexing
  const events = db.getEvents(sessionId);

  if (events.length === 0) {
    emitHookOutput(getRoutingBlock());
    return;
  }

  const eventsPath = getSessionEventsPath();
  try {
    const md = eventsToMarkdown(events);
    writeFileSync(eventsPath, md, 'utf8');
  } catch { /* ignore */ }

  const resumeDirective = `
<session_knowledge>
Resuming previous session with ${events.length} recorded events.
Use ctx_search(queries: [...], source: "session-events") to retrieve session history.
The knowledge base retains all previously indexed content.
</session_knowledge>`;

  emitHookOutput(getRoutingBlock() + '\n\n' + resumeDirective);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Emit hook output to stdout in the expected format.
 */
function emitHookOutput(additionalContext) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext
    }
  }));
}

/**
 * Convert session events to markdown for auto-indexing.
 */
function eventsToMarkdown(events) {
  let md = '# Session Events\n\n';

  const byCategory = {};
  for (const evt of events) {
    if (!byCategory[evt.category]) byCategory[evt.category] = [];
    byCategory[evt.category].push(evt);
  }

  for (const [category, catEvents] of Object.entries(byCategory)) {
    md += `## ${category}\n\n`;
    for (const evt of catEvents) {
      md += `- **${evt.type}** (P${evt.priority}): ${evt.data}\n`;
    }
    md += '\n';
  }

  return md;
}

main();
