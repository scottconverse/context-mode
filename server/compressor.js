/**
 * Local Token Compression Engine for context-mode.
 *
 * Three-stage pipeline:
 *   Stage 1 — Deterministic stripping (lossless)
 *   Stage 2 — Pattern-based compression (per tool type)
 *   Stage 3 — Session-aware relevance (lossy, guided by learner)
 *
 * Licensed under Elastic License 2.0.
 */

import { createHash } from 'node:crypto';

// ─── Constants ──────────────────────────────────────────────────────────────

const COMPRESSION_THRESHOLD_BYTES = 2048; // 2KB — don't compress small outputs

// ─── ANSI / Terminal Noise Patterns ─────────────────────────────────────────

const ANSI_REGEX = /\x1B\[[0-9;?]*[A-Za-z]|\x1B\[[0-9;]*m|\x1B\].*?(?:\x07|\x1B\\)|\x1B\(B/g;
const BOM = /^\uFEFF/;

// ─── Stage 1: Deterministic Stripping ───────────────────────────────────────

/**
 * Strip ANSI escape codes, collapse blanks, trim whitespace.
 * Lossless — only formatting noise is removed.
 */
export function stageDeterministic(text) {
  let result = text;

  // Strip BOM
  result = result.replace(BOM, '');

  // Strip ANSI escape codes
  result = result.replace(ANSI_REGEX, '');

  // Handle carriage return overwrites: keep only the last \r-segment per line
  result = result.split('\n').map(line => {
    if (line.includes('\r')) {
      const segments = line.split('\r');
      return segments[segments.length - 1];
    }
    return line;
  }).join('\n');

  // Strip trailing whitespace per line
  result = result.split('\n').map(l => l.trimEnd()).join('\n');

  // Collapse 3+ consecutive newlines to 2 (one blank line)
  result = result.replace(/\n{3,}/g, '\n\n');

  return result;
}

// ─── Error Line Tagging ─────────────────────────────────────────────────────

const ERROR_KEYWORDS = /\b(error|Error|ERROR|fail|FAIL|warning|Warning|WARN|panic|exception|traceback|TypeError|ReferenceError|SyntaxError|ENOENT|EPERM|EACCES)\b/;

/**
 * Pre-scan: tag lines that must survive compression.
 * Returns a Set of line indices that are protected.
 */
export function tagErrorLines(lines) {
  const protected_ = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (ERROR_KEYWORDS.test(lines[i])) {
      for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) {
        protected_.add(j);
      }
    }
  }
  return protected_;
}

// ─── Tool Pattern Detection ─────────────────────────────────────────────────

/**
 * Detect which tool type a command represents for pattern matching.
 */
export function detectToolPattern(command) {
  if (!command) return null;
  if (/npm\s+test|npx\s+(jest|vitest)\b/i.test(command)) return 'npm_test';
  if (/npm\s+(install|ci)\b/i.test(command)) return 'npm_install';
  if (/git\s+log\b/i.test(command)) return 'git_log';
  if (/git\s+diff\b/i.test(command)) return 'git_diff';
  if (/pip\s+install\b/i.test(command)) return 'pip_install';
  if (/pytest\b|python\s+-m\s+pytest/i.test(command)) return 'pytest';
  if (/cargo\s+(build|test)\b/i.test(command)) return 'cargo_build';
  if (/docker\s+build\b/i.test(command)) return 'docker_build';
  if (/\bmake\b|cmake\s+--build/i.test(command)) return 'make';
  if (/\bls\s|tree\s|find\s/i.test(command)) return 'directory_listing';
  return null;
}

// ─── Pattern Matchers ───────────────────────────────────────────────────────

/**
 * npm test / jest / vitest: collapse passing tests to count, preserve failures.
 */
