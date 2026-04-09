/**
 * Language runtime detection for the sandbox executor.
 * Detects 11 language runtimes across Windows and macOS/Linux.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const isWindows = process.platform === 'win32';

/**
 * Check if a command exists on the system.
 */
function commandExists(cmd) {
  try {
    if (isWindows) {
      // Filter out WindowsApps and System32 bash stubs
      const result = execSync(`where ${cmd}`, {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'] // Suppress stderr ("INFO: Could not find files...")
      });
      const lines = result.trim().split(/\r?\n/).filter(line => {
        const lower = line.toLowerCase();
        return !lower.includes('windowsapps') && !lower.includes('system32');
      });
      return lines.length > 0 ? lines[0] : null;
    } else {
      const result = execSync(`command -v ${cmd}`, {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      return result.trim() || null;
    }
  } catch {
    return null;
  }
}

/**
 * Get command version string.
 */
function getVersion(cmd, versionFlag = '--version') {
  try {
    // Quote the command path in case it contains spaces (e.g. "C:\Program Files\...")
    const quotedCmd = cmd.includes(' ') ? `"${cmd}"` : cmd;
    const result = execSync(`${quotedCmd} ${versionFlag}`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return result.trim().split('\n')[0];
  } catch {
    return null;
  }
}

/**
 * Resolve bash path on Windows (Git Bash).
 */
function resolveWindowsBash() {
  // Check common Git Bash locations first
  const gitBashPaths = [
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe'
  ];
  for (const p of gitBashPaths) {
    if (existsSync(p)) return p;
  }
  // Fall back to where, filtering out System32/WindowsApps
  return commandExists('bash');
}

/**
 * Check if Bun is available.
 */
function hasBunRuntime() {
  if (commandExists('bun')) return true;
  const bunPath = join(homedir(), '.bun', 'bin', 'bun');
  return existsSync(bunPath);
}

/**
 * Detect all available language runtimes.
 * Returns a map of language -> { command, version } or null.
 */
export function detectRuntimes() {
  const runtimes = {};

  // JavaScript / Node.js
  const nodeCmd = commandExists('node');
  if (nodeCmd) {
    runtimes.javascript = { command: nodeCmd, version: getVersion(nodeCmd) };
    runtimes.typescript = { command: nodeCmd, version: getVersion(nodeCmd), useTsx: false };
  }

  // Check for tsx (TypeScript executor)
  const tsxCmd = commandExists('tsx');
  if (tsxCmd) {
    runtimes.typescript = { command: tsxCmd, version: getVersion(tsxCmd), useTsx: true };
  }

  // Python
  const py3Cmd = commandExists('python3') || commandExists('python');
  if (py3Cmd) {
    const ver = getVersion(py3Cmd);
    if (ver && ver.includes('3.')) {
      runtimes.python = { command: py3Cmd, version: ver };
    }
  }

  // Shell (bash)
  if (isWindows) {
    const bashCmd = resolveWindowsBash();
    if (bashCmd) {
      runtimes.shell = { command: bashCmd, version: getVersion(bashCmd) };
    }
  } else {
    const bashCmd = commandExists('bash') || commandExists('sh');
    if (bashCmd) {
      runtimes.shell = { command: bashCmd, version: getVersion(bashCmd) };
    }
  }

  // Ruby
  const rubyCmd = commandExists('ruby');
  if (rubyCmd) {
    runtimes.ruby = { command: rubyCmd, version: getVersion(rubyCmd) };
  }

  // Go
  const goCmd = commandExists('go');
  if (goCmd) {
    runtimes.go = { command: goCmd, version: getVersion(goCmd, 'version') };
  }

  // Rust
  const rustcCmd = commandExists('rustc');
  if (rustcCmd) {
    runtimes.rust = { command: rustcCmd, version: getVersion(rustcCmd) };
  }

  // PHP
  const phpCmd = commandExists('php');
  if (phpCmd) {
    runtimes.php = { command: phpCmd, version: getVersion(phpCmd) };
  }

  // Perl
  const perlCmd = commandExists('perl');
  if (perlCmd) {
    runtimes.perl = { command: perlCmd, version: getVersion(perlCmd) };
  }

  // R
  const rCmd = commandExists('Rscript');
  if (rCmd) {
    runtimes.r = { command: rCmd, version: getVersion(rCmd) };
  }

  // Elixir
  const elixirCmd = commandExists('elixir');
  if (elixirCmd) {
    runtimes.elixir = { command: elixirCmd, version: getVersion(elixirCmd) };
  }

  return runtimes;
}

/**
 * Get file extension for a language.
 */
const EXTENSIONS = {
  javascript: '.js',
  typescript: '.ts',
  python: '.py',
  shell: '.sh',
  ruby: '.rb',
  go: '.go',
  rust: '.rs',
  php: '.php',
  perl: '.pl',
  r: '.R',
  elixir: '.exs'
};

/**
 * Build the spawn command for a given language and file path.
 */
export function buildCommand(runtimes, language, filePath) {
  const rt = runtimes[language];
  if (!rt) return null;

  switch (language) {
    case 'javascript':
      return [rt.command, [filePath]];
    case 'typescript':
      if (rt.useTsx) return [rt.command, [filePath]];
      return [rt.command, ['--loader', 'tsx', filePath]];
    case 'python':
      return [rt.command, ['-u', filePath]];
    case 'shell':
      return [rt.command, [filePath]];
    case 'ruby':
      return [rt.command, [filePath]];
    case 'go':
      return [rt.command, ['run', filePath]];
    case 'rust':
      // Rust needs compile-then-run, handled by executor
      return [rt.command, [filePath]];
    case 'php':
      return [rt.command, [filePath]];
    case 'perl':
      return [rt.command, [filePath]];
    case 'r':
      return [rt.command, ['--vanilla', filePath]];
    case 'elixir':
      return [rt.command, [filePath]];
    default:
      return null;
  }
}

/**
 * Get list of available languages.
 */
export function getAvailableLanguages(runtimes) {
  return Object.keys(runtimes);
}

/**
 * Get formatted runtime summary.
 */
export function getRuntimeSummary(runtimes) {
  const lines = [];
  for (const [lang, info] of Object.entries(runtimes)) {
    lines.push(`  ${lang}: ${info.command} (${info.version || 'version unknown'})`);
  }
  return lines.length > 0
    ? `Available runtimes:\n${lines.join('\n')}`
    : 'No runtimes detected.';
}

export { EXTENSIONS, hasBunRuntime, isWindows };
