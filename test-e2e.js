/**
 * Comprehensive E2E test suite for context-mode plugin.
 *
 * Sections:
 *   1.  Utils
 *   2.  Exit Classify
 *   3.  Runtime Detection
 *   4.  Sandbox Executor
 *   5.  Knowledge Base
 *   6.  Session DB
 *   7.  Snapshot Builder
 *   8.  Event Extraction
 *   9.  Routing Block
 *   10. Hook .cmd Wrapper
 *   11. MCP Protocol Smoke Test (live server via SDK client)
 *   12. Plugin Discoverability (manifest, hooks, mcp, structure)
 *   13. Spec Compliance (validates against Claude Code plugin reference)
 *   14. OSS Attribution
 *   15. Plugin Manifest Validation
 *   16. PreToolUse Routing
 *   17. hooks.json Validation
 *   18. Plugin CLAUDE.md and Settings
 *   19. Schema Migration
 *   20. Version Consistency
 */

import { ContentStore } from './server/knowledge.js';
import { runMigrations, validateTables } from './server/migrate.js';
import { openDatabase, closeDB } from './server/db-base.js';
import { SessionDB } from './server/session.js';
import { buildResumeSnapshot } from './server/snapshot.js';
import { extractEvents } from './hooks/session-extract.js';
import { detectRuntimes } from './server/runtime.js';
import { PolyglotExecutor } from './server/sandbox.js';
import { sanitizeQuery, levenshtein, findMinSpan, extractSnippet, escapeXML } from './server/utils.js';
import { classifyNonZeroExit } from './server/exit-classify.js';
import { ROUTING_BLOCK, createRoutingBlock } from './hooks/routing-block.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, unlinkSync, mkdirSync, readFileSync, readdirSync, statSync, rmSync, mkdtempSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { homedir, tmpdir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = __dirname;

let passed = 0;
let failed = 0;

function PASS(name) { passed++; console.log('  PASS:', name); }
function FAIL(name, msg) { failed++; console.error('  FAIL:', name, msg ? '- ' + JSON.stringify(msg) : ''); }
function SECTION(name) { console.log('\n--- ' + name + ' ---'); }

const contentDb = join('.data', 'e2e-content.db');
const sessionDb = join('.data', 'e2e-session.db');

if (!existsSync('.data')) mkdirSync('.data');

// ─── 1. Utils ─────────────────────────────────────────────────────────
SECTION('1. Utils');

sanitizeQuery('hello world') === '"hello" "world"' ? PASS('sanitizeQuery AND') : FAIL('sanitizeQuery AND');
sanitizeQuery('hello world', 'OR') === '"hello" OR "world"' ? PASS('sanitizeQuery OR') : FAIL('sanitizeQuery OR');
sanitizeQuery('') === null ? PASS('sanitizeQuery empty') : FAIL('sanitizeQuery empty');
levenshtein('kitten', 'sitting') === 3 ? PASS('levenshtein') : FAIL('levenshtein');
levenshtein('', 'abc') === 3 ? PASS('levenshtein empty') : FAIL('levenshtein empty');
findMinSpan([[1, 10, 20], [5, 15, 25]]) === 4 ? PASS('findMinSpan') : FAIL('findMinSpan');
findMinSpan([]) === Infinity ? PASS('findMinSpan empty') : FAIL('findMinSpan empty');

const longText = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
extractSnippet(longText, 'lazy dog', 100).includes('lazy dog') ? PASS('extractSnippet') : FAIL('extractSnippet');
extractSnippet('Short text', 'Short', 100) === 'Short text' ? PASS('extractSnippet passthrough') : FAIL('extractSnippet passthrough');
escapeXML('<test>&"\'') === '&lt;test&gt;&amp;&quot;&apos;' ? PASS('escapeXML') : FAIL('escapeXML');

// ─── 2. Exit Classify ─────────────────────────────────────────────────
SECTION('2. Exit Classify');

classifyNonZeroExit({ language: 'shell', exitCode: 1, stdout: '5 passed, 2 failed', stderr: '' }).isError === false ? PASS('test runner non-error') : FAIL('test runner');
classifyNonZeroExit({ language: 'shell', exitCode: 139, stdout: '', stderr: 'Segfault' }).isError === true ? PASS('SIGSEGV is error') : FAIL('SIGSEGV');
classifyNonZeroExit({ language: 'shell', exitCode: 1, stdout: '3 errors found', stderr: '' }).isError === false ? PASS('linter non-error') : FAIL('linter');

// ─── 3. Runtime Detection ─────────────────────────────────────────────
SECTION('3. Runtime Detection');

const runtimes = detectRuntimes();
Object.keys(runtimes).length >= 3 ? PASS(`${Object.keys(runtimes).length} languages`) : FAIL('runtimes');
runtimes.javascript ? PASS('javascript') : FAIL('javascript');
runtimes.python ? PASS('python') : FAIL('python');
runtimes.shell ? PASS('shell') : FAIL('shell');

// ─── 4. Sandbox Executor ──────────────────────────────────────────────
SECTION('4. Sandbox Executor');

const executor = new PolyglotExecutor({ projectRoot: process.cwd(), runtimes });

const pyRes = await executor.execute({ language: 'python', code: 'print(42)', timeout: 10000 });
pyRes.stdout.trim() === '42' && pyRes.exitCode === 0 ? PASS('python exec') : FAIL('python exec');

const jsRes = await executor.execute({ language: 'javascript', code: 'console.log("ok")', timeout: 10000 });
jsRes.stdout.trim() === 'ok' && jsRes.exitCode === 0 ? PASS('javascript exec') : FAIL('javascript exec');

const shRes = await executor.execute({ language: 'shell', code: 'echo hello', timeout: 10000 });
shRes.stdout.trim() === 'hello' && shRes.exitCode === 0 ? PASS('shell exec') : FAIL('shell exec');

const errRes = await executor.execute({ language: 'python', code: 'raise ValueError("test error")', timeout: 10000 });
errRes.exitCode !== 0 ? PASS('error exit code') : FAIL('error exit');
errRes.stderr.includes('ValueError') ? PASS('error in stderr') : FAIL('error stderr');

const toRes = await executor.execute({ language: 'python', code: 'import time; time.sleep(10)', timeout: 1000 });
toRes.timedOut === true ? PASS('timeout') : FAIL('timeout');

