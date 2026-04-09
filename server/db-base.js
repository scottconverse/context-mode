/**
 * SQLite database base utilities.
 * Provides lazy-loading of better-sqlite3, WAL pragmas,
 * retry logic, and connection management.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, unlinkSync, mkdirSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let Database = null;

/**
 * Lazy-load better-sqlite3.
 * Checks CLAUDE_PLUGIN_DATA/node_modules first, then local node_modules.
 */
export function loadDatabase() {
  if (Database) return Database;

  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  const pluginRoot = join(__dirname, '..');
  const searchPaths = [];

  if (pluginData) {
    searchPaths.push(join(pluginData, 'node_modules'));
  }
  searchPaths.push(join(pluginRoot, 'node_modules'));

  for (const searchPath of searchPaths) {
    try {
      const require = createRequire(join(searchPath, '.package.json'));
      Database = require('better-sqlite3');
      return Database;
    } catch { /* try next */ }
  }

  // Last resort: global require
  try {
    const require = createRequire(import.meta.url);
    Database = require('better-sqlite3');
    return Database;
  } catch (err) {
    throw new Error(
      `Failed to load better-sqlite3. Run: node scripts/setup.js\n` +
      `Searched: ${searchPaths.join(', ')}\n` +
      `Error: ${err.message}`
    );
  }
}

/**
 * Apply WAL mode and performance pragmas to a database.
 */
export function applyWALPragmas(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000');     // 64MB cache
  db.pragma('mmap_size = 268435456');   // 256MB mmap
  db.pragma('busy_timeout = 30000');    // 30s busy timeout
}

/**
 * Create and open a database with WAL pragmas.
 */
export function openDatabase(dbPath) {
  const DB = loadDatabase();

  // Ensure directory exists
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new DB(dbPath);
  applyWALPragmas(db);
  return db;
}

/**
 * Properly close a database with WAL checkpoint.
 */
export function closeDB(db) {
  if (!db) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch { /* ignore */ }
  try {
    db.close();
  } catch { /* ignore */ }
}

/**
 * Clean up WAL and SHM files alongside a database.
 */
export function cleanupDBFiles(dbPath) {
  for (const suffix of ['-wal', '-shm']) {
    const p = dbPath + suffix;
    try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
  }
}

/**
 * Retry a function on SQLITE_BUSY errors with exponential backoff.
 */
export function withRetry(fn, maxRetries = 3) {
  let lastError;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return fn();
    } catch (err) {
      lastError = err;
      if (err.code === 'SQLITE_BUSY' && i < maxRetries) {
        // Exponential backoff: 10ms, 20ms, 40ms
        const delay = 10 * Math.pow(2, i);
        const start = Date.now();
        while (Date.now() - start < delay) { /* busy wait */ }
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}
