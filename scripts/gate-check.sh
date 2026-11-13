#!/usr/bin/env bash
set -euo pipefail

echo "[Gate 1/4] Checking diff size guideline..."
if git rev-parse --verify HEAD >/dev/null 2>&1; then
  CHANGED_LINES=$(git diff --numstat HEAD | awk '{add+=$1; del+=$2} END {print add+del+0}')
else
  CHANGED_LINES=$(git diff --cached --numstat | awk '{add+=$1; del+=$2} END {print add+del+0}')
fi

if [ "${CHANGED_LINES:-0}" -gt 400 ]; then
  echo "WARN: Diff exceeds 400 lines ($CHANGED_LINES). Verify slice granularity."
fi

echo "[Gate 2/4] Typecheck & Lint..."
if [ -f package.json ]; then
  pnpm check
  pnpm i18n:check
fi

echo "[Gate 3/4] Deterministic Test Suite..."
if [ -f package.json ]; then
  pnpm build
  pnpm test --run
fi

echo "[Gate 4/4] Basic Secret & Debug Leftover Scan..."
SECRET_ONLY_PATTERN='^\+.*(AKIA[0-9A-Z]{16}|sk-[a-zA-Z0-9]{20,})'
DEBUGGER_PATTERN='^\+.*debugger[;]'
if { git diff --cached -U0; git diff -U0; } | grep -v '^+++' | grep -E "$SECRET_ONLY_PATTERN"; then
  echo "FAIL: Potential secret or debugger statement detected in diff." >&2
  exit 1
fi
if { git diff --cached -U0 -- . ':!*.md'; git diff -U0 -- . ':!*.md'; } | grep -v '^+++' | grep -E "$DEBUGGER_PATTERN"; then
  echo "FAIL: Potential secret or debugger statement detected in diff." >&2
  exit 1
fi

echo "ALL SOFTWARE 1.0 GATES PASSED."
