#!/usr/bin/env node

/**
 * context-mode installer for Claude Code / Cowork.
 *
 * Usage:
 *   npx github:scottconverse/context-mode
 *   — or —
 *   node install.js
 *
 * What it does:
 *   1. Clones/copies the plugin to the plugin cache
 *   2. Creates a local marketplace entry
 *   3. Registers the plugin in installed_plugins.json
 *   4. Enables the plugin in settings.json
 *   5. Installs dependencies (better-sqlite3, zod, MCP SDK)
 *   6. Verifies FTS5 works
 *
 * After running, start a new Claude Code session. The plugin loads automatically.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PLUGIN_NAME = 'context-mode';
const MARKETPLACE_NAME = 'local-dev';
const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
const VERSION = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')).version;

const HOME = homedir();
const CLAUDE_DIR = join(HOME, '.claude');
const PLUGINS_DIR = join(CLAUDE_DIR, 'plugins');
const CACHE_DIR = join(PLUGINS_DIR, 'cache', MARKETPLACE_NAME, PLUGIN_NAME, VERSION);
const DATA_DIR = join(PLUGINS_DIR, 'data', PLUGIN_NAME);
const MARKETPLACE_DIR = join(PLUGINS_DIR, 'marketplaces', MARKETPLACE_NAME);
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');
const INSTALLED_PATH = join(PLUGINS_DIR, 'installed_plugins.json');
const KNOWN_MKT_PATH = join(PLUGINS_DIR, 'known_marketplaces.json');

function log(msg) { console.log(`[context-mode] ${msg}`); }
function err(msg) { console.error(`[context-mode] ERROR: ${msg}`); }

// ─── Pre-flight checks ───────────────────────────────────────────────────────

if (!existsSync(CLAUDE_DIR)) {
  err(`Claude directory not found at ${CLAUDE_DIR}`);
  err('Is Claude Code installed? Install it first: https://code.claude.com');
  process.exit(1);
}

log(`Installing context-mode v${VERSION}`);
log(`Platform: ${process.platform} (${process.arch})`);
log(`Node.js: ${process.version}`);

// ─── Step 1: Copy plugin to cache ────────────────────────────────────────────

log('Step 1/6: Copying plugin to cache...');

if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true });
}

// Copy all plugin files (except node_modules, .data, .git)
const SOURCE = __dirname;
const SKIP = new Set(['node_modules', '.data', '.git', 'install.js']);
try {
  cpSync(SOURCE, CACHE_DIR, {
    recursive: true,
    filter: (src) => {
      const name = src.split(/[/\\]/).pop();
      return !SKIP.has(name);
    }
  });
  log(`  Copied to ${CACHE_DIR}`);
} catch (e) {
  err(`Failed to copy plugin: ${e.message}`);
  process.exit(1);
}

// ─── Step 2: Create local marketplace ────────────────────────────────────────

log('Step 2/6: Creating local marketplace...');

const mktPluginDir = join(MARKETPLACE_DIR, '.claude-plugin');
if (!existsSync(mktPluginDir)) mkdirSync(mktPluginDir, { recursive: true });

writeFileSync(join(mktPluginDir, 'marketplace.json'), JSON.stringify({
  name: MARKETPLACE_NAME,
  description: 'Local development plugins',
  owner: { name: 'Local' },
  plugins: [{
    name: PLUGIN_NAME,
    description: 'Context window optimization for Cowork',
    version: VERSION,
    source: `./${PLUGIN_NAME}`
  }]
}, null, 2));

// Symlink/junction the cached plugin into marketplace dir
const mktLink = join(MARKETPLACE_DIR, PLUGIN_NAME);
if (!existsSync(mktLink)) {
  try {
    if (process.platform === 'win32') {
      execSync(`cmd /c mklink /J "${mktLink}" "${CACHE_DIR}"`, { stdio: 'pipe' });
    } else {
      execSync(`ln -sf "${CACHE_DIR}" "${mktLink}"`, { stdio: 'pipe' });
    }
  } catch {
    // Junction failed — copy instead
    log('  (junction failed, using direct reference)');
  }
}

log('  Local marketplace configured');

// ─── Step 3: Register in installed_plugins.json ──────────────────────────────

log('Step 3/6: Registering plugin...');

let installed = { version: 2, plugins: {} };
if (existsSync(INSTALLED_PATH)) {
  try { installed = JSON.parse(readFileSync(INSTALLED_PATH, 'utf8')); } catch {}
}

installed.plugins[PLUGIN_ID] = [{
  scope: 'user',
  installPath: CACHE_DIR,
  version: VERSION,
  installedAt: new Date().toISOString(),
  lastUpdated: new Date().toISOString()
}];

writeFileSync(INSTALLED_PATH, JSON.stringify(installed, null, 2));
log('  Registered in installed_plugins.json');

// ─── Step 4: Enable in settings.json ─────────────────────────────────────────

log('Step 4/6: Enabling plugin...');

let settings = {};
if (existsSync(SETTINGS_PATH)) {
  try { settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')); } catch {}
}

if (!settings.enabledPlugins) settings.enabledPlugins = {};
settings.enabledPlugins[PLUGIN_ID] = true;

// Also register the marketplace
if (!settings.extraKnownMarketplaces) settings.extraKnownMarketplaces = {};
if (!settings.extraKnownMarketplaces[MARKETPLACE_NAME]) {
  settings.extraKnownMarketplaces[MARKETPLACE_NAME] = {
    source: { source: 'local', path: MARKETPLACE_DIR }
  };
}

writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
log('  Plugin enabled in settings.json');

// Also update known_marketplaces.json
let knownMkt = {};
if (existsSync(KNOWN_MKT_PATH)) {
  try { knownMkt = JSON.parse(readFileSync(KNOWN_MKT_PATH, 'utf8')); } catch {}
}
knownMkt[MARKETPLACE_NAME] = {
  source: { source: 'local', path: MARKETPLACE_DIR },
  installLocation: MARKETPLACE_DIR,
  lastUpdated: new Date().toISOString()
};
writeFileSync(KNOWN_MKT_PATH, JSON.stringify(knownMkt, null, 2));

// ─── Step 5: Install dependencies ────────────────────────────────────────────

log('Step 5/6: Installing dependencies...');

// Install to persistent data dir
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

copyFileSync(join(CACHE_DIR, 'package.json'), join(DATA_DIR, 'package.json'));
try {
  execSync('npm install --omit=dev', {
    cwd: DATA_DIR,
    stdio: 'pipe',
    timeout: 120_000
  });
  log('  Dependencies installed to ' + DATA_DIR);
} catch (e) {
  // Fallback: install in cache dir
  log('  Data dir install failed, installing in cache...');
  try {
    execSync('npm install --omit=dev', {
      cwd: CACHE_DIR,
      stdio: 'pipe',
      timeout: 120_000
    });
    log('  Dependencies installed to ' + CACHE_DIR);
  } catch (e2) {
    err('Failed to install dependencies: ' + e2.message);
    process.exit(1);
  }
}

// ─── Step 6: Verify ──────────────────────────────────────────────────────────

log('Step 6/6: Verifying...');

let verified = false;
const searchPaths = [
  join(DATA_DIR, 'node_modules'),
  join(CACHE_DIR, 'node_modules')
];

for (const searchPath of searchPaths) {
  try {
    const req = createRequire(join(searchPath, '.package.json'));
    const Database = req('better-sqlite3');
    const db = new Database(':memory:');
    db.exec("CREATE VIRTUAL TABLE _test USING fts5(content, tokenize='porter unicode61')");
    db.exec('DROP TABLE _test');
    db.close();
    verified = true;
    log('  better-sqlite3 + FTS5: OK');
    break;
  } catch { continue; }
}

if (!verified) {
  err('better-sqlite3 verification failed');
  err('Try: cd ' + DATA_DIR + ' && npm rebuild better-sqlite3');
  process.exit(1);
}

// ─── Done ────────────────────────────────────────────────────────────────────

console.log('');
console.log('='.repeat(50));
console.log('  context-mode v' + VERSION + ' installed successfully!');
console.log('='.repeat(50));
console.log('');
console.log('Next steps:');
console.log('  1. Open Claude Code (or start a new session in Cowork)');
console.log('  2. Type /context-mode:ctx-doctor to verify');
console.log('  3. The 9 MCP tools load automatically');
console.log('');
console.log('Tools: ctx_execute, ctx_search, ctx_index,');
console.log('       ctx_fetch_and_index, ctx_batch_execute,');
console.log('       ctx_execute_file, ctx_stats, ctx_doctor, ctx_purge');
console.log('');
