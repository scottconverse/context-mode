// test/routing-expanded.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { routePreToolUse, resetGuidanceThrottle } from '../hooks/core/routing.js';

beforeEach(() => {
  resetGuidanceThrottle();
});

describe('Expanded Routing — New Matchers', () => {
  describe('git log', () => {
    it('redirects unbounded git log', () => {
      const result = routePreToolUse('Bash', { command: 'git log' });
      expect(result).not.toBeNull();
      expect(result.action).toBe('modify');
      expect(result.updatedInput.command).toContain('context-mode');
    });

    it('passes through git log --oneline', () => {
      const result = routePreToolUse('Bash', { command: 'git log --oneline' });
      // Should be null (passthrough) or guidance (not redirect)
      expect(result?.action).not.toBe('modify');
    });

    it('passes through git log -n 3', () => {
      const result = routePreToolUse('Bash', { command: 'git log -n 3' });
      expect(result?.action).not.toBe('modify');
    });

    it('passes through git log | head -20', () => {
      const result = routePreToolUse('Bash', { command: 'git log | head -20' });
      expect(result?.action).not.toBe('modify');
    });

    it('passes through git log --format="%H %s"', () => {
      const result = routePreToolUse('Bash', { command: 'git log --format="%H %s"' });
      expect(result?.action).not.toBe('modify');
    });

    it('passes through git log -5', () => {
      const result = routePreToolUse('Bash', { command: 'git log -5' });
      expect(result?.action).not.toBe('modify');
    });
  });

  describe('git diff', () => {
    it('redirects unbounded git diff', () => {
      const result = routePreToolUse('Bash', { command: 'git diff' });
      expect(result?.action).toBe('modify');
    });

    it('passes through git diff --stat', () => {
      const result = routePreToolUse('Bash', { command: 'git diff --stat' });
      expect(result?.action).not.toBe('modify');
    });

    it('passes through single-file git diff', () => {
      const result = routePreToolUse('Bash', { command: 'git diff src/index.js' });
      expect(result?.action).not.toBe('modify');
    });

    it('passes through git diff | grep pattern', () => {
      const result = routePreToolUse('Bash', { command: 'git diff | grep "function"' });
      expect(result?.action).not.toBe('modify');
    });
  });

  describe('npm test', () => {
    it('redirects npm test', () => {
      const result = routePreToolUse('Bash', { command: 'npm test' });
      expect(result?.action).toBe('modify');
    });

    it('redirects npx jest', () => {
      const result = routePreToolUse('Bash', { command: 'npx jest' });
      expect(result?.action).toBe('modify');
    });

    it('redirects npx vitest run', () => {
      const result = routePreToolUse('Bash', { command: 'npx vitest run' });
      expect(result?.action).toBe('modify');
    });

    it('passes through npm test | grep FAIL', () => {
      const result = routePreToolUse('Bash', { command: 'npm test | grep FAIL' });
      expect(result?.action).not.toBe('modify');
    });
  });

  describe('pytest', () => {
    it('redirects pytest', () => {
      const result = routePreToolUse('Bash', { command: 'pytest' });
      expect(result?.action).toBe('modify');
    });

    it('redirects python -m pytest', () => {
      const result = routePreToolUse('Bash', { command: 'python -m pytest' });
      expect(result?.action).toBe('modify');
    });

    it('passes through pytest | tail -5', () => {
      const result = routePreToolUse('Bash', { command: 'pytest | tail -5' });
      expect(result?.action).not.toBe('modify');
    });
  });

  describe('npm install', () => {
    it('redirects npm install', () => {
      const result = routePreToolUse('Bash', { command: 'npm install' });
      expect(result?.action).toBe('modify');
    });

    it('redirects npm ci', () => {
      const result = routePreToolUse('Bash', { command: 'npm ci' });
      expect(result?.action).toBe('modify');
    });
  });

  describe('pip install', () => {
    it('redirects pip install flask', () => {
      const result = routePreToolUse('Bash', { command: 'pip install flask' });
      expect(result?.action).toBe('modify');
    });
  });

  describe('cargo', () => {
    it('redirects cargo build', () => {
      const result = routePreToolUse('Bash', { command: 'cargo build' });
      expect(result?.action).toBe('modify');
    });

    it('redirects cargo test', () => {
      const result = routePreToolUse('Bash', { command: 'cargo test' });
      expect(result?.action).toBe('modify');
    });

    it('passes through cargo build | tail -5', () => {
      const result = routePreToolUse('Bash', { command: 'cargo build | tail -5' });
      expect(result?.action).not.toBe('modify');
    });
  });

  describe('docker build', () => {
    it('redirects docker build .', () => {
      const result = routePreToolUse('Bash', { command: 'docker build .' });
      expect(result?.action).toBe('modify');
    });
  });

  describe('make', () => {
    it('redirects make', () => {
      const result = routePreToolUse('Bash', { command: 'make' });
      expect(result?.action).toBe('modify');
    });

    it('redirects cmake --build .', () => {
      const result = routePreToolUse('Bash', { command: 'cmake --build .' });
      expect(result?.action).toBe('modify');
    });

    it('passes through make | grep error', () => {
      const result = routePreToolUse('Bash', { command: 'make | grep error' });
      expect(result?.action).not.toBe('modify');
    });
  });
});

describe('Expanded Routing — Existing Matchers Unchanged', () => {
  it('still blocks curl stdout', () => {
    const result = routePreToolUse('Bash', { command: 'curl https://example.com' });
    expect(result?.action).toBe('modify');
  });

  it('still blocks WebFetch', () => {
    const result = routePreToolUse('WebFetch', { url: 'https://example.com' });
    expect(result?.action).toBe('deny');
  });

  it('still redirects gradle', () => {
    const result = routePreToolUse('Bash', { command: './gradlew build' });
    expect(result?.action).toBe('modify');
  });

  it('still passes through unknown tools', () => {
    const result = routePreToolUse('SomeTool', { input: 'test' });
    expect(result).toBeNull();
  });
});
