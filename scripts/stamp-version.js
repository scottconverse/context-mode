#!/usr/bin/env node
/**
 * stamp-version.js — Single source of truth version stamper.
 *
 * Reads version from package.json and stamps it into every file that
 * carries a version string. Run before every release. Exits non-zero
 * if any stamp fails or CHANGELOG is missing the new version entry.
 *
 * Stamped locations:
 *   1. .claude-plugin/plugin.json  — "version": "x.y.z"
 *   2. server/index.js             — const VERSION = 'x.y.z';
 *   3. README.md                   — Current version: **x.y.z**
 *   4. docs/README-FULL.md         — **Version x.y.z** | ...
 *   5. docs/index.html             — context-mode vx.y.z &middot;
 *
 * Validated (not stamped):
 *   6. CHANGELOG.md                — must contain [x.y.z] entry
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function read(rel) {
  const abs = resolve(ROOT, rel);
  if (!existsSync(abs)) throw new Error(`File not found: ${rel}`);
  return readFileSync(abs, 'utf8');
}

function write(rel, content) {
  writeFileSync(resolve(ROOT, rel), content, 'utf8');
}

function stamp(rel, pattern, replacement, { required = true } = {}) {
  const original = read(rel);
  if (!pattern.test(original)) {
    if (required) {
      console.error(`  FAIL ${rel} — pattern not found: ${pattern}`);
      return false;
    }
    console.warn(`  WARN ${rel} — pattern not found (optional)`);
    return true;
  }
  const updated = original.replace(pattern, replacement);
  if (updated === original) {
    console.log(`  OK   ${rel} (already current)`);
    return true;
  }
  write(rel, updated);
  console.log(`  STAMP ${rel}`);
  return true;
}

// ── main ──────────────────────────────────────────────────────────────────
const pkg = JSON.parse(read('package.json'));
const version = pkg.version;
if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`Invalid version in package.json: ${JSON.stringify(version)}`);
  process.exit(1);
}

// Derive month/year for README-FULL.md date field
const now = new Date();
const months = ['January','February','March','April','May','June',
                 'July','August','September','October','November','December'];
const monthYear = `${months[now.getMonth()]} ${now.getFullYear()}`;

console.log(`\nStamping version ${version} into all source files...\n`);

let ok = true;

// 1. .claude-plugin/plugin.json
ok &= stamp(
  '.claude-plugin/plugin.json',
  /"version":\s*"\d+\.\d+\.\d+"/,
  `"version": "${version}"`
);

// 2. server/index.js
ok &= stamp(
  'server/index.js',
  /const VERSION = '[^']+';/,
  `const VERSION = '${version}';`
);

// 3. README.md
ok &= stamp(
  'README.md',
  /Current version:\s*\*\*[\d.]+\*\*/,
  `Current version: **${version}**`
);

// 4. docs/README-FULL.md — stamp version and update month/year
ok &= stamp(
  'docs/README-FULL.md',
  /\*\*Version [\d.]+\*\* \| ([^|]+) \| [A-Za-z]+ \d{4}/,
  `**Version ${version}** | $1 | ${monthYear}`
);

// 5. docs/index.html — footer version
ok &= stamp(
  'docs/index.html',
  /context-mode v[\d.]+ &middot;/,
  `context-mode v${version} &middot;`
);

// 6. CHANGELOG.md — validate entry exists (don't auto-generate)
const changelog = read('CHANGELOG.md');
if (!changelog.includes(`[${version}]`)) {
  console.error(`  FAIL CHANGELOG.md — missing entry for [${version}]`);
  ok = false;
} else {
  console.log(`  OK   CHANGELOG.md has entry for [${version}]`);
}

// 7. Auto-generate routing table in README.md
try {
  const { execSync } = await import('node:child_process');
  execSync('node scripts/gen-routing-table.js', { cwd: ROOT, stdio: 'inherit' });
} catch (e) {
  console.error('  FAIL gen-routing-table.js failed:', e.message);
  ok = false;
}

console.log('');
if (!ok) {
  console.error('stamp-version FAILED — fix errors above before releasing.');
  process.exit(1);
} else {
  console.log(`stamp-version complete. All files stamped with ${version}.`);
}
