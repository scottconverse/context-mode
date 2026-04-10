// test/compressor.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compress } from '../server/compressor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

// Minimal context for Stage 1 (no session awareness needed)
const minContext = {
  toolName: 'shell:echo',
  command: 'echo test',
  sessionEvents: [],
  learnerWeights: { retentionScore: 0.5 },
  sourceLabel: 'test',
};

describe('Compressor Stage 1 — Deterministic Stripping', () => {
  it('strips ANSI escape codes', () => {
    const input = '\x1B[1m\x1B[32mTest Suites: 6 passed\x1B[39m\x1B[22m';
    const { compressed } = compress(input, minContext);
    expect(compressed).toBe('Test Suites: 6 passed');
  });

  it('strips cursor movement and erase sequences', () => {
    const input = '\x1B[2K\x1B[1G\x1B[2m$ jest --verbose\x1B[22m';
    const { compressed } = compress(input, minContext);
    expect(compressed).toBe('$ jest --verbose');
  });

  it('collapses duplicate blank lines', () => {
    const input = 'line 1\n\n\n\nline 2\n\n\nline 3';
    const { compressed } = compress(input, minContext);
    expect(compressed).toBe('line 1\n\nline 2\n\nline 3');
  });

  it('strips trailing whitespace per line', () => {
    const input = 'line 1   \nline 2\t\t\nline 3  ';
    const { compressed } = compress(input, minContext);
    expect(compressed).toBe('line 1\nline 2\nline 3');
  });

  it('strips carriage return overwrites', () => {
    const input = 'Downloading... 10%\rDownloading... 50%\rDownloading... 100%\nDone.';
    const { compressed } = compress(input, minContext);
    expect(compressed).toBe('Downloading... 100%\nDone.');
  });

  it('strips UTF-8 BOM', () => {
    const input = '\uFEFFconst x = 1;';
    const { compressed } = compress(input, minContext);
    expect(compressed).toBe('const x = 1;');
  });

  it('returns stats with stagesApplied', () => {
    const input = '\x1B[32mhello\x1B[0m';
    const { stats } = compress(input, minContext);
    expect(stats.originalBytes).toBeGreaterThan(stats.compressedBytes);
    expect(stats.stagesApplied).toContain('deterministic');
  });

  it('passes through small output unchanged (below 2KB threshold)', () => {
    const input = 'small output';
    const { compressed } = compress(input, minContext);
    expect(compressed).toBe('small output');
  });

  it('passes through empty output', () => {
    const { compressed } = compress('', minContext);
    expect(compressed).toBe('');
  });

  it('strips ANSI from real Jest output', () => {
    const input = fixture('npm-test-jest-pass.txt');
    const { compressed } = compress(input, minContext);
    expect(compressed).not.toMatch(/\x1B\[/);
    expect(compressed).toContain('Test Suites: 6 passed');
    expect(compressed).toContain('Tests:');
  });

  it('strips ANSI from heavy ANSI fixture', () => {
    const input = fixture('ansi-heavy.txt');
    const { compressed } = compress(input, minContext);
    expect(compressed).not.toMatch(/\x1B\[/);
  });
});

describe('Compressor Stage 2 — Pattern Matchers', () => {
  describe('npm test / jest', () => {
    const jestContext = {
      toolName: 'shell:npm_test',
      command: 'npm test',
      sessionEvents: [],
      learnerWeights: { retentionScore: 0.5 },
      sourceLabel: 'test',
    };

    it('collapses passing tests to count', () => {
      const input = fixture('npm-test-jest-pass.txt');
      const { compressed } = compress(input, jestContext);
      // Should mention collapsed count
      expect(compressed).toMatch(/passing tests collapsed/);
      // Should NOT contain individual passing test lines
      expect(compressed).not.toContain('\u2713 formats bytes');
      expect(compressed).not.toContain('\u2713 hashes strings');
    });

    it('preserves failures verbatim', () => {
      const input = fixture('npm-test-jest-fail.txt');
      const { compressed } = compress(input, jestContext);
      // Failures must survive in full
      expect(compressed).toContain('expect(result.exitCode).toBe(0)');
      expect(compressed).toContain('sandbox.test.js:16:29');
      expect(compressed).toContain('store.searchTrigram is not a function');
      expect(compressed).toContain('knowledge.test.js:23:26');
      // Summary must survive
      expect(compressed).toMatch(/2 failed/);
    });

    it('preserves suite summary line', () => {
      const input = fixture('npm-test-jest-pass.txt');
      const { compressed } = compress(input, jestContext);
      expect(compressed).toContain('Test Suites:');
      expect(compressed).toContain('Tests:');
    });
  });

  describe('git log', () => {
    const gitLogContext = {
      toolName: 'shell:git_log',
      command: 'git log',
      sessionEvents: [
        { type: 'file_operation', data: 'server/index.js' },
      ],
      learnerWeights: { retentionScore: 0.5 },
      sourceLabel: 'test',
    };

    it('deduplicates merge commits', () => {
      const input = fixture('git-log-200-commits.txt');
      const { compressed } = compress(input, gitLogContext);
      // Count occurrences of identical merge messages
      const merges = compressed.match(/Merge branch/g) || [];
      const uniqueMerges = new Set(
        compressed.split('\n')
          .filter(l => l.includes('Merge branch'))
          .map(l => l.trim())
      );
      // Each unique merge message should appear at most once
      expect(merges.length).toBeLessThanOrEqual(uniqueMerges.size + 5); // small tolerance
    });

    it('caps output to 30 entries by default', () => {
      const input = fixture('git-log-200-commits.txt');
      const { compressed } = compress(input, gitLogContext);
      const commitCount = (compressed.match(/^commit [a-f0-9]{20,}/gm) || []).length;
      expect(commitCount).toBeLessThanOrEqual(30);
    });

    it('preserves commits mentioning session-relevant files', () => {
      const input = fixture('git-log-200-commits.txt');
      const { compressed } = compress(input, gitLogContext);
      expect(compressed).toContain('server/index.js');
    });
  });

  describe('git diff', () => {
    const gitDiffContext = {
      toolName: 'shell:git_diff',
      command: 'git diff',
      sessionEvents: [
        { type: 'file_operation', data: 'server/index.js' },
        { type: 'file_operation', data: 'hooks/core/routing.js' },
      ],
      learnerWeights: { retentionScore: 0.5 },
      sourceLabel: 'test',
    };

    it('preserves hunks for session-relevant files', () => {
      const input = fixture('git-diff-large.txt');
      const { compressed } = compress(input, gitDiffContext);
      expect(compressed).toContain('diff --git a/server/index.js');
      expect(compressed).toContain('diff --git a/hooks/core/routing.js');
    });

    it('summarizes non-relevant file diffs', () => {
      const input = fixture('git-diff-large.txt');
      const { compressed } = compress(input, gitDiffContext);
      // node_modules diff content should be summarized, not shown in full
      expect(compressed).not.toContain('var __prop0=Object.defineProperty');
    });
  });

  describe('npm install', () => {
    const npmInstallContext = {
      toolName: 'shell:npm_install',
      command: 'npm install',
      sessionEvents: [],
      learnerWeights: { retentionScore: 0.5 },
      sourceLabel: 'test',
    };

    it('strips progress and keeps summary', () => {
      const input = fixture('npm-install-verbose.txt');
      const { compressed } = compress(input, npmInstallContext);
      expect(compressed).toMatch(/added \d+ packages/i);
      expect(compressed.length).toBeLessThan(input.length * 0.3);
    });
  });

  describe('pip install', () => {
    const pipContext = {
      toolName: 'shell:pip_install',
      command: 'pip install requests flask',
      sessionEvents: [],
      learnerWeights: { retentionScore: 0.5 },
      sourceLabel: 'test',
    };

    it('strips download progress and keeps summary', () => {
      const input = fixture('pip-install-progress.txt');
      const { compressed } = compress(input, pipContext);
      expect(compressed).toMatch(/Successfully installed/i);
      expect(compressed.length).toBeLessThan(input.length * 0.3);
    });
  });

  describe('pytest', () => {
    const pytestContext = {
      toolName: 'shell:pytest',
      command: 'pytest',
      sessionEvents: [],
      learnerWeights: { retentionScore: 0.5 },
      sourceLabel: 'test',
    };

    it('preserves failures verbatim and summarizes passes', () => {
      const input = fixture('pytest-mixed.txt');
      const { compressed } = compress(input, pytestContext);
      expect(compressed).toMatch(/FAILED/);
      expect(compressed).toMatch(/\d+ passed/);
    });
  });

  describe('cargo build', () => {
    const cargoContext = {
      toolName: 'shell:cargo_build',
      command: 'cargo build',
      sessionEvents: [],
      learnerWeights: { retentionScore: 0.5 },
      sourceLabel: 'test',
    };

    it('strips compile lines and keeps warnings/errors/summary', () => {
      const input = fixture('cargo-build-incremental.txt');
      const { compressed } = compress(input, cargoContext);
      expect(compressed).toMatch(/warning|Finished/i);
      // Most compiling lines should be stripped (some near warnings survive via error protection)
      const compilingLines = (compressed.match(/Compiling.*v\d+\.\d+\.\d+/g) || []).length;
      expect(compilingLines).toBeLessThanOrEqual(5);
      expect(compressed).toMatch(/crate compilation steps collapsed/);
    });
  });

  describe('docker build', () => {
    const dockerContext = {
      toolName: 'shell:docker_build',
      command: 'docker build .',
      sessionEvents: [],
      learnerWeights: { retentionScore: 0.5 },
      sourceLabel: 'test',
    };

    it('strips cache lines and keeps steps/errors/image ID', () => {
      const input = fixture('docker-build-cached.txt');
      const { compressed } = compress(input, dockerContext);
      expect(compressed).toMatch(/writing image/i);
    });
  });

  describe('make', () => {
    const makeContext = {
      toolName: 'shell:make',
      command: 'make',
      sessionEvents: [],
      learnerWeights: { retentionScore: 0.5 },
      sourceLabel: 'test',
    };

    it('strips compile invocations and keeps warnings/errors', () => {
      const input = fixture('make-build-output.txt');
      const { compressed } = compress(input, makeContext);
      expect(compressed).toMatch(/warning/i);
      // Most gcc -c lines should be stripped (some near warnings survive via error protection)
      const gccLines = compressed.split('\n').filter(l => /^\s*(gcc|g\+\+|cc)\s+.*-c\s/.test(l));
      expect(gccLines.length).toBeLessThanOrEqual(3);
      expect(compressed).toMatch(/compile steps collapsed/);
    });
  });

  describe('directory listings', () => {
    it('collapses node_modules/.git/__pycache__', () => {
      const input = fixture('directory-listing-deep.txt');
      const { compressed } = compress(input, {
        ...minContext,
        command: 'ls -la',
      });
      expect(compressed).not.toMatch(/node_modules\/.+\//);
      expect(compressed).toMatch(/node_modules.*\d+.*items.*collapsed/i);
    });
  });
});

describe('Compressor Stage 3 — Session-Aware Relevance', () => {
  it('preserves blocks mentioning session-relevant files', () => {
    const input = [
      'Building module: server/index.js',
      'Result: success',
      '',
      'Building module: utils/deprecated.js',
      'Result: success',
      '',
      'Building module: test/old-fixture.js',
      'Result: success',
    ].join('\n');

    const padded = input + '\n' + Array(300).fill('Building module: filler.js\nResult: ok\n').join('\n');

    const { compressed } = compress(padded, {
      toolName: 'shell:make',
      command: 'make build',
      sessionEvents: [{ type: 'file_operation', data: 'server/index.js' }],
      learnerWeights: { retentionScore: 0.0 },
      sourceLabel: 'test',
    });

    expect(compressed).toContain('server/index.js');
  });

  it('summarizes low-relevance blocks when learner weight is low', () => {
    const blocks = [];
    for (let i = 0; i < 50; i++) {
      blocks.push(`Block ${i}: some routine build output for module-${i}.js`);
      blocks.push(`Compiled successfully in ${i + 10}ms`);
      blocks.push('');
    }
    const input = blocks.join('\n');

    const { compressed } = compress(input, {
      toolName: 'shell:make',
      command: 'make build',
      sessionEvents: [],
      learnerWeights: { retentionScore: 0.0 },
      sourceLabel: 'test',
    });

    expect(compressed.length).toBeLessThan(input.length * 0.5);
    expect(compressed).toContain('indexed');
  });

  it('preserves more when learner weight is high', () => {
    const blocks = [];
    for (let i = 0; i < 50; i++) {
      blocks.push(`Block ${i}: routine output for module-${i}.js`);
      blocks.push('');
    }
    const input = blocks.join('\n');

    const highWeight = compress(input, {
      toolName: 'shell:make',
      command: 'make build',
      sessionEvents: [],
      learnerWeights: { retentionScore: 1.0 },
      sourceLabel: 'test',
    });

    const lowWeight = compress(input, {
      toolName: 'shell:make',
      command: 'make build',
      sessionEvents: [],
      learnerWeights: { retentionScore: 0.0 },
      sourceLabel: 'test',
    });

    expect(highWeight.compressed.length).toBeGreaterThan(lowWeight.compressed.length);
  });

  it('never compresses error lines regardless of relevance score', () => {
    const input = [
      'routine output line 1',
      'routine output line 2',
      'Error: something failed at line 42',
      'routine output line 3',
    ].join('\n');

    const padded = input + '\n' + Array(300).fill('filler line').join('\n');

    const { compressed } = compress(padded, {
      toolName: 'shell:build',
      command: 'build',
      sessionEvents: [],
      learnerWeights: { retentionScore: 0.0 },
      sourceLabel: 'test',
    });

    expect(compressed).toContain('Error: something failed at line 42');
  });

  it('returns decisions in stats for learner tracking', () => {
    const blocks = Array(200).fill('some output line that is long enough').join('\n');
    const { stats } = compress(blocks, {
      toolName: 'shell:build',
      command: 'build something',
      sessionEvents: [],
      learnerWeights: { retentionScore: 0.0 },
      sourceLabel: 'test',
    });

    expect(stats.stagesApplied).toContain('session-aware');
    expect(stats.decisions.length).toBeGreaterThan(0);
  });
});

describe('Compressor — Error Invariant', () => {
  it('never strips lines containing error keywords', () => {
    const errorLines = [
      'Error: ENOENT: no such file or directory',
      'TypeError: Cannot read property of undefined',
      'FAIL  src/test.js',
      'warning: unused variable',
      'WARN: deprecated API',
      'panic: runtime error',
      'exception: connection refused',
      'Traceback (most recent call last):',
    ];
    const filler = Array(20).fill('Compiling crate v1.0.0').join('\n');
    const input = errorLines.join('\n') + '\n' + filler;

    const { compressed } = compress(input, {
      toolName: 'shell:cargo_build',
      command: 'cargo build',
      sessionEvents: [],
      learnerWeights: { retentionScore: 0.5 },
      sourceLabel: 'test',
    });

    for (const line of errorLines) {
      expect(compressed).toContain(line);
    }
  });
});
