#!/usr/bin/env node
/**
 * Codex CLI installer — writes host files in place.
 *
 *   node install.js --adapter codex
 *   node adapters/codex/install.js
 *
 * Not a file dump. Copies the plugin to ~/.context-mode/plugin, installs
 * better-sqlite3, merges ~/.codex/hooks.json, merges MCP into
 * ~/.codex/config.toml, and upserts a sentinel block in AGENTS.md.
 *
 * Codex contract (official, not guessed from a TypeScript port):
 *   hooks:  ~/.codex/hooks.json  — events under a top-level "hooks" key
 *   MCP:    ~/.codex/config.toml — [mcp_servers.context-mode]
 *   instructions: AGENTS.md (project, then ~/.codex/AGENTS.md)
 *   PreToolUse tool_name: "Bash" (exec_command matches as Bash)
 *   stdin:  { session_id, tool_name, tool_input, hook_event_name, ... }
 *   stdout: { hookSpecificOutput: { hookEventName, permissionDecision, updatedInput } }
 *
 * Does NOT claim production until the repo owner smoke-tests intercept
 * on their machine.
 */

import { execSync, spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, copyFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { npmExecOpts } from '../../hooks/core/npm-exec.js';
import { upsertMcpServer, hasMcpServer } from './toml-merge.js';
import { buildCodexHooksDoc, mergeHooksJson, hooksJsonHasDispatch } from './hooks-merge.js';
import { agentsBlock, mergeAgentsMarkdown } from './agents-block.js';
import { mcpToolName } from '../../hooks/core/tool-naming.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');

function pkgVersion(root) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
}

function log(msg) { console.log(`[context-mode] ${msg}`); }
function err(msg) { console.error(`[context-mode] ERROR: ${msg}`); }

function resolveNodePath() {
  const ep = process.execPath;
  if (ep && (ep.endsWith('/node') || ep.endsWith('\\node.exe') || ep.endsWith('\\node'))) {
    return ep;
  }
  return 'node';
}

function copyPlugin(source, dest) {
  mkdirSync(dest, { recursive: true });
  const skip = new Set(['node_modules', '.data', '.git', 'install.js']);
  cpSync(source, dest, {
    recursive: true,
    filter: (src) => !skip.has(src.split(/[/\\]/).pop()),
  });
  for (const rel of ['.mcp.json', join('.claude-plugin', 'plugin.json')]) {
    const from = join(source, rel);
    const to = join(dest, rel);
    if (existsSync(from) && !existsSync(to)) {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
  }
}

function installDeps(dataDir, pluginDir) {
  mkdirSync(dataDir, { recursive: true });
  copyFileSync(join(pluginDir, 'package.json'), join(dataDir, 'package.json'));
  try {
    execSync('npm install --omit=dev', npmExecOpts({
      cwd: dataDir,
      stdio: 'pipe',
      timeout: 120_000,
    }));
    return dataDir;
  } catch (e) {
    log('  Data dir install failed, installing in plugin copy...');
    execSync('npm install --omit=dev', npmExecOpts({
      cwd: pluginDir,
      stdio: 'pipe',
      timeout: 120_000,
    }));
    return pluginDir;
  }
}

function verifySqlite(searchPaths) {
  for (const searchPath of searchPaths) {
    try {
      const req = createRequire(join(searchPath, '.package.json'));
      const Database = req('better-sqlite3');
      const db = new Database(':memory:');
      db.exec("CREATE VIRTUAL TABLE _test USING fts5(content, tokenize='porter unicode61')");
      db.exec('DROP TABLE _test');
      db.close();
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function probeServer(pluginDir, dataDir) {
  const server = spawn(process.execPath, [join(pluginDir, 'start.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CONTEXT_MODE_PLATFORM: 'codex',
      CONTEXT_MODE_DATA: dataDir,
      CONTEXT_MODE_PROJECT_DIR: process.cwd(),
    },
  });
  const initMsg = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'codex-probe', version: '1.0.0' },
    },
  }) + '\n';
  const initializedMsg = JSON.stringify({
    jsonrpc: '2.0', method: 'notifications/initialized',
  }) + '\n';
  const listMsg = JSON.stringify({
    jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
  }) + '\n';

  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk.toString(); });
  server.stdin.write(initMsg);
  await new Promise((r) => setTimeout(r, 4000));
  server.stdin.write(initializedMsg);
  await new Promise((r) => setTimeout(r, 500));
  server.stdin.write(listMsg);
  await new Promise((r) => setTimeout(r, 4000));
  server.kill();
  const toolMatches = output.match(/"name"\s*:\s*"ctx_/g);
  return toolMatches ? toolMatches.length : 0;
}

function writeFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

/**
 * @param {object} [opts]
 * @param {string} [opts.sourceRoot]
 * @param {string} [opts.dataDir]
 * @param {string} [opts.pluginDir]
 * @param {string} [opts.codexHome]
 * @param {string} [opts.projectDir]
 * @param {boolean} [opts.skipDeps]
 * @param {boolean} [opts.skipProbe]
 * @param {boolean} [opts.globalAgents]
 */
export async function installCodex(opts = {}) {
  const sourceRoot = opts.sourceRoot || REPO_ROOT;
  const version = pkgVersion(sourceRoot);
  const home = opts.home || process.env.HOME || process.env.USERPROFILE || homedir();
  const dataDir = opts.dataDir || process.env.CONTEXT_MODE_DATA || join(home, '.context-mode');
  const pluginDir = opts.pluginDir || join(dataDir, 'plugin');
  const codexHome = opts.codexHome || process.env.CODEX_HOME || join(home, '.codex');
  const projectDir = opts.projectDir || process.cwd();
  const skipDeps = Boolean(opts.skipDeps);
  const skipProbe = Boolean(opts.skipProbe);
  const globalAgents = opts.globalAgents !== false;

  log(`Installing context-mode v${version} for Codex CLI`);
  log(`Platform: ${process.platform} (${process.arch})`);
  log(`Node.js: ${process.version}`);
  log(`Codex home: ${codexHome}`);
  log(`Data dir: ${dataDir}`);

  log('Step 1/6: Copying plugin...');
  copyPlugin(sourceRoot, pluginDir);
  log(`  Copied to ${pluginDir}`);

  let depsRoot = dataDir;
  if (skipDeps) {
    log('Step 2/6: Skipping npm install (skipDeps)');
  } else {
    log('Step 2/6: Installing dependencies...');
    depsRoot = installDeps(dataDir, pluginDir);
    log(`  Dependencies installed to ${depsRoot}`);
    const ok = verifySqlite([
      join(dataDir, 'node_modules'),
      join(pluginDir, 'node_modules'),
    ]);
    if (!ok) {
      err('better-sqlite3 verification failed');
      err(`Try: cd ${dataDir} && npm rebuild better-sqlite3`);
      process.exitCode = 1;
      return { ok: false, reason: 'sqlite' };
    }
    log('  better-sqlite3 + FTS5: OK');
  }

  const nodePath = resolveNodePath();
  const dispatchPath = join(pluginDir, 'hooks', 'dispatch.js');
  const startPath = join(pluginDir, 'start.js');

  log('Step 3/6: Merging ~/.codex/hooks.json...');
  mkdirSync(codexHome, { recursive: true });
  const hooksPath = join(codexHome, 'hooks.json');
  const ours = buildCodexHooksDoc({ nodePath, dispatchPath, dataDir });
  const prevHooks = existsSync(hooksPath) ? readFileSync(hooksPath, 'utf8') : '';
  writeFile(hooksPath, mergeHooksJson(prevHooks, ours));
  log(`  Wrote ${hooksPath}`);

  log('Step 4/6: Merging MCP server into config.toml...');
  const tomlPath = join(codexHome, 'config.toml');
  const prevToml = existsSync(tomlPath) ? readFileSync(tomlPath, 'utf8') : '';
  const nextToml = upsertMcpServer(prevToml, {
    command: nodePath,
    args: [startPath],
    env: {
      CONTEXT_MODE_PLATFORM: 'codex',
      CONTEXT_MODE_DATA: dataDir,
      NODE_PATH: join(depsRoot, 'node_modules'),
    },
  });
  writeFile(tomlPath, nextToml);
  log(`  Wrote ${tomlPath}`);

  log('Step 5/6: Upserting AGENTS.md sentinel block...');
  const block = agentsBlock({
    version,
    mcpTool: (name) => mcpToolName(name, 'codex'),
  });
  const projectAgents = join(projectDir, 'AGENTS.md');
  const prevProject = existsSync(projectAgents) ? readFileSync(projectAgents, 'utf8') : '';
  writeFile(projectAgents, mergeAgentsMarkdown(prevProject, block));
  log(`  Wrote ${projectAgents}`);
  if (globalAgents) {
    const globalPath = join(codexHome, 'AGENTS.md');
    const prevGlobal = existsSync(globalPath) ? readFileSync(globalPath, 'utf8') : '';
    writeFile(globalPath, mergeAgentsMarkdown(prevGlobal, block));
    log(`  Wrote ${globalPath}`);
  }

  let toolCount = 0;
  if (skipProbe) {
    log('Step 6/6: Skipping MCP probe (skipProbe)');
  } else {
    log('Step 6/6: Server probe...');
    try {
      toolCount = await probeServer(pluginDir, dataDir);
      if (toolCount >= 9) log(`  ${toolCount}/9 tools responding`);
      else log(`  WARNING: Only ${toolCount}/9 tools found in probe response`);
    } catch (e) {
      log(`  WARNING: Server probe failed: ${e.message}`);
    }
  }

  const result = {
    ok: true,
    version,
    dataDir,
    pluginDir,
    codexHome,
    hooksPath,
    tomlPath,
    projectAgents,
    toolCount,
    hooksOk: hooksJsonHasDispatch(readFileSync(hooksPath, 'utf8')),
    mcpOk: hasMcpServer(readFileSync(tomlPath, 'utf8')),
  };

  console.log('');
  console.log('='.repeat(50));
  console.log(`  context-mode v${version} installed for Codex CLI`);
  console.log('='.repeat(50));
  console.log('');
  console.log('Wrote in place (not --out):');
  console.log(`  ${hooksPath}`);
  console.log(`  ${tomlPath}`);
  console.log(`  ${projectAgents}`);
  console.log(`  ${pluginDir}`);
  console.log('');
  console.log('This is NOT production until you confirm intercept.');
  console.log('Claude Code / Cowork remains the supported production install.');
  console.log('');
  console.log('Smoke test (you run this — Grok cannot see your Codex):');
  console.log('  1. Restart Codex (new TUI session).');
  console.log('  2. Ask: "run ctx doctor"');
  console.log('  3. Ask Codex to run `git log` in a repo (no -n / --oneline).');
  console.log('     Expect PreToolUse to rewrite the call, not dump the full log.');
  console.log('  4. Ask Codex to `curl https://example.com` — should be redirected.');
  console.log('');
  console.log('If hooks do not fire: [features] hooks = true in config.toml');
  console.log('(hooks are on by default; that key only turns them off).');
  console.log('');
  console.log(`MCP tools: ${mcpToolName('ctx_execute', 'codex')}, ${mcpToolName('ctx_search', 'codex')}, ${mcpToolName('ctx_doctor', 'codex')}`);
  console.log('');
  return result;
}

const isMain = process.argv[1] && /codex[/\\]install\.js$/.test(process.argv[1]);
if (isMain) {
  installCodex().catch((e) => {
    err(e.message);
    process.exit(1);
  });
}