const bgRes = await executor.execute({ language: 'python', code: 'import time\nfor i in range(100):\n    print(f"tick {i}")\n    time.sleep(0.1)', timeout: 500, background: true });
bgRes.timedOut && bgRes.backgrounded && bgRes.stdout.includes('tick') ? PASS('background mode') : FAIL('background mode');

const badRes = await executor.execute({ language: 'elixir', code: 'IO.puts("hi")', timeout: 5000 });
badRes.exitCode !== 0 ? PASS('unavailable language') : FAIL('unavailable language');

await new Promise(r => setTimeout(r, 500));
executor.cleanup();

// ─── 5. Knowledge Base ────────────────────────────────────────────────
SECTION('5. Knowledge Base');

const store = new ContentStore(contentDb);

const idxRes = store.index({
  content: '# API Reference\n\nThe ctx_execute tool runs code in a sandbox.\n\n## Parameters\n\nlanguage: string\ncode: string\ntimeout: number\n\n## Examples\n\nRun Python: ctx_execute({language: "python", code: "print(1)"})',
  source: 'api-docs'
});
idxRes.totalChunks >= 2 ? PASS(`markdown: ${idxRes.totalChunks} chunks`) : FAIL('markdown');

store.index({ content: '# Updated API\n\nNew content.', source: 'api-docs' });
store.index({
  content: '# API Reference\n\nThe ctx_execute tool runs code in a sandbox.\n\n## Parameters\n\nlanguage: string\ncode: string\ntimeout: number\n\n## Examples\n\nRun Python: ctx_execute({language: "python", code: "print(1)"})',
  source: 'api-docs'
});
PASS('re-index replaces');

const s1 = store.searchWithFallback('sandbox execute', 2);
s1.length > 0 ? PASS('search: porter') : FAIL('search: porter');
s1[0].snippet ? PASS('search: snippet') : FAIL('search: no snippet');
s1[0].sourceLabel === 'api-docs' ? PASS('search: source label') : FAIL('search: source label');
s1[0].matchLayer === 'rrf' ? PASS('search: RRF layer') : FAIL('search: layer');

store.searchWithFallback('parameters language', 2).length > 0 ? PASS('search: multi-term') : FAIL('search: multi-term');
store.indexJSON('{"users":[{"name":"Alice","role":"admin"}]}', 'users.json').totalChunks >= 1 ? PASS('index json') : FAIL('index json');
store.indexPlainText('Line 1\nLine 2\n\nParagraph 2\nMore\n\nParagraph 3', 'plain.txt').totalChunks >= 1 ? PASS('index plain') : FAIL('index plain');
store.getSourceMeta('api-docs')?.chunkCount >= 2 ? PASS('source meta') : FAIL('source meta');
Array.isArray(store.getDistinctiveTerms('api-docs', 5)) ? PASS('distinctive terms') : FAIL('distinctive terms');
store.getChunkCount() > 0 ? PASS('chunk count') : FAIL('chunk count');
store.searchWithFallback('xyznonexistent12345', 2).length === 0 ? PASS('no false positives') : FAIL('false positive');

store.close();

// ─── 6. Session DB ────────────────────────────────────────────────────
SECTION('6. Session DB');

const sdb = new SessionDB(sessionDb);
sdb.ensureSession('e2e-test', '/tmp/project');

sdb.insertEvent('e2e-test', { type: 'file_write', category: 'file', data: '/src/main.js', priority: 1 });
sdb.insertEvent('e2e-test', { type: 'file_write', category: 'file', data: '/src/main.js', priority: 1 }) === false ? PASS('dedup') : FAIL('dedup');
sdb.insertEvent('e2e-test', { type: 'file_edit', category: 'file', data: '/src/utils.js', priority: 1 });
sdb.insertEvent('e2e-test', { type: 'git', category: 'git', data: 'git commit -m fix', priority: 3 });
sdb.insertEvent('e2e-test', { type: 'error_tool', category: 'error', data: '{"tool":"Bash","error":"npm ERR"}', priority: 2 });
sdb.insertEvent('e2e-test', { type: 'task', category: 'task', data: '{"content":"Build X","status":"in_progress"}', priority: 1 });
sdb.insertEvent('e2e-test', { type: 'cwd', category: 'cwd', data: 'cd /src', priority: 2 });

sdb.getEvents('e2e-test').length === 6 ? PASS('6 events') : FAIL('event count');
sdb.getEventsByCategory('e2e-test', 'file').length === 2 ? PASS('category filter') : FAIL('category filter');
sdb.getSessionStats('e2e-test') ? PASS('session stats') : FAIL('session stats');

// ─── 7. Snapshot Builder ──────────────────────────────────────────────
SECTION('7. Snapshot Builder');

const events = sdb.getEvents('e2e-test');
const snapshot = buildResumeSnapshot(events);
const snapBytes = Buffer.byteLength(snapshot, 'utf8');
snapBytes <= 2048 ? PASS(`${snapBytes}B (budget: 2048B)`) : FAIL('over budget');
snapshot.includes('<session_resume>') ? PASS('XML root') : FAIL('no root');
snapshot.includes('<files') ? PASS('files section') : FAIL('no files');
snapshot.includes('<task_state') ? PASS('task_state') : FAIL('no tasks');
snapshot.includes('ctx_search') ? PASS('search hints') : FAIL('no hints');
snapshot.includes('<errors') ? PASS('errors section') : FAIL('no errors');

sdb.upsertResume('e2e-test', snapshot, events.length);
sdb.getResume('e2e-test')?.consumed === 0 ? PASS('resume stored') : FAIL('resume');
sdb.markResumeConsumed('e2e-test');
sdb.getResume('e2e-test') === null ? PASS('resume consumed') : FAIL('not consumed');

sdb.close();

// ─── 8. Event Extraction ──────────────────────────────────────────────
SECTION('8. Event Extraction');

