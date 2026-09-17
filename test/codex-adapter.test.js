// test/codex-adapter.test.js
// Real Codex installer: in-place writes, host-shaped payloads, no --out dump.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getAdapter } from '../adapters/catalog.js';
import { upsertMcpServer, hasMcpServer, upsertTomlTable } from '../adapters/codex/toml-merge.js';
import {
  buildCodexHooksDoc, mergeHooksJson, hooksJsonHasDispatch,
} from '../adapters/codex/hooks-merge.js';
import { agentsBlock, mergeAgentsMarkdown, agentsHasBlock } from '../adapters/codex/agents-block.js';
import { installCodex } from '../adapters/codex/install.js';
import { diagnoseCodex } from '../adapters/codex/doctor.js';
import {
  canonicalizeTool, normalizeHookPayload, resolveDataDir,
} from '../hooks/core/platform.js';
import { mcpToolName, createToolNamer } from '../hooks/core/tool-naming.js';
import { routePreToolUse, resetGuidanceThrottle } from '../hooks/core/routing.js';
import { formatDecision } from '../hooks/core/formatters.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FIX = join(__dirname, 'fixtures', 'codex');

function loadFix(name) {
  return JSON.parse(readFileSync(join(FIX, name), 'utf8'));
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'cm-codex-'));
}

describe('codex catalog contract', () => {
  it('names official Codex files and Bash, not a guessed marketplace plugin', () => {
    const a = getAdapter('codex');
    assert.equal(a.instructionFile, 'AGENTS.md');
    assert.match(a.mcpConfigPath, /config\.toml/);
    assert.equal(a.hooks.preToolUse, 'PreToolUse');
    assert.equal(a.toolMap.Bash, 'shell');
    assert.equal(a.toolMap.exec_command, 'shell');
    assert.equal(a.toolMap.apply_patch, undefined);
    assert.match(a.install[0], /--adapter codex/);
    assert.equal(a.install.some((s) => s.includes('marketplace add')), false);
  });
});

describe('codex tool naming', () => {
  it('uses mcp__context-mode__ctx_* not the Cowork plugin prefix', () => {
    assert.equal(mcpToolName('ctx_execute', 'codex'), 'mcp__context-mode__ctx_execute');
    assert.equal(
      mcpToolName('ctx_execute', 'claude-code'),
      'mcp__plugin_context-mode_context-mode__ctx_execute',
    );
    const t = createToolNamer('codex');
    assert.equal(t('ctx_search'), 'mcp__context-mode__ctx_search');
  });
});

describe('codex payload normalization', () => {
  const adapter = getAdapter('codex');

  it('official PreToolUse Bash git log → Claude Bash + command', () => {
    const n = normalizeHookPayload(loadFix('pretooluse-bash-gitlog.json'), adapter);
    assert.equal(n.host_tool, 'Bash');
    assert.equal(n.canonical, 'shell');
    assert.equal(n.tool_name, 'Bash');
    assert.equal(n.tool_input.command, 'git log');
    assert.equal(n.session_id, 'codex-sess-gitlog');
  });

  it('exec_command + cmd alias maps to shell', () => {
    const n = normalizeHookPayload(loadFix('pretooluse-exec-command-gitlog.json'), adapter);
    assert.equal(n.canonical, 'shell');
    assert.equal(n.tool_input.command, 'git log');
  });

  it('apply_patch is not treated as Read', () => {
    const n = normalizeHookPayload(loadFix('pretooluse-apply-patch.json'), adapter);
    assert.equal(n.canonical, 'apply_patch');
    assert.equal(canonicalizeTool('apply_patch', adapter), 'apply_patch');
  });
});

