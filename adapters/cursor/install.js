#!/usr/bin/env node
/**
 * Cursor adapter installer for context-mode.
 * 
 * This implements a real installer that writes files in place for Cursor,
 * following the actual Cursor contract from upstream.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function log(msg) { 
  console.log(`[context-mode] ${msg}`); 
}

function err(msg) { 
  console.error(`[context-mode] ERROR: ${msg}`); 
}

/**
 * Install Cursor adapter files in place
 */
export async function installCursor(opts = {}) {
  const home = opts.home || process.env.HOME || process.env.USERPROFILE || homedir();
  const cursorHome = opts.cursorHome || join(process.cwd(), '.cursor');
  const projectDir = opts.projectDir || process.cwd();

  log(`Installing context-mode for Cursor IDE`);
  log(`Cursor home: ${cursorHome}`);
  log(`Project dir: ${projectDir}`);

  // Create required directories
  mkdirSync(cursorHome, { recursive: true });
  
  // Create MCP configuration for Cursor - proper format matching upstream contract
  const mcpConfig = {
    mcpServers: {
      "context-mode": {
        command: "npx",
        args: ["--yes", "github:scottconverse/context-mode"],
        env: {
          CONTEXT_MODE_PLATFORM: "cursor"
        }
      }
    }
  };
  
  const mcpPath = join(cursorHome, 'mcp.json');
  writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2));
  log(`  Wrote ${mcpPath}`);

  // Create hooks configuration for Cursor - object-keyed with matchers
  const hooksConfig = {
    version: 1,
    hooks: {
      preToolUse: [
        {
          command: "node hooks/dispatch.js cursor preToolUse",
          matcher: "Shell|Read|Grep|WebFetch|mcp_web_fetch|mcp_fetch_tool|Task|MCP:ctx_execute|MCP:ctx_execute_file|MCP:ctx_batch_execute|MCP:(?!ctx_)"
        }
      ],
      postToolUse: [
        {
          command: "node hooks/dispatch.js cursor postToolUse", 
          matcher: "Shell|Read|Grep|WebFetch|mcp_web_fetch|mcp_fetch_tool|Task|MCP:ctx_execute|MCP:ctx_execute_file|MCP:ctx_batch_execute|MCP:(?!ctx_)"
        }
      ],
      stop: [
        {
          command: "node hooks/dispatch.js cursor stop",
          matcher: ".*"
        }
      ]
    }
  };
  
  const hooksPath = join(cursorHome, 'hooks.json');
  writeFileSync(hooksPath, JSON.stringify(hooksConfig, null, 2));
  log(`  Wrote ${hooksPath}`);

  // Create context-mode rule file for Cursor (proper MDC format with YAML frontmatter)
  const rulesContent = `---
title: Context Mode Rules
version: 1.0
---

# Context Mode Integration for Cursor

This file enables context-mode integration with Cursor through the MDC rule system.

## Rules

# This is a comment - real MDC files use Markdown directives, not rule blocks.
# The actual routing happens in the hook handlers which call the context-mode dispatcher.`;
  
  const rulesDir = join(cursorHome, 'rules');
  mkdirSync(rulesDir, { recursive: true });
  const rulesPath = join(rulesDir, 'context-mode.mdc');
  writeFileSync(rulesPath, rulesContent);
  log(`  Wrote ${rulesPath}`);

  console.log('');
  console.log('='.repeat(50));
  console.log('  context-mode installed for Cursor IDE');
  console.log('='.repeat(50));
  console.log('');
  console.log('Wrote in place:');
  console.log(`  ${mcpPath}`);
  console.log(`  ${hooksPath}`);
  console.log(`  ${rulesPath}`);
  console.log('');
  console.log('Next steps:');
  console.log('1. Restart Cursor IDE');
  console.log('2. Verify the MCP server is loaded in Cursor settings');
  console.log('');
  
  return {
    ok: true,
    cursorHome,
    mcpPath,
    hooksPath,
    rulesPath
  };
}

// Run directly if called as a script
const isMain = process.argv[1] && /cursor[/\\]install\.js$/.test(process.argv[1]);
if (isMain) {
  installCursor().catch((e) => {
    err(e.message);
    process.exit(1);
  });
}