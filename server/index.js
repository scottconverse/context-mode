/**
 * Context Mode MCP Server
 *
 * Provides sandbox execution, knowledge base indexing/search,
 * and session continuity tools for Cowork.
 *
 * Ported from mksglu/context-mode (https://github.com/mksglu/context-mode)
 * by @mksglu, licensed under Elastic License 2.0.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir as osHomedir } from 'node:os';

import { detectRuntimes, getRuntimeSummary, getAvailableLanguages, isWindows } from './runtime.js';
import { PolyglotExecutor } from './sandbox.js';
import { ContentStore } from './knowledge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = join(__dirname, '..');

// ─── Constants ────────────────────────────────────────────────────────────────

const VERSION = '1.1.1';
const INTENT_SEARCH_THRESHOLD = 5000;       // Auto-index if output > 5KB
const LARGE_OUTPUT_THRESHOLD = 102400;       // 100KB
const SEARCH_WINDOW_MS = 60000;             // 60s throttle window
const SEARCH_MAX_RESULTS_AFTER = 3;         // After 3 calls: 1 result/query
const SEARCH_BLOCK_AFTER = 8;               // After 8 calls: blocked
const MAX_TOTAL_SEARCH = 40 * 1024;         // 40KB max search output
const TTL_MS = 24 * 60 * 60 * 1000;         // 24h fetch cache TTL
const BATCH_TIMEOUT = 60000;                // 60s batch timeout

// ─── Data Directories ─────────────────────────────────────────────────────────

// Resolve CLAUDE_PLUGIN_DATA: Cowork may or may not expand ${CLAUDE_PLUGIN_DATA}
// in .mcp.json env block. If it's unexpanded (literal string), resolve it ourselves.
function resolvePluginData() {
  const envVal = process.env.CLAUDE_PLUGIN_DATA;

  // If Cowork expanded it properly, use it
  if (envVal && !envVal.includes('${') && !envVal.includes('CLAUDE_PLUGIN_DATA')) {
    return envVal;
  }

  // Resolve per spec: ~/.claude/plugins/data/<plugin-id>/
  // Plugin ID: name@marketplace with non-alphanumeric chars replaced by -
  const pluginName = 'context-mode';
  const homedir = process.env.USERPROFILE || process.env.HOME || osHomedir();
  const specPath = join(homedir, '.claude', 'plugins', 'data', pluginName);
  if (existsSync(join(homedir, '.claude', 'plugins'))) {
    return specPath;
  }

  // Fallback: .data inside plugin root
  return join(PLUGIN_ROOT, '.data');
}

const PLUGIN_DATA = resolvePluginData();
const CONTENT_DIR = join(PLUGIN_DATA, 'content');
const SESSIONS_DIR = join(PLUGIN_DATA, 'sessions');

for (const dir of [PLUGIN_DATA, CONTENT_DIR, SESSIONS_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ─── Session Stats ────────────────────────────────────────────────────────────

const sessionStats = {
  calls: {},
  bytesReturned: {},
  bytesIndexed: 0,
  bytesSandboxed: 0,
  cacheHits: 0,
  cacheBytesSaved: 0,
  sessionStart: Date.now()
};

function trackCall(toolName, responseBytes) {
  sessionStats.calls[toolName] = (sessionStats.calls[toolName] || 0) + 1;
  sessionStats.bytesReturned[toolName] = (sessionStats.bytesReturned[toolName] || 0) + responseBytes;
}

// ─── Search Throttle State ────────────────────────────────────────────────────

let searchCallCount = 0;
let searchWindowStart = Date.now();

// ─── Lazy-loaded Modules ──────────────────────────────────────────────────────

let _store = null;
let _executor = null;
let _runtimes = null;

function getProjectHash() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return createHash('sha256').update(projectDir).digest('hex').slice(0, 16);
}

function getStoreSync() {
  if (!_store) {
    const dbPath = join(CONTENT_DIR, `${getProjectHash()}.db`);
    _store = new ContentStore(dbPath);
  }
  return _store;
}

// Alias for backward compat with async tool handlers
async function getStoreAsync() {
  return getStoreSync();
}

function getRuntimes() {
  if (!_runtimes) {
    _runtimes = detectRuntimes();
  }
  return _runtimes;
}

function getExecutor() {
  if (!_executor) {
    const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    _executor = new PolyglotExecutor({
      projectRoot,
      runtimes: getRuntimes()
    });
  }
  return _executor;
}

// ─── Utility Functions ────────────────────────────────────────────────────────

function makeTextResponse(text) {
  return { content: [{ type: 'text', text }] };
}

function makeErrorResponse(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'context-mode',
  version: VERSION
});

// ─── Tool: ctx_execute ────────────────────────────────────────────────────────

server.tool(
  'ctx_execute',
  'Run code in an isolated subprocess. Returns only stdout — raw output never enters context. Supports: javascript, typescript, python, shell, ruby, go, rust, php, perl, r, elixir.',
  {
    language: z.enum([
      'javascript', 'typescript', 'python', 'shell', 'ruby',
      'go', 'rust', 'php', 'perl', 'r', 'elixir'
    ]).describe('Programming language to execute'),
    code: z.string().describe('Code to execute in the sandbox'),
    timeout: z.number().optional().default(30000).describe('Timeout in milliseconds (default: 30000)'),
    background: z.boolean().optional().default(false).describe('Keep process running after timeout'),
    intent: z.string().optional().describe('If provided and output is large, auto-indexes output and returns only relevant snippets matching this intent')
  },
  async ({ language, code, timeout, background, intent }) => {
    const executor = getExecutor();
    let result;
    try {
      result = await executor.execute({ language, code, timeout, background });
    } catch (err) {
      process.stderr.write(`[context-mode] ctx_execute spawn failed: ${err.message}\n`);
      return makeErrorResponse(`Execution failed: ${err.message}`);
    }

    const rawBytes = Buffer.byteLength(result.stdout + result.stderr, 'utf8');
    sessionStats.bytesSandboxed += rawBytes;

    // Build response
    let output = '';

    if (result.timedOut) {
      output += result.backgrounded
        ? `⏱ Process backgrounded after ${timeout}ms (PID: running)\n`
        : `⏱ Process timed out after ${timeout}ms\n`;
    }

    if (result.exitCode !== 0 && result.exitCode !== null) {
      output += `Exit code: ${result.exitCode}\n`;
    }

    if (result.stderr && result.stderr.trim()) {
      output += `stderr:\n${result.stderr.trim()}\n\n`;
    }

    const stdout = result.stdout || '';

    // If intent provided and output is large, auto-index and search
    if (intent && Buffer.byteLength(stdout, 'utf8') > INTENT_SEARCH_THRESHOLD) {
      try {
        const store = await getStoreAsync();
        const source = `exec:${language}:${Date.now()}`;
        store.index({ content: stdout, source });
        sessionStats.bytesIndexed += Buffer.byteLength(stdout, 'utf8');

        const results = store.searchWithFallback(intent, 2, source);
        if (results.length > 0) {
          output += `Output indexed (${formatBytes(rawBytes)} → searched by intent)\n\n`;
          for (const r of results) {
            output += `### ${r.title}\n${r.snippet || r.content}\n\n`;
          }
          const responseBytes = Buffer.byteLength(output, 'utf8');
          trackCall('ctx_execute', responseBytes);
          return makeTextResponse(output.trim());
        }
      } catch (err) {
        // Auto-index failed — fall through to return raw stdout
        process.stderr.write(`[context-mode] ctx_execute auto-index failed: ${err.message}\n`);
      }
    }

    // Large output without intent: auto-index and return pointer
    if (Buffer.byteLength(stdout, 'utf8') > LARGE_OUTPUT_THRESHOLD) {
      try {
        const store = await getStoreAsync();
        const source = `exec:${language}:${Date.now()}`;
        store.index({ content: stdout, source });
        sessionStats.bytesIndexed += Buffer.byteLength(stdout, 'utf8');
        output += `Output indexed as "${source}" (${formatBytes(rawBytes)}). Use ctx_search to query it.`;
        const responseBytes = Buffer.byteLength(output, 'utf8');
        trackCall('ctx_execute', responseBytes);
        return makeTextResponse(output.trim());
      } catch {
        // Fall through to truncated output
        output += stdout.slice(0, 5000) + `\n\n... [truncated, ${formatBytes(rawBytes)} total]`;
        const responseBytes = Buffer.byteLength(output, 'utf8');
        trackCall('ctx_execute', responseBytes);
        return makeTextResponse(output.trim());
      }
    }

    output += stdout;
    const responseBytes = Buffer.byteLength(output, 'utf8');
    trackCall('ctx_execute', responseBytes);
    return makeTextResponse(output.trim() || '(no output)');
  }
);

// ─── Tool: ctx_execute_file ───────────────────────────────────────────────────

server.tool(
  'ctx_execute_file',
  'Process files through a sandboxed script. File contents are read inside the subprocess — raw content never enters context. Returns only computed results.',
  {
    files: z.array(z.string()).describe('Array of file paths to process'),
    language: z.enum([
      'javascript', 'typescript', 'python', 'shell', 'ruby',
      'go', 'rust', 'php', 'perl', 'r', 'elixir'
    ]).describe('Programming language for the processing script'),
    code: z.string().describe('Code that processes FILE_CONTENTS (array of {path, content} objects)'),
    timeout: z.number().optional().default(30000).describe('Timeout in milliseconds'),
    intent: z.string().optional().describe('If provided and output is large, auto-indexes and returns relevant snippets')
  },
  async ({ files, language, code, timeout, intent }) => {
    const executor = getExecutor();

    // Validate files exist
    const missing = files.filter(f => !existsSync(f));
    if (missing.length > 0) {
      return makeErrorResponse(`Files not found: ${missing.join(', ')}`);
    }

    let result;
    try {
      result = await executor.executeFile({ files, language, code, timeout });
    } catch (err) {
      process.stderr.write(`[context-mode] ctx_execute_file spawn failed: ${err.message}\n`);
      return makeErrorResponse(`File execution failed: ${err.message}`);
    }

    const rawBytes = Buffer.byteLength(result.stdout + result.stderr, 'utf8');
    sessionStats.bytesSandboxed += rawBytes;

    let output = '';

    if (result.exitCode !== 0 && result.exitCode !== null) {
      output += `Exit code: ${result.exitCode}\n`;
    }
    if (result.stderr && result.stderr.trim()) {
      output += `stderr:\n${result.stderr.trim()}\n\n`;
    }

    const stdout = result.stdout || '';

    // Intent-based search for large outputs
    if (intent && Buffer.byteLength(stdout, 'utf8') > INTENT_SEARCH_THRESHOLD) {
      try {
        const store = await getStoreAsync();
        const source = `file:${files[0]}:${Date.now()}`;
        store.index({ content: stdout, source });
        sessionStats.bytesIndexed += Buffer.byteLength(stdout, 'utf8');

        const results = store.searchWithFallback(intent, 2, source);
        if (results.length > 0) {
          output += `Processed ${files.length} file(s), output indexed (${formatBytes(rawBytes)} → searched)\n\n`;
          for (const r of results) {
            output += `### ${r.title}\n${r.snippet || r.content}\n\n`;
          }
          const responseBytes = Buffer.byteLength(output, 'utf8');
          trackCall('ctx_execute_file', responseBytes);
          return makeTextResponse(output.trim());
        }
      } catch (err) {
      // Auto-index failed — fall through to return raw stdout
      process.stderr.write(`[context-mode] ctx_execute_file auto-index failed: ${err.message}\n`);
    }
    }

    output += stdout;
    const responseBytes = Buffer.byteLength(output, 'utf8');
    trackCall('ctx_execute_file', responseBytes);
    return makeTextResponse(output.trim() || '(no output)');
  }
);

// ─── Tool: ctx_index ──────────────────────────────────────────────────────────

server.tool(
  'ctx_index',
  'Index text/markdown/JSON content into the local knowledge base for later search via ctx_search. Raw content never enters context.',
  {
    content: z.string().optional().describe('Text content to index'),
    source: z.string().optional().describe('Identifier for this content (e.g., filename, URL)'),
    path: z.string().optional().describe('File path to read and index'),
    contentType: z.enum(['code', 'prose']).optional().describe('Content type hint for search filtering')
  },
  async ({ content, source, path }) => {
    let text = content;
    let label = source;

    if (path) {
      if (!existsSync(path)) {
        return makeErrorResponse(`File not found: ${path}`);
      }
      text = readFileSync(path, 'utf8');
      label = label || path;
    }

    if (!text) {
      return makeErrorResponse('No content provided. Supply either content or path.');
    }

    label = label || `indexed:${Date.now()}`;

    const store = await getStoreAsync();
    const rawBytes = Buffer.byteLength(text, 'utf8');

    // Auto-detect content type
    const trimmed = text.trim();
    let result;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        JSON.parse(trimmed);
        result = store.indexJSON(text, label);
      } catch {
        result = store.index({ content: text, source: label });
      }
    } else {
      result = store.index({ content: text, source: label });
    }

    sessionStats.bytesIndexed += rawBytes;
    trackCall('ctx_index', 100); // ~100B response

    return makeTextResponse(
      `Indexed "${label}": ${result.totalChunks} chunks (${result.codeChunks || 0} code). ` +
      `Raw size: ${formatBytes(rawBytes)}. Use ctx_search to query.`
    );
  }
);

// ─── Tool: ctx_search ─────────────────────────────────────────────────────────

server.tool(
  'ctx_search',
  'Search the knowledge base using BM25 + trigram dual-strategy search with RRF fusion. Returns relevant snippets without loading full documents into context.',
  {
    queries: z.array(z.string()).optional().describe('Array of search queries'),
    query: z.string().optional().describe('Single search query (alternative to queries array)'),
    limit: z.number().optional().default(2).describe('Max results per query (default: 2)'),
    source: z.string().optional().describe('Filter to specific source'),
    contentType: z.enum(['code', 'prose']).optional().describe('Filter by content type')
  },
  async ({ queries, query, limit, source, contentType }) => {
    // Coerce to array
    const queryList = queries || (query ? [query] : []);
    if (queryList.length === 0) {
      return makeErrorResponse('No queries provided. Supply queries array or query string.');
    }

    // Progressive throttling
    const now = Date.now();
    if (now - searchWindowStart > SEARCH_WINDOW_MS) {
      searchCallCount = 0;
      searchWindowStart = now;
    }
    searchCallCount++;

    if (searchCallCount > SEARCH_BLOCK_AFTER) {
      return makeErrorResponse(
        `BLOCKED: ${searchCallCount} search calls in ${Math.round((now - searchWindowStart) / 1000)}s. ` +
        'Use ctx_batch_execute to combine multiple searches into one call.'
      );
    }

    // Determine effective limit based on throttle level
    const effectiveLimit = searchCallCount > SEARCH_MAX_RESULTS_AFTER
      ? 1
      : Math.min(limit, 2);

    const store = await getStoreAsync();
    let output = '';
    let totalBytes = 0;

    for (const q of queryList) {
      if (totalBytes > MAX_TOTAL_SEARCH) {
        output += `\n\n⚠ Output limit reached (${formatBytes(MAX_TOTAL_SEARCH)}). Use ctx_batch_execute for more.`;
        break;
      }

      const results = store.searchWithFallback(q, effectiveLimit, source, contentType);

      if (results.length === 0) {
        output += `## "${q}"\nNo results found.\n\n`;
        continue;
      }

      output += `## "${q}"\n\n`;
      for (const r of results) {
        const section = `--- [${r.sourceLabel || 'unknown'}] ---\n### ${r.title}\n\n${r.snippet || r.content}\n\n`;
        totalBytes += Buffer.byteLength(section, 'utf8');
        output += section;
      }
    }

    // Warning on high call count
    if (searchCallCount >= SEARCH_MAX_RESULTS_AFTER) {
      output += `\n\n⚠ Search call #${searchCallCount}/${SEARCH_BLOCK_AFTER} in this window. ` +
        'Consider using ctx_batch_execute to batch queries.';
    }

    const responseBytes = Buffer.byteLength(output, 'utf8');
    trackCall('ctx_search', responseBytes);
    return makeTextResponse(output.trim() || 'No results found.');
  }
);

// ─── Tool: ctx_fetch_and_index ────────────────────────────────────────────────

server.tool(
  'ctx_fetch_and_index',
  'Fetch a URL, convert HTML to markdown, and index it. 24h TTL cache — repeated calls skip the network. Returns a compact summary instead of raw page content.',
  {
    url: z.string().url().describe('URL to fetch and index'),
    queries: z.array(z.string()).optional().describe('Search queries to run after indexing'),
    source: z.string().optional().describe('Custom source label (defaults to URL)'),
    force: z.boolean().optional().default(false).describe('Bypass 24h TTL cache')
  },
  async ({ url, queries, source, force }) => {
    const label = source || url;
    const store = await getStoreAsync();

    // Check TTL cache
    if (!force) {
      const meta = store.getSourceMeta(label);
      if (meta) {
        const indexedAt = new Date(meta.indexedAt + 'Z');
        const ageMs = Date.now() - indexedAt.getTime();
        if (ageMs < TTL_MS) {
          const estimatedBytes = meta.chunkCount * 1600;
          sessionStats.cacheHits++;
          sessionStats.cacheBytesSaved += estimatedBytes;

          const ageStr = ageMs < 3600000
            ? `${Math.round(ageMs / 60000)}m ago`
            : `${Math.round(ageMs / 3600000)}h ago`;

          let output = `Cached: **${meta.label}** — ${meta.chunkCount} sections, indexed ${ageStr} (fresh, TTL: 24h).`;

          // Run queries if provided
          if (queries && queries.length > 0) {
            output += '\n\n';
            for (const q of queries) {
              const results = store.searchWithFallback(q, 2, label);
              output += `## "${q}"\n\n`;
              for (const r of results) {
                output += `### ${r.title}\n${r.snippet || r.content}\n\n`;
              }
            }
          }

          trackCall('ctx_fetch_and_index', Buffer.byteLength(output, 'utf8'));
          return makeTextResponse(output);
        }
      }
    }

    // Fetch via sandboxed subprocess
    const executor = getExecutor();
    const fetchCode = `
const url = ${JSON.stringify(url)};
try {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'context-mode/1.0 (MCP plugin)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000)
  });
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  console.log('__CM_CT__:' + ct);
  console.log(text);
} catch (err) {
  console.error('Fetch error: ' + err.message);
  process.exit(1);
}
`;

    let result;
    try {
      result = await executor.execute({ language: 'javascript', code: fetchCode, timeout: 20000 });
    } catch (err) {
      process.stderr.write(`[context-mode] ctx_fetch_and_index spawn failed: ${err.message}\n`);
      return makeErrorResponse(`Fetch failed: ${err.message}`);
    }

    if (result.exitCode !== 0) {
      return makeErrorResponse(`Failed to fetch ${url}: ${result.stderr || 'unknown error'}`);
    }

    const stdout = result.stdout || '';
    const rawBytes = Buffer.byteLength(stdout, 'utf8');
    sessionStats.bytesSandboxed += rawBytes;

    // Parse content type marker
    const ctMatch = stdout.match(/^__CM_CT__:(.+)$/m);
    const contentType = ctMatch ? ctMatch[1].trim() : 'text/html';
    const content = stdout.replace(/^__CM_CT__:.+\n/, '');

    // Convert HTML to markdown if needed
    let indexContent = content;
    if (contentType.includes('html')) {
      try {
        const { default: TurndownService } = await import('turndown');
        const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
        try {
          const { gfm } = await import('turndown-plugin-gfm');
          td.use(gfm);
        } catch { /* gfm plugin optional */ }
        indexContent = td.turndown(content);
      } catch {
        // Turndown not available, use raw content
        indexContent = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    }

    // Index content
    let indexResult;
    if (contentType.includes('json')) {
      indexResult = store.indexJSON(indexContent, label);
    } else {
      indexResult = store.index({ content: indexContent, source: label });
    }

    sessionStats.bytesIndexed += rawBytes;

    // Build response
    const preview = indexContent.slice(0, 3000);
    let output = `Indexed: **${label}** — ${indexResult.totalChunks} chunks from ${formatBytes(rawBytes)} page.\n\n`;
    output += `Preview (first 3KB):\n${preview}\n`;

    // Run queries if provided
    if (queries && queries.length > 0) {
      output += '\n';
      for (const q of queries) {
        const results = store.searchWithFallback(q, 2, label);
        output += `## "${q}"\n\n`;
        for (const r of results) {
          output += `### ${r.title}\n${r.snippet || r.content}\n\n`;
        }
      }
    }

    trackCall('ctx_fetch_and_index', Buffer.byteLength(output, 'utf8'));
    return makeTextResponse(output.trim());
  }
);

