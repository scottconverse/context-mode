/**
 * hooks-merge.js — Merge context-mode entries into a Codex hooks.json
 * without wiping the user's other hooks.
 *
 * Official Codex shape (developers.openai.com/codex/hooks):
 *   { "description": "...", "hooks": { "PreToolUse": [ { matcher, hooks: [...] } ] } }
 *
 * Some third-party writeups put events at the root (no "hooks" wrapper).
 * We preserve whichever shape we find. New files use the official wrapper.
 */

export const DISPATCH_MARK = 'hooks/dispatch.js';

const EVENTS = [
  { event: 'SessionStart', canonical: 'sessionStart', matcher: '*' },
  { event: 'PreToolUse', canonical: 'preToolUse', matcher: 'Bash' },
  { event: 'PostToolUse', canonical: 'postToolUse', matcher: 'Bash' },
  { event: 'PreCompact', canonical: 'preCompact', matcher: '*' },
  { event: 'UserPromptSubmit', canonical: 'userPromptSubmit', matcher: '*' },
  { event: 'Stop', canonical: 'stop', matcher: '*' },
];

// Normalize Windows backslash paths to forward slashes so DISPATCH_MARK
// detection works consistently across platforms.
function normSlash(p) { return String(p).replace(/\\/g, '/'); }

function posixQuote(s) {
  if (s === '') return "''";
  if (/^[A-Za-z0-9_./:=+-]+$/.test(s)) return s;
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function winQuote(s) {
  return `"${String(s).replace(/"/g, '\\"')}"`;
}

function unixCommand(nodePath, dispatchPath, dataDir, canonical) {
  return [
    'env',
    `CONTEXT_MODE_PLATFORM=codex`,
    `CONTEXT_MODE_DATA=${posixQuote(dataDir)}`,
    posixQuote(normSlash(nodePath)),
    posixQuote(normSlash(dispatchPath)),
    'codex',
    canonical,
  ].join(' ');
}

function windowsCommand(nodePath, dispatchPath, dataDir, canonical) {
  return [
    winQuote(normSlash(nodePath)),
    winQuote(normSlash(dispatchPath)),
    'codex',
    canonical,
  ].join(' ');
}

export function buildCodexHookEntry({ nodePath, dispatchPath, dataDir, canonical, matcher }) {
  return {
    matcher,
    hooks: [
      {
        type: 'command',
        command: unixCommand(nodePath, dispatchPath, dataDir, canonical),
        commandWindows: windowsCommand(nodePath, dispatchPath, dataDir, canonical),
        timeout: 30,
        statusMessage: 'context-mode',
      },
    ],
  };
}

export function buildCodexHooksDoc({ nodePath, dispatchPath, dataDir }) {
  const hooks = {};
  for (const { event, canonical, matcher } of EVENTS) {
    hooks[event] = [
      buildCodexHookEntry({ nodePath, dispatchPath, dataDir, canonical, matcher }),
    ];
  }
  return {
    description: 'context-mode hooks for Codex CLI',
    hooks,
  };
}

function isOurs(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
  return hooks.some((h) => {
    const cmd = `${h?.command || ''} ${h?.commandWindows || ''}`;
    return cmd.includes(DISPATCH_MARK);
  });
}

function eventBucket(doc) {
  if (doc && doc.hooks && typeof doc.hooks === 'object' && !Array.isArray(doc.hooks)) {
    return { shape: 'wrapped', bucket: doc.hooks };
  }
  if (doc && typeof doc === 'object' && (doc.PreToolUse || doc.SessionStart)) {
    return { shape: 'root', bucket: doc };
  }
  return { shape: 'wrapped', bucket: (doc.hooks = {}) };
}

/**
 * Merge our matcher groups into an existing hooks.json document.
 * Replaces previous context-mode groups; leaves everything else.
 */
export function mergeHooksJson(existingText, ours) {
  let doc;
  try {
    doc = existingText && String(existingText).trim()
      ? JSON.parse(existingText)
      : { description: ours.description, hooks: {} };
  } catch {
    doc = { description: ours.description, hooks: {} };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    doc = { description: ours.description, hooks: {} };
  }

  const { shape, bucket } = eventBucket(doc);
  for (const [event, groups] of Object.entries(ours.hooks)) {
    const current = Array.isArray(bucket[event]) ? bucket[event] : [];
    const kept = current.filter((g) => !isOurs(g));
    bucket[event] = [...groups, ...kept];
  }

  if (shape === 'wrapped' && !doc.description) doc.description = ours.description;
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function hooksJsonHasDispatch(text) {
  return typeof text === 'string' && text.includes(DISPATCH_MARK);
}
