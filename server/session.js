/**
 * SessionDB — Session event persistence for context continuity.
 *
 * Captures structured events from tool calls, tracks session metadata,
 * stores compaction snapshots for resume after context compaction.
 */

import { openDatabase, closeDB, withRetry } from './db-base.js';
import { createHash } from 'node:crypto';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_EVENTS_PER_SESSION = 1000;
const DEDUP_WINDOW = 5;

// ─── SessionDB ────────────────────────────────────────────────────────────────

export class SessionDB {
  #db;
  #dbPath;
  #stmts = {};

  constructor(dbPath) {
    this.#dbPath = dbPath;
    this.#db = openDatabase(dbPath);
    this.#createSchema();
    this.#prepareStatements();
  }

  // ─── Schema ───────────────────────────────────────────────────────────────

  #createSchema() {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 2,
        data TEXT NOT NULL,
        source_hook TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        data_hash TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS session_meta (
        session_id TEXT PRIMARY KEY,
        project_dir TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_event_at TEXT,
        event_count INTEGER NOT NULL DEFAULT 0,
        compact_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS session_resume (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        snapshot TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        consumed INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(session_id, type);
      CREATE INDEX IF NOT EXISTS idx_session_events_priority ON session_events(session_id, priority);
    `);
  }

  // ─── Prepared Statements ──────────────────────────────────────────────────

  #prepareStatements() {
    const db = this.#db;

    this.#stmts.ensureSession = db.prepare(
      'INSERT OR IGNORE INTO session_meta (session_id, project_dir) VALUES (?, ?)'
    );

    this.#stmts.insertEvent = db.prepare(`
      INSERT INTO session_events (session_id, type, category, priority, data, source_hook, data_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.#stmts.updateMeta = db.prepare(`
      UPDATE session_meta
      SET last_event_at = datetime('now'), event_count = event_count + 1
      WHERE session_id = ?
    `);

    this.#stmts.getRecentHashes = db.prepare(`
      SELECT type, data_hash FROM session_events
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT ?
    `);

    this.#stmts.getEventCount = db.prepare(
      'SELECT event_count FROM session_meta WHERE session_id = ?'
    );

    this.#stmts.evictLowest = db.prepare(`
      DELETE FROM session_events
      WHERE id = (
        SELECT id FROM session_events
        WHERE session_id = ?
        ORDER BY priority ASC, id ASC
        LIMIT 1
      )
    `);

    this.#stmts.getEvents = db.prepare(
      'SELECT * FROM session_events WHERE session_id = ? ORDER BY id ASC'
    );

    this.#stmts.getEventsByType = db.prepare(
      'SELECT * FROM session_events WHERE session_id = ? AND type = ? ORDER BY id ASC'
    );

    this.#stmts.getEventsByPriority = db.prepare(
      'SELECT * FROM session_events WHERE session_id = ? AND priority >= ? ORDER BY priority DESC, id DESC'
    );

    this.#stmts.getEventsByCategory = db.prepare(
      'SELECT * FROM session_events WHERE session_id = ? AND category = ? ORDER BY id ASC'
    );

    this.#stmts.getSessionStats = db.prepare(`
      SELECT
        session_id,
        (SELECT COUNT(*) FROM session_events WHERE session_id = ?) AS event_count,
        (SELECT MIN(created_at) FROM session_events WHERE session_id = ?) AS first_event,
        (SELECT MAX(created_at) FROM session_events WHERE session_id = ?) AS last_event,
        compact_count
      FROM session_meta
      WHERE session_id = ?
    `);

    this.#stmts.incrementCompact = db.prepare(
      'UPDATE session_meta SET compact_count = compact_count + 1 WHERE session_id = ?'
    );

    this.#stmts.upsertResume = db.prepare(`
      INSERT INTO session_resume (session_id, snapshot, event_count)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        snapshot = excluded.snapshot,
        event_count = excluded.event_count,
        created_at = datetime('now'),
        consumed = 0
    `);

    this.#stmts.getResume = db.prepare(
      'SELECT * FROM session_resume WHERE session_id = ? AND consumed = 0'
    );

    this.#stmts.markResumeConsumed = db.prepare(
      'UPDATE session_resume SET consumed = 1 WHERE session_id = ?'
    );

    this.#stmts.cleanupOldSessions = db.prepare(`
      DELETE FROM session_events
      WHERE session_id IN (
        SELECT session_id FROM session_meta
        WHERE started_at < datetime('now', '-' || ? || ' days')
      )
    `);

    this.#stmts.cleanupOldMeta = db.prepare(`
      DELETE FROM session_meta
      WHERE started_at < datetime('now', '-' || ? || ' days')
    `);

    this.#stmts.cleanupOldResumes = db.prepare(`
      DELETE FROM session_resume
      WHERE created_at < datetime('now', '-' || ? || ' days')
    `);
  }

  // ─── Session Management ───────────────────────────────────────────────────

  ensureSession(sessionId, projectDir) {
    withRetry(() => this.#stmts.ensureSession.run(sessionId, projectDir));
  }

  // ─── Event Insertion ──────────────────────────────────────────────────────

  insertEvent(sessionId, event, sourceHook = 'PostToolUse') {
    const { type, category, data, priority = 2 } = event;

    // Compute hash for dedup
    const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
    const hash = createHash('sha256')
      .update(type + category + dataStr)
      .digest('hex')
      .slice(0, 16);

    // Dedup: check last DEDUP_WINDOW events
    const recent = this.#stmts.getRecentHashes.all(sessionId, DEDUP_WINDOW);
    for (const r of recent) {
      if (r.type === type && r.data_hash === hash) {
        return false; // Duplicate, skip
      }
    }

    // FIFO eviction if at capacity
    const meta = this.#stmts.getEventCount.get(sessionId);
    if (meta && meta.event_count >= MAX_EVENTS_PER_SESSION) {
      withRetry(() => this.#stmts.evictLowest.run(sessionId));
    }

    // Insert event
    withRetry(() => {
      this.#stmts.insertEvent.run(
        sessionId, type, category, priority, dataStr, sourceHook, hash
      );
      this.#stmts.updateMeta.run(sessionId);
    });

    return true;
  }

  // ─── Event Retrieval ──────────────────────────────────────────────────────

  getEvents(sessionId, type = null, priority = null) {
    if (type) {
      return this.#stmts.getEventsByType.all(sessionId, type);
    }
    if (priority) {
      return this.#stmts.getEventsByPriority.all(sessionId, priority);
    }
    return this.#stmts.getEvents.all(sessionId);
  }

  getEventsByCategory(sessionId, category) {
    return this.#stmts.getEventsByCategory.all(sessionId, category);
  }

  getSessionStats(sessionId) {
    return this.#stmts.getSessionStats.get(sessionId, sessionId, sessionId, sessionId);
  }

  // ─── Compaction Support ───────────────────────────────────────────────────

  incrementCompactCount(sessionId) {
    withRetry(() => this.#stmts.incrementCompact.run(sessionId));
  }

  upsertResume(sessionId, snapshot, eventCount) {
    withRetry(() => this.#stmts.upsertResume.run(sessionId, snapshot, eventCount));
  }

  getResume(sessionId) {
    return this.#stmts.getResume.get(sessionId) || null;
  }

  markResumeConsumed(sessionId) {
    withRetry(() => this.#stmts.markResumeConsumed.run(sessionId));
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  cleanupOldSessions(maxAgeDays = 7) {
    withRetry(() => {
      this.#stmts.cleanupOldSessions.run(maxAgeDays);
      this.#stmts.cleanupOldMeta.run(maxAgeDays);
      this.#stmts.cleanupOldResumes.run(maxAgeDays);
    });
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  close() {
    closeDB(this.#db);
  }
}
