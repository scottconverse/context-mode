/**
 * Cross-platform npm execution helper.
 *
 * On Mac/Linux with nvm/volta, neither `node` nor `npm` are on the default
 * shell PATH. npm is a `#!/usr/bin/env node` script, so even calling it by
 * full path fails unless `node` is findable via PATH.
 *
 * This helper prepends the running node binary's directory to PATH in the
 * execSync environment, so both `npm` and any subprocesses npm spawns can
 * find `node`.
 *
 * On Windows, npm is always on PATH — returns options unchanged.
 */

import { dirname } from "node:path";

/**
 * Build execSync options with node's bin dir on PATH.
 * @param {object} extra — additional execSync options (cwd, stdio, timeout, etc.)
 * @returns {object} merged options safe for execSync('npm ...', result)
 */
export function npmExecOpts(extra = {}) {
  if (process.platform === "win32") return extra;
  const nodeBinDir = dirname(process.execPath);
  return {
    ...extra,
    env: {
      ...process.env,
      ...extra.env,
      PATH: `${nodeBinDir}:${process.env.PATH || ""}`,
    },
  };
}
