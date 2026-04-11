# context-mode v1.3.1 Patch — Bug Fixes from Technical Review

**Goal:** Fix 3 bugs identified in the Chrome extension technical review of v1.3.0.

**Scope:** Patch release. No new features, no architecture changes. Three targeted fixes with tests.

---

## Bug 1: Learner accuracy label inversion

**File:** `server/learner.js`, `server/index.js`

**Root cause:** `was_retrieved = 1` in the `compression_log` table means "Claude later searched for this content" — a retrieval **hit**. But `getLifetimeStats()` returns this count as `totalMisses`, and `ctx_stats` displays `(1 - misses/decisions) * 100` as "accuracy." The displayed number is inverted — high retrieval rates show as low accuracy.

**Fix:**
- In `learner.js`: rename `totalMisses` → `totalRetrievals` in the return value of `getLifetimeStats()`.
- In `index.js` (`ctx_stats` handler): 
  - Replace `Retrieval misses: ${totalMisses}` with `Retrieval rate: ${totalRetrievals}/${totalDecisions}`.
  - Accuracy = `(totalRetrievals / totalDecisions * 100).toFixed(1)%`.
  - Confidence label: retrieval rate > 10% → "High", otherwise → "Learning".
- In `index.js` (`ctx_stats` lifetime section): same label fix.

**Test updates:**
- Update `test/learner.test.js` assertions that reference `totalMisses` → `totalRetrievals`.

---

## Bug 2: ctx_execute_file missing compression pipeline

**File:** `server/index.js`

**Root cause:** `ctx_execute` and `ctx_batch_execute` both pass output through the 3-stage compression pipeline (`compress()` from `compressor.js`). `ctx_execute_file` does not — it returns raw stdout directly to context. This inconsistency means large file-processing outputs bypass compression entirely.

**Fix:**
- Add the same try/catch-wrapped compression pipeline to the `ctx_execute_file` handler, after the existing intent-based auto-indexing block.
- Use `toolPattern = 'file:' + language` for learner tracking.
- Graceful fallback: if compression throws, return raw stdout (same pattern as `ctx_execute`).
- The 2KB threshold in `compress()` already ensures small outputs (typical for `execute_file` use cases) only get Stage 1 ANSI stripping.

**Test:**
- Add 1 test verifying `ctx_execute_file` output goes through compression (can verify via the MCP smoke test pattern — call `ctx_execute_file`, check the response doesn't contain ANSI codes that Stage 1 would strip).

---

## Bug 3: ctx_fetch_and_index silent failure on network error

**File:** `server/index.js`

**Root cause:** When a fetch fails, the sandboxed subprocess exits with code 1 and produces no stdout. The parent calls `JSON.parse('')` which throws. The catch block falls through to "treat entire stdout as content" — which indexes an empty string. Claude receives a success-like response when nothing was actually indexed.

**Fix:**
- Before `JSON.parse(stdout)`, check if `stdout.trim()` is empty.
- If empty and `exitCode !== 0`: return an explicit error response: `"Fetch failed: no content returned from <url>. Check the URL is accessible and try again."`
- If empty and `exitCode === 0`: return `"Fetch returned empty content from <url>. The page may require authentication or JavaScript rendering."`
- Never call `store.index()` with empty content.

**Test:**
- Add 1 E2E test: call `ctx_fetch_and_index` with a guaranteed-bad URL (e.g., `http://localhost:1/nonexistent`), assert the response contains "Fetch failed" and `isError: true`.

---

## Version Bump

- `package.json`: `1.3.0` → `1.3.1`
- `.claude-plugin/plugin.json`: `1.3.0` → `1.3.1`
- `server/index.js`: `const VERSION = '1.3.1'`
- `CHANGELOG.md`: Add `[1.3.1]` Fixed section

---

## Out of Scope

The review identified additional concerns (Stage 3 scoring shallowness, learner miss-detection fragility, no rate limiting on ctx_execute). These are improvements for a future minor release, not bug fixes for this patch.
