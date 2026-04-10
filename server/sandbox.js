/**
 * PolyglotExecutor — subprocess isolation for sandbox execution.
 * Runs code in isolated temp directories, captures only stdout,
 * enforces hard byte caps and timeouts.
 * Cross-platform: Windows (taskkill) and macOS/Linux (kill -PGID).
 *
 * Ported from mksglu/context-mode (https://github.com/mksglu/context-mode)
 * by @mksglu, licensed under Elastic License 2.0.
 */

import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCommand, EXTENSIONS, isWindows } from './runtime.js';

/**
 * Resolve the real OS temp directory, avoiding TMPDIR overrides
 * that might pollute project roots.
 */
function resolveOSTmpDir() {
  if (isWindows) {
    return process.env.TEMP || process.env.TMP || tmpdir();
  }
  if (process.platform === 'darwin') {
    try {
      const dir = execSync('getconf DARWIN_USER_TEMP_DIR', {
        encoding: 'utf8',
        timeout: 3000
      }).trim();
      if (dir && existsSync(dir)) return dir;
    } catch { /* fall through */ }
  }
  // Linux or fallback
  try {
    const dir = execSync('mktemp -u -d', { encoding: 'utf8', timeout: 3000 }).trim();
    // Go up one level to get the temp root
    const parts = dir.split('/');
    parts.pop();
    const root = parts.join('/');
    if (root && existsSync(root)) return root;
  } catch { /* fall through */ }
  return tmpdir();
}

const OS_TMPDIR = resolveOSTmpDir();

/**
 * Kill a process tree.
 */
function killTree(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (isWindows) {
      execSync(`taskkill /F /T /PID ${proc.pid}`, {
        stdio: 'ignore',
        timeout: 5000
      });
    } else {
      // Kill the entire process group (negative PID)
      process.kill(-proc.pid, 'SIGKILL');
    }
  } catch {
    // Process may have already exited
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
  }
}

export class PolyglotExecutor {
  #hardCapBytes;
  #projectRoot;
  #runtimes;
  #backgroundedPids = new Set();

  constructor({ hardCapBytes = 100 * 1024 * 1024, projectRoot, runtimes }) {
    this.#hardCapBytes = hardCapBytes;
    this.#projectRoot = projectRoot;
    this.#runtimes = runtimes;
  }

