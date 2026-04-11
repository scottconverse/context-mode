/**
 * Compression Learner — feedback loop for self-improving compression.
 *
 * Records compression decisions, detects retrieval misses via signal files
 * from PostToolUse, and computes retention weights per tool pattern.
 *
 * Licensed under Elastic License 2.0.
 */

import { readdirSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const RETRIEVAL_WINDOW_MS = 10 * 60 * 1000;  // 10 minutes
const WEIGHT_CACHE_TTL_MS = 5 * 60 * 1000;   // 5 minutes
const DEFAULT_RETENTION = 0.5;
const RETENTION_MULTIPLIER = 3;

export class Learner {
  #db;
  #signalDir;
  #weightCache = new Map(); // toolPattern → { retentionScore, cachedAt }

  constructor(db, signalDir) {
    this.#db = db;
    this.#signalDir = signalDir;
    this.#ensureSchema();
    if (!existsSync(signalDir)) {
      mkdirSync(signalDir, { recursive: true });
    }
  }

  #ensureSchema() {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS compression_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        tool_pattern TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        content_preview TEXT,
        session_context TEXT,
        was_retrieved INTEGER DEFAULT 0,
        retrieval_delay_ms INTEGER,
        source_label TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_cl_pattern ON compression_log(tool_pattern);
      CREATE INDEX IF NOT EXISTS idx_cl_hash ON compression_log(content_hash);
      CREATE INDEX IF NOT EXISTS idx_cl_timestamp ON compression_log(timestamp);

      CREATE TABLE IF NOT EXISTS compression_stats (
        date TEXT NOT NULL,
        tool_pattern TEXT NOT NULL,
        calls INTEGER DEFAULT 0,
        original_tokens INTEGER DEFAULT 0,
        compressed_tokens INTEGER DEFAULT 0,
        sandboxed_tokens INTEGER DEFAULT 0,
        retrieval_misses INTEGER DEFAULT 0,
        PRIMARY KEY (date, tool_pattern)
      );
    `);
  }

  /**
   * Record a compression decision.
   */
  recordDecision({ toolPattern, contentHash, contentPreview, sessionContext, sourceLabel }) {
    this.#db.prepare(`
      INSERT INTO compression_log (timestamp, tool_pattern, content_hash, content_preview, session_context, source_label)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(Date.now(), toolPattern, contentHash, contentPreview || '', sessionContext || '', sourceLabel || '');
  }

  /**
   * Process retrieval signal files written by PostToolUse.
   */
  processSignals() {
    let files;
    try {
      files = readdirSync(this.#signalDir).filter(f => f.startsWith('retrieval-') && f.endsWith('.json'));
    } catch {
      return;
    }

    const now = Date.now();
    const cutoff = now - RETRIEVAL_WINDOW_MS;

    // Get recent unmatched decisions
    const recentDecisions = this.#db.prepare(`
      SELECT id, content_preview, timestamp FROM compression_log
      WHERE was_retrieved = 0 AND timestamp > ?
    `).all(cutoff);

    for (const file of files) {
      const filePath = join(this.#signalDir, file);
      try {
        const signal = JSON.parse(readFileSync(filePath, 'utf8'));
        const queries = signal.queries || [];

        for (const query of queries) {
          const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);

          for (const decision of recentDecisions) {
            if (decision.was_retrieved) continue;
            const previewWords = (decision.content_preview || '').toLowerCase().split(/\s+/);
            const overlap = queryWords.filter(w => previewWords.some(pw => pw.includes(w)));

            if (overlap.length >= 2) {
              const delayMs = now - decision.timestamp;
              this.#db.prepare(`
                UPDATE compression_log SET was_retrieved = 1, retrieval_delay_ms = ? WHERE id = ?
              `).run(delayMs, decision.id);
              decision.was_retrieved = true;
            }
          }
        }

        unlinkSync(filePath);
      } catch {
        try { unlinkSync(filePath); } catch {}
      }
    }

    // Clean up old signal files (>1 hour)
    try {
      for (const file of readdirSync(this.#signalDir)) {
        const match = file.match(/retrieval-(\d+)\.json/);
        if (match && now - parseInt(match[1]) > 60 * 60 * 1000) {
          try { unlinkSync(join(this.#signalDir, file)); } catch {}
        }
      }
    } catch {}
  }

  /**
   * Get retention weights for a tool pattern.
   * Returns { retentionScore: 0.0–1.0 }
   */
  getWeights(toolPattern) {
    const cached = this.#weightCache.get(toolPattern);
    if (cached && Date.now() - cached.cachedAt < WEIGHT_CACHE_TTL_MS) {
      return { retentionScore: cached.retentionScore };
    }

    this.processSignals();

    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const row = this.#db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN was_retrieved = 1 THEN 1 ELSE 0 END) as retrieved
      FROM compression_log
      WHERE tool_pattern = ? AND timestamp > ?
    `).get(toolPattern, cutoff);

    if (!row || row.total === 0) {
      this.#weightCache.set(toolPattern, { retentionScore: DEFAULT_RETENTION, cachedAt: Date.now() });
      return { retentionScore: DEFAULT_RETENTION };
    }

    const retrievalRate = row.retrieved / row.total;
    const retentionScore = Math.min(retrievalRate * RETENTION_MULTIPLIER, 1.0);

    this.#weightCache.set(toolPattern, { retentionScore, cachedAt: Date.now() });
    return { retentionScore };
  }

  /**
   * Clear the weight cache (for testing).
   */
  clearWeightCache() {
    this.#weightCache.clear();
  }

  /**
   * Flush session compression stats to the lifetime table.
   */
  flushStats(sessionStats) {
    const today = new Date().toISOString().slice(0, 10);
    const compression = sessionStats.compression || {};

    const upsert = this.#db.prepare(`
      INSERT INTO compression_stats (date, tool_pattern, calls, original_tokens, compressed_tokens)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(date, tool_pattern) DO UPDATE SET
        calls = calls + excluded.calls,
        original_tokens = original_tokens + excluded.original_tokens,
        compressed_tokens = compressed_tokens + excluded.compressed_tokens
    `);

    const tx = this.#db.transaction(() => {
      for (const [pattern, stats] of Object.entries(compression)) {
        upsert.run(today, pattern, stats.calls || 0, stats.originalTokens || 0, stats.compressedTokens || 0);
      }
    });
    tx();
  }

  /**
   * Get lifetime aggregate statistics.
   */
  getLifetimeStats() {
    const row = this.#db.prepare(`
      SELECT
        SUM(calls) as totalCalls,
        SUM(original_tokens) as totalOriginalTokens,
        SUM(compressed_tokens) as totalCompressedTokens,
        MIN(date) as firstDate,
        COUNT(DISTINCT date) as sessionDays
      FROM compression_stats
    `).get();

    if (!row || !row.totalCalls) {
      return { totalCalls: 0, totalOriginalTokens: 0, totalCompressedTokens: 0, firstDate: null, sessionDays: 0 };
    }

    const accuracy = this.#db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN was_retrieved = 1 THEN 1 ELSE 0 END) as retrievals
      FROM compression_log
    `).get();

    return {
      totalCalls: row.totalCalls,
      totalOriginalTokens: row.totalOriginalTokens,
      totalCompressedTokens: row.totalCompressedTokens,
      firstDate: row.firstDate,
      sessionDays: row.sessionDays,
      totalDecisions: accuracy?.total || 0,
      totalRetrievals: accuracy?.retrievals || 0,
    };
  }

  /**
   * Delete old data beyond retention window.
   */
  prune(maxAgeDays = 7) {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    this.#db.prepare('DELETE FROM compression_log WHERE timestamp < ?').run(cutoff);
  }
}