export function matchNpmTest(lines, context) {
  const protected_ = tagErrorLines(lines);
  const result = [];
  let passCount = 0;
  let inFailBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (protected_.has(i)) {
      result.push(line);
      continue;
    }

    // Detect start of failure block
    if (/^\s*●\s|FAIL\s+\S/.test(line)) {
      inFailBlock = true;
      result.push(line);
      continue;
    }

    // Inside failure block: preserve until we hit a PASS or summary
    if (inFailBlock) {
      if (/^\s*PASS\s/.test(line) || /^Test Suites:/.test(line)) {
        inFailBlock = false;
      } else {
        result.push(line);
        continue;
      }
    }

    // Passing test lines: count but don't include
    if (/^\s+[✓✔√]\s/.test(line)) {
      passCount++;
      continue;
    }

    // Suite headers (PASS lines): skip individual ones
    if (/^\s*PASS\s+\S/.test(line)) {
      continue;
    }

    // Summary lines: always keep
    if (/^Test Suites:|^Tests:|^Snapshots:|^Time:|^Ran all/.test(line)) {
      result.push(line);
      continue;
    }

    // Suite name lines (describe block headers): skip unless near failure
    if (/^\s{2,}\S/.test(line) && !/^\s+[✓✔✕✗●]\s/.test(line) && !protected_.has(i)) {
      const nearbyFail = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 3))
        .some(l => /FAIL|✕|✗|●/.test(l));
      if (nearbyFail) {
        result.push(line);
      }
      continue;
    }

    result.push(line);
  }

  if (passCount > 0) {
    const summaryIdx = result.findIndex(l => /^Test Suites:/.test(l));
    if (summaryIdx >= 0) {
      result.splice(summaryIdx, 0, `  (${passCount} passing tests collapsed)`);
    } else {
      result.push(`  (${passCount} passing tests collapsed)`);
    }
  }

  return result;
}

/**
 * git log: dedup merge commits, cap entries, preserve session-relevant commits.
 */
export function matchGitLog(lines, context, maxEntries = 30) {
  const sessionFiles = (context.sessionEvents || [])
    .filter(e => e.type === 'file_operation')
    .map(e => e.data)
    .filter(Boolean);

  // Parse into commit blocks
  const commits = [];
  let current = null;

  for (const line of lines) {
    if (/^commit [a-f0-9]{40}/.test(line)) {
      if (current) commits.push(current);
      current = { lines: [line], message: '', isSessionRelevant: false, isMerge: false };
    } else if (current) {
      current.lines.push(line);
      if (!current.message && line.trim() && !line.startsWith('Author:') && !line.startsWith('Date:') && !line.startsWith('Merge:')) {
        current.message = line.trim();
      }
      if (sessionFiles.some(f => line.includes(f))) {
        current.isSessionRelevant = true;
      }
      if (/^Merge:|Merge branch/.test(line.trim())) {
        current.isMerge = true;
      }
    }
  }
  if (current) commits.push(current);

  // Dedup merge commits with identical messages
  const seenMergeMessages = new Set();
  const dedupedCommits = [];
  let mergesSkipped = 0;

  for (const commit of commits) {
    if (commit.isMerge && seenMergeMessages.has(commit.message)) {
      mergesSkipped++;
      continue;
    }
    if (commit.isMerge) {
      seenMergeMessages.add(commit.message);
    }
    dedupedCommits.push(commit);
  }

  // Prioritize: session-relevant first, then recent
  const relevant = dedupedCommits.filter(c => c.isSessionRelevant);
  const others = dedupedCommits.filter(c => !c.isSessionRelevant);

  const kept = [...relevant, ...others].slice(0, maxEntries);

  const result = [];
  for (const commit of kept) {
    result.push(...commit.lines);
  }

  if (dedupedCommits.length > maxEntries || mergesSkipped > 0) {
    result.push('');
    if (mergesSkipped > 0) {
      result.push(`... ${mergesSkipped} duplicate merge commits collapsed`);
    }
    if (dedupedCommits.length > maxEntries) {
      result.push(`... ${dedupedCommits.length - maxEntries} more commits (indexed, use ctx_search to query)`);
    }
  }

  return result;
}

/**
 * git diff: preserve hunks for session-relevant files, summarize others.
 */