// ─── Tool: ctx_batch_execute ──────────────────────────────────────────────────

server.tool(
  'ctx_batch_execute',
  'Run multiple commands and/or search queries in a single call. Minimizes round-trips. Commands are executed sequentially, all output is auto-indexed, and queries run against the combined index.',
  {
    commands: z.array(z.object({
      label: z.string().describe('Label for this command'),
      language: z.enum([
        'javascript', 'typescript', 'python', 'shell', 'ruby',
        'go', 'rust', 'php', 'perl', 'r', 'elixir'
      ]).optional().default('shell').describe('Language (default: shell)'),
      code: z.string().describe('Code to execute')
    })).optional().default([]).describe('Commands to execute'),
    queries: z.array(z.string()).optional().default([]).describe('Search queries to run against indexed output'),
    timeout: z.number().optional().default(BATCH_TIMEOUT).describe('Total timeout for all commands')
  },
  async ({ commands, queries, timeout }) => {
    const executor = getExecutor();
    const store = await getStoreAsync();
    let totalOutput = '';
    let remaining = timeout;
    const startTime = Date.now();

    // Execute commands
    for (const cmd of commands) {
      const cmdStart = Date.now();
      let result;
      try {
        result = await executor.execute({
          language: cmd.language,
          code: cmd.code,
          timeout: Math.max(remaining, 5000)
        });
      } catch (err) {
        process.stderr.write(`[context-mode] ctx_batch_execute command failed: ${err.message}\n`);
        totalOutput += `### ${cmd.label || 'command'}\nError: ${err.message}\n\n`;
        continue;
      }

      const elapsed = Date.now() - cmdStart;
      remaining -= elapsed;

      const rawBytes = Buffer.byteLength(result.stdout + result.stderr, 'utf8');
      sessionStats.bytesSandboxed += rawBytes;

      totalOutput += `# ${cmd.label}\n\n`;
      if (result.exitCode !== 0) {
        totalOutput += `Exit code: ${result.exitCode}\n`;
      }
      if (result.stderr && result.stderr.trim()) {
        totalOutput += `stderr: ${result.stderr.trim()}\n`;
      }
      totalOutput += `${result.stdout || '(no output)'}\n\n`;

      if (remaining <= 0) {
        totalOutput += `\n⏱ Batch timeout reached after ${commands.indexOf(cmd) + 1}/${commands.length} commands.\n`;
        break;
      }
    }

    // Index combined output
    const batchSource = `batch:${commands.map(c => c.label).join(',')}:${Date.now()}`;
    if (totalOutput.trim()) {
      store.index({ content: totalOutput, source: batchSource });
      sessionStats.bytesIndexed += Buffer.byteLength(totalOutput, 'utf8');
    }

    // Build response
    let output = `Batch complete: ${commands.length} commands executed in ${Date.now() - startTime}ms.\n`;
    output += `Indexed as "${batchSource}" (${formatBytes(Buffer.byteLength(totalOutput, 'utf8'))}).\n\n`;

    // Run search queries
    if (queries.length > 0) {
      for (const q of queries) {
        const results = store.searchWithFallback(q, 2, batchSource);
        output += `## "${q}"\n\n`;
        if (results.length === 0) {
          output += 'No results.\n\n';
        } else {
          for (const r of results) {
            output += `### ${r.title}\n${r.snippet || r.content}\n\n`;
          }
        }
      }
    }

    // Get distinctive terms
    try {
      const terms = store.getDistinctiveTerms(batchSource, 10);
      if (terms.length > 0) {
        output += `\nKey terms: ${terms.join(', ')}`;
      }
    } catch { /* ignore */ }

    trackCall('ctx_batch_execute', Buffer.byteLength(output, 'utf8'));
    return makeTextResponse(output.trim());
  }
);

