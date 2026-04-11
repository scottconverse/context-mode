/**
 * Shared dependency bootstrap for hooks and start.js.
 *
 * Single source of truth — ensures native deps (better-sqlite3) are
 * installed in the plugin cache before any hook or server code runs.
 *
 * Pattern: same as suppress-stderr.js — imported at the top of every
 * hook that needs native modules. Fast path: existsSync check (~0.1ms).
 * Slow path: npm install (first run only, ~5-30s).
 *
 * Also handles ABI compatibility (#148, #203): when the current Node.js
 * version differs from the one better-sqlite3 was compiled against,
 * automatically swaps in a cached binary or rebuilds. This protects
 * both the MCP server AND hooks from ABI mismatch crashes when users
 * have multiple Node versions via mise/volta/fnm/nvm.
 *
 * @see https://github.com/mksglu/context-mode/issues/148
 * @see https://github.com/mksglu/context-mode/issues/172
 * @see https://github.com/mksglu/context-mode/issues/203
 *
 * Ported from mksglu/context-mode (https://github.com/mksglu/context-mode)
 * by @mksglu, licensed under Elastic License 2.0.
 */

import { existsSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { npmExecOpts } from "./core/npm-exec.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const NATIVE_DEPS = ["better-sqlite3"];

export function ensureDeps() {
  for (const pkg of NATIVE_DEPS) {
    const pkgDir = resolve(root, "node_modules", pkg);
    if (!existsSync(pkgDir)) {
      // Package not installed at all
      try {
        execSync(`npm install ${pkg} --no-package-lock --no-save --silent`, npmExecOpts({
          cwd: root,
          stdio: "pipe",
          timeout: 120000,
        }));
      } catch { /* best effort — hook degrades gracefully without DB */ }
    } else if (
      !existsSync(resolve(pkgDir, "build", "Release")) &&
      !existsSync(resolve(pkgDir, "prebuilds"))
    ) {
      // Package installed but native binary missing (e.g., npm ignore-scripts=true)
      try {
        execSync(`npm rebuild ${pkg} --ignore-scripts=false`, npmExecOpts({
          cwd: root,
          stdio: "pipe",
          timeout: 120000,
        }));
      } catch { /* best effort — hook degrades gracefully without DB */ }
    }
  }
}

/**
 * ABI-aware native binary caching for better-sqlite3 (#148, #203).
 *
 * Users with mise/asdf/volta/fnm may run sessions with different Node
 * versions. Each ABI needs its own compiled binary — cache them
 * side-by-side so switching Node versions doesn't require a rebuild
 * every time.
 *
 * Flow:
 *   1. Check if ABI-specific cache exists → swap in
 *   2. Probe-load better-sqlite3 → if OK, cache current binary
 *   3. If ABI mismatch → npm rebuild, then cache the new binary
 */
export function ensureNativeCompat(pluginRoot) {
  try {
    const abi = process.versions.modules;
    const nativeDir = resolve(pluginRoot, "node_modules", "better-sqlite3", "build", "Release");
    const binaryPath = resolve(nativeDir, "better_sqlite3.node");
    const abiCachePath = resolve(nativeDir, `better_sqlite3.abi${abi}.node`);

    if (!existsSync(nativeDir)) return;

    // Fast path: cached binary for this ABI already exists
    if (existsSync(abiCachePath)) {
      copyFileSync(abiCachePath, binaryPath);
      codesignBinary(binaryPath);
      return;
    }

    if (!existsSync(binaryPath)) return;

    // Probe: try loading better-sqlite3 with current Node
    try {
      const req = createRequire(resolve(pluginRoot, "package.json"));
      req("better-sqlite3");
      // Load succeeded — cache the working binary for this ABI
      copyFileSync(binaryPath, abiCachePath);
    } catch (probeErr) {
      if (probeErr?.message?.includes("NODE_MODULE_VERSION")) {
        // ABI mismatch — rebuild for current Node version
        execSync('npm rebuild better-sqlite3', npmExecOpts({
          cwd: pluginRoot,
          stdio: "pipe",
          timeout: 60000,
        }));
        if (existsSync(binaryPath)) {
          copyFileSync(binaryPath, abiCachePath);
        }
      }
    }
  } catch {
    /* best effort — caller will report the error on first DB access */
  }
}

/**
 * Ad-hoc codesign a native binary on macOS.
 *
 * When a cached .node binary is copied over the active one, macOS hardened
 * runtime (e.g. Zed, VS Code with runtime hardening) will SIGKILL the
 * process on the next dlopen because the code signature is invalidated.
 * SIGKILL is uncatchable — the only fix is to re-sign after the copy.
 *
 * No-op on non-macOS. Swallows errors (codesign may not be available in
 * all environments, e.g. Docker containers).
 */
export function codesignBinary(binaryPath) {
  if (process.platform === "darwin") {
    try {
      execSync(`codesign --sign - --force "${binaryPath}"`, {
        stdio: "pipe",
        timeout: 10000,
      });
    } catch { /* codesign unavailable — continue without signing */ }
  }
}

// Auto-run on import (like suppress-stderr.js)
ensureDeps();
ensureNativeCompat(root);
