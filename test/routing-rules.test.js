// test/routing-rules.test.js
// Per-rule and per-condition unit tests for the declarative routing system.
// Tests conditions in routing-conditions.js and rules in routing-rules.js independently.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  hasFileOutput, isStdoutAlias, isSilent, isVerbose,
  hasLimit, hasShortFormat, hasPipe, hasStat, hasSingleFile,
} from '../hooks/core/routing-conditions.js';
import { ROUTING_RULES } from '../hooks/core/routing-rules.js';
import { routePreToolUse, resetGuidanceThrottle } from '../hooks/core/routing.js';

beforeEach(() => resetGuidanceThrottle());

// ── routing-conditions.js ────────────────────────────────────────────────

describe('routing-conditions: hasFileOutput', () => {
  it('curl -o file is file output', () => expect(hasFileOutput('curl -s -o out.json https://x')).toBe(true));
  it('curl > file is file output', () => expect(hasFileOutput('curl https://x > out.json')).toBe(true));
  it('curl with no output flag is not file output', () => expect(hasFileOutput('curl https://x')).toBe(false));
  it('wget -O file is file output', () => expect(hasFileOutput('wget -O out.zip https://x')).toBe(true));
  it('wget with no output flag is not file output', () => expect(hasFileOutput('wget https://x')).toBe(false));
});

describe('routing-conditions: isStdoutAlias', () => {
  it('curl -o - is stdout alias', () => expect(isStdoutAlias('curl -s -o - https://x')).toBe(true));
  it('curl -o /dev/stdout is stdout alias', () => expect(isStdoutAlias('curl -s -o /dev/stdout https://x')).toBe(true));
  it('curl -o file.json is not stdout alias', () => expect(isStdoutAlias('curl -s -o file.json https://x')).toBe(false));
  it('wget -O - is stdout alias', () => expect(isStdoutAlias('wget -q -O - https://x')).toBe(true));
  it('wget -O file.zip is not stdout alias', () => expect(isStdoutAlias('wget -q -O file.zip https://x')).toBe(false));
});

describe('routing-conditions: isSilent', () => {
  it('curl -s is silent', () => expect(isSilent('curl -s -o f https://x')).toBe(true));
  it('curl --silent is silent', () => expect(isSilent('curl --silent -o f https://x')).toBe(true));
  it('curl without -s is not silent', () => expect(isSilent('curl -o f https://x')).toBe(false));
  it('wget -q is quiet', () => expect(isSilent('wget -q -O f https://x')).toBe(true));
  it('wget --quiet is quiet', () => expect(isSilent('wget --quiet -O f https://x')).toBe(true));
  it('wget without -q is not quiet', () => expect(isSilent('wget -O f https://x')).toBe(false));
});

describe('routing-conditions: isVerbose', () => {
  it('curl -v is verbose', () => expect(isVerbose('curl -v https://x')).toBe(true));
  it('curl --verbose is verbose', () => expect(isVerbose('curl --verbose https://x')).toBe(true));
  it('curl --trace is verbose', () => expect(isVerbose('curl --trace https://x')).toBe(true));
  it('curl -s is not verbose', () => expect(isVerbose('curl -s https://x')).toBe(false));
});

describe('routing-conditions: git helpers', () => {
  it('hasLimit: -n 5', () => expect(hasLimit('git log -n 5')).toBe(true));
  it('hasLimit: --max-count=10', () => expect(hasLimit('git log --max-count=10')).toBe(true));
  it('hasLimit: -3 shorthand', () => expect(hasLimit('git log -3')).toBe(true));
  it('hasLimit: plain git log', () => expect(hasLimit('git log')).toBe(false));

  it('hasShortFormat: --oneline', () => expect(hasShortFormat('git log --oneline')).toBe(true));
  it('hasShortFormat: --format=', () => expect(hasShortFormat('git log --format="%H"')).toBe(true));
  it('hasShortFormat: plain log', () => expect(hasShortFormat('git log')).toBe(false));

  it('hasPipe: | head', () => expect(hasPipe('git log | head -20')).toBe(true));
  it('hasPipe: | grep', () => expect(hasPipe('git log | grep fix')).toBe(true));
  it('hasPipe: no pipe', () => expect(hasPipe('git log')).toBe(false));

  it('hasStat: --stat', () => expect(hasStat('git diff --stat')).toBe(true));
  it('hasStat: no stat', () => expect(hasStat('git diff')).toBe(false));

  it('hasSingleFile: .js file', () => expect(hasSingleFile('git diff src/index.js')).toBe(true));
  it('hasSingleFile: .ts file', () => expect(hasSingleFile('git diff hooks/routing.ts')).toBe(true));
  it('hasSingleFile: no file', () => expect(hasSingleFile('git diff')).toBe(false));
});

// ── routing-rules.js structure ───────────────────────────────────────────

