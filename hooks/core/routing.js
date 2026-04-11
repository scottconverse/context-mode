/**
 * routing.js — Declarative routing engine for PreToolUse hooks.
 *
 * Iterates ROUTING_RULES and executes the first matching rule.
 * Returns a normalized decision object or null for passthrough.
 *
 * Decision types:
 * - { action: "deny", reason: string }
 * - { action: "modify", updatedInput: object }
 * - { action: "context", additionalContext: string }
 * - null (passthrough)
 *
 * Ported from mksglu/context-mode (https://github.com/mksglu/context-mode)
 * by @mksglu, licensed under Elastic License 2.0.
 */

import {
  ROUTING_BLOCK, READ_GUIDANCE, GREP_GUIDANCE, BASH_GUIDANCE,
} from '../routing-block.js';
import { createToolNamer } from './tool-naming.js';
import { ROUTING_RULES } from './routing-rules.js';
import { existsSync, mkdirSync, rmSync, openSync, closeSync, constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// ── Guidance throttle ─────────────────────────────────────────────────────
// Show each advisory type at most once per session.
// Hybrid: in-memory Set (same-process / vitest) + file markers (cross-process).
const _guidanceShown = new Set();
const _guidanceId = process.env.VITEST_WORKER_ID
  ? `${process.ppid}-w${process.env.VITEST_WORKER_ID}`
  : String(process.ppid);
const _guidanceDir = resolve(tmpdir(), `context-mode-guidance-${_guidanceId}`);

function guidanceOnce(type, content) {
  if (_guidanceShown.has(type)) return null;
  try { mkdirSync(_guidanceDir, { recursive: true }); } catch {}
  const marker = resolve(_guidanceDir, type);
  try {
    const fd = openSync(marker, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
    closeSync(fd);
  } catch {
    _guidanceShown.add(type);
    return null;
  }
  _guidanceShown.add(type);
  return { action: 'context', additionalContext: content };
}

export function resetGuidanceThrottle() {
  _guidanceShown.clear();
  try { rmSync(_guidanceDir, { recursive: true, force: true }); } catch {}
}

// ── Pre-processors ────────────────────────────────────────────────────────

/** Strip heredoc content so regex doesn't match inside heredoc bodies. */
function stripHeredocs(cmd) {
  return cmd.replace(/<<-?\s*["']?(\w+)["']?[\s\S]*?\n\s*\1/g, '');
}

/**
 * Strip ALL quoted content (heredocs + single + double quotes) so regex
 * only matches command tokens — prevents false positives like
 * `gh issue edit --body "text with curl in it"` (Issue #63).
 */
function stripQuotedContent(cmd) {
  return stripHeredocs(cmd)
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""');
}

const PREPROCESSORS = {
  stripHeredocs,
  stripQuotedContent,
};

// ── Message template expansion ────────────────────────────────────────────

function expandMessage(template, t) {
  return `context-mode: ${template}`
    .replace(/\{TOOL\}/g, t('ctx_execute'))
    .replace(/\{FETCH\}/g, t('ctx_fetch_and_index'))
    .replace(/\{SEARCH\}/g, t('ctx_search'));
}

// ── Guidance content map ──────────────────────────────────────────────────

const GUIDANCE_CONTENT = {
  bash: BASH_GUIDANCE,
  read: READ_GUIDANCE,
  grep: GREP_GUIDANCE,
};

// ── Main export ───────────────────────────────────────────────────────────

/**
 * Route a PreToolUse event. Returns normalized decision object or null.
 *
 * @param {string} toolName   - The tool name (canonical Claude Code name)
 * @param {object} toolInput  - The tool input/parameters
 * @param {string} [projectDir] - Project directory (reserved for future use)
 */
export function routePreToolUse(toolName, toolInput, projectDir) {
  const t = createToolNamer();

  // ── MCP passthrough rules (before ROUTING_RULES table) ────────────────
  // ctx_execute, ctx_execute_file, ctx_batch_execute always pass through.
  if (
    (toolName.includes('context-mode') && /(?:__|\/)(ctx_)?execute$/.test(toolName)) ||
    /^MCP:(ctx_)?execute$/.test(toolName)
  ) return null;

  if (
    (toolName.includes('context-mode') && /(?:__|\/)(ctx_)?execute_file$/.test(toolName)) ||
    /^MCP:(ctx_)?execute_file$/.test(toolName)
  ) return null;

  if (toolName.includes('context-mode') && /(?:__|\/)(ctx_)?batch_execute$/.test(toolName)) {
    return null;
  }

  // ── Rule table ────────────────────────────────────────────────────────
  for (const rule of ROUTING_RULES) {
    if (rule.tool !== toolName) continue;

    const rawCommand = toolInput.command ?? '';

    // Apply pre-processor
    const preprocessFn = rule.preprocess ? PREPROCESSORS[rule.preprocess] : null;
    const processed = preprocessFn ? preprocessFn(rawCommand) : rawCommand;

    // Match regex
    if (rule.match && !rule.match.test(processed)) continue;

    // ── Guidance (once-per-session advisory) ──────────────────────────
    if (rule.action === 'guidance') {
      return guidanceOnce(rule.guidanceKey, GUIDANCE_CONTENT[rule.guidanceKey]);
    }

    // ── Safety check: if safeWhen passes, allow through ───────────────
    if (rule.safeWhen) {
      if (rule.perSegment) {
        const segments = processed.split(/\s*(?:&&|\|\||;)\s*/);
        const hasDanger = segments.some(seg => {
          if (!rule.match.test(seg)) return false;
          return !rule.safeWhen(processed, seg);
        });
        if (!hasDanger) return null;
      } else {
        if (rule.safeWhen(processed)) return null;
      }
    }

    // ── Dispatch by action ────────────────────────────────────────────
    if (rule.action === 'modify') {
      const msg = expandMessage(rule.message, t).replace(/"/g, '\\"');
      return { action: 'modify', updatedInput: { command: `echo "${msg}"` } };
    }

    if (rule.action === 'deny') {
      const url = toolInput.url ?? '';
      return {
        action: 'deny',
        reason: expandMessage(rule.message, t).replace('url: "..."', `url: "${url}"`),
      };
    }

    if (rule.action === 'inject-routing-block') {
      const subagentType = toolInput.subagent_type ?? '';
      const fieldName = ['prompt', 'request', 'objective', 'question', 'query', 'task']
        .find(f => f in toolInput) ?? 'prompt';
      const prompt = toolInput[fieldName] ?? '';
      const updatedInput = subagentType === 'Bash'
        ? { ...toolInput, [fieldName]: prompt + ROUTING_BLOCK, subagent_type: 'general-purpose' }
        : { ...toolInput, [fieldName]: prompt + ROUTING_BLOCK };
      return { action: 'modify', updatedInput };
    }
  }

  // No rule matched → passthrough
  return null;
}