export function matchGitDiff(lines, context) {
  const protected_ = tagErrorLines(lines);
  const sessionFiles = (context.sessionEvents || [])
    .filter(e => e.type === 'file_operation')
    .map(e => e.data)
    .filter(Boolean);

  // Parse into file blocks
  const files = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    if (/^diff --git/.test(lines[i])) {
      if (current) files.push(current);
      const match = lines[i].match(/^diff --git a\/(.+?) b\/(.+)/);
      const filePath = match ? match[2] : '';
      current = {
        header: lines[i],
        filePath,
        lines: [lines[i]],
        addCount: 0,
        removeCount: 0,
        isSessionRelevant: sessionFiles.some(f => filePath.includes(f) || f.includes(filePath)),
        hasProtectedLines: false,
      };
    } else if (current) {
      current.lines.push(lines[i]);
      if (lines[i].startsWith('+') && !lines[i].startsWith('+++')) current.addCount++;
      if (lines[i].startsWith('-') && !lines[i].startsWith('---')) current.removeCount++;
      if (protected_.has(i)) current.hasProtectedLines = true;
    }
  }
  if (current) files.push(current);

  const result = [];
  let summarizedCount = 0;
  const summaries = [];

  for (const file of files) {
    if (file.isSessionRelevant || file.hasProtectedLines) {
      result.push(...file.lines);
    } else {
      summarizedCount++;
      summaries.push(`  ${file.filePath}: +${file.addCount}/-${file.removeCount} lines`);
    }
  }

  if (summaries.length > 0) {
    result.push('');
    result.push(`... ${summarizedCount} files summarized (full diffs indexed, use ctx_search):`);
    result.push(...summaries);
  }

  return result;
}

/**
 * npm install: strip per-package progress, keep summary + warnings/errors.
 */
export function matchNpmInstall(lines, context) {
  const protected_ = tagErrorLines(lines);
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    if (protected_.has(i)) { result.push(lines[i]); continue; }

    if (/^added \d+|^removed \d+|^up to date|^found \d+|npm warn|npm ERR|^\d+ packages/.test(lines[i])) {
      result.push(lines[i]);
      continue;
    }
    if (/^npm http|^npm timing|^⸩|^⸨|^\s*$/.test(lines[i])) continue;
    if (/^npm info|^npm notice/.test(lines[i]) && !/warn|deprecat/i.test(lines[i])) continue;

    result.push(lines[i]);
  }

  return result;
}

/**
 * pip install: strip download/collecting lines, keep summary.
 */
export function matchPipInstall(lines, context) {
  const protected_ = tagErrorLines(lines);
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    if (protected_.has(i)) { result.push(lines[i]); continue; }

    if (/^\s*(Collecting|Downloading|Using cached|Installing collected)\b/.test(lines[i]) && !/error|warn/i.test(lines[i])) continue;
    if (/^\s*━+/.test(lines[i])) continue;
    if (/^\s*\d+(\.\d+)?%/.test(lines[i])) continue;

    result.push(lines[i]);
  }

  return result;
}

/**
 * pytest: preserve failures verbatim, collapse passes to count.
 */
export function matchPytest(lines, context) {
  const protected_ = tagErrorLines(lines);
  const result = [];
  let inFailSection = false;
  let passCount = 0;

  for (let i = 0; i < lines.length; i++) {
    if (protected_.has(i)) { result.push(lines[i]); continue; }

    if (/^={3,}\s*FAILURES\s*={3,}/.test(lines[i]) || /^_{3,}\s*\w/.test(lines[i])) {
      inFailSection = true;
      result.push(lines[i]);
      continue;
    }

    if (/^={3,}\s*short test summary/.test(lines[i])) {
      inFailSection = true;
      result.push(lines[i]);
      continue;
    }

    if (inFailSection) {
      result.push(lines[i]);
      if (/^={3,}\s*\d+/.test(lines[i])) {
        inFailSection = false;
      }
      continue;
    }

    if (/^\s*PASSED\b/.test(lines[i]) || /^tests\/.*PASSED/.test(lines[i])) {
      passCount++;
      continue;
    }

    if (/^collected \d+|^\s*=+\s*\d+\s*(passed|failed|error)/.test(lines[i])) {
      result.push(lines[i]);
      continue;
    }

    result.push(lines[i]);
  }

  if (passCount > 0) {
    const summaryIdx = result.findIndex(l => /^\s*=+\s*\d+/.test(l));
    const msg = `  (${passCount} passing tests collapsed)`;
    if (summaryIdx >= 0) {
      result.splice(summaryIdx, 0, msg);
    } else {
      result.push(msg);
    }
  }

  return result;
}

/**
 * cargo build/test: strip "Compiling" lines, keep warnings/errors/summary.
 */