describe('ROUTING_RULES structure', () => {
  const REQUIRED_FIELDS = ['id', 'tool', 'action', 'docLabel', 'docTarget'];

  it('every rule has required fields', () => {
    for (const rule of ROUTING_RULES) {
      for (const field of REQUIRED_FIELDS) {
        expect(rule, `rule ${rule.id} missing ${field}`).toHaveProperty(field);
      }
    }
  });

  it('every rule id is unique', () => {
    const ids = ROUTING_RULES.map(r => r.id);
    const unique = new Set(ids);
    expect(ids.length).toBe(unique.size);
  });

  it('every modify/deny rule has a message', () => {
    for (const rule of ROUTING_RULES) {
      if (rule.action === 'modify' || rule.action === 'deny') {
        expect(rule.message, `rule ${rule.id} missing message`).toBeTruthy();
      }
    }
  });

  it('every guidance rule has a guidanceKey', () => {
    for (const rule of ROUTING_RULES) {
      if (rule.action === 'guidance') {
        expect(rule.guidanceKey, `rule ${rule.id} missing guidanceKey`).toBeTruthy();
      }
    }
  });

  it('perSegment rules also have safeWhen', () => {
    for (const rule of ROUTING_RULES) {
      if (rule.perSegment) {
        expect(rule.safeWhen, `rule ${rule.id} has perSegment but no safeWhen`).toBeTypeOf('function');
      }
    }
  });

  const KNOWN_TOOLS = ['Bash', 'Read', 'Grep', 'WebFetch', 'Agent', 'Task'];
  it('every rule targets a known tool', () => {
    for (const rule of ROUTING_RULES) {
      expect(KNOWN_TOOLS, `rule ${rule.id} targets unknown tool ${rule.tool}`).toContain(rule.tool);
    }
  });
});

// ── Per-rule integration tests (via routePreToolUse) ─────────────────────

describe('rule: curl-wget', () => {
  it('blocks plain curl', () => {
    const r = routePreToolUse('Bash', { command: 'curl https://api.example.com/data' });
    expect(r?.action).toBe('modify');
    expect(r.updatedInput.command).toContain('context-mode');
  });
  it('blocks wget without flags', () => {
    expect(routePreToolUse('Bash', { command: 'wget https://example.com/file.zip' })?.action).toBe('modify');
  });
  it('allows curl -s -o file', () => {
    expect(routePreToolUse('Bash', { command: 'curl -s -o out.json https://api.example.com' })?.action).not.toBe('modify');
  });
  it('blocks curl -s -o - (stdout alias)', () => {
    expect(routePreToolUse('Bash', { command: 'curl -s -o - https://api.example.com' })?.action).toBe('modify');
  });
  it('does not false-positive on gh with curl in --body', () => {
    const r = routePreToolUse('Bash', { command: 'gh issue edit 1 --body "text with curl in it"' });
    expect(r?.action).not.toBe('modify');
  });
});

describe('rule: inline-http', () => {
  it('blocks fetch() in node -e', () => {
    expect(routePreToolUse('Bash', { command: "node -e \"fetch('https://api.example.com')\"" })?.action).toBe('modify');
  });
  it('blocks requests.get()', () => {
    expect(routePreToolUse('Bash', { command: "python -c \"import requests; requests.get('https://x')\"" })?.action).toBe('modify');
  });
  it('does not block echo with fetch word', () => {
    expect(routePreToolUse('Bash', { command: 'echo "no fetch here"' })?.action).not.toBe('modify');
  });
});

describe('rule: build-tools', () => {
  it('redirects gradle', () => expect(routePreToolUse('Bash', { command: './gradlew build' })?.action).toBe('modify'));
  it('redirects mvn', () => expect(routePreToolUse('Bash', { command: 'mvn package' })?.action).toBe('modify'));
  it('redirects mvnw', () => expect(routePreToolUse('Bash', { command: './mvnw clean install' })?.action).toBe('modify'));
});

describe('rule: git-log', () => {
  it('redirects unbounded git log', () => expect(routePreToolUse('Bash', { command: 'git log' })?.action).toBe('modify'));
  it('passes git log --oneline', () => expect(routePreToolUse('Bash', { command: 'git log --oneline' })?.action).not.toBe('modify'));
  it('passes git log -n 10', () => expect(routePreToolUse('Bash', { command: 'git log -n 10' })?.action).not.toBe('modify'));
  it('passes git log | head -5', () => expect(routePreToolUse('Bash', { command: 'git log | head -5' })?.action).not.toBe('modify'));
  it('passes git log -5', () => expect(routePreToolUse('Bash', { command: 'git log -5' })?.action).not.toBe('modify'));
});

describe('rule: git-diff', () => {
  it('redirects unbounded git diff', () => expect(routePreToolUse('Bash', { command: 'git diff' })?.action).toBe('modify'));
  it('passes git diff --stat', () => expect(routePreToolUse('Bash', { command: 'git diff --stat' })?.action).not.toBe('modify'));
  it('passes git diff src/index.js', () => expect(routePreToolUse('Bash', { command: 'git diff src/index.js' })?.action).not.toBe('modify'));
  it('passes git diff | grep "^+"', () => expect(routePreToolUse('Bash', { command: 'git diff | grep "^+"' })?.action).not.toBe('modify'));
});

