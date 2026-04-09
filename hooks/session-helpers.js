/**
 * Session helper utilities for hook scripts.
 * Shared by PostToolUse, PreCompact, SessionStart hooks.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

// ─── Stdin Reader ─────────────────────────────────────────────────────────────

/**
 * Read all of stdin as a string (hook input JSON).
 */
export function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      let text = chunks.join('');
      // Strip BOM if present
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      resolve(text);
    });
    process.stdin.on('error', reject);

    // Safety timeout — hooks must complete fast
    setTimeout(() => resolve(chunks.join('')), 5000);
  });
}

/**
 * Parse hook input from stdin.
 */
export async function parseHookInput() {
  const raw = await readStdin();
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ─── Project Directory ────────────────────────────────────────────────────────

/**
 * Get the project directory.
 */
export function getProjectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

// ─── Session ID ───────────────────────────────────────────────────────────────

/**
 * Extract session ID from hook input, env, or generate one.
 * Priority chain:
 *   transcript_path UUID > conversation_id > sessionId > session_id > env > pid
 */
export function getSessionId(input = {}) {
  // From transcript path (extract UUID)
  if (input.transcript_path) {
    const uuidMatch = input.transcript_path.match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
    );
    if (uuidMatch) return uuidMatch[1];
  }

  // From explicit fields
  if (input.conversation_id) return input.conversation_id;
  if (input.sessionId) return input.sessionId;
  if (input.session_id) return input.session_id;

  // From environment
  if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;

  // Fallback: parent PID based
  return `pid-${process.ppid || process.pid}`;
}

// ─── Database Paths ───────────────────────────────────────────────────────────

/**
 * Get the directory for session databases.
 */
function getSessionDBDir() {
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (pluginData) return join(pluginData, 'sessions');

  // Fallback to ~/.claude/context-mode/sessions/
  return join(homedir(), '.claude', 'context-mode', 'sessions');
}

/**
 * Get the session database path for the current project.
 */
export function getSessionDBPath() {
  const projectDir = getProjectDir();
  const hash = createHash('sha256').update(projectDir).digest('hex').slice(0, 16);
  const dir = getSessionDBDir();
  return join(dir, `${hash}.db`);
}

/**
 * Get the session events markdown file path (for auto-indexing).
 */
export function getSessionEventsPath() {
  const projectDir = getProjectDir();
  const hash = createHash('sha256').update(projectDir).digest('hex').slice(0, 16);
  const dir = getSessionDBDir();
  return join(dir, `${hash}-events.md`);
}

// ─── Worktree Detection ───────────────────────────────────────────────────────

/**
 * Detect if we're in a git worktree and return a suffix for session isolation.
 */
export function getWorktreeSuffix() {
  // Override via env
  if (process.env.CONTEXT_MODE_SESSION_SUFFIX) {
    return process.env.CONTEXT_MODE_SESSION_SUFFIX;
  }

  try {
    const gitDir = execSync('git rev-parse --git-dir', {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    // If .git is a file (not a dir), we're in a worktree
    if (existsSync(gitDir) && !gitDir.endsWith('.git')) {
      const cwd = process.cwd();
      const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 8);
      return `__${hash}`;
    }
  } catch {
    // Not in a git repo, no suffix needed
  }

  return '';
}
