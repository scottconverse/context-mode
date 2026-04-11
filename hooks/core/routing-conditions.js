/**
 * routing-conditions.js — Pure predicate functions for routing safety checks.
 *
 * Each function takes a command string (or segment) and returns a boolean.
 * These are the "safeWhen" building blocks used by routing-rules.js.
 *
 * All functions are pure (no side effects) and individually testable.
 */

// ── curl/wget safety predicates ──────────────────────────────────────────

/** True if the segment redirects output to a file (not stdout). */
export function hasFileOutput(seg) {
  const isCurl = /\bcurl\b/i.test(seg);
  const isWget = /\bwget\b/i.test(seg);
  if (isCurl) {
    return /\s(-o|--output)\s/.test(seg) || /\s*>\s*/.test(seg) || /\s*>>\s*/.test(seg);
  }
  if (isWget) {
    return /\s(-O|--output-document)\s/.test(seg) || /\s*>\s*/.test(seg) || /\s*>>\s*/.test(seg);
  }
  return false;
}

/** True if the segment aliases output to stdout (dangerous even with -o). */
export function isStdoutAlias(seg) {
  const isCurl = /\bcurl\b/i.test(seg);
  const isWget = /\bwget\b/i.test(seg);
  if (isCurl) return /\s(-o|--output)\s+(-|\/dev\/stdout)(\s|$)/.test(seg);
  if (isWget) return /\s(-O|--output-document)\s+(-|\/dev\/stdout)(\s|$)/.test(seg);
  return false;
}

/** True if the segment runs in silent/quiet mode (suppresses progress bar). */
export function isSilent(seg) {
  if (/\bcurl\b/i.test(seg)) return /\s-[a-zA-Z]*s\b|--silent/.test(seg);
  if (/\bwget\b/i.test(seg)) return /\s-[a-zA-Z]*q\b|--quiet/.test(seg);
  return false;
}

/** True if the segment uses verbose/trace flags that flood stderr. */
export function isVerbose(seg) {
  return /\s(-v|--verbose|--trace|-D\s+-)\b/.test(seg);
}

// ── git log/diff safety predicates ───────────────────────────────────────

/** True if the command has an explicit count limit (-n N, --max-count, -N). */
export function hasLimit(cmd) {
  return /\s(-n\s*\d+|--max-count[= ]\d+|-\d+)\b/.test(cmd);
}

/** True if the command uses a short/one-line format. */
export function hasShortFormat(cmd) {
  return /\s(--oneline|--format=|--pretty=oneline)/.test(cmd);
}

/** True if the command pipes output to a reducing tool. */
export function hasPipe(cmd) {
  return /\|\s*(head|grep|wc|tail|awk|sed|sort|uniq|cut)\b/.test(cmd);
}

/** True if git diff uses --stat (summary only, not full diff). */
export function hasStat(cmd) {
  return /\s--stat\b/.test(cmd);
}

/** True if git diff targets a single named file (bounded output). */
export function hasSingleFile(cmd) {
  return /git\s+diff\s+(?:--\w+\s+)*[\w./-]+\.(js|ts|py|rs|go|java|jsx|tsx|css|html|json|yaml|yml|toml|md|txt)\b/.test(cmd);
}
