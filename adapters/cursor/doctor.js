/**
 * Cursor adapter doctor - checks that Cursor configuration is correct
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Diagnose Cursor adapter configuration
 * @param {object} opts
 * @param {string} opts.projectDir
 * @returns {object}
 */
export function diagnoseCursor({ projectDir }) {
  const checks = [];
  
  // Check 1: .cursor/hooks.json exists and has preToolUse with non-empty array
  let hooksPath = join(projectDir, '.cursor', 'hooks.json');
  let ok = true;
  
  try {
    if (!existsSync(hooksPath)) {
      checks.push({
        name: 'hooks.json exists',
        ok: false,
        detail: 'Missing .cursor/hooks.json'
      });
      ok = false;
    } else {
      const hooksContent = readFileSync(hooksPath, 'utf8');
      const hooks = JSON.parse(hooksContent);
      
      if (!hooks.hooks || !hooks.hooks.preToolUse) {
        checks.push({
          name: 'hooks.preToolUse exists',
          ok: false,
          detail: 'Missing hooks.preToolUse in hooks.json'
        });
        ok = false;
      } else if (!Array.isArray(hooks.hooks.preToolUse) || hooks.hooks.preToolUse.length === 0) {
        checks.push({
          name: 'hooks.preToolUse is non-empty array',
          ok: false,
          detail: 'hooks.preToolUse is not a non-empty array'
        });
        ok = false;
      } else {
        checks.push({
          name: 'hooks.preToolUse exists',
          ok: true,
          detail: 'Found hooks.preToolUse'
        });
        
        // Check if first command contains dispatch.js
        const firstCommand = hooks.hooks.preToolUse[0].command || '';
        if (firstCommand.includes('dispatch.js')) {
          checks.push({
            name: 'hooks.preToolUse command references dispatch.js',
            ok: true,
            detail: 'Command properly references dispatch.js'
          });
        } else {
          checks.push({
            name: 'hooks.preToolUse command references dispatch.js',
            ok: false,
            detail: 'Command does not reference dispatch.js'
          });
          ok = false;
        }
      }
    }
  } catch (e) {
    checks.push({
      name: 'hooks.json parsing',
      ok: false,
      detail: `Failed to parse hooks.json: ${e.message}`
    });
    ok = false;
  }

  // Check 2: .cursor/hooks.json has correct matcher for preToolUse
  try {
    const hooksContent = readFileSync(hooksPath, 'utf8');
    const hooks = JSON.parse(hooksContent);
    
    if (hooks.hooks && hooks.hooks.preToolUse && hooks.hooks.preToolUse[0]) {
      const matcher = hooks.hooks.preToolUse[0].matcher || '';
      // Check for the specific matchers we expect
      if (matcher.includes('MCP:ctx_execute')) {
        checks.push({
          name: 'hooks.preToolUse matcher includes MCP:ctx_execute',
          ok: true,
          detail: 'Matcher properly includes MCP:ctx_execute'
        });
      } else {
        checks.push({
          name: 'hooks.preToolUse matcher includes MCP:ctx_execute',
          ok: false,
          detail: 'Matcher does not include MCP:ctx_execute'
        });
        ok = false;
      }
    }
  } catch (e) {
    checks.push({
      name: 'hooks.preToolUse matcher check',
      ok: false,
      detail: `Failed to check matcher: ${e.message}`
    });
    ok = false;
  }

  // Check 3: .cursor/mcp.json exists and has correct structure
  let mcpPath = join(projectDir, '.cursor', 'mcp.json');
  try {
    if (!existsSync(mcpPath)) {
      checks.push({
        name: 'mcp.json exists',
        ok: false,
        detail: 'Missing .cursor/mcp.json'
      });
      ok = false;
    } else {
      const mcpContent = readFileSync(mcpPath, 'utf8');
      const mcp = JSON.parse(mcpContent);
      
      if (!mcp.mcpServers || typeof mcp.mcpServers !== 'object') {
        checks.push({
          name: 'mcpServers is object',
          ok: false,
          detail: 'mcpServers is not an object in mcp.json'
        });
        ok = false;
      } else if (!mcp.mcpServers['context-mode']) {
        checks.push({
          name: 'mcpServers has context-mode',
          ok: false,
          detail: 'Missing context-mode server in mcp.json'
        });
        ok = false;
      } else {
        checks.push({
          name: 'mcpServers has context-mode',
          ok: true,
          detail: 'Found context-mode server in mcp.json'
        });
      }
    }
  } catch (e) {
    checks.push({
      name: 'mcp.json parsing',
      ok: false,
      detail: `Failed to parse mcp.json: ${e.message}`
    });
    ok = false;
  }

  // Check 4: .cursor/rules/context-mode.mdc exists
  let rulesPath = join(projectDir, '.cursor', 'rules', 'context-mode.mdc');
  try {
    if (!existsSync(rulesPath)) {
      checks.push({
        name: 'context-mode.mdc exists',
        ok: false,
        detail: 'Missing .cursor/rules/context-mode.mdc'
      });
      ok = false;
    } else {
      checks.push({
        name: 'context-mode.mdc exists',
        ok: true,
        detail: 'Found context-mode.mdc'
      });
    }
  } catch (e) {
    checks.push({
      name: 'context-mode.mdc existence',
      ok: false,
      detail: `Failed to check rules file: ${e.message}`
    });
    ok = false;
  }

  return { ok, checks };
}