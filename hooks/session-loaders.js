/**
 * Session module loaders for context-mode hooks.
 *
 * Returns factory functions that dynamically import server modules.
 * Uses pathToFileURL for Windows compatibility with dynamic imports.
 *
 * Ported from mksglu/context-mode by @mksglu, licensed under Elastic License 2.0.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function createSessionLoaders(hookDir) {
  const pluginRoot = join(hookDir, "..");

  return {
    async loadSessionDB() {
      const modPath = join(pluginRoot, "server", "session.js");
      return await import(pathToFileURL(modPath).href);
    },
    async loadExtract() {
      const modPath = join(hookDir, "session-extract.js");
      return await import(pathToFileURL(modPath).href);
    },
    async loadSnapshot() {
      const modPath = join(pluginRoot, "server", "snapshot.js");
      return await import(pathToFileURL(modPath).href);
    },
  };
}
