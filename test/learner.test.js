// test/learner.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Learner } from '../server/learner.js';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmpDir;
let db;
let signalDir;
let learner;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'learner-test-'));
  signalDir = join(tmpDir, 'signals');
  mkdirSync(signalDir, { recursive: true });
  db = new Database(join(tmpDir, 'test.db'));
  learner = new Learner(db, signalDir);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Learner — Schema', () => {
  it('creates compression_log table', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    expect(tables.map(t => t.name)).toContain('compression_log');
  });

  it('creates compression_stats table', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    expect(tables.map(t => t.name)).toContain('compression_stats');
  });
});

describe('Learner — Cold Start', () => {
  it('returns default 0.5 retention for unknown patterns', () => {
    const { retentionScore } = learner.getWeights('git_log');
    expect(retentionScore).toBe(0.5);
  });
});

describe('Learner — Record + Query', () => {
  it('records a compression decision', () => {
    learner.recordDecision({
      toolPattern: 'git_log',
      contentHash: 'abc123',
      contentPreview: 'commit a1b2c3 fix auth middleware',
      sessionContext: 'editing server/index.js',
      sourceLabel: 'exec:shell:123',
    });

    const rows = db.prepare('SELECT * FROM compression_log').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].tool_pattern).toBe('git_log');
    expect(rows[0].content_hash).toBe('abc123');
    expect(rows[0].was_retrieved).toBe(0);
  });
});

describe('Learner — Retrieval Detection', () => {
  it('detects retrieval miss from signal file', () => {
    learner.recordDecision({
      toolPattern: 'git_log',
      contentHash: 'abc123',
      contentPreview: 'commit fix auth middleware routing',
      sessionContext: 'editing server/index.js',
      sourceLabel: 'exec:shell:123',
    });

    const signal = {
      queries: ['auth middleware'],
      timestamp: Date.now(),
    };
    writeFileSync(
      join(signalDir, `retrieval-${Date.now()}.json`),
      JSON.stringify(signal),
    );

    learner.processSignals();

    const rows = db.prepare('SELECT * FROM compression_log WHERE was_retrieved = 1').all();
    expect(rows).toHaveLength(1);
  });

  it('does not match signals older than 10 minutes', () => {
    learner.recordDecision({
      toolPattern: 'git_log',
      contentHash: 'abc123',
      contentPreview: 'commit fix auth middleware routing',
      sessionContext: 'editing server/index.js',
      sourceLabel: 'exec:shell:123',
    });

    // Backdate the decision by 15 minutes
    db.prepare('UPDATE compression_log SET timestamp = ?').run(Date.now() - 15 * 60 * 1000);

    const signal = {
      queries: ['auth middleware'],
      timestamp: Date.now(),
    };
    writeFileSync(
      join(signalDir, `retrieval-${Date.now()}.json`),
      JSON.stringify(signal),
    );

    learner.processSignals();

    const rows = db.prepare('SELECT * FROM compression_log WHERE was_retrieved = 1').all();
    expect(rows).toHaveLength(0);
  });
});

describe('Learner — Weight Computation', () => {
  it('computes higher retention when retrievals are frequent', () => {
    for (let i = 0; i < 10; i++) {
      learner.recordDecision({
        toolPattern: 'pytest',
        contentHash: `hash-${i}`,
        contentPreview: `test content ${i}`,
        sessionContext: 'testing',
        sourceLabel: `exec:shell:${i}`,
      });
    }
    // Mark 4 as retrieved → 40% rate → clamp(0.4 * 3) = 1.0
    db.prepare('UPDATE compression_log SET was_retrieved = 1 WHERE id <= 4').run();

    learner.clearWeightCache();
    const { retentionScore } = learner.getWeights('pytest');
    expect(retentionScore).toBe(1.0);
  });

  it('computes lower retention when nothing is retrieved', () => {
    for (let i = 0; i < 10; i++) {
      learner.recordDecision({
        toolPattern: 'npm_install',
        contentHash: `hash-${i}`,
        contentPreview: `install content ${i}`,
        sessionContext: 'installing',
        sourceLabel: `exec:shell:${i}`,
      });
    }

    learner.clearWeightCache();
    const { retentionScore } = learner.getWeights('npm_install');
    expect(retentionScore).toBe(0.0);
  });
});

describe('Learner — Decay / Prune', () => {
  it('deletes decisions older than 7 days', () => {
    learner.recordDecision({
      toolPattern: 'old_pattern',
      contentHash: 'old',
      contentPreview: 'old content',
      sessionContext: 'old',
      sourceLabel: 'old',
    });

    // Backdate by 8 days
    db.prepare('UPDATE compression_log SET timestamp = ?').run(Date.now() - 8 * 24 * 60 * 60 * 1000);

    learner.prune(7);

    const rows = db.prepare('SELECT * FROM compression_log').all();
    expect(rows).toHaveLength(0);
  });
});

describe('Learner — Lifetime Stats', () => {
  it('flushes session stats to compression_stats table', () => {
    const sessionStats = {
      compression: {
        npm_test: { calls: 5, originalTokens: 50000, compressedTokens: 3000 },
        git_log: { calls: 3, originalTokens: 20000, compressedTokens: 5000 },
      },
    };

    learner.flushStats(sessionStats);

    const rows = db.prepare('SELECT * FROM compression_stats').all();
    expect(rows).toHaveLength(2);

    const npmRow = rows.find(r => r.tool_pattern === 'npm_test');
    expect(npmRow.calls).toBe(5);
    expect(npmRow.original_tokens).toBe(50000);
  });

  it('aggregates into existing daily rows', () => {
    const stats1 = { compression: { npm_test: { calls: 5, originalTokens: 50000, compressedTokens: 3000 } } };
    const stats2 = { compression: { npm_test: { calls: 3, originalTokens: 30000, compressedTokens: 2000 } } };

    learner.flushStats(stats1);
    learner.flushStats(stats2);

    const rows = db.prepare('SELECT * FROM compression_stats WHERE tool_pattern = ?').all('npm_test');
    expect(rows).toHaveLength(1);
    expect(rows[0].calls).toBe(8);
    expect(rows[0].original_tokens).toBe(80000);
  });

  it('returns lifetime totals', () => {
    learner.flushStats({
      compression: {
        npm_test: { calls: 5, originalTokens: 50000, compressedTokens: 3000 },
        git_log: { calls: 3, originalTokens: 20000, compressedTokens: 5000 },
      },
    });

    const totals = learner.getLifetimeStats();
    expect(totals.totalOriginalTokens).toBe(70000);
    expect(totals.totalCompressedTokens).toBe(8000);
    expect(totals.totalCalls).toBe(8);
    expect(totals).toHaveProperty('totalRetrievals');
    expect(totals).not.toHaveProperty('totalMisses');
  });
});

describe('Learner — Weight Cache', () => {
  it('caches weights for 5 minutes', () => {
    for (let i = 0; i < 5; i++) {
      learner.recordDecision({
        toolPattern: 'cached_test',
        contentHash: `h${i}`,
        contentPreview: `content ${i}`,
        sessionContext: 'test',
        sourceLabel: `s${i}`,
      });
    }

    const w1 = learner.getWeights('cached_test');

    // Add more data that would change the weight
    db.prepare('UPDATE compression_log SET was_retrieved = 1').run();

    // Should return cached value (same as w1)
    const w2 = learner.getWeights('cached_test');
    expect(w2.retentionScore).toBe(w1.retentionScore);
  });
});