export function matchCargoBuild(lines, context) {
  const protected_ = tagErrorLines(lines);
  const result = [];
  let compilingCount = 0;

  for (let i = 0; i < lines.length; i++) {
    if (protected_.has(i)) { result.push(lines[i]); continue; }

    if (/^\s*Compiling\s+\S+\s+v\d/.test(lines[i])) {
      compilingCount++;
      continue;
    }

    if (/^\s*Downloading\s/.test(lines[i])) continue;

    result.push(lines[i]);
  }

  if (compilingCount > 0) {
    result.unshift(`  (${compilingCount} crate compilation steps collapsed)`);
  }

  return result;
}

/**
 * docker build: strip cache lines, keep steps/errors/final image.
 */
export function matchDockerBuild(lines, context) {
  const protected_ = tagErrorLines(lines);
  const result = [];
  let cacheCount = 0;

  for (let i = 0; i < lines.length; i++) {
    if (protected_.has(i)) { result.push(lines[i]); continue; }

    if (/--->\s*Using cache/.test(lines[i])) {
      cacheCount++;
      continue;
    }

    if (/^--->\s*[a-f0-9]{12}$/.test(lines[i].trim())) continue;

    result.push(lines[i]);
  }

  if (cacheCount > 0) {
    result.push(`  (${cacheCount} cached layers collapsed)`);
  }

  return result;
}

/**
 * make/cmake: strip compile invocations, keep warnings/errors/link step.
 */
export function matchMake(lines, context) {
  const protected_ = tagErrorLines(lines);
  const result = [];
  let compileCount = 0;

  for (let i = 0; i < lines.length; i++) {
    if (protected_.has(i)) { result.push(lines[i]); continue; }

    if (/^\s*(gcc|g\+\+|cc|clang|clang\+\+)\s+.*-c\s/.test(lines[i])) {
      compileCount++;
      continue;
    }

    result.push(lines[i]);
  }

  if (compileCount > 0) {
    result.unshift(`  (${compileCount} compile steps collapsed)`);
  }

  return result;
}

/**
 * Directory listings: collapse node_modules/.git/__pycache__/venv.
 */
export function matchDirectoryListing(lines, context) {
  const COLLAPSE_DIRS = ['node_modules', '.git', '__pycache__', 'venv', '.venv', 'dist', 'build', '.next'];
  const result = [];
  const collapsedDirs = {};

  for (const line of lines) {
    const inCollapsible = COLLAPSE_DIRS.find(d =>
      line.includes(`${d}/`) || line.includes(`${d}\\`)
    );

    if (inCollapsible) {
      collapsedDirs[inCollapsible] = (collapsedDirs[inCollapsible] || 0) + 1;
      continue;
    }

    result.push(line);
  }

  for (const [dir, count] of Object.entries(collapsedDirs)) {
    result.push(`  ${dir}/ (${count} items collapsed)`);
  }

  return result;
}

// ─── Stage 2: Pattern-Based Compression ─────────────────────────────────────

const PATTERN_MATCHERS = {
  npm_test: matchNpmTest,
  npm_install: matchNpmInstall,
  git_log: matchGitLog,
  git_diff: matchGitDiff,
  pip_install: matchPipInstall,
  pytest: matchPytest,
  cargo_build: matchCargoBuild,
  docker_build: matchDockerBuild,
  make: matchMake,
  directory_listing: matchDirectoryListing,
};

export function stagePatternBased(text, context) {
  const pattern = detectToolPattern(context.command);
  if (!pattern || !PATTERN_MATCHERS[pattern]) {
    return { text, applied: false };
  }

  const lines = text.split('\n');
  const compressed = PATTERN_MATCHERS[pattern](lines, context);
  return { text: compressed.join('\n'), applied: true };
}

// ─── Stage 3: Session-Aware Relevance ───────────────────────────────────────

const RELEVANCE_THRESHOLD = 0.4;
const DEFAULT_RETENTION = 0.5;

/**
 * Score a block of text for relevance to current session.
 */
