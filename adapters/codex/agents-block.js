/**
 * agents-block.js — Sentinel-delimited AGENTS.md section for Codex.
 *
 * Codex reads ~/.codex/AGENTS.md then project AGENTS.md
 * (developers.openai.com/codex/guides/agents-md). We never overwrite
 * the rest of the file. Upgrade = replace the marked block.
 */

export const START = '<!-- context-mode:start -->';
export const END = '<!-- context-mode:end -->';

export function agentsBlock({ version, mcpTool }) {
  const t = (name) => mcpTool(name);
  return `${START}
# context-mode (Codex)

Raw tool output floods the context window. Keep raw data in the sandbox.

Platform: **Codex CLI** (OpenAI)
Version: **${version}**
MCP server name: \`context-mode\`
Hook file: \`~/.codex/hooks.json\` (PreToolUse matcher: \`Bash\`)

This block is managed by \`node install.js --adapter codex\`. Do not edit between the sentinels.

## Think in Code — MANDATORY

When you need to analyze, count, filter, compare, search, parse, transform, or process data: **write code** that does the work via \`${t('ctx_execute')}\` and print only the answer. Do NOT read raw data into context to process mentally. Your role is to PROGRAM the analysis, not to COMPUTE it.

## Tool map (Codex → context-mode)

| Codex tool | Use instead |
|---|---|
| \`Bash\` / \`exec_command\` | \`${t('ctx_execute')}\` / \`${t('ctx_batch_execute')}\` for anything >20 lines |
| \`apply_patch\` | keep for file edits — do **not** route file writes through ctx_execute |
| web fetch / curl in Bash | \`${t('ctx_fetch_and_index')}\` then \`${t('ctx_search')}\` |

## Decision tree

1. **GATHER** — \`${t('ctx_batch_execute')}(commands, queries)\`. One call replaces many.
2. **FOLLOW-UP** — \`${t('ctx_search')}(queries: [...])\`.
3. **PROCESSING** — \`${t('ctx_execute')}\` / \`${t('ctx_execute_file')}\`.
4. **WEB** — \`${t('ctx_fetch_and_index')}(url)\` then \`${t('ctx_search')}\`. Never dump raw HTML.

## Rules

- DO NOT use \`Bash\` for commands producing >20 lines of output.
- DO NOT use \`Bash\` curl/wget to fetch pages.
- \`Bash\` is ONLY for git, mkdir, rm, mv, navigation, and short commands.
- File creates/edits stay on \`apply_patch\`. Never write files through \`${t('ctx_execute')}\`.

## Output

- Keep responses under 500 words unless asked otherwise.
- Write artifacts to files — do not paste them inline.
- Return file path + one-line description.

## Health check

When the user says "ctx doctor" or "ctx-doctor": call \`${t('ctx_doctor')}\` and show the result.
When the user says "ctx stats": call \`${t('ctx_stats')}\`.
${END}
`;
}

export function mergeAgentsMarkdown(existing, block) {
  const src = String(existing || '');
  const start = src.indexOf(START);
  const end = src.indexOf(END);
  if (start >= 0 && end > start) {
    const after = src.slice(end + END.length);
    return src.slice(0, start) + block.trimEnd() + (after.startsWith('\n') ? after : `\n${after}`);
  }
  if (!src.trim()) return `${block.trimEnd()}\n`;
  const sep = src.endsWith('\n') ? '\n' : '\n\n';
  return `${src}${sep}${block.trimEnd()}\n`;
}

export function agentsHasBlock(text) {
  return typeof text === 'string' && text.includes(START) && text.includes(END);
}
