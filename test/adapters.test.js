// test/adapters.test.js
// Adapter catalog, generator, and platform resolver.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, getAdapter, hookCount, reverseToolMap } from '../adapters/catalog.js';
import { generateAdapter, instructionFile } from '../adapters/generate.js';
import {
  canonicalizeTool,
  toClaudeToolName,
  normalizeHookPayload,
  normalizeEventName,
  resolveDataDir,
  CANONICAL_TO_CLAUDE,
} from '../hooks/core/platform.js';
import { routePreToolUse, resetGuidanceThrottle } from '../hooks/core/routing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

describe('adapter catalog', () => {
  it('has 22 adapters', () => {
    assert.equal(ADAPTERS.length, 22);
  });

  it('every adapter has unique id, instruction file, tool map, compliance', () => {
    const ids = new Set();
    for (const a of ADAPTERS) {
      assert.ok(a.id, 'missing id');
      assert.equal(ids.has(a.id), false, `duplicate id ${a.id}`);
      ids.add(a.id);
      assert.ok(a.name);
      assert.ok(a.instructionFile);
      assert.ok(a.mcpConfigPath);
      assert.ok(['json-stdio', 'ts-plugin', 'mcp-only', 'skills'].includes(a.hookParadigm));
      assert.ok(Object.keys(a.toolMap).length > 0);
      assert.ok(a.compliance >= 0 && a.compliance <= 100);
    }
  });

  it('claude-code and generic exist', () => {
    assert.equal(getAdapter('claude-code').vendor, 'Anthropic');
    assert.equal(getAdapter('generic').hookParadigm, 'mcp-only');
    assert.equal(getAdapter('nope'), undefined);
  });

  it('hookCount counts non-null hook events', () => {
    assert.equal(hookCount(getAdapter('claude-code')), 4);
    assert.equal(hookCount(getAdapter('generic')), 0);
    assert.equal(hookCount(getAdapter('grok')), 0);
  });
});

describe('platform tool mapping', () => {
  it('maps Claude names to canonical', () => {
    assert.equal(canonicalizeTool('Bash'), 'shell');
    assert.equal(canonicalizeTool('Read'), 'read');
    assert.equal(canonicalizeTool('WebFetch'), 'webfetch');
  });

  it('maps Grok / Cursor / Codex host names', () => {
    assert.equal(canonicalizeTool('run_terminal_command'), 'shell');
    assert.equal(canonicalizeTool('read_file'), 'read');
    assert.equal(canonicalizeTool('Shell'), 'shell');
    assert.equal(canonicalizeTool('spawn_agent'), 'agent');
  });

  it('canonical names round-trip to Claude routing names', () => {
    assert.equal(toClaudeToolName('run_terminal_command'), 'Bash');
    assert.equal(toClaudeToolName('shell'), 'Bash');
    assert.equal(toClaudeToolName('Bash'), 'Bash');
    assert.equal(toClaudeToolName('browse_page'), 'WebFetch');
    for (const [canonical, claude] of Object.entries(CANONICAL_TO_CLAUDE)) {
      assert.equal(toClaudeToolName(canonical), claude);
    }
  });

  it('unknown tool names pass through', () => {
    assert.equal(canonicalizeTool('TotallyUnknownTool'), 'TotallyUnknownTool');
  });

  it('normalizeHookPayload accepts Grok-shaped input', () => {
    const grok = getAdapter('grok');
    const n = normalizeHookPayload(
      {
        tool_name: 'run_terminal_command',
        command: 'git log',
        session_id: 'abc',
      },
      grok,
    );
    // Grok may nest or flatten; we also accept tool_input
    const n2 = normalizeHookPayload(
      {
        tool_name: 'run_terminal_command',
        tool_input: { command: 'git log' },
        session_id: 'abc',
      },
      grok,
    );
    assert.equal(n2.tool_name, 'Bash');
    assert.equal(n2.canonical, 'shell');
    assert.equal(n2.tool_input.command, 'git log');
    assert.equal(n2.session_id, 'abc');
    assert.equal(n.host_tool, 'run_terminal_command');
  });

  it('normalizeEventName maps host-specific event names', () => {
    assert.equal(normalizeEventName('BeforeTool'), 'preToolUse');
    assert.equal(normalizeEventName('tool.execute.before'), 'preToolUse');
    assert.equal(normalizeEventName('PreCompact'), 'preCompact');
    assert.equal(normalizeEventName('sessionStart'), 'sessionStart');
  });

  it('resolveDataDir prefers CONTEXT_MODE_DATA', () => {
    const prev = process.env.CONTEXT_MODE_DATA;
    process.env.CONTEXT_MODE_DATA = '/tmp/cm-data-test';
    try {
      assert.equal(resolveDataDir('/unused'), '/tmp/cm-data-test');
    } finally {
      if (prev === undefined) delete process.env.CONTEXT_MODE_DATA;
      else process.env.CONTEXT_MODE_DATA = prev;
    }
  });
});

describe('routing is host-agnostic', () => {
  it('Grok run_terminal_command git log hits git-log rule', () => {
    resetGuidanceThrottle();
    const decision = routePreToolUse('run_terminal_command', { command: 'git log' });
    assert.ok(decision, 'expected a routing decision');
    assert.equal(decision.action, 'modify');
  });

  it('Cursor Shell curl is blocked', () => {
    resetGuidanceThrottle();
    const decision = routePreToolUse('Shell', { command: 'curl https://example.com' });
    assert.ok(decision);
    assert.equal(decision.action, 'modify');
  });

  it('Claude Bash still works', () => {
    resetGuidanceThrottle();
    const decision = routePreToolUse('Bash', { command: 'curl https://example.com' });
    assert.ok(decision);
    assert.equal(decision.action, 'modify');
  });
});

describe('generator', () => {
  it('embeds the stamped package version', () => {
    const grok = getAdapter('grok');
    const files = generateAdapter(grok);
    const manifest = files.find((f) => f.path === 'adapter.json');
    assert.ok(manifest.contents.includes(`"version": "${pkgVersion}"`));
    const instruction = files.find((f) => f.path === grok.instructionFile || f.path.endsWith('AGENTS.md'));
    assert.ok(instruction.contents.includes(`Version: **${pkgVersion}**`));
  });

  it('emits hooks.json only for hook-capable adapters', () => {
    const grok = generateAdapter(getAdapter('grok'));
    const claude = generateAdapter(getAdapter('claude-code'));
    assert.equal(grok.some((f) => f.path === 'hooks.json'), false);
    assert.equal(claude.some((f) => f.path === 'hooks.json'), true);
  });

  it('instructionFile names the host tool, not Claude Bash, for Grok', () => {
    const text = instructionFile(getAdapter('grok'));
    assert.ok(text.includes('run_terminal_command'));
    assert.equal(text.includes('| `Bash` |'), false);
  });

  it('reverseToolMap returns first host name per canonical', () => {
    const map = reverseToolMap(getAdapter('grok'));
    assert.equal(map.shell, 'run_terminal_command');
    assert.equal(map.read, 'read_file');
  });
});
