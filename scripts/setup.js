#!/usr/bin/env node

/**
 * Setup script for context-mode plugin.
 * Installs dependencies into CLAUDE_PLUGIN_DATA and verifies better-sqlite3.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pluginRoot = join(__dirname, '..');

const pluginData = process.env.CLAUDE_PLUGIN_DATA || join(pluginRoot, '.data');

// Ensure data directory exists
for (const sub of ['', 'content', 'sessions', 'node_modules']) {
  const dir = join(pluginData, sub);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// Check if dependencies need installing by comparing package.json checksums
const srcPkg = join(pluginRoot, 'package.json');
const dstPkg = join(pluginData, 'package.json');

let needsInstall = true;
if (existsSync(dstPkg)) {
  const srcHash = createHash('sha256').update(readFileSync(srcPkg)).digest('hex');
  const dstHash = createHash('sha256').update(readFileSync(dstPkg)).digest('hex');
  needsInstall = srcHash !== dstHash;
}

if (needsInstall) {
  console.log('[context-mode] Installing dependencies...');
  copyFileSync(srcPkg, dstPkg);
  try {
    execSync('npm install --production', {
      cwd: pluginData,
      stdio: 'inherit',
      timeout: 120_000
    });
  } catch (err) {
    // Clean up the copied package.json so next run retries
    try { require('fs').unlinkSync(dstPkg); } catch { /* ignore */ }
    console.error('[context-mode] Failed to install dependencies:', err.message);
    process.exit(1);
  }
} else {
  console.log('[context-mode] Dependencies up to date.');
}

// Verify better-sqlite3 loads
try {
  const { createRequire } = await import('node:module');
  const require = createRequire(join(pluginData, 'node_modules', '.package.json'));
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  // Verify FTS5 is available
  db.exec("CREATE VIRTUAL TABLE _test_fts USING fts5(content, tokenize='porter unicode61')");
  db.exec('DROP TABLE _test_fts');
  db.close();
  console.log('[context-mode] better-sqlite3 with FTS5 verified.');
} catch (err) {
  console.error('[context-mode] better-sqlite3 verification failed:', err.message);
  console.error('[context-mode] Try: cd ' + pluginData + ' && npm rebuild better-sqlite3');
  process.exit(1);
}

console.log('[context-mode] Setup complete.');
console.log('[context-mode] Plugin root:', pluginRoot);
console.log('[context-mode] Data directory:', pluginData);