describe('codex routing + formatter', () => {
  it('Bash git log produces Codex-shaped deny/rewrite JSON', () => {
    resetGuidanceThrottle();
    const adapter = getAdapter('codex');
    const n = normalizeHookPayload(loadFix('pretooluse-bash-gitlog.json'), adapter);
    const decision = routePreToolUse(n.tool_name, n.tool_input);
    assert.ok(decision);
    assert.equal(decision.action, 'modify');
    const json = formatDecision(decision);
    assert.equal(json.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(json.hookSpecificOutput.permissionDecision, 'allow');
    assert.ok(json.hookSpecificOutput.updatedInput.command.includes('echo'));
    assert.match(json.hookSpecificOutput.updatedInput.command, /ctx_execute/);
  });

  it('Bash curl is rewritten', () => {
    resetGuidanceThrottle();
    const n = normalizeHookPayload(loadFix('pretooluse-bash-curl.json'), getAdapter('codex'));
    const decision = routePreToolUse(n.tool_name, n.tool_input);
    assert.ok(decision);
    assert.equal(decision.action, 'modify');
  });

  it('apply_patch passes through', () => {
    resetGuidanceThrottle();
    const n = normalizeHookPayload(loadFix('pretooluse-apply-patch.json'), getAdapter('codex'));
    const decision = routePreToolUse(n.tool_name, n.tool_input);
    assert.equal(decision, null);
  });
});

describe('toml merge', () => {
  it('inserts mcp_servers.context-mode and leaves other servers', () => {
    const before = `# user config
model = "gpt-5"

[mcp_servers.other]
command = "npx"
args = ["-y", "something"]

[mcp_servers.other.env]
TOKEN = "abc"
`;
    const after = upsertMcpServer(before, {
      command: '/usr/bin/node',
      args: ['/tmp/start.js'],
      env: { CONTEXT_MODE_PLATFORM: 'codex', CONTEXT_MODE_DATA: '/tmp/data' },
    });
    assert.match(after, /model = "gpt-5"/);
    assert.match(after, /\[mcp_servers\.other\]/);
    assert.match(after, /TOKEN = "abc"/);
    assert.match(after, /\[mcp_servers\.context-mode\]/);
    assert.match(after, /command = "\/usr\/bin\/node"/);
    assert.match(after, /CONTEXT_MODE_PLATFORM = "codex"/);
    assert.equal(hasMcpServer(after), true);
  });

  it('replaces a stale context-mode table instead of duplicating', () => {
    const first = upsertMcpServer('', {
      command: 'old-node',
      args: ['old.js'],
      env: { CONTEXT_MODE_PLATFORM: 'codex' },
    });
    const second = upsertMcpServer(first, {
      command: 'new-node',
      args: ['new.js'],
      env: { CONTEXT_MODE_PLATFORM: 'codex' },
    });
    assert.equal((second.match(/\[mcp_servers\.context-mode\]/g) || []).length, 1);
    assert.match(second, /command = "new-node"/);
    assert.equal(second.includes('old-node'), false);
  });

  it('upsertTomlTable is generic', () => {
    const out = upsertTomlTable('a = 1\n', 'features', ['hooks = true']);
    assert.match(out, /a = 1/);
    assert.match(out, /\[features\]/);
    assert.match(out, /hooks = true/);
  });
});

describe('hooks.json merge', () => {
  it('writes official wrapped shape and keeps user hooks', () => {
    const existing = JSON.stringify({
      description: 'mine',
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'python3 ~/policy.py' }],
          },
        ],
      },
    });
    const ours = buildCodexHooksDoc({
      nodePath: '/usr/bin/node',
      dispatchPath: '/opt/cm/hooks/dispatch.js',
      dataDir: '/opt/cm',
    });
    const merged = JSON.parse(mergeHooksJson(existing, ours));
    assert.ok(merged.hooks);
    assert.ok(merged.hooks.PreToolUse.length >= 2);
    const cmds = merged.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
    assert.ok(cmds.some((c) => c.includes('policy.py')));
    assert.ok(cmds.some((c) => c.includes('hooks/dispatch.js')));
    assert.equal(hooksJsonHasDispatch(JSON.stringify(merged)), true);
  });

  it('replaces previous context-mode groups on reinstall', () => {
    const ours1 = buildCodexHooksDoc({
      nodePath: '/usr/bin/node',
      dispatchPath: '/opt/old/hooks/dispatch.js',
      dataDir: '/opt/old',
    });
    const first = mergeHooksJson('', ours1);
    const ours2 = buildCodexHooksDoc({
      nodePath: '/usr/bin/node',
      dispatchPath: '/opt/new/hooks/dispatch.js',
      dataDir: '/opt/new',
    });
    const second = mergeHooksJson(first, ours2);
    assert.equal(second.includes('/opt/old/'), false);
    assert.equal((second.match(/hooks\/dispatch\.js/g) || []).length > 0, true);
  });
});

