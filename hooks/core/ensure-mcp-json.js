/**
 * Ensure ~/.mcp.json contains the context-mode MCP server entry.
 *
 * On macOS (and possibly other platforms), the Claude desktop app reads
 * MCP server config from ~/.mcp.json rather than ~/.claude/settings.json.
 * The plugin system writes to settings.json, but the desktop app may not
 * pick it up — so we self-heal by merging our entry into ~/.mcp.json.
 *
 * Safe to call on all platforms: reads existing ~/.mcp.json, merges only
 * the context-mode entry (preserving other servers), and writes back only
 * if something actually changed.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Resolve the absolute path to the `node` binary currently running.
 * Falls back to "node" (bare command) if process.execPath is unusable.
 */
function resolveNodePath() {
  const ep = process.execPath;
  if (ep && (ep.endsWith("/node") || ep.endsWith("\\node.exe") || ep.endsWith("\\node"))) {
    return ep;
  }
  return "node";
}

/**
 * Ensure ~/.mcp.json has a context-mode server entry pointing to the
 * current plugin root and node binary.
 *
 * @param {string} pluginRoot — absolute path to the plugin root directory
 *   (the directory containing start.js)
 */
export function ensureMcpJson(pluginRoot) {
  try {
    const mcpJsonPath = join(homedir(), ".mcp.json");
    const nodePath = resolveNodePath();
    const startScript = join(pluginRoot, "start.js");

    // Resolve data directory (same logic as server/index.js and setup.js)
    const home = homedir();
    let pluginData = process.env.CLAUDE_PLUGIN_DATA;
    if (!pluginData || pluginData.includes("${") || pluginData.includes("CLAUDE_PLUGIN_DATA")) {
      const specPath = join(home, ".claude", "plugins", "data", "context-mode");
      if (existsSync(join(home, ".claude", "plugins"))) {
        pluginData = specPath;
      } else {
        pluginData = join(pluginRoot, ".data");
      }
    }

    const desired = {
      command: nodePath,
      args: [startScript],
      env: {
        CLAUDE_PLUGIN_DATA: pluginData,
        NODE_PATH: join(pluginData, "node_modules"),
      },
    };

    // Read existing ~/.mcp.json or start fresh
    let mcpConfig = { mcpServers: {} };
    if (existsSync(mcpJsonPath)) {
      try {
        mcpConfig = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
        if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
      } catch {
        // Corrupted file — preserve as backup, start fresh
        try {
          writeFileSync(mcpJsonPath + ".bak", readFileSync(mcpJsonPath));
        } catch { /* ignore backup failure */ }
        mcpConfig = { mcpServers: {} };
      }
    }

    const existing = mcpConfig.mcpServers["context-mode"];

    // Only write if the entry is missing or stale
    if (
      existing &&
      existing.command === desired.command &&
      JSON.stringify(existing.args) === JSON.stringify(desired.args) &&
      existing.env?.CLAUDE_PLUGIN_DATA === desired.env.CLAUDE_PLUGIN_DATA &&
      existing.env?.NODE_PATH === desired.env.NODE_PATH
    ) {
      return; // Already up to date
    }

    mcpConfig.mcpServers["context-mode"] = desired;
    writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + "\n", "utf-8");
  } catch {
    // Best effort — never block startup or setup
  }
}