// ─── Tool: ctx_stats ──────────────────────────────────────────────────────────

server.tool(
  'ctx_stats',
  'Show context savings statistics for the current session.',
  {},
  async () => {
    const elapsed = Date.now() - sessionStats.sessionStart;
    const elapsedMin = Math.round(elapsed / 60000);

    let output = `# Context Mode Stats (session: ${elapsedMin}m)\n\n`;

    // Per-tool stats
    output += '## Tool Calls\n';
    const totalCalls = Object.values(sessionStats.calls).reduce((a, b) => a + b, 0);
    for (const [tool, count] of Object.entries(sessionStats.calls)) {
      const bytes = sessionStats.bytesReturned[tool] || 0;
      output += `- ${tool}: ${count} calls, ${formatBytes(bytes)} returned\n`;
    }
    output += `\nTotal calls: ${totalCalls}\n\n`;

    // Savings
    output += '## Context Savings\n';
    output += `- Bytes sandboxed (kept out of context): ${formatBytes(sessionStats.bytesSandboxed)}\n`;
    output += `- Bytes indexed: ${formatBytes(sessionStats.bytesIndexed)}\n`;
    const totalReturned = Object.values(sessionStats.bytesReturned).reduce((a, b) => a + b, 0);
    output += `- Bytes returned to context: ${formatBytes(totalReturned)}\n`;

    if (sessionStats.bytesSandboxed > 0) {
      const ratio = ((1 - totalReturned / sessionStats.bytesSandboxed) * 100).toFixed(1);
      output += `- Savings ratio: ${ratio}%\n`;
    }

    // Cache
    output += '\n## Cache\n';
    output += `- Cache hits: ${sessionStats.cacheHits}\n`;
    output += `- Network requests saved: ${sessionStats.cacheHits}\n`;
    output += `- Estimated bytes saved by cache: ${formatBytes(sessionStats.cacheBytesSaved)}\n`;

    trackCall('ctx_stats', Buffer.byteLength(output, 'utf8'));
    return makeTextResponse(output.trim());
  }
);