function scoreBlock(block, sessionFiles, errorProtected) {
  if (errorProtected) return 1.0;

  let score = 0;

  if (sessionFiles.some(f => block.includes(f))) {
    score += 0.8;
  }

  if (/\b[\w\-./]+\.(js|ts|py|rs|go|java|jsx|tsx|vue|rb|php|css|html|json|yaml|yml|toml|md)\b/.test(block)) {
    score += 0.2;
  }

  return Math.min(score, 1.0);
}

/**
 * Session-aware lossy compression.
 * Scores blocks by relevance, preserves high-scoring and error-containing blocks,
 * summarizes the rest.
 */
export function stageSessionAware(text, context) {
  const sessionFiles = (context.sessionEvents || [])
    .filter(e => e.type === 'file_operation')
    .map(e => e.data)
    .filter(Boolean);

  const retentionScore = context.learnerWeights?.retentionScore ?? DEFAULT_RETENTION;

  const lines = text.split('\n');
  const errorLines = tagErrorLines(lines);

  // Split into blocks (blank-line-separated)
  const blocks = [];
  let currentBlock = { lines: [], startIdx: 0 };

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '' && currentBlock.lines.length > 0) {
      blocks.push(currentBlock);
      currentBlock = { lines: [], startIdx: i + 1 };
    } else if (lines[i].trim() !== '') {
      currentBlock.lines.push({ text: lines[i], idx: i });
    }
  }
  if (currentBlock.lines.length > 0) blocks.push(currentBlock);

  const result = [];
  const decisions = [];
  let cutBlockCount = 0;
  let cutLineCount = 0;

  for (const block of blocks) {
    const blockText = block.lines.map(l => l.text).join('\n');
    const hasError = block.lines.some(l => errorLines.has(l.idx));
    const relevance = scoreBlock(blockText, sessionFiles, hasError);
    const shouldPreserve = (relevance + retentionScore) > RELEVANCE_THRESHOLD || hasError;

    if (shouldPreserve) {
      result.push(...block.lines.map(l => l.text));
      result.push('');
    } else {
      cutBlockCount++;
      cutLineCount += block.lines.length;

      const hash = createHash('sha256').update(blockText).digest('hex').slice(0, 16);
      decisions.push({
        contentHash: hash,
        contentPreview: blockText.slice(0, 100),
        cut: true,
      });
    }
  }

  if (cutBlockCount > 0) {
    result.push(`... ${cutLineCount} lines in ${cutBlockCount} blocks summarized (indexed, use ctx_search to query)`);
  }

  return {
    text: result.join('\n'),
    decisions,
    applied: cutBlockCount > 0,
  };
}

// ─── Main Pipeline ──────────────────────────────────────────────────────────

/**
 * Compress tool output through the 3-stage pipeline.
 *
 * @param {string} output - Raw tool output
 * @param {object} context - { toolName, command, sessionEvents, learnerWeights, sourceLabel }
 * @returns {{ compressed: string, stats: { originalBytes, compressedBytes, stagesApplied, decisions } }}
 */
export function compress(output, context) {
  const originalBytes = Buffer.byteLength(output, 'utf8');

  // Pass through empty output
  if (!output || output.trim() === '') {
    return {
      compressed: output,
      stats: { originalBytes: 0, compressedBytes: 0, stagesApplied: [], decisions: [] },
    };
  }

  // Stage 1 always runs (even below threshold — ANSI stripping is cheap and always useful)
  let text = stageDeterministic(output);
  const stagesApplied = ['deterministic'];

  // Below threshold: return after Stage 1 only
  if (originalBytes < COMPRESSION_THRESHOLD_BYTES) {
    const compressedBytes = Buffer.byteLength(text, 'utf8');
    return {
      compressed: text,
      stats: { originalBytes, compressedBytes, stagesApplied, decisions: [] },
    };
  }

  // Stage 2 — Pattern-based compression
  const s2 = stagePatternBased(text, context);
  text = s2.text;
  if (s2.applied) stagesApplied.push('pattern-based');

  // Stage 3 — Session-aware relevance
  const s3 = stageSessionAware(text, context);
  text = s3.text;
  if (s3.applied) stagesApplied.push('session-aware');

  const compressedBytes = Buffer.byteLength(text, 'utf8');

  return {
    compressed: text,
    stats: {
      originalBytes,
      compressedBytes,
      stagesApplied,
      decisions: s3.decisions || [],
    },
  };
}
