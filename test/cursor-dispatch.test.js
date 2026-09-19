// test/cursor-dispatch.test.js
// Test that cursor dispatch works with the new fixture files

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

describe('cursor dispatch integration', () => {
  async function runDispatch(fixtureName) {
    const child = spawn(
      process.execPath,
      [join(ROOT, 'hooks', 'dispatch.js'), 'cursor', 'preToolUse'],
      { 
        stdio: ['pipe', 'pipe', 'pipe'], 
        env: { ...process.env, CONTEXT_MODE_PLATFORM: 'cursor' } 
      },
    );
    
    const raw = readFileSync(join(__dirname, 'fixtures', 'cursor', fixtureName), 'utf8');
    child.stdin.write(raw);
    child.stdin.end();
    
    let out = '';
    let err = '';
    
    for await (const c of child.stdout) out += c;
    for await (const c of child.stderr) err += c;
    
    const code = await new Promise((resolve) => child.on('close', resolve));
    
    return { code, out, err };
  }

  it('pretooluse-shell-curl fixture should parse and contain curl/wget blocked in command', async () => {
    const { code, out } = await runDispatch('pretooluse-shell-curl.json');
    assert.equal(code, 0);
    
    // Should parse as JSON
    const parsed = JSON.parse(out.trim().split('\n').pop());
    assert.ok(parsed.updated_input);
    assert.ok(parsed.updated_input.command.includes('curl/wget blocked'));
  });

  it('pretooluse-shell-gitlog fixture should parse and contain git log routed through compressor', async () => {
    const { code, out } = await runDispatch('pretooluse-shell-gitlog.json');
    assert.equal(code, 0);
    
    // Should parse as JSON
    const parsed = JSON.parse(out.trim().split('\n').pop());
    assert.ok(parsed.updated_input);
    assert.ok(parsed.updated_input.command.includes('git log routed through compressor'));
  });

  it('pretooluse-mcp-execute fixture should parse and return empty object', async () => {
    const { code, out } = await runDispatch('pretooluse-mcp-execute.json');
    assert.equal(code, 0);
    
    // Should parse as JSON and be empty object
    const parsed = JSON.parse(out.trim());
    assert.deepStrictEqual(parsed, {});
  });

  it('pretooluse-read fixture should parse and have updated_input or agent_message or be empty', async () => {
    const { code, out } = await runDispatch('pretooluse-read.json');
    assert.equal(code, 0);
    
    // Should parse as JSON 
    const parsed = JSON.parse(out.trim());
    
    // Should either have updated_input, agent_message, or be an empty object
    const hasUpdatedInput = parsed.hasOwnProperty('updated_input');
    const hasAgentMessage = parsed.hasOwnProperty('agent_message');
    const isEmpty = Object.keys(parsed).length === 0;
    
    assert.ok(hasUpdatedInput || hasAgentMessage || isEmpty);
  });

  it('claude-code preToolUse with SomeRandomTool should return empty output', async () => {
    const child = spawn(
      process.execPath,
      [join(ROOT, 'hooks', 'dispatch.js'), 'claude-code', 'preToolUse'],
      { 
        stdio: ['pipe', 'pipe', 'pipe'], 
        env: { ...process.env, CONTEXT_MODE_PLATFORM: 'claude-code' } 
      },
    );
    
    const raw = JSON.stringify({
      "tool_name":"SomeRandomTool",
      "tool_input":{},
      "session_id":"x"
    });
    
    child.stdin.write(raw);
    child.stdin.end();
    
    let out = '';
    for await (const c of child.stdout) out += c;
    
    const code = await new Promise((resolve) => child.on('close', resolve));
    
    assert.equal(code, 0);
    // Should be exactly empty after trim
    assert.equal(out.trim(), '');
  });
});