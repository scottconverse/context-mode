/**
 * SQLite database base utilities.
 * Provides lazy-loading of better-sqlite3, WAL pragmas,
 * retry logic, and connection management.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let Database = null;

/**
 * Lazy-load better-sqlite3.
 * Search order (first match wins):
 *   1. CLAUDE_PLUGIN_DATA (canonical — where install.js puts deps)
 *   2. Spec path: ~/.claude/plugins/data/context-mode/node_modules
 *   3. Plugin root node_modules (dev/local installs)
 *   4. NODE_PATH (if set)
 *   5. Global require (last resort)
 */
export function loadDatabase() {
  if (Database) return Database;

  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  const pluginRoot = join(__dirname, '..');
  const searchPaths = [];

  // 1. Canonical: CLAUDE_PLUGIN_DATA (where install.js installs deps)
  if (pluginData && !pluginData.includes('${')) {
    searchPaths.push(join(pluginData, 'node_modules'));
  }
  // 2. Spec path: ~/.claude/plugins/data/context-mode/node_modules
  searchPaths.push(join(homedir(), '.claude', 'plugins', 'data', 'context-mode', 'node_modules'));
  // 3. Plugin root (dev installs, npm ci)
  searchPaths.push(join(pluginRoot, 'node_modules'));
  // 4. NODE_PATH
  if (process.env.NODE_PATH && !process.env.NODE_PATH.includes('${')) {
    searchPaths.push(process.env.NODE_PATH);
  }

  for (const searchPath of searchPaths) {
    try {
      const require = createRequire(join(searchPath, '.package.json'));
      Database = require('better-sqlite3');
      process.stderr.write(`[context-mode] better-sqlite3 loaded from: ${searchPath}\n`);
      return Database;
    } catch { /* try next */ }
  }

  // 5. Last resort: global require
  try {
    const require = createRequire(import.meta.url);
    Database = require('better-sqlite3');
    process.stderr.write('[context-mode] better-sqlite3 loaded from: global require\n');
    return Database;
  } catch (err) {
    throw new Error(
      `Failed to load better-sqlite3. Run: node install.js\n` +
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
        // Exponential backoff: 10ms, 20ms, 40ms — non-blocking sleep
        const delay = 10 * Math.pow(2, i);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}