// ─── Tool: ctx_doctor ─────────────────────────────────────────────────────────

server.tool(
  'ctx_doctor',
  'Diagnose the context-mode plugin environment.',
  {},
  async () => {
    let output = `# Context Mode Doctor\n\n`;
    output += `Version: ${VERSION}\n`;
    output += `Platform: ${process.platform} (${process.arch})\n`;
    output += `Node.js: ${process.version}\n`;
    output += `Plugin root: ${PLUGIN_ROOT}\n`;
    output += `Data directory: ${PLUGIN_DATA}\n\n`;

    // Runtimes
    const runtimes = getRuntimes();
    output += `## Runtimes (${Object.keys(runtimes).length} detected)\n`;
    output += getRuntimeSummary(runtimes) + '\n\n';

    // FTS5 check
    output += '## SQLite FTS5\n';
    try {
      const store = await getStoreAsync();
      output += 'FTS5: OK (porter + trigram tokenizers available)\n\n';
    } catch (err) {
      output += `FTS5: FAILED — ${err.message}\n\n`;
    }

    // Hook scripts
    output += '## Hook Scripts\n';
    const hooks = ['posttooluse.js', 'precompact.js', 'sessionstart.js', 'pretooluse.js', 'userpromptsubmit.js'];
    for (const hook of hooks) {
      const hookPath = join(PLUGIN_ROOT, 'hooks', hook);
      const exists = existsSync(hookPath);
      output += `- ${hook}: ${exists ? 'OK' : 'MISSING'}\n`;
    }

    // Data directories
    output += '\n## Data Directories\n';
    output += `- Content: ${existsSync(CONTENT_DIR) ? 'OK' : 'MISSING'} (${CONTENT_DIR})\n`;
    output += `- Sessions: ${existsSync(SESSIONS_DIR) ? 'OK' : 'MISSING'} (${SESSIONS_DIR})\n`;

    trackCall('ctx_doctor', Buffer.byteLength(output, 'utf8'));
    return makeTextResponse(output.trim());
  }
);

