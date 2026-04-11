# context-mode v1.5.0 Scoring + Configurable Compression — Design Spec

**Date:** 2026-04-10
**Project:** context-mode v1.5.0 (Spec C)
**Status:** Approved

---

## Overview

Two features plus version bump. No breaking changes.

1. **Enhanced Stage 3 scoring** — Replace flat +0.8/+0.2 scoring with multi-signal scorer using recency, frequency, and content signals.
2. **Configurable compression aggressiveness** — Environment variable to control compression level (conservative/balanced/aggressive).

---

## Feature 1: Enhanced scoreBlock()

### Problem

Current scoring is binary — either a block mentions a session file (+0.8) or it doesn't. This misses recency (recently edited files matter more), frequency (heavily-touched files matter more), and content signals (stack traces and definitions have diagnostic value).

### Design

Replace the flat scoring in `scoreBlock()` with a weighted multi-signal scorer:

| Signal | Score | Rationale |
|--------|-------|-----------|
| Mentions a file edited in last 5 min | +0.6 | Hot file — very likely relevant |
| Mentions a file edited in last 30 min | +0.4 | Warm file |
| Mentions any other session file | +0.2 | Cold file — still some relevance |
| File mentioned N times in session (log₂(N) * 0.1, max 0.3) | +0.0–0.3 | Frequency boost |
| Contains stack trace pattern (`at `, `File "`, `Traceback`) | +0.3 | Diagnostic value even without error keywords |
| Contains function/class definition (`function `, `def `, `class `, `fn `) | +0.1 | Structural code |
| Contains any source file reference (`.js`, `.py`, etc.) | +0.1 | Generic code signal |
| Error-protected line | 1.0 | Unchanged — absolute protection |

Max score capped at 1.0.

### Context Change

`sessionFiles` currently arrives as a flat `string[]` from `context.sessionEvents`:
```javascript
const sessionFiles = (context.sessionEvents || [])
  .filter(e => e.type === 'file_operation')
  .map(e => e.data)
  .filter(Boolean);
```

Change to pass richer objects: `{ path: string, timestamp: number, count: number }`.

The caller in `server/index.js` (ctx_execute, ctx_execute_file, ctx_batch_execute) builds this from session events. The `stageSessionAware()` function receives the enriched array and passes it to `scoreBlock()`.

### Threshold

The `shouldPreserve` check stays the same:
```javascript
const shouldPreserve = (relevance + retentionScore) > threshold || hasError;
```

Only the relevance inputs change. The threshold value becomes configurable (Feature 2).

---

## Feature 2: Configurable Compression Aggressiveness

### Problem

No user control over compression aggressiveness. Power users who want more token savings or more preserved detail have no knob.

### Design

A single `COMPRESSION_LEVEL` environment variable with 3 presets:

| Level | RELEVANCE_THRESHOLD | Effect |
|-------|-------------------|--------|
| `conservative` | 0.2 | Preserves more — only cuts clearly irrelevant blocks |
| `balanced` (default) | 0.4 | Current behavior |
| `aggressive` | 0.7 | Cuts more — only keeps highly relevant + errors |

**Configuration source:** Environment variable `CONTEXT_MODE_COMPRESSION` read once at server startup.

**Fallback:** If the env var is unset or unrecognized, default to `balanced`.

**Implementation:** In `compressor.js`, replace the hardcoded `RELEVANCE_THRESHOLD = 0.4` constant with a function that returns the threshold based on the configured level. Export the level getter so `ctx_stats` can display it.

```javascript
const COMPRESSION_LEVELS = {
  conservative: 0.2,
  balanced: 0.4,
  aggressive: 0.7,
};

const compressionLevel = COMPRESSION_LEVELS[process.env.CONTEXT_MODE_COMPRESSION] 
  ? process.env.CONTEXT_MODE_COMPRESSION 
  : 'balanced';

export function getCompressionLevel() { return compressionLevel; }
export function getRelevanceThreshold() { return COMPRESSION_LEVELS[compressionLevel]; }
```

### ctx_stats Display

Add compression level to the stats output header:
```
# Token Savings This Session (45m) — compression: balanced
```

---

## Version Bump

Bump to **1.5.0** (MINOR — new backward-compatible features).

Update: package.json, plugin.json, server/index.js VERSION constant, CHANGELOG.md, README.md, docs/index.html, docs/README-FULL.md.

---

## Testing

### scoreBlock tests (in test/compressor.test.js)
- Hot file (edited < 5 min ago) scores +0.6
- Warm file (edited < 30 min ago) scores +0.4
- Cold session file scores +0.2
- Frequency boost: file with 8 touches gets log₂(8) * 0.1 = +0.3
- Stack trace pattern detected (+0.3)
- Function definition detected (+0.1)
- Combined signals cap at 1.0
- Error-protected always returns 1.0 (unchanged)

### Compression level tests (in test/compressor.test.js)
- `conservative` uses threshold 0.2
- `balanced` uses threshold 0.4 (default)
- `aggressive` uses threshold 0.7
- Unrecognized value falls back to `balanced`

### ctx_stats test
- Compression level displayed in output

### Integration
- E2E: tool output compressed at each level produces different retention rates

---

## Out of Scope

- Per-tool compression level (e.g., aggressive for npm install, conservative for git diff) — future work
- UI for setting compression level — env var is sufficient for power users
- User manual updates — will be a separate docs pass after code ships
