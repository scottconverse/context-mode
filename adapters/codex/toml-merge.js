/**
 * toml-merge.js — Tiny TOML table upsert. No parser dependency.
 *
 * Used by the Codex installer to write [mcp_servers.context-mode] into
 * ~/.codex/config.toml without touching any other table.
 *
 * Handles:
 *   - missing file (caller creates)
 *   - existing context-mode table (replace, including nested .env)
 *   - other mcp_servers.* tables (leave them alone)
 */

const TABLE_RE = /^\s*\[([^\]]+)\]\s*$/;

export function tomlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Remove every table whose name is `tableName` or `tableName.*`, then
 * append `[tableName]` followed by `bodyLines`.
 */
export function upsertTomlTable(text, tableName, bodyLines) {
  const src = String(text || '').replace(/\r\n/g, '\n');
  const lines = src.length ? src.split('\n') : [];
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(TABLE_RE);
    if (m && (m[1] === tableName || m[1].startsWith(`${tableName}.`))) {
      i += 1;
      while (i < lines.length) {
        const n = lines[i].match(TABLE_RE);
        if (n && !(n[1] === tableName || n[1].startsWith(`${tableName}.`))) break;
        i += 1;
      }
      continue;
    }
    out.push(lines[i]);
    i += 1;
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  if (out.length) out.push('');
  out.push(`[${tableName}]`);
  for (const line of bodyLines) out.push(line);
  if (!bodyLines.length || bodyLines[bodyLines.length - 1] !== '') out.push('');
  return out.join('\n');
}

/**
 * Build the body of [mcp_servers.context-mode] plus nested .env table.
 * Nested table is included in bodyLines; upsertTomlTable treats
 * mcp_servers.context-mode.env as part of the same family when removing.
 */
export function mcpServerBody({ command, args, env, startupTimeout = 15, toolTimeout = 120 }) {
  const lines = [
    `command = ${tomlString(command)}`,
    `args = [${args.map(tomlString).join(', ')}]`,
    'startup_timeout_sec = ' + Number(startupTimeout),
    'tool_timeout_sec = ' + Number(toolTimeout),
    '',
    '[mcp_servers.context-mode.env]',
  ];
  for (const [key, value] of Object.entries(env || {})) {
    lines.push(`${key} = ${tomlString(value)}`);
  }
  return lines;
}

export function upsertMcpServer(tomlText, spec) {
  return upsertTomlTable(tomlText, 'mcp_servers.context-mode', mcpServerBody(spec));
}

export function hasMcpServer(tomlText, name = 'context-mode') {
  const re = new RegExp(`^\\s*\\[mcp_servers\\.${name}(?:\\.|\\])`, 'm');
  return re.test(String(tomlText || ''));
}
