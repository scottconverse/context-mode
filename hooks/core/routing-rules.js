/**
 * routing-rules.js — Declarative routing rule table for PreToolUse hooks.
 *
 * Each rule is a plain object describing when to intercept a tool call and
 * what action to take. The routing engine (routing.js) iterates this table
 * and executes the first matching rule.
 *
 * Rule schema:
 *   id          {string}   Unique identifier (used in tests and doc generation)
 *   tool        {string}   Tool name to match ("Bash", "WebFetch", "Agent", etc.)
 *   match       {RegExp?}  Regex to test against the (pre-processed) command string.
 *                          If omitted, the rule matches any call to `tool`.
 *   preprocess  {string?}  Pre-processor to apply before matching:
 *                          "stripQuotedContent" | "stripHeredocs" | null
 *   perSegment  {boolean?} If true, split command on chain operators (&&, ||, ;)
 *                          and evaluate safeWhen per segment.
 *   safeWhen    {Function?} (cmd, seg?) => boolean. If returns true, allow through.
 *   action      {string}   "modify" | "deny" | "guidance"
 *   message     {string}   Human-readable redirect message. Use {TOOL} as placeholder
 *                          for ctx_execute, {FETCH} for ctx_fetch_and_index,
 *                          {SEARCH} for ctx_search.
 *   docLabel    {string}   Short label for the auto-generated routing table in docs.
 *   docTarget   {string}   "Redirect target" column for docs.
 */

import {
  hasFileOutput, isStdoutAlias, isSilent, isVerbose,
  hasLimit, hasShortFormat, hasPipe, hasStat, hasSingleFile,
} from './routing-conditions.js';

