#!/usr/bin/env node
/**
 * context-mode bootstrapper for Cowork.
 * Entry point for the MCP server.
 *
 * Ported from mksglu/context-mode (https://github.com/mksglu/context-mode)
 * by @mksglu, licensed under Elastic License 2.0.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, openSync, closeSync, unlinkSync, constants as fsConstants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const originalCwd = process.cwd();
process.chdir(__dirname);

if (!process.env.CLAUDE_PROJECT_DIR) {
  process.env.CLAUDE_PROJECT_DIR = originalCwd;
}

if (!process.env.CONTEXT_MODE_PROJECT_DIR) {
  process.env.CONTEXT_MODE_PROJECT_DIR = originalCwd;
}

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
        const lockPath = ipPath + ".lock";
        let lockFd = null;
        try {
          lockFd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
        } catch {
          // Another session holds the lock — skip self-heal (best effort)
          lockFd = null;
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
for (const pkg of ["turndown", "turndown-plugin-gfm"]) {
  if (!existsSync(resolve(__dirname, "node_modules", pkg))) {
    try {
      execSync(`npm install ${pkg} --no-package-lock --no-save --silent`, {
        cwd: __dirname,
        stdio: "pipe",
        timeout: 120000,
      });
    } catch { /* best effort */ }
  }
}

// Start the MCP server
await import("./server/index.js");
