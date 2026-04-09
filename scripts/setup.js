#!/usr/bin/env node

/**
 * Setup script for context-mode plugin.
 * Installs dependencies into the persistent data directory and verifies better-sqlite3.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pluginRoot = join(__dirname, '..');

// Resolve data directory — same logic as server/index.js
function resolvePluginData() {
  const envVal = process.env.CLAUDE_PLUGIN_DATA;
  if (envVal && !envVal.includes('${') && !envVal.includes('CLAUDE_PLUGIN_DATA')) {
    return envVal;
  }
  const home = homedir();
  const specPath = join(home, '.claude', 'plugins', 'data', 'context-mode');
  if (existsSync(join(home, '.claude', 'plugins'))) {
    return specPath;
  }
  return join(pluginRoot, '.data');
}

const pluginData = resolvePluginData();

// Ensure data directory exists
for (const sub of ['', 'content', 'sessions']) {
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
  console.error('[context-mode] Installing dependencies to', pluginData);
  copyFileSync(srcPkg, dstPkg);
  try {
    execSync('npm install --omit=dev', {
      cwd: pluginData,
      stdio: 'inherit',
      timeout: 120_000
    });
  } catch (err) {
    try { unlinkSync(dstPkg); } catch { /* ignore */ }
    console.error('[context-mode] Failed to install dependencies:', err.message);
    process.exit(1);
  }
} else {
  console.error('[context-mode] Dependencies up to date.');
}

// Verify better-sqlite3 loads
try {
  const { createRequire } = await import('node:module');
  const req = createRequire(join(pluginData, 'node_modules', '.package.json'));
  const Database = req('better-sqlite3');
  const db = new Database(':memory:');
  db.exec("CREATE VIRTUAL TABLE _test_fts USING fts5(content, tokenize='porter unicode61')");
  db.exec('DROP TABLE _test_fts');
  db.close();
  console.error('[context-mode] better-sqlite3 with FTS5 verified.');
} catch (err) {
  console.error('[context-mode] better-sqlite3 verification failed:', err.message);
  process.exit(1);
}

console.error('[context-mode] Setup complete. Data:', pluginData);