export const ROUTING_RULES = [
  // ── Bash rules ──────────────────────────────────────────────────────────
  {
    id: 'curl-wget',
    tool: 'Bash',
    match: /(^|\s|&&|\||\;)(curl|wget)\s/i,
    preprocess: 'stripQuotedContent',
    perSegment: true,
    safeWhen: (_cmd, seg) =>
      hasFileOutput(seg) && !isStdoutAlias(seg) && isSilent(seg) && !isVerbose(seg),
    action: 'modify',
    message: 'curl/wget blocked. Think in Code — use {TOOL}(language, code) to fetch and process, or {FETCH}(url, source) to fetch and index. Write pure JS with try/catch, no npm deps. Do NOT retry with curl/wget.',
    docLabel: '`curl` / `wget`',
    docTarget: '`ctx_execute` or `ctx_fetch_and_index`',
  },
  {
    id: 'inline-http',
    tool: 'Bash',
    match: /fetch\s*\(\s*['"](https?:\/\/|http)|requests\.(get|post|put)\s*\(|http\.(get|request)\s*\(/i,
    preprocess: 'stripHeredocs',
    action: 'modify',
    message: 'Inline HTTP blocked. Think in Code — use {TOOL}(language, code) to fetch, process, and console.log() only the result. Write pure JS with try/catch, no npm deps. Do NOT retry with Bash.',
    docLabel: 'Inline HTTP (`fetch`, `requests.get`, `http.get`)',
    docTarget: '`ctx_execute`',
  },
  {
    id: 'build-tools',
    tool: 'Bash',
    match: /(^|\s|&&|\||\;)(\.\/gradlew|gradlew|gradle|\.\/mvnw|mvnw|mvn)\s/i,
    preprocess: 'stripQuotedContent',
    action: 'modify',
    message: 'Build tool redirected. Think in Code — use {TOOL}(language: "shell", code: "<cmd> 2>&1 | tail -30") to run and print only errors/summary. Do NOT retry with Bash.',
    docLabel: '`gradle` / `maven`',
    docTarget: '`ctx_execute`',
  },
  {
    id: 'git-log',
    tool: 'Bash',
    match: /(?:^|\s|&&|\||\;)git\s+log\b/,
    preprocess: 'stripQuotedContent',
    safeWhen: (cmd) => hasLimit(cmd) || hasShortFormat(cmd) || hasPipe(cmd),
    action: 'modify',
    message: 'git log routed through compressor for token efficiency. Full output indexed to knowledge base. Use {SEARCH}(queries: [...]) to find specific content. Do NOT retry with Bash — use {TOOL}(language: "shell", code: "git log 2>&1") instead.',
    docLabel: '`git log` (unbounded)',
    docTarget: '`ctx_execute` (compressor)',
  },
  {
    id: 'git-diff',
    tool: 'Bash',
    match: /(?:^|\s|&&|\||\;)git\s+diff\b/,
    preprocess: 'stripQuotedContent',
    safeWhen: (cmd) => hasStat(cmd) || hasPipe(cmd) || hasSingleFile(cmd),
    action: 'modify',
    message: 'git diff routed through compressor for token efficiency. Full output indexed. Use {SEARCH} to find specific changes. Do NOT retry with Bash — use {TOOL}(language: "shell", code: "git diff 2>&1") instead.',
    docLabel: '`git diff` (unbounded)',
    docTarget: '`ctx_execute` (compressor)',
  },
  {
    id: 'npm-test',
    tool: 'Bash',
    match: /(?:^|\s|&&|\||\;)(npm\s+test|npx\s+(jest|vitest))\b/,
    preprocess: 'stripQuotedContent',
    safeWhen: (cmd) => hasPipe(cmd),
    action: 'modify',
    message: 'test runner routed through compressor. Failures preserved verbatim, passes summarized. Full output indexed. Do NOT retry with Bash — use {TOOL}(language: "shell", code: "npm test 2>&1") instead.',
    docLabel: '`npm test` / `jest` / `vitest`',
    docTarget: '`ctx_execute` (compressor)',
  },
  {
    id: 'pytest',
    tool: 'Bash',
    match: /(?:^|\s|&&|\||\;)(pytest|python\s+-m\s+pytest)\b/,
    preprocess: 'stripQuotedContent',
    safeWhen: (cmd) => hasPipe(cmd),
    action: 'modify',
    message: 'pytest routed through compressor. Failures preserved verbatim, passes summarized. Full output indexed. Do NOT retry with Bash — use {TOOL}(language: "shell", code: "pytest 2>&1") instead.',
    docLabel: '`pytest`',
    docTarget: '`ctx_execute` (compressor)',
  },
  {
    id: 'npm-install',
    tool: 'Bash',
    match: /(?:^|\s|&&|\||\;)npm\s+(install|ci)\b/,
    preprocess: 'stripQuotedContent',
    action: 'modify',
    message: 'npm install routed through compressor. Summary + warnings preserved, progress stripped. Full output indexed. Do NOT retry with Bash — use {TOOL}(language: "shell", code: "npm install 2>&1") instead.',
    docLabel: '`npm install` / `npm ci`',
    docTarget: '`ctx_execute` (compressor)',
  },
  {
    id: 'pip-install',
    tool: 'Bash',
    match: /(?:^|\s|&&|\||\;)pip\s+install\b/,
    preprocess: 'stripQuotedContent',
    action: 'modify',
    message: 'pip install routed through compressor. Summary preserved, download progress stripped. Full output indexed. Do NOT retry with Bash — use {TOOL}(language: "shell", code: "pip install 2>&1") instead.',
    docLabel: '`pip install`',
    docTarget: '`ctx_execute` (compressor)',
  },
  {
    id: 'cargo',
    tool: 'Bash',
    match: /(?:^|\s|&&|\||\;)cargo\s+(build|test)\b/,
    preprocess: 'stripQuotedContent',
    safeWhen: (cmd) => hasPipe(cmd),
    action: 'modify',
    message: 'cargo routed through compressor. Errors/warnings preserved, compile steps collapsed. Full output indexed. Do NOT retry with Bash — use {TOOL}(language: "shell", code: "cargo build 2>&1") instead.',
    docLabel: '`cargo build` / `cargo test`',
    docTarget: '`ctx_execute` (compressor)',
  },
  {
    id: 'docker-build',
    tool: 'Bash',
    match: /(?:^|\s|&&|\||\;)docker\s+build\b/,
    preprocess: 'stripQuotedContent',
    safeWhen: (cmd) => hasPipe(cmd),
    action: 'modify',
    message: 'docker build routed through compressor. Steps + errors preserved, cache lines collapsed. Full output indexed. Do NOT retry with Bash — use {TOOL}(language: "shell", code: "docker build . 2>&1") instead.',
    docLabel: '`docker build`',
    docTarget: '`ctx_execute` (compressor)',
  },
  {
    id: 'make',
    tool: 'Bash',
    match: /(?:^|\s|&&|\||\;)(make|cmake\s+--build)\b/,
    preprocess: 'stripQuotedContent',
    safeWhen: (cmd) => hasPipe(cmd),
    action: 'modify',
    message: 'build routed through compressor. Warnings/errors preserved, compile invocations collapsed. Full output indexed. Do NOT retry with Bash — use {TOOL}(language: "shell", code: "make 2>&1") instead.',
    docLabel: '`make` / `cmake --build`',
    docTarget: '`ctx_execute` (compressor)',
  },
  {
    id: 'bash-guidance',
    tool: 'Bash',
    action: 'guidance',
    guidanceKey: 'bash',
    docLabel: 'All other `Bash` commands',
    docTarget: 'Passthrough (once-per-session guidance nudge)',
  },

  // ── Read / Grep guidance ─────────────────────────────────────────────────
  {
    id: 'read-guidance',
    tool: 'Read',
    action: 'guidance',
    guidanceKey: 'read',
    docLabel: '`Read`',
    docTarget: 'Passthrough (once-per-session guidance nudge)',
  },
  {
    id: 'grep-guidance',
    tool: 'Grep',
    action: 'guidance',
    guidanceKey: 'grep',
    docLabel: '`Grep`',
    docTarget: 'Passthrough (once-per-session guidance nudge)',
  },

  // ── WebFetch deny ────────────────────────────────────────────────────────
  {
    id: 'webfetch',
    tool: 'WebFetch',
    action: 'deny',
    message: 'WebFetch blocked. Think in Code — use {FETCH}(url: "...", source: "...") to fetch and index, then {SEARCH}(queries: [...]) to query. Or use {TOOL}(language, code) to fetch, process, and console.log() only what you need. Write pure JS, no npm deps. Do NOT use curl, wget, or WebFetch.',
    docLabel: '`WebFetch`',
    docTarget: '`ctx_fetch_and_index` + `ctx_search`',
  },

  // ── Agent / Task injection ───────────────────────────────────────────────
  {
    id: 'agent-inject',
    tool: 'Agent',
    action: 'inject-routing-block',
    docLabel: '`Agent`',
    docTarget: 'Routing block injected into subagent prompt',
  },
  {
    id: 'task-inject',
    tool: 'Task',
    action: 'inject-routing-block',
    docLabel: '`Task`',
    docTarget: 'Routing block injected into subagent prompt',
  },
];
