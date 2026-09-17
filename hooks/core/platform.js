/**
 * platform.js — Host-agnostic platform + data-dir + tool-name resolver.
 *
 * The compressor, router, knowledge base, and session snapshot never need to
 * know which agent called them. This module is the only place that translates
 * a host tool name / env var into the portable core.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir as osHomedir } from 'node:os';
import { ADAPTERS, getAdapter } from '../../adapters/catalog.js';

export const CANONICAL_TOOLS = Object.freeze(['shell', 'read', 'grep', 'webfetch', 'agent', 'task']);

export const CANONICAL_TO_CLAUDE = Object.freeze({
  shell: 'Bash',
  read: 'Read',
  grep: 'Grep',
  webfetch: 'WebFetch',
  agent: 'Agent',
  task: 'Task',
});

const CANONICAL_SET = new Set(CANONICAL_TOOLS);

let _hostMap;
function hostMap() {
  if (_hostMap) return _hostMap;
  _hostMap = Object.create(null);
  for (const a of ADAPTERS) {
    for (const [host, canonical] of Object.entries(a.toolMap)) {
      _hostMap[host] = canonical;
      _hostMap[host.toLowerCase()] = canonical;
    }
  }
  for (const c of CANONICAL_TOOLS) {
    _hostMap[c] = c;
    _hostMap[c.toLowerCase()] = c;
  }
  for (const [canonical, claude] of Object.entries(CANONICAL_TO_CLAUDE)) {
    _hostMap[claude] = canonical;
    _hostMap[claude.toLowerCase()] = canonical;
  }
  return _hostMap;
}

export function getPlatformId() {
  return process.env.CONTEXT_MODE_PLATFORM || 'claude-code';
}

export function getPlatformAdapter() {
  return getAdapter(getPlatformId()) || getAdapter('generic');
}

/**
 * Resolve the on-disk data directory.
 *
 * Preference order:
 *   1. CONTEXT_MODE_DATA (if expanded)
 *   2. CLAUDE_PLUGIN_DATA (if expanded) — Cowork backward compat
 *   3. ~/.claude/plugins/data/context-mode if that tree exists
 *   4. ~/.context-mode
 *   5. <pluginRoot>/.data
 */
export function resolveDataDir(pluginRoot) {
  const home = process.env.USERPROFILE || process.env.HOME || osHomedir();

  const ctx = process.env.CONTEXT_MODE_DATA;
  if (ctx && !ctx.includes('${') && !ctx.includes('CONTEXT_MODE_DATA')) return ctx;

  const claude = process.env.CLAUDE_PLUGIN_DATA;
  if (claude && !claude.includes('${') && !claude.includes('CLAUDE_PLUGIN_DATA')) return claude;

  const claudeData = join(home, '.claude', 'plugins', 'data', 'context-mode');
  if (existsSync(join(home, '.claude', 'plugins'))) return claudeData;

  if (home) return join(home, '.context-mode');
  return join(pluginRoot, '.data');
}

/**
 * Map a host-specific tool name to a canonical name (shell/read/grep/webfetch/agent/task).
 * Unknown names are returned unchanged so existing exact-match rules still fire.
 */
export function canonicalizeTool(toolName, adapter) {
  if (!toolName) return '';
  if (adapter?.toolMap?.[toolName]) return adapter.toolMap[toolName];
  const map = hostMap();
  if (map[toolName]) return map[toolName];
  const lower = String(toolName).toLowerCase();
  if (map[lower]) return map[lower];
  if (CANONICAL_SET.has(lower)) return lower;
  return toolName;
}

/** Canonical (or host) name → Claude Code tool name used by ROUTING_RULES. */
export function toClaudeToolName(toolName, adapter) {
  const canonical = canonicalizeTool(toolName, adapter);
  return CANONICAL_TO_CLAUDE[canonical] || toolName;
}

/**
 * Normalize a hook payload from any host into the Claude-shaped
 * { tool_name, tool_input, session_id } object the existing handlers expect.
 */
export function normalizeHookPayload(input, adapter) {
  const src = input && typeof input === 'object' ? input : {};
  const hostTool =
    src.tool_name ?? src.toolName ?? src.name ?? src.tool ?? '';
  const rawInput =
    src.tool_input ?? src.toolInput ?? src.input ?? src.params ?? src.arguments ?? {};
  const canonical = canonicalizeTool(hostTool, adapter);
  const toolInput = { ...rawInput };

  if (canonical === 'shell') {
    toolInput.command = rawInput.command ?? rawInput.cmd ?? rawInput.script ?? rawInput.code ?? '';
  }
  if (canonical === 'read') {
    toolInput.file_path =
      rawInput.file_path ?? rawInput.path ?? rawInput.filePath ?? rawInput.target_file ?? '';
  }
  if (canonical === 'grep') {
    toolInput.pattern = rawInput.pattern ?? rawInput.query ?? rawInput.search ?? rawInput.regex ?? '';
  }
  if (canonical === 'webfetch') {
    toolInput.url = rawInput.url ?? rawInput.uri ?? rawInput.href ?? '';
  }

  const sessionId =
    src.session_id ?? src.sessionId ?? src.conversation_id ?? src.conversationId ?? '';

  return {
    tool_name: toClaudeToolName(hostTool, adapter),
    tool_input: toolInput,
    session_id: sessionId,
    canonical,
    host_tool: hostTool,
  };
}

export function normalizeEventName(event) {
  if (!event) return '';
  const key = String(event).replace(/[._]/g, '').toLowerCase();
  const map = {
    pretooluse: 'preToolUse',
    beforetool: 'preToolUse',
    toolexecutebefore: 'preToolUse',
    toolcallbefore: 'preToolUse',
    posttooluse: 'postToolUse',
    aftertool: 'postToolUse',
    toolexecuteafter: 'postToolUse',
    toolcallafter: 'postToolUse',
    precompact: 'preCompact',
    precompress: 'preCompact',
    compacting: 'preCompact',
    sessionstart: 'sessionStart',
    commandnew: 'sessionStart',
    stop: 'stop',
    agentstop: 'stop',
    subagentstop: 'stop',
    userpromptsubmit: 'userPromptSubmit',
  };
  return map[key] || event;
}
