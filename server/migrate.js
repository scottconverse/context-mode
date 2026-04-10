/**
 * Schema versioning and migration runner for context-mode SQLite databases.
 *
 * Uses PRAGMA user_version for zero-overhead version tracking.
 * Runs ordered migrations in transactions with automatic backup.
 *
 * Ported from mksglu/context-mode (https://github.com/mksglu/context-mode)
 * by @mksglu, licensed under Elastic License 2.0.
 */

import { copyFileSync } from 'node:fs';

/**
 * Run pending schema migrations on a database.
 *
 * @param {object} db - Open better-sqlite3 instance
 * @param {string} dbPath - Filesystem path to the .db file (for backup)
 * @param {Array<{version: number, up: (db: object) => void}>} migrations - Ordered ascending
 * @param {object} opts
 * @param {string} opts.label - Database label for backup naming ('knowledge' | 'session')
 * @param {string} opts.detectTable - Table name to detect pre-existing unversioned DB
 * @param {(db: object) => void} opts.validate - Validation function, throws if schema invalid
 * @returns {{ previousVersion: number, currentVersion: number, migrationsRun: number }}
 */
export function runMigrations(db, dbPath, migrations, opts) {
  const { label = 'unknown', detectTable, validate } = opts;

  // Read current schema version (0 = new or pre-existing unversioned)
  const currentVersion = db.pragma('user_version', { simple: true });

  // Filter and sort pending migrations
  const pending = migrations
    .filter(m => m.version > currentVersion)
    .sort((a, b) => a.version - b.version);

  // Nothing to do — validate and return
  if (pending.length === 0) {
    if (validate) validate(db);
    return { previousVersion: currentVersion, currentVersion, migrationsRun: 0 };
  }

  // Backup before destructive migrations (skip for v0 → v1 bootstrap)
  if (currentVersion > 0) {
    try {
      // Flush WAL to main DB file before backup
      db.pragma('wal_checkpoint(TRUNCATE)');
      const backupPath = `${dbPath}.backup-v${currentVersion}`;
      copyFileSync(dbPath, backupPath);
      process.stderr.write(
        `[context-mode] ${label} DB backed up to ${backupPath}\n`
      );
    } catch (err) {
      // Backup failure is fatal — don't run migrations without a safety net
      throw new Error(
        `[context-mode] ${label} DB backup failed, aborting migration: ${err.message}`
      );
    }
  }

  // Run each migration in its own transaction
  let lastVersion = currentVersion;
  for (const migration of pending) {
    const runMigration = db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    });

    try {
      runMigration();
      lastVersion = migration.version;
      process.stderr.write(
        `[context-mode] ${label} DB migrated to v${migration.version}\n`
      );
    } catch (err) {
      process.stderr.write(
        `[context-mode] ${label} DB migration to v${migration.version} failed: ${err.message}\n`
      );
      throw new Error(
        `[context-mode] ${label} DB migration to v${migration.version} failed. ` +
        `DB remains at v${lastVersion}. ` +
        (currentVersion > 0 ? `Backup at: ${dbPath}.backup-v${currentVersion}` : 'No backup (was unversioned).') +
        ` Error: ${err.message}`
      );
    }
  }

  // Validate final schema
  if (validate) validate(db);

  return {
    previousVersion: currentVersion,
    currentVersion: lastVersion,
    migrationsRun: pending.length,
  };
}

/**
 * Validate that required tables exist in a database.
 *
 * @param {object} db - Open better-sqlite3 instance
 * @param {string[]} requiredTables - Table names that must exist
 * @param {string} label - Database label for error messages
 * @throws {Error} if any required table is missing
 */
export function validateTables(db, requiredTables, label) {
  const existing = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
    .all()
    .map(r => r.name);

  const missing = requiredTables.filter(t => !existing.includes(t));
  if (missing.length > 0) {
    throw new Error(
      `[context-mode] ${label} DB schema invalid: missing tables: ${missing.join(', ')}`
    );
  }
}
