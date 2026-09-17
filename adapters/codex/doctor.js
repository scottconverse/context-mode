/**
 * Codex-specific ctx_doctor checks. Pure filesystem — no Codex binary required.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { hasMcpServer } from './toml-merge.js';
import { hooksJsonHasDispatch, DISPATCH_MARK } from './hooks-merge.js';
import { agentsHasBlock } from './agents-block.js';

export function diagnoseCodex({
  home = homedir(),
  dataDir,
  projectDir = process.cwd(),
} = {}) {
  const lines = [];
  const codexHome = process.env.CODEX_HOME || join(home, '.codex');
  const resolvedData = dataDir || process.env.CONTEXT_MODE_DATA || join(home, '.context-mode');
  const hooksPath = join(codexHome, 'hooks.json');
  const tomlPath = join(codexHome, 'config.toml');
  const pluginDispatch = join(resolvedData, 'plugin', 'hooks', 'dispatch.js');
  const projectAgents = join(projectDir, 'AGENTS.md');
  const globalAgents = join(codexHome, 'AGENTS.md');

  const checks = [];

  function check(name, ok, detail) {
    checks.push({ name, ok, detail });
    lines.push(`- ${name}: ${ok ? 'OK' : 'MISSING'} ${detail ? `(${detail})` : ''}`);
  }

  let hooksText = '';
  if (existsSync(hooksPath)) {
    try { hooksText = readFileSync(hooksPath, 'utf8'); } catch { hooksText = ''; }
  }
  check('~/.codex/hooks.json', existsSync(hooksPath), hooksPath);
  check('hooks.json dispatch.js', hooksJsonHasDispatch(hooksText), DISPATCH_MARK);

  let tomlText = '';
  if (existsSync(tomlPath)) {
    try { tomlText = readFileSync(tomlPath, 'utf8'); } catch { tomlText = ''; }
  }
  check('~/.codex/config.toml', existsSync(tomlPath), tomlPath);
  check('[mcp_servers.context-mode]', hasMcpServer(tomlText));
  check('plugin dispatch.js', existsSync(pluginDispatch), pluginDispatch);

  const projectOk = existsSync(projectAgents) && agentsHasBlock(readFileSync(projectAgents, 'utf8'));
  const globalOk = existsSync(globalAgents) && agentsHasBlock(readFileSync(globalAgents, 'utf8'));
  check('AGENTS.md sentinel', projectOk || globalOk, projectOk ? projectAgents : globalAgents);

  const failed = checks.filter((c) => !c.ok);
  lines.push('');
  lines.push('Smoke test (run in Codex, not here):');
  lines.push('1. New Codex session.');
  lines.push('2. Ask: run ctx doctor');
  lines.push('3. Ask Codex to run `git log` with no -n / --oneline. Expect rewrite, not a full dump.');
  lines.push('4. Ask Codex to `curl https://example.com`. Expect redirect to ctx_fetch_and_index.');
  lines.push('');
  lines.push(failed.length ? `Codex adapter: ${failed.length} check(s) failed.` : 'Codex adapter files: OK (intercept still needs a live Codex session).');

  return {
    ok: failed.length === 0,
    failed,
    checks,
    markdown: lines.join('\n'),
  };
}
