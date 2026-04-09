/**
 * Event extraction from hook input.
 * Parses tool call data into structured session events with priorities.
 *
 * Priority levels:
 *   1 (CRITICAL) — Files, tasks, last prompt
 *   2 (HIGH)     — Errors, cwd changes, env, tasks
 *   3 (NORMAL)   — Git, decisions, subagents, skills
 *   4 (LOW)      — Data, environment details
 */

// ─── Event Priority ───────────────────────────────────────────────────────────

const Priority = {
  CRITICAL: 1,
  HIGH: 2,
  NORMAL: 3,
  LOW: 4
};

// ─── Event Extraction ─────────────────────────────────────────────────────────

/**
 * Extract session events from a PostToolUse hook input.
 * Returns array of { type, category, data, priority }.
 */
export function extractEvents(input) {
  const events = [];
  if (!input) return events;

  const toolName = input.tool_name || input.toolName || '';
  const toolInput = input.tool_input || input.toolInput || {};
  const toolOutput = input.tool_output || input.toolOutput || {};
  const isError = toolOutput.isError || toolOutput.is_error || false;

  // ─── File Operations (Priority 1) ─────────────────────────────────────

  if (toolName === 'Read' || toolName === 'read_file') {
    const path = toolInput.path || toolInput.file_path || '';
    if (path) {
      events.push({
        type: 'file_read',
        category: 'file',
        data: path,
        priority: Priority.CRITICAL
      });

      // Check if it's a rules file
      if (isRulesFile(path)) {
        events.push({
          type: 'rule',
          category: 'rule',
          data: `Rules file read: ${path}`,
          priority: Priority.CRITICAL
        });
      }
    }
  }

  if (toolName === 'Write' || toolName === 'write_file') {
    const path = toolInput.path || toolInput.file_path || '';
    if (path) {
      events.push({
        type: 'file_write',
        category: 'file',
        data: path,
        priority: Priority.CRITICAL
      });
    }
  }

  if (toolName === 'Edit' || toolName === 'edit_file') {
    const path = toolInput.path || toolInput.file_path || '';
    if (path) {
      events.push({
        type: 'file_edit',
        category: 'file',
        data: path,
        priority: Priority.CRITICAL
      });
    }
  }

  // ─── Task Operations (Priority 1-2) ───────────────────────────────────

  if (toolName === 'TodoWrite' || toolName === 'todo_write') {
    const todos = toolInput.todos || [];
    for (const todo of todos) {
      events.push({
        type: todo.status === 'completed' ? 'task_update' : 'task',
        category: 'task',
        data: JSON.stringify({
          content: todo.content,
          status: todo.status,
          activeForm: todo.activeForm
        }),
        priority: todo.status === 'in_progress' ? Priority.CRITICAL : Priority.HIGH
      });
    }
  }

  // ─── Error Events (Priority 2) ────────────────────────────────────────

  if (isError) {
    const errorData = typeof toolOutput.content === 'string'
      ? toolOutput.content
      : JSON.stringify(toolOutput.content || toolOutput);

    events.push({
      type: 'error_tool',
      category: 'error',
      data: JSON.stringify({
        tool: toolName,
        error: errorData.slice(0, 500) // Truncate error data
      }),
      priority: Priority.HIGH
    });
  }

  // ─── Bash / Shell Commands ────────────────────────────────────────────

  if (toolName === 'Bash' || toolName === 'bash' || toolName === 'execute_command') {
    const command = toolInput.command || toolInput.cmd || '';

    // CWD changes (Priority 2)
    if (/\bcd\s+/.test(command)) {
      events.push({
        type: 'cwd',
        category: 'cwd',
        data: command,
        priority: Priority.HIGH
      });
    }

    // Git operations (Priority 3)
    if (/\bgit\s+(commit|push|merge|rebase|pull|checkout|branch|stash|reset|diff|status|log)\b/.test(command)) {
      events.push({
        type: 'git',
        category: 'git',
        data: command.slice(0, 200),
        priority: Priority.NORMAL
      });
    }

    // Package installs (Priority 2)
    if (/\b(npm|yarn|pnpm|pip|cargo|gem)\s+(install|add|update|upgrade)\b/.test(command)) {
      events.push({
        type: 'env',
        category: 'env',
        data: `Package operation: ${command.slice(0, 200)}`,
        priority: Priority.HIGH
      });
    }

    // Non-zero exit (Priority 2)
    const exitCode = toolOutput.exitCode || toolOutput.exit_code;
    if (exitCode && exitCode !== 0 && !isError) {
      events.push({
        type: 'error_tool',
        category: 'error',
        data: JSON.stringify({
          tool: 'Bash',
          command: command.slice(0, 200),
          exitCode
        }),
        priority: Priority.HIGH
      });
    }
  }

  // ─── Sub-agent Events (Priority 3) ────────────────────────────────────

  if (toolName === 'Agent' || toolName === 'agent') {
    events.push({
      type: 'subagent',
      category: 'subagent',
      data: JSON.stringify({
        description: toolInput.description || '',
        prompt: (toolInput.prompt || '').slice(0, 300),
        subagent_type: toolInput.subagent_type || 'general-purpose'
      }),
      priority: Priority.NORMAL
    });
  }

  // ─── MCP Tool Calls (Priority 3) ──────────────────────────────────────

  if (toolName.startsWith('mcp__') || toolName.startsWith('ctx_')) {
    events.push({
      type: 'mcp_call',
      category: 'mcp',
      data: JSON.stringify({
        tool: toolName,
        input_keys: Object.keys(toolInput)
      }),
      priority: Priority.NORMAL
    });
  }

  // ─── Skill Invocations (Priority 3) ───────────────────────────────────

  if (toolName === 'Skill' || toolName === 'skill') {
    events.push({
      type: 'skill',
      category: 'skill',
      data: JSON.stringify({
        skill: toolInput.skill || toolInput.name || '',
        args: toolInput.args || ''
      }),
      priority: Priority.NORMAL
    });
  }

  return events;
}

// ─── Helper ─────────────────────────────────────────────────────────────────

function isRulesFile(path) {
  const lower = path.toLowerCase().replace(/\\/g, '/');
  return lower.includes('claude.md') ||
    lower.includes('.claude/') ||
    lower.endsWith('.cursorrules') ||
    lower.endsWith('.windsurfrules');
}
