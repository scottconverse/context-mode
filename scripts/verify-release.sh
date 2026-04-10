#!/usr/bin/env bash
# verify-release.sh — Automated pre-push verification for context-mode
# Run this before every push. All checks must pass.
set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/.."
cd "$ROOT"

PASS=0
FAIL=0
WARN=0

pass() { echo -e "  ${GREEN}PASS${NC} $1"; ((PASS++)); }
fail() { echo -e "  ${RED}FAIL${NC} $1"; ((FAIL++)); }
warn() { echo -e "  ${YELLOW}WARN${NC} $1"; ((WARN++)); }

echo "============================================"
echo "  context-mode — Pre-Push Verification"
echo "============================================"
echo ""

# ── 1. Secrets Scan ──────────────────────────────────────────────
echo "1. Secrets Scan"
SECRETS_FOUND=0
for pattern in 'ghp_[A-Za-z0-9]\{20,\}' 'sk-ant-[A-Za-z0-9]\{20,\}' 'AKIA[A-Z0-9]\{16,\}' 'api[_-]key\s*[:=]\s*["\x27][A-Za-z0-9]\{10,\}' 'password\s*[:=]\s*["\x27][^"\x27]\{8,\}'; do
  if grep -r --include='*.js' --include='*.json' --include='*.md' --include='*.html' --include='*.sh' --include='*.yml' -l "$pattern" . 2>/dev/null | grep -v node_modules | grep -v '.git/' | head -5; then
    SECRETS_FOUND=1
  fi
done
if [ "$SECRETS_FOUND" -eq 0 ]; then
  pass "No secrets detected in source files"
else
  fail "Potential secrets found — review files above"
fi

# ── 2. Repo Hygiene ──────────────────────────────────────────────
echo ""
echo "2. Repo Hygiene"
for f in LICENSE README.md CHANGELOG.md CONTRIBUTING.md; do
  if [ -f "$f" ]; then
    pass "$f exists"
  else
    fail "$f missing"
  fi
done

# ── 3. .gitignore Coverage ───────────────────────────────────────
echo ""
echo "3. .gitignore Coverage"
if [ -f ".gitignore" ]; then
  pass ".gitignore exists"
  for entry in node_modules .env '*.db' '.DS_Store'; do
    if grep -q "$entry" .gitignore 2>/dev/null; then
      pass ".gitignore covers $entry"
    else
      warn ".gitignore missing coverage for $entry"
    fi
  done
else
  fail ".gitignore missing"
fi

# ── 4. Version Consistency ───────────────────────────────────────
echo ""
echo "4. Version Consistency"
PKG_VERSION=$(node -e "console.log(require('./package.json').version)")
echo "   package.json version: $PKG_VERSION"

# Check server/index.js VERSION constant
if grep -q "VERSION = '$PKG_VERSION'" server/index.js 2>/dev/null; then
  pass "server/index.js VERSION matches $PKG_VERSION"
else
  SERVER_VER=$(grep "VERSION = " server/index.js 2>/dev/null | head -1)
  fail "server/index.js VERSION mismatch: $SERVER_VER (expected $PKG_VERSION)"
fi

# Check plugin.json version
if [ -f ".claude-plugin/plugin.json" ]; then
  PLUGIN_VER=$(node -e "console.log(require('./.claude-plugin/plugin.json').version)")
  if [ "$PLUGIN_VER" = "$PKG_VERSION" ]; then
    pass "plugin.json version matches $PKG_VERSION"
  else
    fail "plugin.json version mismatch: $PLUGIN_VER (expected $PKG_VERSION)"
  fi
fi

# Check CHANGELOG has entry for this version
if grep -q "\[$PKG_VERSION\]" CHANGELOG.md 2>/dev/null; then
  pass "CHANGELOG.md has entry for $PKG_VERSION"
else
  fail "CHANGELOG.md missing entry for $PKG_VERSION"
fi

# Check README mentions version
if grep -q "$PKG_VERSION" README.md 2>/dev/null; then
  pass "README.md references $PKG_VERSION"
else
  warn "README.md does not reference $PKG_VERSION"
fi

# Check landing page footer
if grep -q "$PKG_VERSION" docs/index.html 2>/dev/null; then
  pass "docs/index.html references $PKG_VERSION"
else
  warn "docs/index.html does not reference $PKG_VERSION"
fi

# ── 5. Documentation Artifacts ───────────────────────────────────
echo ""
echo "5. Documentation Artifacts"
for f in README.md CHANGELOG.md CONTRIBUTING.md USER-MANUAL.md docs/index.html; do
  if [ -f "$f" ]; then
    pass "$f exists"
  else
    fail "$f missing"
  fi
done

# ── 6. Test Suite ────────────────────────────────────────────────
echo ""
echo "6. Test Suite"
echo "   Running E2E tests..."
if node test-e2e.js 2>&1; then
  pass "E2E tests passed"
else
  fail "E2E tests failed"
fi

echo "   Running adversarial tests..."
if node test-adversarial.js 2>&1; then
  pass "Adversarial tests passed"
else
  fail "Adversarial tests failed"
fi

# Run vitest if available (compressor + learner + routing tests)
if command -v npx &>/dev/null && [ -d "test" ]; then
  echo "   Running vitest suite..."
  if npx vitest run 2>&1; then
    pass "Vitest suite passed"
  else
    fail "Vitest suite failed"
  fi
fi

# ── 7. No Skipped Tests ─────────────────────────────────────────
echo ""
echo "7. Skipped Test Scan"
SKIPS_FOUND=0
for pattern in 'test\.skip' 'it\.skip' 'describe\.skip' 'xit(' 'xdescribe(' 'xtest('; do
  if grep -r --include='*.js' --include='*.ts' -l "$pattern" test/ 2>/dev/null | head -5; then
    SKIPS_FOUND=1
  fi
done
if [ "$SKIPS_FOUND" -eq 0 ]; then
  pass "No skipped tests found"
else
  fail "Skipped tests detected — fix or remove them"
fi

# ── 8. No TODO/FIXME ────────────────────────────────────────────
echo ""
echo "8. TODO/FIXME Scan"
TODOS_FOUND=0
for pattern in 'TODO' 'FIXME' 'HACK' 'XXX'; do
  matches=$(grep -r --include='*.js' -l "$pattern" server/ hooks/ 2>/dev/null | grep -v node_modules | head -5)
  if [ -n "$matches" ]; then
    echo "   $pattern found in: $matches"
    TODOS_FOUND=1
  fi
done
if [ "$TODOS_FOUND" -eq 0 ]; then
  pass "No TODO/FIXME/HACK markers in source"
else
  warn "TODO/FIXME markers found — review before pushing"
fi

# ── Summary ──────────────────────────────────────────────────────
echo ""
echo "============================================"
echo "  Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}, ${YELLOW}${WARN} warnings${NC}"
echo "============================================"

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}VERIFICATION FAILED — fix failures before pushing${NC}"
  exit 1
else
  echo -e "${GREEN}VERIFICATION PASSED — safe to push${NC}"
  exit 0
fi