// ─── Tool: ctx_purge ──────────────────────────────────────────────────────────

server.tool(
  'ctx_purge',
  'Permanently delete all indexed knowledge base content for the current project.',
  {
    confirm: z.boolean().describe('Must be true to confirm deletion')
  },
  async ({ confirm }) => {
    if (!confirm) {
      return makeErrorResponse('Set confirm: true to delete all indexed content.');
    }

    // Delete content DB
    const dbPath = join(CONTENT_DIR, `${getProjectHash()}.db`);
    for (const suffix of ['', '-wal', '-shm']) {
      const p = dbPath + suffix;
      try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
    }

    // Reset store
    _store = null;

    // Reset stats
    sessionStats.bytesIndexed = 0;
    sessionStats.cacheHits = 0;
    sessionStats.cacheBytesSaved = 0;

    trackCall('ctx_purge', 50);
    return makeTextResponse('All indexed content has been purged for this project.');
  }
);

// ─── Lifecycle ────────────────────────────────────────────────────────────────

function shutdown() {
  try { getExecutor().cleanup(); } catch { /* ignore */ }
  try {
    if (_store && typeof _store.close === 'function') _store.close();
  } catch { /* ignore */ }
}

process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
process.on('exit', shutdown);

// Lifecycle guard: detect parent death via stdin close
process.stdin.on('end', () => { shutdown(); process.exit(0); });
process.stdin.resume();

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Cleanup stale DBs (older than 14 days)
  try {
    const { readdirSync, statSync } = await import('node:fs');
    const now = Date.now();
    const maxAge = 14 * 24 * 60 * 60 * 1000;
    for (const dir of [CONTENT_DIR, SESSIONS_DIR]) {
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.db')) continue;
        const fPath = join(dir, file);
        try {
          const stat = statSync(fPath);
          if (now - stat.mtimeMs > maxAge) {
            for (const suffix of ['', '-wal', '-shm']) {
              try { unlinkSync(fPath + suffix); } catch { /* ignore */ }
            }
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore cleanup errors */ }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[context-mode] MCP server v${VERSION} started (${process.platform})\n`);
}

main().catch(err => {
  process.stderr.write(`[context-mode] Fatal: ${err.message}\n`);
  process.exit(1);
});
