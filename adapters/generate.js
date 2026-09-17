/**
 * generate.js — Produce installable files for one adapter.
 *
 * Usage (via adapters/cli.js):
 *   node adapters/cli.js --adapter grok --out ./out
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookCount, reverseToolMap } from './catalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function pkgVersion() {
  return JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version;
}

function mcpBlock(adapter) {
  const version = pkgVersion();
  const server = {
    command: 'npx',
    args: ['-y', 'github:scottconverse/context-mode'],
    env: {
      CONTEXT_MODE_PLATFORM: adapter.id,
      CONTEXT_MODE_DATA: '${HOME}/.context-mode',
    },
  };
  if (adapter.mcpConfigPath.includes('config.toml')) {
    return `[mcp_servers.context-mode]
command = "npx"
args = ["-y", "github:scottconverse/context-mode"]

[mcp_servers.context-mode.env]
CONTEXT_MODE_PLATFORM = "${adapter.id}"
CONTEXT_MODE_DATA = "~/.context-mode"
`;
  }
  if (adapter.id === 'zed') {
    return JSON.stringify(
      {
        context_servers: {
          'context-mode': {
            command: 'npx',
            args: ['-y', 'github:scottconverse/context-mode'],
            env: { CONTEXT_MODE_PLATFORM: 'zed', CONTEXT_MODE_DATA: '${HOME}/.context-mode' },
          },
        },
      },
      null,
      2,
    ) + '\n';
  }
  return JSON.stringify({
    mcpServers: {
      'context-mode': {
        ...server,
        env: { ...server.env, CONTEXT_MODE_VERSION: version },
      },
    },
  }, null, 2) + '\n';
}

function toolLine(adapter, canonical, fallback) {
  return reverseToolMap(adapter)[canonical] ?? fallback;
}

export function instructionFile(adapter) {
  const shell = toolLine(adapter, 'shell', 'shell');
  const read = toolLine(adapter, 'read', 'read');
  const grep = toolLine(adapter, 'grep', 'grep');
  const web = toolLine(adapter, 'webfetch', 'webfetch');
  const hooks = hookCount(adapter);
  const version = pkgVersion();
  const enforce =
    hooks > 0
      ? `This host exposes ${hooks} hook event(s). context-mode will intercept oversized tool calls.`
      : `This host has no tool hooks. Follow the decision tree below — nothing will intercept a bad call for you.`;

  return `# context-mode

Raw tool output floods the context window. Keep raw data in the sandbox.

Platform: **${adapter.name}** (${adapter.vendor})
Version: **${version}**
Instruction file: \`${adapter.instructionFile}\`
MCP: \`${adapter.mcpConfigPath}\`

${enforce}

## Think in Code — MANDATORY

When you need to analyze, count, filter, compare, search, parse, transform, or process data: **write code** that does the work via \`ctx_execute\` and print only the answer. Do NOT read raw data into context to process mentally. Your role is to PROGRAM the analysis, not to COMPUTE it.

## Tool map (${adapter.name} → canonical)

| Host tool | Canonical | Use instead |
|---|---|---|
| \`${shell}\` | shell | \`ctx_execute\` / \`ctx_batch_execute\` for anything >20 lines |
| \`${read}\` | read | \`ctx_execute_file\` for analysis; \`${read}\` is correct for files you will edit |
| \`${grep}\` | grep | \`ctx_search\` against the indexed knowledge base |
| \`${web}\` | webfetch | \`ctx_fetch_and_index\` then \`ctx_search\` |

## Decision tree

1. **GATHER** — \`ctx_batch_execute(commands, queries)\`. One call replaces many.
2. **FOLLOW-UP** — \`ctx_search(queries: [...])\`.
3. **PROCESSING** — \`ctx_execute\` / \`ctx_execute_file\`.
4. **WEB** — \`ctx_fetch_and_index(url)\` then \`ctx_search\`. Never dump raw HTML.

## Rules

- DO NOT use \`${shell}\` for commands producing >20 lines of output.
- DO NOT use \`${read}\` for analysis of large files.
- DO NOT use \`${web}\` — fetch and index instead.
- DO NOT use curl/wget in a shell tool.
- \`${shell}\` is ONLY for git, mkdir, rm, mv, navigation, and short commands.

## Output

- Keep responses under 500 words unless asked otherwise.
- Write artifacts to files — do not paste them inline.
- Return file path + one-line description.
`;
}

function hooksJson(adapter) {
  const events = {};
  for (const [canonical, name] of Object.entries(adapter.hooks)) {
    if (!name) continue;
    events[name] = [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `node \${CONTEXT_MODE_ROOT}/hooks/dispatch.js ${adapter.id} ${canonical}`,
          },
        ],
      },
    ];
  }
  return JSON.stringify(
    {
      description: `context-mode hooks for ${adapter.name}`,
      hooks: events,
    },
    null,
    2,
  ) + '\n';
}

function manifest(adapter) {
  return JSON.stringify(
    {
      name: 'context-mode',
      version: pkgVersion(),
      adapter: adapter.id,
      vendor: adapter.vendor,
      core: 'portable',
      hookParadigm: adapter.hookParadigm,
      instructionFile: adapter.instructionFile,
      mcpConfigPath: adapter.mcpConfigPath,
      compliance: adapter.compliance,
      toolMap: adapter.toolMap,
      hooks: adapter.hooks,
    },
    null,
    2,
  ) + '\n';
}

function readme(adapter) {
  const version = pkgVersion();
  return `# context-mode adapter — ${adapter.name}

${adapter.summary}

context-mode **${version}**. Expected routing compliance: **${adapter.compliance}%**
Hook paradigm: \`${adapter.hookParadigm}\`

## Install

${adapter.install.map((s, i) => `${i + 1}. ${s}`).join('\n')}

## Notes

${adapter.notes}

## What this adapter does not do

The portable core (compressor, knowledge base, session snapshot, sandbox) is shared.
This folder only binds ${adapter.name}'s tool names, hook events, and config paths.
`;
}

export function generateAdapter(adapter) {
  const files = [
    { path: 'README.md', language: 'markdown', contents: readme(adapter) },
    { path: 'adapter.json', language: 'json', contents: manifest(adapter) },
    {
      path: adapter.instructionFile.replace(/^\.\//, '').replace(/^~\//, '').replace(/\s.*/, ''),
      language: 'markdown',
      contents: instructionFile(adapter),
    },
  ];

  const mcpLang = adapter.mcpConfigPath.includes('.toml')
    ? 'toml'
    : adapter.mcpConfigPath.includes('.yaml')
      ? 'yaml'
      : 'json';
  const mcpName = adapter.mcpConfigPath.includes('config.toml')
    ? 'config.toml'
    : adapter.id === 'zed'
      ? 'zed-settings.json'
      : 'mcp.json';
  files.push({ path: mcpName, language: mcpLang, contents: mcpBlock(adapter) });

  if (hookCount(adapter) > 0) {
    files.push({ path: 'hooks.json', language: 'json', contents: hooksJson(adapter) });
  }

  if (adapter.hookParadigm === 'skills') {
    files.push({
      path: '.grok/skills/context-mode/SKILL.md',
      language: 'markdown',
      contents: `# context-mode

Load this skill before any tool-heavy turn (shell, search, fetch, large-file analysis).

${instructionFile(adapter)}
`,
    });
  }

  return files;
}

export function bundleText(files) {
  return files.map((f) => `----- ${f.path} -----\n${f.contents.trimEnd()}\n`).join('\n');
}