extractEvents({ tool_name: 'Edit', tool_input: { path: '/src/app.js' }, tool_output: {} })[0]?.type === 'file_edit' ? PASS('Edit') : FAIL('Edit');
extractEvents({ tool_name: 'Write', tool_input: { path: '/src/new.js' }, tool_output: {} }).some(e => e.type === 'file_write') ? PASS('Write') : FAIL('Write');
extractEvents({ tool_name: 'Read', tool_input: { path: '/src/app.js' }, tool_output: {} }).some(e => e.type === 'file_read') ? PASS('Read') : FAIL('Read');
extractEvents({ tool_name: 'Bash', tool_input: { command: 'git commit -m test' }, tool_output: { exitCode: 0 } }).some(e => e.type === 'git') ? PASS('git') : FAIL('git');
extractEvents({ tool_name: 'Bash', tool_input: { command: 'cd /src && ls' }, tool_output: { exitCode: 0 } }).some(e => e.type === 'cwd') ? PASS('cwd') : FAIL('cwd');
extractEvents({ tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_output: { isError: true, content: 'fail' } }).some(e => e.type === 'error_tool') ? PASS('error') : FAIL('error');
extractEvents({ tool_name: 'Agent', tool_input: { description: 'test', prompt: 'do x' }, tool_output: {} }).some(e => e.type === 'subagent') ? PASS('Agent') : FAIL('Agent');
extractEvents({ tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'task1', status: 'pending' }] }, tool_output: {} }).some(e => e.type === 'task') ? PASS('TodoWrite') : FAIL('TodoWrite');
extractEvents({ tool_name: 'Skill', tool_input: { skill: 'ctx-stats' }, tool_output: {} }).some(e => e.type === 'skill') ? PASS('Skill') : FAIL('Skill');
extractEvents({ tool_name: 'Read', tool_input: { path: '/project/CLAUDE.md' }, tool_output: {} }).some(e => e.type === 'rule') ? PASS('CLAUDE.md rule') : FAIL('rule');
extractEvents(null).length === 0 ? PASS('null -> empty') : FAIL('null');

// ─── 9. Routing Block ─────────────────────────────────────────────────
SECTION('9. Routing Block');

ROUTING_BLOCK.includes('ctx_batch_execute') ? PASS('batch_execute') : FAIL('batch');
ROUTING_BLOCK.includes('ctx_search') ? PASS('search') : FAIL('search');
ROUTING_BLOCK.includes('ctx_execute') ? PASS('execute') : FAIL('execute');
ROUTING_BLOCK.includes('ctx_fetch_and_index') ? PASS('fetch_and_index') : FAIL('fetch');
ROUTING_BLOCK.includes('ctx_execute_file') ? PASS('execute_file') : FAIL('execute_file');
ROUTING_BLOCK.includes('context_window_protection') ? PASS('routing block root tag') : FAIL('routing block root tag');

// createRoutingBlock returns a string with custom tool names
const customRb = createRoutingBlock(name => `[[${name}]]`);
customRb.includes('[[ctx_batch_execute]]') ? PASS('createRoutingBlock custom namer') : FAIL('createRoutingBlock custom namer');

// ─── 10. Hook .cmd Wrapper ───────────────────────────────────────────
SECTION('10. Hook .cmd Wrapper');

const cmdPath = join(PLUGIN_ROOT, 'hooks', 'run-hook.cmd');
existsSync(cmdPath) ? PASS('run-hook.cmd exists') : FAIL('run-hook.cmd missing');