  /**
   * Build a safe environment for the subprocess.
   * Strips dangerous env vars that could escape the sandbox.
   */
  #buildSafeEnv(sandboxTmpDir) {
    const env = { ...process.env };
    // Strip vars that could break isolation
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_REPL_HISTORY;
    // Redirect temp dirs into sandbox
    if (isWindows) {
      env.TEMP = sandboxTmpDir;
      env.TMP = sandboxTmpDir;
    } else {
      env.TMPDIR = sandboxTmpDir;
    }
    return env;
  }

  /**
   * Write a script file with language-specific wrapping.
   */
  #writeScript(tmpDir, code, language) {
    const ext = EXTENSIONS[language] || '.txt';
    const filePath = join(tmpDir, `script${ext}`);

    let finalCode = code;

    switch (language) {
      case 'go':
        // Wrap in package main if missing
        if (!code.includes('package ')) {
          finalCode = `package main\n\nimport "fmt"\n\nfunc main() {\n${code}\n_ = fmt.Sprintf\n}`;
        }
        break;
      case 'php':
        // Add opening tag if missing
        if (!code.trim().startsWith('<?')) {
          finalCode = `<?php\n${code}`;
        }
        break;
      case 'elixir':
        // Prepend BEAM path resolution for Mix projects
        finalCode = code;
        break;
      case 'shell':
        // Ensure shebang
        if (!code.startsWith('#!')) {
          finalCode = `#!/usr/bin/env bash\nset -e\n${code}`;
        }
        break;
    }

    writeFileSync(filePath, finalCode, 'utf8');
    return filePath;
  }

  /**
   * Compile and run Rust code.
   */
  async #compileAndRun(tmpDir, filePath, timeout, env) {
    const binaryPath = join(tmpDir, isWindows ? 'script.exe' : 'script');

    // Compile
    const compileResult = await this.#spawnCollect(
      this.#runtimes.rust.command,
      [filePath, '-o', binaryPath],
      { cwd: tmpDir, env, timeout: Math.min(timeout, 30000) }
    );

    if (compileResult.exitCode !== 0) {
      return {
        stdout: '',
        stderr: `Compilation failed:\n${compileResult.stderr}`,
        exitCode: compileResult.exitCode,
        timedOut: false,
        backgrounded: false
      };
    }

    // Run
    return this.#spawnCollect(binaryPath, [], { cwd: tmpDir, env, timeout });
  }

  /**
   * Spawn a process and collect stdout/stderr with hard byte cap.
   */
  #spawnCollect(cmd, args, { cwd, env, timeout = 30000, background = false }) {
    return new Promise((resolve) => {
      const proc = spawn(cmd, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: !isWindows,
        windowsHide: true
      });

      const stdoutChunks = [];
      const stderrChunks = [];
      let totalBytes = 0;
      let timedOut = false;
      let backgrounded = false;
      let killed = false;

      const onData = (chunks) => (data) => {
        totalBytes += data.length;
        if (totalBytes > this.#hardCapBytes) {
          if (!killed) {
            killed = true;
            killTree(proc);
          }
          return;
        }
        chunks.push(data);
      };

      proc.stdout.on('data', onData(stdoutChunks));
      proc.stderr.on('data', onData(stderrChunks));

      let timer = null;
      if (timeout > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          if (background) {
            // Detach and let it run
            backgrounded = true;
            this.#backgroundedPids.add(proc.pid);
            proc.unref();
            resolve({
              stdout: Buffer.concat(stdoutChunks).toString('utf8'),
              stderr: Buffer.concat(stderrChunks).toString('utf8'),
              exitCode: null,
              timedOut: true,
              backgrounded: true
            });
          } else {
            killTree(proc);
          }
        }, timeout);
      }

      proc.on('close', (exitCode) => {
        if (timer) clearTimeout(timer);
        if (backgrounded) return; // Already resolved
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          exitCode: exitCode ?? (killed ? 137 : 1),
          timedOut,
          backgrounded: false
        });
      });

      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        if (backgrounded) return;
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: err.message,
          exitCode: 1,
          timedOut: false,
          backgrounded: false
        });
      });
    });
  }

  /**
   * Execute code in a sandboxed subprocess.
   */
  async execute({ language, code, timeout = 30000, background = false }) {
    if (!this.#runtimes[language]) {
      return {
        stdout: '',
        stderr: `Language "${language}" is not available. Available: ${Object.keys(this.#runtimes).join(', ')}`,
        exitCode: 1,
        timedOut: false,
        backgrounded: false
      };
    }

    const tmpDir = mkdtempSync(join(OS_TMPDIR, '.ctx-mode-'));

    try {
      const filePath = this.#writeScript(tmpDir, code, language);
      const env = this.#buildSafeEnv(tmpDir);

      // Shell runs in project root for git/relative paths
      const cwd = language === 'shell' ? this.#projectRoot : tmpDir;

      // Rust needs compile-then-run
      if (language === 'rust') {
        return await this.#compileAndRun(tmpDir, filePath, timeout, env);
      }

      const cmdArgs = buildCommand(this.#runtimes, language, filePath);
      if (!cmdArgs) {
        return {
          stdout: '',
          stderr: `Cannot build command for "${language}"`,
          exitCode: 1,
          timedOut: false,
          backgrounded: false
        };
      }

      const [cmd, args] = cmdArgs;
      return await this.#spawnCollect(cmd, args, { cwd, env, timeout, background });

    } finally {
      // Clean up temp dir unless process was backgrounded
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch { /* ignore cleanup errors */ }
    }
  }

  /**
   * Execute code that processes file contents.
   * File contents are injected as a variable inside the sandbox.
   */
  async executeFile({ files, language, code, timeout = 30000 }) {
    if (!Array.isArray(files) || files.length === 0) {
      return {
        stdout: '',
        stderr: 'No files provided',
        exitCode: 1,
        timedOut: false,
        backgrounded: false
      };
    }

    // Build wrapper code that reads files and makes content available
    let wrappedCode;
    switch (language) {
      case 'javascript':
      case 'typescript':
        wrappedCode = `
import { readFileSync } from 'fs';
const FILES = ${JSON.stringify(files)};
const FILE_CONTENTS = FILES.map(f => ({ path: f, content: readFileSync(f, 'utf8') }));
${code}`;
        break;
      case 'python':
        wrappedCode = `
import json
FILES = ${JSON.stringify(files)}
FILE_CONTENTS = []
for f in FILES:
    with open(f, 'r') as fh:
        FILE_CONTENTS.append({'path': f, 'content': fh.read()})
${code}`;
        break;
      case 'shell':
        // For shell, create file list as env var (quote-safe for paths with spaces/special chars)
        wrappedCode = `
FILES=(${files.map(f => `"${f.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(' ')})
${code}`;
        break;
      default:
        // For other languages, just prepend file paths as comments
        wrappedCode = `# Files: ${files.join(', ')}\n${code}`;
    }

    return this.execute({ language, code: wrappedCode, timeout });
  }

  /**
   * Clean up all backgrounded processes.
   */
  cleanup() {
    for (const pid of this.#backgroundedPids) {
      try {
        if (isWindows) {
          execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', timeout: 3000 });
        } else {
          process.kill(-pid, 'SIGKILL');
        }
      } catch { /* ignore */ }
    }
    this.#backgroundedPids.clear();
  }
}
