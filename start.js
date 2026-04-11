#!/usr/bin/env node
/**
 * context-mode bootstrapper for Cowork.
 * Entry point for the MCP server.
 *
 * Ported from mksglu/context-mode (https://github.com/mksglu/context-mode)
 * by @mksglu, licensed under Elastic License 2.0.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, openSync, closeSync, unlinkSync, statSync, constants as fsConstants } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { ensureMcpJson } from "./hooks/core/ensure-mcp-json.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const originalCwd = process.cwd();
process.chdir(__dirname);

if (!process.env.CLAUDE_PROJECT_DIR) {
  process.env.CLAUDE_PROJECT_DIR = originalCwd;
}

if (!process.env.CONTEXT_MODE_PROJECT_DIR) {
  process.env.CONTEXT_MODE_PROJECT_DIR = originalCwd;
}

// Ensure ~/.mcp.json has our server entry — on macOS the desktop app
// reads MCP config from ~/.mcp.json, not ~/.claude/settings.json.
ensureMcpJson(__dirname);

// Self-heal: if a newer version dir exists, update registry so next session uses it
const cacheMatch = __dirname.match(
  /^(.*[\/\\]plugins[\/\\]cache[\/\\][^\/\\]+[\/\\][^\/\\]+[\/\\])([^\/\\]+)$/,
);
if (cacheMatch) {
  try {
    const cacheParent = cacheMatch[1];
    const myVersion = cacheMatch[2];
    const dirs = readdirSync(cacheParent).filter((d) =>
      /^\d+\.\d+\.\d+/.test(d),
    );
    if (dirs.length > 1) {
      dirs.sort((a, b) => {
        const pa = a.split(".").map(Number);
        const pb = b.split(".").map(Number);
        for (let i = 0; i < 3; i++) {
          if ((pa[i] ?? 0) !== (pb[i] ?? 0))
            return (pa[i] ?? 0) - (pb[i] ?? 0);
        }
        return 0;
      });
      const newest = dirs[dirs.length - 1];
      if (newest && newest !== myVersion) {
        const ipPath = resolve(
          homedir(),
          ".claude",
          "plugins",
          "installed_plugins.json",
        );
        // Atomic lockfile: O_CREAT | O_EXCL — first process wins, others skip
        // Stale lock TTL: if lockfile is older than 30s, remove it and retry
        const lockPath = ipPath + ".lock";
        let lockFd = null;
        try {
          lockFd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
        } catch {
          // Lock exists — check if stale (older than 30 seconds)
          try {
            const lockAge = Date.now() - statSync(lockPath).mtimeMs;
            if (lockAge > 30000) {
              unlinkSync(lockPath);
              lockFd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
            }
          } catch {
            // Can't stat or remove stale lock — skip self-heal
          }
        }
        if (lockFd !== null) {
          try {
            const ip = JSON.parse(readFileSync(ipPath, "utf-8"));
            for (const [key, entries] of Object.entries(ip.plugins || {})) {
              if (!key.toLowerCase().includes("context-mode")) continue;
              for (const entry of entries) {
                entry.installPath = resolve(cacheParent, newest);
                entry.version = newest;
                entry.lastUpdated = new Date().toISOString();
              }
            }
            writeFileSync(
              ipPath,
              JSON.stringify(ip, null, 2) + "\n",
              "utf-8",
            );
          } finally {
            closeSync(lockFd);
            try { unlinkSync(lockPath); } catch { /* ignore */ }
          }
        }
      }
    }
  } catch {
    /* best effort — don't block server startup */
  }
}

// Ensure native dependencies + ABI compatibility
import "./hooks/ensure-deps.js";

// Install pure-JS deps used by server
import { npmExecOpts } from "./hooks/core/npm-exec.js";

for (const pkg of ["turndown", "turndown-plugin-gfm"]) {
  if (!existsSync(resolve(__dirname, "node_modules", pkg))) {
    try {
      execSync(`npm install ${pkg} --no-package-lock --no-save --silent`, npmExecOpts({
        cwd: __dirname,
        stdio: "pipe",
        timeout: 120000,
      }));
    } catch { /* best effort */ }
  }
}

// Start the MCP server
await import("./server/index.js");
