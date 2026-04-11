#!/usr/bin/env node
/**
 * gen-routing-table.js — Auto-generates the routing rule table for README.md.
 *
 * Reads ROUTING_RULES from hooks/core/routing-rules.js and emits a markdown
 * table suitable for embedding in README.md under the "Automatic Tool Routing"
 * section. Run automatically by stamp-version.js before every release.
 *
 * Output format:
 *   | Intercepted Tool/Command | Redirected To | Rule ID |
 *   |---|---|---|
 *   | ... | ... | ... |
 *
 * The table is injected between two sentinel comments in README.md:
 *   <!-- ROUTING_TABLE_START -->
 *   <!-- ROUTING_TABLE_END -->
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Dynamic import so this script can run as ESM
const { ROUTING_RULES } = await import('../hooks/core/routing-rules.js');

// Build markdown table
const header = '| Intercepted Tool / Command | Redirected To | Rule ID |\n|---|---|---|';
const rows = ROUTING_RULES.map(rule =>
  `| ${rule.docLabel} | ${rule.docTarget} | \`${rule.id}\` |`
);
const table = [header, ...rows].join('\n');

// Inject into README.md between sentinels
const readmePath = resolve(ROOT, 'README.md');
if (!existsSync(readmePath)) {
  console.error('README.md not found');
  process.exit(1);
}

const readme = readFileSync(readmePath, 'utf8');
const START = '<!-- ROUTING_TABLE_START -->';
const END = '<!-- ROUTING_TABLE_END -->';

if (!readme.includes(START) || !readme.includes(END)) {
  console.warn('  WARN README.md is missing routing table sentinels — table not injected.');
  console.warn(`  Add ${START} and ${END} markers to README.md to enable auto-injection.`);
  // Print table to stdout so it can be manually placed
  console.log('\nGenerated routing table:\n');
  console.log(table);
  process.exit(0);
}

const updated = readme.replace(
  new RegExp(`${START}[\\s\\S]*?${END}`),
  `${START}\n${table}\n${END}`
);

if (updated === readme) {
  console.log('  OK   README.md routing table already up to date');
} else {
  writeFileSync(readmePath, updated, 'utf8');
  console.log(`  STAMP README.md routing table (${ROUTING_RULES.length} rules)`);
}