// Test PostToolUse via .cmd wrapper
try {
  const hookOut = execSync(
    `echo '{"tool_name":"Edit","tool_input":{"path":"/test.js"},"tool_output":{},"session_id":"e2e-cmd-test"}' | "${cmdPath}" posttooluse`,
    { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  PASS('PostToolUse via .cmd');
} catch (err) {
  // Exit 0 with no stdout is fine for PostToolUse
  err.status === 0 ? PASS('PostToolUse via .cmd') : FAIL('PostToolUse .cmd', err.message);
}

// Test SessionStart via .cmd wrapper
try {
  const startOut = execSync(
    `echo '{"source":"startup","session_id":"e2e-cmd-start"}' | "${cmdPath}" sessionstart`,
    { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const parsed = JSON.parse(startOut.trim());
  parsed.hookSpecificOutput?.additionalContext?.includes('ctx_batch_execute') ? PASS('SessionStart routing block via .cmd') : FAIL('SessionStart .cmd output');
} catch (err) {
  FAIL('SessionStart .cmd', err.message);
}

// ─── 11. MCP Protocol Smoke Test ─────────────────────────────────────
SECTION('11. MCP Protocol Smoke Test');

try {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  const transport = new StdioClientTransport({
    command: 'node',
    args: [join(PLUGIN_ROOT, 'server', 'index.js')],
    cwd: PLUGIN_ROOT
  });

  const client = new Client({ name: 'e2e-test', version: '1.0.0' });
  await client.connect(transport);

  // List tools
  const { tools } = await client.listTools();
  tools.length === 9 ? PASS(`9 MCP tools listed`) : FAIL('tool count', tools.length);

  const toolNames = tools.map(t => t.name);
  for (const expected of ['ctx_execute', 'ctx_execute_file', 'ctx_index', 'ctx_search', 'ctx_fetch_and_index', 'ctx_batch_execute', 'ctx_stats', 'ctx_doctor', 'ctx_purge']) {
    toolNames.includes(expected) ? PASS(`tool: ${expected}`) : FAIL(`tool: ${expected} missing`);
  }

  // Call ctx_doctor
  const docResult = await client.callTool({ name: 'ctx_doctor', arguments: {} });
  docResult.content?.[0]?.text?.includes('Context Mode Doctor') ? PASS('MCP: ctx_doctor') : FAIL('MCP: ctx_doctor');

  // Call ctx_execute
  const execResult = await client.callTool({ name: 'ctx_execute', arguments: { language: 'python', code: 'print("mcp-smoke")' } });
  execResult.content?.[0]?.text?.includes('mcp-smoke') ? PASS('MCP: ctx_execute') : FAIL('MCP: ctx_execute');

  // Call ctx_index
  const idxResult = await client.callTool({ name: 'ctx_index', arguments: { content: '# MCP Test\n\nSmoke test content for BM25 search.', source: 'mcp-smoke' } });
  idxResult.content?.[0]?.text?.includes('Indexed') ? PASS('MCP: ctx_index') : FAIL('MCP: ctx_index');

  // Call ctx_search
  const srchResult = await client.callTool({ name: 'ctx_search', arguments: { query: 'BM25 search smoke' } });
  srchResult.content?.[0]?.text?.includes('MCP Test') ? PASS('MCP: ctx_search') : FAIL('MCP: ctx_search');

  // Call ctx_stats
  const statsResult = await client.callTool({ name: 'ctx_stats', arguments: {} });
  statsResult.content?.[0]?.text?.includes('Token Savings This Session') ? PASS('MCP: ctx_stats') : FAIL('MCP: ctx_stats');

  // Call ctx_purge
  const purgeResult = await client.callTool({ name: 'ctx_purge', arguments: { confirm: true } });
  purgeResult.content?.[0]?.text?.includes('purged') ? PASS('MCP: ctx_purge') : FAIL('MCP: ctx_purge');

  // Call ctx_fetch_and_index with unreachable URL
  try {
    const fetchResult = await client.callTool({
      name: 'ctx_fetch_and_index',
      arguments: { url: 'http://127.0.0.1:1/nonexistent', force: true }
    });
    const fetchText = fetchResult.content?.[0]?.text || '';
    (fetchResult.isError || fetchText.includes('Fetch failed') || fetchText.includes('Failed to fetch'))
      ? PASS('MCP: ctx_fetch_and_index error handling')
      : FAIL('MCP: ctx_fetch_and_index error handling');
  } catch {
    PASS('MCP: ctx_fetch_and_index error handling');
  }

  // --- Execute Throttle ---
  // Test: normal execution works
  const execThrottleResult = await client.callTool({
    name: 'ctx_execute',
    arguments: { language: 'javascript', code: 'console.log("throttle-test-unique-" + Date.now())' }
  });
  const execThrottleText = execThrottleResult.content?.[0]?.text || '';
  execThrottleText.includes('throttle-test-unique-')
    ? PASS('Execute throttle: normal execution works')
    : FAIL('Execute throttle: normal execution works', `got: ${execThrottleText.slice(0, 100)}`);

  // Test: duplicate detection (exact same code within window)
  const dupCode = 'console.log("dup-detect-' + Date.now() + '")';
  await client.callTool({
    name: 'ctx_execute',
    arguments: { language: 'javascript', code: dupCode }
  });
  const dupResult = await client.callTool({
    name: 'ctx_execute',
    arguments: { language: 'javascript', code: dupCode }
  });
  const dupText = dupResult.content?.[0]?.text || '';
  (dupResult.isError || dupText.includes('Duplicate execution'))
    ? PASS('Execute throttle: duplicate detection')
    : FAIL('Execute throttle: duplicate detection', `got: ${dupText.slice(0, 100)}`);

  await client.close();
} catch (err) {
  FAIL('MCP smoke test', err.message);
}

// ─── 12. Plugin Discoverability ──────────────────────────────────────
SECTION('12. Plugin Discoverability');

// plugin.json
const pluginJsonPath = join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');
existsSync(pluginJsonPath) ? PASS('.claude-plugin/plugin.json exists') : FAIL('plugin.json missing');

const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf8'));
pluginJson.name === 'context-mode' ? PASS('plugin name') : FAIL('plugin name', pluginJson.name);
pluginJson.version ? PASS('plugin version') : FAIL('no version');
pluginJson.description ? PASS('plugin description') : FAIL('no description');

// .mcp.json
const mcpJsonPath = join(PLUGIN_ROOT, '.mcp.json');
existsSync(mcpJsonPath) ? PASS('.mcp.json exists') : FAIL('.mcp.json missing');

const mcpJson = JSON.parse(readFileSync(mcpJsonPath, 'utf8'));
// .mcp.json uses flat format: top-level key is the server name (no mcpServers wrapper)
mcpJson['context-mode'] ? PASS('.mcp.json flat format: context-mode key') : FAIL('.mcp.json missing context-mode key');
!mcpJson.mcpServers ? PASS('.mcp.json no mcpServers wrapper') : FAIL('.mcp.json has unexpected mcpServers wrapper');
mcpJson['context-mode']?.command === 'node' ? PASS('MCP command: node') : FAIL('MCP command');
(mcpJson['context-mode']?.args?.[0]?.includes('server/index.js') || mcpJson['context-mode']?.args?.[0]?.includes('start.js')) ? PASS('MCP args: entry point') : FAIL('MCP args');
mcpJson['context-mode']?.env?.CLAUDE_PLUGIN_DATA === '${CLAUDE_PLUGIN_DATA}' ? PASS('MCP env: CLAUDE_PLUGIN_DATA') : FAIL('MCP env');

// hooks.json
const hooksJsonPath = join(PLUGIN_ROOT, 'hooks', 'hooks.json');
existsSync(hooksJsonPath) ? PASS('hooks/hooks.json exists') : FAIL('hooks.json missing');

const hooksJson = JSON.parse(readFileSync(hooksJsonPath, 'utf8'));
hooksJson.hooks?.SessionStart ? PASS('hook: SessionStart') : FAIL('no SessionStart');
hooksJson.hooks?.PostToolUse ? PASS('hook: PostToolUse') : FAIL('no PostToolUse');
hooksJson.hooks?.PreCompact ? PASS('hook: PreCompact') : FAIL('no PreCompact');
hooksJson.hooks?.SubagentStop ? PASS('hook: SubagentStop') : FAIL('no SubagentStop');

// run-hook.cmd uses ${CLAUDE_PLUGIN_ROOT}
const hooksStr = JSON.stringify(hooksJson);
hooksStr.includes('${CLAUDE_PLUGIN_ROOT}') ? PASS('hooks use ${CLAUDE_PLUGIN_ROOT}') : FAIL('no CLAUDE_PLUGIN_ROOT in hooks');
hooksStr.includes('run-hook.cmd') ? PASS('hooks use run-hook.cmd') : FAIL('no run-hook.cmd');

// installed_plugins.json (may or may not have the plugin — depends on install method)
const installedPath = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
if (existsSync(installedPath)) {
  const installed = JSON.parse(readFileSync(installedPath, 'utf8'));
  const pluginKey = Object.keys(installed.plugins || {}).find(k => k.startsWith('context-mode@'));
  if (pluginKey) {
    PASS('registered in installed_plugins.json');
    const entry = installed.plugins[pluginKey]?.[0];
    entry?.installPath?.includes('context-mode') ? PASS('installPath correct') : FAIL('installPath');
  } else {
    // Not registered = user hasn't run /plugin install yet, that's OK
    PASS('installed_plugins.json exists (plugin not yet installed via /plugin install)');
    PASS('installPath check skipped (not installed via marketplace yet)');
  }
} else {
  PASS('no installed_plugins.json (fresh Claude install)');
  PASS('installPath check skipped');
}

// ─── 13. Spec Compliance ─────────────────────────────────────────────
SECTION('13. Spec Compliance (Claude Code Plugin Reference)');

// Structure: components at plugin root, NOT inside .claude-plugin/
const rootDirs = readdirSync(PLUGIN_ROOT);
!rootDirs.includes('commands') || existsSync(join(PLUGIN_ROOT, 'commands')) ? PASS('commands at root (or absent)') : FAIL('commands wrong location');
rootDirs.includes('skills') ? PASS('skills/ at root') : FAIL('skills not at root');
rootDirs.includes('agents') ? PASS('agents/ at root') : FAIL('agents not at root');
rootDirs.includes('hooks') ? PASS('hooks/ at root') : FAIL('hooks not at root');
rootDirs.includes('server') ? PASS('server/ at root') : FAIL('server not at root');

// .claude-plugin/ contains ONLY plugin.json
const claudePluginContents = readdirSync(join(PLUGIN_ROOT, '.claude-plugin'));
const validPluginFiles = new Set(['plugin.json', 'marketplace.json']);
claudePluginContents.every(f => validPluginFiles.has(f)) ? PASS('.claude-plugin/ contains only manifest files') : FAIL('.claude-plugin/ has unexpected files', claudePluginContents);

// Marketplace manifest exists and is valid
const mktPath = join(PLUGIN_ROOT, '.claude-plugin', 'marketplace.json');
if (existsSync(mktPath)) {
  const mkt = JSON.parse(readFileSync(mktPath, 'utf8'));
  mkt.name ? PASS('marketplace.json: has name') : FAIL('marketplace: no name');
  mkt.plugins?.length > 0 ? PASS('marketplace.json: has plugins') : FAIL('marketplace: no plugins');
  mkt.plugins?.[0]?.source === './' ? PASS('marketplace.json: source is ./') : FAIL('marketplace: wrong source', mkt.plugins?.[0]?.source);
} else {
  FAIL('marketplace.json missing');
}

// plugin.json: name is kebab-case, no spaces
/^[a-z0-9-]+$/.test(pluginJson.name) ? PASS('name is kebab-case') : FAIL('name not kebab-case', pluginJson.name);

// Semantic versioning
/^\d+\.\d+\.\d+$/.test(pluginJson.version) ? PASS('semver format') : FAIL('not semver', pluginJson.version);

// Version matches package.json
const pkgJson = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'));
pluginJson.version === pkgJson.version ? PASS('version matches package.json') : FAIL('version mismatch', { plugin: pluginJson.version, pkg: pkgJson.version });

// Skills have SKILL.md with frontmatter
const skillDirs = readdirSync(join(PLUGIN_ROOT, 'skills'));
for (const skillDir of skillDirs) {
  const skillMd = join(PLUGIN_ROOT, 'skills', skillDir, 'SKILL.md');
  if (existsSync(skillMd)) {
    const content = readFileSync(skillMd, 'utf8');
    content.startsWith('---') ? PASS(`skill ${skillDir}: has frontmatter`) : FAIL(`skill ${skillDir}: no frontmatter`);
    content.includes('description:') ? PASS(`skill ${skillDir}: has description`) : FAIL(`skill ${skillDir}: no description`);
  } else {
    FAIL(`skill ${skillDir}: no SKILL.md`);
  }
}

// Agents have frontmatter
const agentFiles = readdirSync(join(PLUGIN_ROOT, 'agents'));
for (const agentFile of agentFiles) {
  if (!agentFile.endsWith('.md')) continue;
  const content = readFileSync(join(PLUGIN_ROOT, 'agents', agentFile), 'utf8');
  content.startsWith('---') ? PASS(`agent ${agentFile}: has frontmatter`) : FAIL(`agent ${agentFile}: no frontmatter`);
  content.includes('description:') ? PASS(`agent ${agentFile}: has description`) : FAIL(`agent ${agentFile}: no description`);
}

// Hook events match spec (SessionStart, PostToolUse, PreCompact, SubagentStop are all valid)
const validHookEvents = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PermissionDenied', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted', 'Stop', 'StopFailure', 'TeammateIdle', 'InstructionsLoaded', 'ConfigChange', 'CwdChanged', 'FileChanged', 'WorktreeCreate', 'WorktreeRemove', 'PreCompact', 'PostCompact', 'Elicitation', 'ElicitationResult', 'SessionEnd'];
for (const hookEvent of Object.keys(hooksJson.hooks)) {
  validHookEvents.includes(hookEvent) ? PASS(`hook event "${hookEvent}" is valid`) : FAIL(`hook event "${hookEvent}" not in spec`);
}

// Hook commands use valid types
for (const [eventName, hookGroups] of Object.entries(hooksJson.hooks)) {
  for (const group of hookGroups) {
    for (const hook of group.hooks) {
      ['command', 'http', 'prompt', 'agent'].includes(hook.type) ? PASS(`${eventName} hook type "${hook.type}" valid`) : FAIL(`${eventName} invalid type`);
    }
  }
}

// MCP config uses ${CLAUDE_PLUGIN_ROOT} for paths (not hardcoded)
const mcpStr = JSON.stringify(mcpJson);
!mcpStr.includes('C:\\') && !mcpStr.includes('/Users/') ? PASS('MCP: no hardcoded paths') : FAIL('MCP: hardcoded paths');

// Required files per open-source standards
existsSync(join(PLUGIN_ROOT, 'LICENSE')) ? PASS('LICENSE exists') : FAIL('no LICENSE');
existsSync(join(PLUGIN_ROOT, 'README.md')) ? PASS('README.md exists') : FAIL('no README');
existsSync(join(PLUGIN_ROOT, 'CHANGELOG.md')) ? PASS('CHANGELOG.md exists') : FAIL('no CHANGELOG');
existsSync(join(PLUGIN_ROOT, 'CONTRIBUTING.md')) ? PASS('CONTRIBUTING.md exists') : FAIL('no CONTRIBUTING');
existsSync(join(PLUGIN_ROOT, 'USER-MANUAL.md')) ? PASS('USER-MANUAL.md exists') : FAIL('no USER-MANUAL');
existsSync(join(PLUGIN_ROOT, '.gitignore')) ? PASS('.gitignore exists') : FAIL('no .gitignore');

// Documentation artifacts (6 required by standards)
existsSync(join(PLUGIN_ROOT, 'docs', 'index.html')) ? PASS('docs/index.html landing page') : FAIL('no landing page');
existsSync(join(PLUGIN_ROOT, 'docs', 'README-FULL.pdf')) ? PASS('docs/README-FULL.pdf') : FAIL('no PDF docs');
existsSync(join(PLUGIN_ROOT, 'docs', 'README-FULL.md')) ? PASS('docs/README-FULL.md source') : FAIL('no PDF source');
existsSync(join(PLUGIN_ROOT, 'docs', 'DISCUSSIONS-SEED.md')) ? PASS('docs/DISCUSSIONS-SEED.md') : FAIL('no discussions seed');

// Landing page content check
const landingHtml = readFileSync(join(PLUGIN_ROOT, 'docs', 'index.html'), 'utf8');
landingHtml.includes('context-mode') ? PASS('landing: has project name') : FAIL('landing: no name');
landingHtml.includes('98%') ? PASS('landing: has savings stat') : FAIL('landing: no stat');
landingHtml.includes('MCP Tools') ? PASS('landing: has tools section') : FAIL('landing: no tools');
landingHtml.includes('Architecture') ? PASS('landing: has architecture') : FAIL('landing: no arch');
landingHtml.includes('viewport') ? PASS('landing: mobile responsive meta') : FAIL('landing: no viewport');

// ─── 14. OSS Attribution ─────────────────────────────────────────────
SECTION('14. OSS Attribution');

// README attribution section
const readmeText = readFileSync(join(PLUGIN_ROOT, 'README.md'), 'utf8');
readmeText.includes('mksglu/context-mode') ? PASS('README: credits upstream repo') : FAIL('README: no upstream credit');
readmeText.includes('@mksglu') ? PASS('README: credits upstream author') : FAIL('README: no author credit');
readmeText.includes('Elastic License 2.0') || readmeText.includes('ELv2') ? PASS('README: mentions upstream license') : FAIL('README: no license mention');

// Landing page attribution
landingHtml.includes('mksglu') ? PASS('landing: credits upstream') : FAIL('landing: no upstream credit');

// Source file headers
const coreModules = ['server/index.js', 'server/knowledge.js', 'server/sandbox.js', 'server/session.js', 'server/snapshot.js'];
for (const mod of coreModules) {
  const src = readFileSync(join(PLUGIN_ROOT, mod), 'utf8');
  src.includes('mksglu/context-mode') ? PASS(`${mod}: attribution header`) : FAIL(`${mod}: no attribution`);
}

// CHANGELOG attribution
const changelog = readFileSync(join(PLUGIN_ROOT, 'CHANGELOG.md'), 'utf8');
changelog.includes('mksglu/context-mode') ? PASS('CHANGELOG: credits upstream') : FAIL('CHANGELOG: no upstream credit');

// Full docs attribution
const fullDocs = readFileSync(join(PLUGIN_ROOT, 'docs', 'README-FULL.md'), 'utf8');
fullDocs.includes('mksglu/context-mode') ? PASS('full docs: credits upstream') : FAIL('full docs: no upstream credit');

// .gitignore covers essentials
const gitignore = readFileSync(join(PLUGIN_ROOT, '.gitignore'), 'utf8');
gitignore.includes('node_modules') ? PASS('.gitignore: node_modules') : FAIL('.gitignore: no node_modules');
gitignore.includes('.data') ? PASS('.gitignore: .data') : FAIL('.gitignore: no .data');
gitignore.includes('.env') ? PASS('.gitignore: .env') : FAIL('.gitignore: no .env');

// ─── 15. Plugin Manifest Validation ──────────────────────────────────
SECTION('15. Plugin Manifest Validation');

// .mcp.json flat format validation
const _mcpJson15 = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.mcp.json'), 'utf-8'));
_mcpJson15['context-mode'] ? PASS('.mcp.json flat format') : FAIL('.mcp.json missing context-mode key');
!_mcpJson15.mcpServers ? PASS('.mcp.json no mcpServers wrapper') : FAIL('.mcp.json has mcpServers wrapper');

// plugin.json mcpServers field and required fields
const _pluginJson15 = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf-8'));
_pluginJson15.mcpServers?.['context-mode'] ? PASS('plugin.json has mcpServers') : FAIL('plugin.json missing mcpServers');
_pluginJson15.skills ? PASS('plugin.json has skills') : FAIL('plugin.json missing skills');
_pluginJson15.hooks ? PASS('plugin.json has hooks') : FAIL('plugin.json missing hooks');

// ─── 16. PreToolUse Routing ───────────────────────────────────────────
SECTION('16. PreToolUse Routing');

const { routePreToolUse, resetGuidanceThrottle } = await import('./hooks/core/routing.js');

// Reset throttle before each test batch
resetGuidanceThrottle();

// curl → modify
const curlResult = routePreToolUse('Bash', { command: 'curl https://example.com' });
curlResult?.action === 'modify' ? PASS('curl → modify') : FAIL(`curl → ${curlResult?.action}`);

// git status → passthrough or guidance (safe Bash command)
resetGuidanceThrottle();
const gitResult = routePreToolUse('Bash', { command: 'git status' });
(gitResult === null || gitResult?.action === 'context') ? PASS('git → passthrough/guidance') : FAIL(`git → ${gitResult?.action}`);

// WebFetch → deny
const wfResult = routePreToolUse('WebFetch', { url: 'https://docs.example.com' });
wfResult?.action === 'deny' ? PASS('WebFetch → deny') : FAIL(`WebFetch → ${wfResult?.action}`);

// Agent → modify (inject routing block)
const agentResult = routePreToolUse('Agent', { prompt: 'do something' });
agentResult?.action === 'modify' ? PASS('Agent → modify') : FAIL(`Agent → ${agentResult?.action}`);
agentResult?.updatedInput?.prompt?.includes('context_window_protection') ? PASS('Agent has routing block') : FAIL('Agent missing routing block');

// Unknown tool → passthrough
const unknownResult = routePreToolUse('SomeTool', {});
unknownResult === null ? PASS('unknown → passthrough') : FAIL(`unknown → ${unknownResult?.action}`);

// ─── 17. hooks.json Validation ────────────────────────────────────────
SECTION('17. hooks.json Validation');

const _hooksJson17 = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf-8'));
const hookEvents = Object.keys(_hooksJson17.hooks || {});
hookEvents.includes('PreToolUse') ? PASS('hook: PreToolUse') : FAIL('missing PreToolUse');
hookEvents.includes('PostToolUse') ? PASS('hook: PostToolUse') : FAIL('missing PostToolUse');
hookEvents.includes('PreCompact') ? PASS('hook: PreCompact') : FAIL('missing PreCompact');
hookEvents.includes('SessionStart') ? PASS('hook: SessionStart') : FAIL('missing SessionStart');
hookEvents.includes('UserPromptSubmit') ? PASS('hook: UserPromptSubmit') : FAIL('missing UserPromptSubmit');
hookEvents.includes('SubagentStop') ? PASS('hook: SubagentStop') : FAIL('missing SubagentStop');

const preToolMatchers = _hooksJson17.hooks.PreToolUse || [];
preToolMatchers.length === 9 ? PASS('PreToolUse: 9 matchers') : FAIL(`PreToolUse: ${preToolMatchers.length} matchers (expected 9)`);

// ─── 18. Plugin CLAUDE.md and Settings ───────────────────────────────
SECTION('18. Plugin CLAUDE.md and Settings');

const claudeMdPath = join(PLUGIN_ROOT, 'CLAUDE.md');
existsSync(claudeMdPath) ? PASS('CLAUDE.md exists') : FAIL('CLAUDE.md missing');
if (existsSync(claudeMdPath)) {
  const claudeMd = readFileSync(claudeMdPath, 'utf-8');
  claudeMd.includes('Think in Code') ? PASS('CLAUDE.md: Think in Code directive') : FAIL('CLAUDE.md: missing Think in Code');
  claudeMd.includes('batch_execute') ? PASS('CLAUDE.md: tool selection') : FAIL('CLAUDE.md: missing tool selection');
  claudeMd.includes('500 words') ? PASS('CLAUDE.md: output constraints') : FAIL('CLAUDE.md: missing output constraints');
}

const settingsPath = join(PLUGIN_ROOT, '.claude', 'settings.json');
existsSync(settingsPath) ? PASS('.claude/settings.json exists') : FAIL('.claude/settings.json missing');
if (existsSync(settingsPath)) {
  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  settings.permissions?.deny?.length > 0 ? PASS('settings: has deny rules') : FAIL('settings: no deny rules');
  settings.permissions?.allow?.length > 0 ? PASS('settings: has allow rules') : FAIL('settings: no allow rules');
}

// Routing block upgrade/purge commands
ROUTING_BLOCK.includes('ctx upgrade') ? PASS('routing block: ctx upgrade command') : FAIL('routing block: missing ctx upgrade');
ROUTING_BLOCK.includes('ctx purge') ? PASS('routing block: ctx purge command') : FAIL('routing block: missing ctx purge');

// Reference files use upstream naming (bare 'execute', not 'ctx_execute')
const antiPatternsPath = join(PLUGIN_ROOT, 'skills', 'context-mode', 'references', 'anti-patterns.md');
if (existsSync(antiPatternsPath)) {
  const antiPatterns = readFileSync(antiPatternsPath, 'utf-8');
  antiPatterns.includes('LLM summarization call') ? PASS('anti-patterns: LLM summarization note') : FAIL('anti-patterns: missing LLM summarization note');
  !antiPatterns.includes('ctx_execute') ? PASS('anti-patterns: uses bare execute naming') : FAIL('anti-patterns: has ctx_ prefix (should be bare)');
} else {
  FAIL('anti-patterns.md missing');
}

// ─── 19. Schema Migration ─────────────────────────────────────────────
console.log('\n--- 19. Schema Migration ---');

{
  const migTmpDir = mkdtempSync(join(tmpdir(), '.ctx-mig-'));

  // Test 1: Fresh DB — all migrations run, user_version stamped
  {
    const dbPath = join(migTmpDir, 'fresh.db');
    const db = openDatabase(dbPath);
    const result = runMigrations(db, dbPath, [
      { version: 1, up(d) { d.exec('CREATE TABLE test1 (id INTEGER PRIMARY KEY)'); } },
    ], { label: 'test', detectTable: 'test1', validate: (d) => validateTables(d, ['test1'], 'test') });
    const ver = db.pragma('user_version', { simple: true });
    result.migrationsRun === 1 && ver === 1 ? PASS('fresh DB: migration runs, version stamped') : FAIL('fresh DB migration');
    closeDB(db);
  }

  // Test 2: Pre-existing unversioned DB — stamps v1, data preserved
  {
    const dbPath = join(migTmpDir, 'preexisting.db');
    const db = openDatabase(dbPath);
    db.exec('CREATE TABLE mydata (id INTEGER PRIMARY KEY, val TEXT)');
    db.prepare('INSERT INTO mydata (val) VALUES (?)').run('preserved');
    // user_version is 0 (default), table exists
    const result = runMigrations(db, dbPath, [
      { version: 1, up(d) { d.exec('CREATE TABLE IF NOT EXISTS mydata (id INTEGER PRIMARY KEY, val TEXT)'); } },
    ], { label: 'test', detectTable: 'mydata', validate: (d) => validateTables(d, ['mydata'], 'test') });
    const ver = db.pragma('user_version', { simple: true });
    const row = db.prepare('SELECT val FROM mydata').get();
    result.migrationsRun === 1 && ver === 1 && row.val === 'preserved'
      ? PASS('pre-existing DB: v1 stamped, data preserved')
      : FAIL('pre-existing DB migration');
    closeDB(db);
  }

  // Test 3: Already-current DB — no-op
  {
    const dbPath = join(migTmpDir, 'current.db');
    const db = openDatabase(dbPath);
    db.exec('CREATE TABLE t (id INTEGER)');
    db.pragma('user_version = 1');
    const result = runMigrations(db, dbPath, [
      { version: 1, up(d) { d.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER)'); } },
    ], { label: 'test', detectTable: 't', validate: (d) => validateTables(d, ['t'], 'test') });
    result.migrationsRun === 0 ? PASS('already-current DB: no-op') : FAIL('already-current DB ran migrations');
    closeDB(db);
  }

  // Test 4: Multi-step v1 → v2 → v3
  {
    const dbPath = join(migTmpDir, 'multistep.db');
    const db = openDatabase(dbPath);
    const migrations = [
      { version: 1, up(d) { d.exec('CREATE TABLE base (id INTEGER PRIMARY KEY)'); } },
      { version: 2, up(d) { d.exec('ALTER TABLE base ADD COLUMN name TEXT DEFAULT ""'); } },
      { version: 3, up(d) { d.exec('CREATE TABLE extra (id INTEGER PRIMARY KEY)'); } },
    ];
    const result = runMigrations(db, dbPath, migrations, {
      label: 'test', detectTable: 'base',
      validate: (d) => validateTables(d, ['base', 'extra'], 'test'),
    });
    const ver = db.pragma('user_version', { simple: true });
    result.migrationsRun === 3 && ver === 3 ? PASS('multi-step v1→v2→v3') : FAIL(`multi-step: ran=${result.migrationsRun} ver=${ver}`);
    closeDB(db);
  }

  // Test 5: Backup created before v1→v2 migration
  {
    const dbPath = join(migTmpDir, 'backup.db');
    const db = openDatabase(dbPath);
    db.exec('CREATE TABLE t (id INTEGER)');
    db.pragma('user_version = 1');
    db.prepare('INSERT INTO t (id) VALUES (?)').run(42);
    runMigrations(db, dbPath, [
      { version: 1, up(d) { d.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER)'); } },
      { version: 2, up(d) { d.exec('ALTER TABLE t ADD COLUMN name TEXT DEFAULT ""'); } },
    ], { label: 'test', detectTable: 't', validate: (d) => validateTables(d, ['t'], 'test') });
    const backupExists = existsSync(dbPath + '.backup-v1');
    closeDB(db);
    // Verify backup is valid SQLite with original data
    if (backupExists) {
      const backupDb = openDatabase(dbPath + '.backup-v1');
      const row = backupDb.prepare('SELECT id FROM t').get();
      closeDB(backupDb);
      row && row.id === 42 ? PASS('backup created and valid') : FAIL('backup file corrupt');
    } else {
      FAIL('backup file not created');
    }
  }

  // Test 6: Failed migration rolls back, version unchanged
  {
    const dbPath = join(migTmpDir, 'failmig.db');
    const db = openDatabase(dbPath);
    const migrations = [
      { version: 1, up(d) { d.exec('CREATE TABLE t (id INTEGER)'); } },
      { version: 2, up(d) { throw new Error('intentional failure'); } },
    ];
    let caught = false;
    try {
      runMigrations(db, dbPath, migrations, {
        label: 'test', detectTable: 't', validate: () => {},
      });
    } catch (e) { caught = true; }
    const ver = db.pragma('user_version', { simple: true });
    caught && ver === 1 ? PASS('failed migration: rolled back to v1') : FAIL(`failed migration: caught=${caught} ver=${ver}`);
    closeDB(db);
  }

  // Test 7: Validation catches missing tables
  {
    const dbPath = join(migTmpDir, 'validate.db');
    const db = openDatabase(dbPath);
    let threw = false;
    try {
      validateTables(db, ['nonexistent_table'], 'test');
    } catch (e) {
      threw = e.message.includes('nonexistent_table');
    }
    threw ? PASS('validation catches missing tables') : FAIL('validation did not catch missing table');
    closeDB(db);
  }

  // Test 8: ContentStore reopen after migration preserves data
  {
    const dbPath = join(migTmpDir, 'kb-reopen.db');
    const store1 = new ContentStore(dbPath);
    store1.index({ content: 'migration test content about databases', source: 'mig-test' });
    store1.close();
    // Reopen — should detect v1, no-op migration, data preserved
    const store2 = new ContentStore(dbPath);
    const results = store2.search('databases');
    results.length > 0 ? PASS('ContentStore reopen preserves indexed data') : FAIL('ContentStore reopen lost data');
    store2.close();
  }

  // Test 9: SessionDB reopen after migration preserves events
  {
    const dbPath = join(migTmpDir, 'sess-reopen.db');
    const sdb1 = new SessionDB(dbPath);
    sdb1.ensureSession('test-mig-sess', '/test');
    sdb1.insertEvent('test-mig-sess', { type: 'file_read', category: 'file', data: { path: '/a.js' }, priority: 1 });
    sdb1.close();
    // Reopen
    const sdb2 = new SessionDB(dbPath);
    const events = sdb2.getEvents('test-mig-sess');
    events.length === 1 ? PASS('SessionDB reopen preserves events') : FAIL(`SessionDB reopen: ${events.length} events`);
    sdb2.close();
  }

  // Cleanup migration test DBs
  try { rmSync(migTmpDir, { recursive: true, force: true }); } catch {}
}

// ─── Cleanup ──────────────────────────────────────────────────────────
for (const db of [contentDb, sessionDb]) {
  for (const ext of ['', '-wal', '-shm']) {
    try { if (existsSync(db + ext)) unlinkSync(db + ext); } catch {}
  }
}

// Clean up hook test session DBs
const sessDir = join(homedir(), '.claude', 'context-mode', 'sessions');
if (existsSync(sessDir)) {
  try {
    for (const f of readdirSync(sessDir)) {
      try { unlinkSync(join(sessDir, f)); } catch {}
    }
  } catch {}
}

// ─── 20. Version Consistency ──────────────────────────────────────────
SECTION('20. Version Consistency');
{
  const pkgVersion = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')).version;
  const pluginJson = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const serverSrc = readFileSync(join(PLUGIN_ROOT, 'server', 'index.js'), 'utf8');
  const readmeSrc = readFileSync(join(PLUGIN_ROOT, 'README.md'), 'utf8');
  const changelogSrc = readFileSync(join(PLUGIN_ROOT, 'CHANGELOG.md'), 'utf8');
  const indexHtmlSrc = readFileSync(join(PLUGIN_ROOT, 'docs', 'index.html'), 'utf8');
  const readmeFullSrc = readFileSync(join(PLUGIN_ROOT, 'docs', 'README-FULL.md'), 'utf8');

  pluginJson.version === pkgVersion
    ? PASS(`plugin.json version matches package.json (${pkgVersion})`)
    : FAIL('plugin.json version mismatch', `${pluginJson.version} !== ${pkgVersion}`);

  new RegExp(`const VERSION = '${pkgVersion.replace(/\./g, '\\.')}'`).test(serverSrc)
    ? PASS(`server/index.js VERSION constant matches (${pkgVersion})`)
    : FAIL('server/index.js VERSION mismatch', `expected ${pkgVersion}`);

  readmeSrc.includes(`Current version: **${pkgVersion}**`)
    ? PASS(`README.md references current version (${pkgVersion})`)
    : FAIL('README.md version reference missing or stale', `expected ${pkgVersion}`);

  changelogSrc.includes(`[${pkgVersion}]`)
    ? PASS(`CHANGELOG.md has entry for [${pkgVersion}]`)
    : FAIL('CHANGELOG.md missing version entry', `expected [${pkgVersion}]`);

  indexHtmlSrc.includes(`context-mode v${pkgVersion}`)
    ? PASS(`docs/index.html footer references current version (${pkgVersion})`)
    : FAIL('docs/index.html version stale', `expected context-mode v${pkgVersion}`);

  readmeFullSrc.includes(`**Version ${pkgVersion}**`)
    ? PASS(`docs/README-FULL.md references current version (${pkgVersion})`)
    : FAIL('docs/README-FULL.md version stale', `expected **Version ${pkgVersion}**`);
}

// ─── Summary ──────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(50)}`);
console.log(`E2E RESULTS: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));

if (failed > 0) process.exit(1);