describe('rule: npm-test', () => {
  it('redirects npm test', () => expect(routePreToolUse('Bash', { command: 'npm test' })?.action).toBe('modify'));
  it('redirects npx jest', () => expect(routePreToolUse('Bash', { command: 'npx jest' })?.action).toBe('modify'));
  it('passes npm test | grep FAIL', () => expect(routePreToolUse('Bash', { command: 'npm test | grep FAIL' })?.action).not.toBe('modify'));
});

describe('rule: pytest', () => {
  it('redirects pytest', () => expect(routePreToolUse('Bash', { command: 'pytest' })?.action).toBe('modify'));
  it('redirects python -m pytest', () => expect(routePreToolUse('Bash', { command: 'python -m pytest tests/' })?.action).toBe('modify'));
  it('passes pytest | grep FAILED', () => expect(routePreToolUse('Bash', { command: 'pytest | grep FAILED' })?.action).not.toBe('modify'));
});

describe('rule: npm-install', () => {
  it('redirects npm install', () => expect(routePreToolUse('Bash', { command: 'npm install' })?.action).toBe('modify'));
  it('redirects npm ci', () => expect(routePreToolUse('Bash', { command: 'npm ci' })?.action).toBe('modify'));
  it('does not redirect npm run build', () => expect(routePreToolUse('Bash', { command: 'npm run build' })?.action).not.toBe('modify'));
});

describe('rule: pip-install', () => {
  it('redirects pip install', () => expect(routePreToolUse('Bash', { command: 'pip install requests' })?.action).toBe('modify'));
  it('does not redirect pip list', () => expect(routePreToolUse('Bash', { command: 'pip list' })?.action).not.toBe('modify'));
});

describe('rule: cargo', () => {
  it('redirects cargo build', () => expect(routePreToolUse('Bash', { command: 'cargo build' })?.action).toBe('modify'));
  it('redirects cargo test', () => expect(routePreToolUse('Bash', { command: 'cargo test' })?.action).toBe('modify'));
  it('passes cargo build | grep error', () => expect(routePreToolUse('Bash', { command: 'cargo build | grep error' })?.action).not.toBe('modify'));
});

describe('rule: docker-build', () => {
  it('redirects docker build', () => expect(routePreToolUse('Bash', { command: 'docker build .' })?.action).toBe('modify'));
  it('passes docker build | grep Step', () => expect(routePreToolUse('Bash', { command: 'docker build . | grep Step' })?.action).not.toBe('modify'));
  it('does not redirect docker run', () => expect(routePreToolUse('Bash', { command: 'docker run myimage' })?.action).not.toBe('modify'));
});

describe('rule: make', () => {
  it('redirects make', () => expect(routePreToolUse('Bash', { command: 'make' })?.action).toBe('modify'));
  it('redirects cmake --build', () => expect(routePreToolUse('Bash', { command: 'cmake --build .' })?.action).toBe('modify'));
  it('passes make | grep error', () => expect(routePreToolUse('Bash', { command: 'make | grep error' })?.action).not.toBe('modify'));
});

describe('rule: webfetch', () => {
  it('denies WebFetch', () => {
    const r = routePreToolUse('WebFetch', { url: 'https://example.com' });
    expect(r?.action).toBe('deny');
    expect(r.reason).toContain('context-mode');
  });
  it('includes the URL in the denial reason', () => {
    const r = routePreToolUse('WebFetch', { url: 'https://api.example.com/data' });
    expect(r.reason).toContain('https://api.example.com/data');
  });
});

describe('rule: agent-inject / task-inject', () => {
  it('injects routing block into Agent prompt', () => {
    const r = routePreToolUse('Agent', { prompt: 'do the thing' });
    expect(r?.action).toBe('modify');
    expect(r.updatedInput.prompt).toContain('do the thing');
    expect(r.updatedInput.prompt.length).toBeGreaterThan('do the thing'.length);
  });
  it('injects routing block into Task prompt', () => {
    const r = routePreToolUse('Task', { prompt: 'run task' });
    expect(r?.action).toBe('modify');
    expect(r.updatedInput.prompt).toContain('run task');
  });
  it('downgrades Bash subagent to general-purpose', () => {
    const r = routePreToolUse('Agent', { prompt: 'do thing', subagent_type: 'Bash' });
    expect(r.updatedInput.subagent_type).toBe('general-purpose');
  });
});

describe('MCP passthrough rules', () => {
  it('ctx_execute passes through', () => {
    expect(routePreToolUse('mcp__plugin_context-mode_context-mode__ctx_execute', {})).toBeNull();
  });
  it('ctx_execute_file passes through', () => {
    expect(routePreToolUse('mcp__plugin_context-mode_context-mode__ctx_execute_file', {})).toBeNull();
  });
  it('ctx_batch_execute passes through', () => {
    expect(routePreToolUse('mcp__plugin_context-mode_context-mode__ctx_batch_execute', {})).toBeNull();
  });
});
