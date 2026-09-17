#!/usr/bin/env node
/**
 * Adapter CLI.
 *
 *   node adapters/cli.js --list
 *   node adapters/cli.js --adapter grok
 *   node adapters/cli.js --adapter cursor --out ./out
 *
 * Also invoked from install.js when those flags are present, so
 * `npx github:scottconverse/context-mode --adapter grok` works.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ADAPTERS, getAdapter, hookCount } from './catalog.js';
import { generateAdapter, bundleText } from './generate.js';

function printList() {
  const width = Math.max(...ADAPTERS.map((a) => a.id.length));
  console.log('context-mode adapters\n');
  console.log(
    `${'id'.padEnd(width)}  ${'hooks'.padStart(5)}  ${'comp'.padStart(4)}  name`,
  );
  for (const a of ADAPTERS) {
    console.log(
      `${a.id.padEnd(width)}  ${String(hookCount(a)).padStart(5)}  ${String(a.compliance).padStart(3)}%  ${a.name} (${a.vendor})`,
    );
  }
  console.log('\nInstall one:');
  console.log('  npx --yes --package=github:scottconverse/context-mode context-mode --adapter <id>');
  console.log('  node adapters/cli.js --adapter <id> --out ./out');
}

function writeFiles(files, outDir) {
  for (const f of files) {
    const dest = join(outDir, f.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.contents, 'utf8');
    console.log(`  wrote ${join(outDir === process.cwd() ? '.' : outDir, f.path)}`);
  }
}

export function runAdapterCli(argv) {
  const args = argv.slice();
  const list = args.includes('--list') || args.includes('-l');
  const adapterIdx = args.findIndex((a) => a === '--adapter' || a === '-a');
  const outIdx = args.findIndex((a) => a === '--out' || a === '-o');
  const adapterId = adapterIdx >= 0 ? args[adapterIdx + 1] : null;
  const outDir = outIdx >= 0 ? resolve(args[outIdx + 1]) : resolve(process.cwd(), 'context-mode-adapter');
  const print = args.includes('--print');

  if (list || args.includes('--help') || args.includes('-h')) {
    if (args.includes('--help') || args.includes('-h')) {
      console.log(`context-mode adapter generator

Usage:
  node adapters/cli.js --list
  node adapters/cli.js --adapter <id> [--out <dir>] [--print]

Claude Code / Cowork remain the default. Run install.js with no flags
for the original 7-step Cowork installer.
`);
      printList();
      return true;
    }
    printList();
    return true;
  }

  if (!adapterId) return false;

  const adapter = getAdapter(adapterId);
  if (!adapter) {
    console.error(`[context-mode] unknown adapter: ${adapterId}`);
    console.error('Run --list to see ids.');
    process.exitCode = 1;
    return true;
  }

  const files = generateAdapter(adapter);
  console.log(`[context-mode] generating ${adapter.name} adapter (${files.length} files)`);
  if (print) {
    process.stdout.write(bundleText(files));
  } else {
    mkdirSync(outDir, { recursive: true });
    writeFiles(files, outDir);
    console.log('');
    console.log(`Next: copy the generated files into place for ${adapter.name}.`);
    for (const step of adapter.install) console.log(`  - ${step}`);
    console.log('');
    console.log(`Notes: ${adapter.notes}`);
  }
  return true;
}

const isMain = process.argv[1] && process.argv[1].endsWith('cli.js');
if (isMain) {
  const handled = runAdapterCli(process.argv.slice(2));
  if (!handled) {
    console.error('Specify --list or --adapter <id>. See --help.');
    process.exit(1);
  }
}
