#!/usr/bin/env node
/**
 * Host-agnostic hook dispatcher.
 *
 *   node hooks/dispatch.js <platform> <event>
 *
 * Reads a hook payload on stdin (any host's shape), normalizes it to the
 * Claude-shaped { tool_name, tool_input, session_id } object, then:
 *   - preToolUse: runs the declarative router and writes a decision
 *   - other events: forwards the normalized payload to the existing handler
 *
 * Generated adapter hooks.json files call this. Claude Code / Cowork keep
 * using the original per-event scripts directly.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdin } from './core/stdin.js';
import { routePreToolUse } from './core/routing.js';
import { formatDecision } from './core/formatters.js';
import { getAdapter } from '../adapters/catalog.js';
import {
  normalizeEventName,
  normalizeHookPayload,
} from './core/platform.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const EVENT_SCRIPT = {
  preToolUse: 'pretooluse.js',
  postToolUse: 'posttooluse.js',
  preCompact: 'precompact.js',
  sessionStart: 'sessionstart.js',
  userPromptSubmit: 'userpromptsubmit.js',
  stop: 'subagent-stop.js',
};

function parseInput(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function forward(script, payload) {
  const child = spawn(process.execPath, [join(__dirname, script)], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: process.env,
  });
  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();
  let out = '';
  for await (const chunk of child.stdout) out += chunk;
  if (out) process.stdout.write(out);
  const code = await new Promise((resolve) => child.on('close', resolve));
  return code ?? 0;
}

const platformId = process.argv[2] || process.env.CONTEXT_MODE_PLATFORM || 'claude-code';
const event = normalizeEventName(process.argv[3] || 'preToolUse');
process.env.CONTEXT_MODE_PLATFORM = platformId;

const adapter = getAdapter(platformId);
const raw = await readStdin();
const src = parseInput(raw);
const normalized = normalizeHookPayload(src, adapter);

try {
  if (event === 'preToolUse') {
    const decision = routePreToolUse(
      normalized.tool_name,
      normalized.tool_input,
      process.env.CONTEXT_MODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR,
    );
    const response = formatDecision(decision);
    if (response !== null) {
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  } else {
    const script = EVENT_SCRIPT[event];
    if (!script) {
      process.stderr.write(`[context-mode] dispatch: unknown event ${event}\n`);
      process.exit(0);
    }
    const code = await forward(script, {
      ...src,
      tool_name: normalized.tool_name,
      tool_input: normalized.tool_input,
      session_id: normalized.session_id || src.session_id,
    });
    process.exit(code);
  }
} catch (err) {
  process.stderr.write(`[context-mode] dispatch error: ${err.message}\n`);
}