describe('AGENTS.md sentinel', () => {
  it('appends to existing user content and replaces on upgrade', () => {
    const block1 = agentsBlock({ version: '1.8.0', mcpTool: (n) => `mcp__context-mode__${n}` });
    const once = mergeAgentsMarkdown('# My rules\n\nAlways lint.\n', block1);
    assert.match(once, /# My rules/);
    assert.equal(agentsHasBlock(once), true);
    assert.match(once, /mcp__context-mode__ctx_execute/);
    const block2 = agentsBlock({ version: '1.8.1', mcpTool: (n) => `mcp__context-mode__${n}` });
    const twice = mergeAgentsMarkdown(once, block2);
    assert.equal((twice.match(/context-mode:start/g) || []).length, 1);
    assert.match(twice, /1\.8\.1/);
    assert.match(twice, /Always lint/);
  });
});

describe('codex installer writes in place', () => {
  it('does not use --out; writes hooks, toml, AGENTS.md, plugin copy', async () => {
    const root = tmp();
    const dataDir = join(root, 'data');
    const pluginDir = join(dataDir, 'plugin');
    const codexHome = join(root, 'codex');
    const projectDir = join(root, 'proj');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(projectDir, 'AGENTS.md'), '# already here\n', 'utf8');
    writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-5"\n', 'utf8');

    const result = await installCodex({
      sourceRoot: ROOT,
      dataDir,
      pluginDir,
      codexHome,
      projectDir,
      skipDeps: true,
      skipProbe: true,
      globalAgents: true,
    });
    assert.equal(result.ok, true);
    assert.equal(existsSync(join(pluginDir, 'hooks', 'dispatch.js')), true);
    assert.equal(existsSync(join(pluginDir, 'start.js')), true);
    const hooks = readFileSync(join(codexHome, 'hooks.json'), 'utf8');
    assert.equal(hooksJsonHasDispatch(hooks), true);
    assert.match(hooks, /"PreToolUse"/);
    const parsed = JSON.parse(hooks);
    assert.ok(parsed.hooks.PreToolUse);
    assert.equal(parsed.hooks.PreToolUse[0].matcher, 'Bash');
    const toml = readFileSync(join(codexHome, 'config.toml'), 'utf8');
    assert.match(toml, /model = "gpt-5"/);
    assert.equal(hasMcpServer(toml), true);
    const agents = readFileSync(join(projectDir, 'AGENTS.md'), 'utf8');
    assert.match(agents, /# already here/);
    assert.equal(agentsHasBlock(agents), true);
    const report = diagnoseCodex({ home: root, dataDir, projectDir });
    // diagnoseCodex uses ~/.codex via CODEX_HOME or homedir — pass via env
    assert.ok(result.hooksOk);
    assert.ok(result.mcpOk);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('resolveDataDir does not steal Claude tree on Codex', () => {
  it('codex platform uses ~/.context-mode even if ~/.claude/plugins exists', () => {
    const prevP = process.env.CONTEXT_MODE_PLATFORM;
    const prevD = process.env.CONTEXT_MODE_DATA;
    const prevC = process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.CONTEXT_MODE_DATA;
    delete process.env.CLAUDE_PLUGIN_DATA;
    process.env.CONTEXT_MODE_PLATFORM = 'codex';
    try {
      const dir = resolveDataDir('/unused');
      assert.match(dir, /\.context-mode$/);
      assert.equal(dir.includes(`${join('.claude', 'plugins')}`), false);
    } finally {
      if (prevP === undefined) delete process.env.CONTEXT_MODE_PLATFORM;
      else process.env.CONTEXT_MODE_PLATFORM = prevP;
      if (prevD === undefined) delete process.env.CONTEXT_MODE_DATA;
      else process.env.CONTEXT_MODE_DATA = prevD;
      if (prevC === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = prevC;
    }
  });
});

describe('dispatch.js Codex golden payloads', () => {
  async function runDispatch(fixtureName) {
    const child = spawn(
      process.execPath,
      [join(ROOT, 'hooks', 'dispatch.js'), 'codex', 'preToolUse'],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CONTEXT_MODE_PLATFORM: 'codex' } },
    );
    const raw = readFileSync(join(FIX, fixtureName), 'utf8');
    child.stdin.write(raw);
    child.stdin.end();
    let out = '';
    let err = '';
    for await (const c of child.stdout) out += c;
    for await (const c of child.stderr) err += c;
    const code = await new Promise((resolve) => child.on('close', resolve));
    return { code, out, err };
  }

  it('git log fixture exits 0 and prints hookSpecificOutput', async () => {
    resetGuidanceThrottle();
    const { code, out } = await runDispatch('pretooluse-bash-gitlog.json');
    assert.equal(code, 0);
    const json = JSON.parse(out.trim().split('\n').pop());
    assert.equal(json.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(json.hookSpecificOutput.permissionDecision, 'allow');
    assert.ok(json.hookSpecificOutput.updatedInput.command);
  });

  it('apply_patch fixture prints nothing (passthrough)', async () => {
    resetGuidanceThrottle();
    const { code, out } = await runDispatch('pretooluse-apply-patch.json');
    assert.equal(code, 0);
    assert.equal(out.trim(), '');
  });
});
