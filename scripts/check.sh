#!/usr/bin/env bash
#
# Runs the hand-rolled *.check.ts suites.
#
# There is no test runner in this project's dependencies and adding one is not
# worth a hackathon weekend, so the suites are plain scripts that assert and
# exit non-zero. This compiles them to CommonJS under .check-build, symlinks
# node_modules/@ -> the build root so the `@/*` alias resolves at runtime, and
# runs each one.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=.check-build
rm -rf "$OUT"
npx tsc -p tsconfig.check.json
mkdir -p "$OUT/node_modules"
ln -sfn .. "$OUT/node_modules/@"

failed=0
for suite in \
  lib/__tests__/session-view.check.js \
  lib/room/__tests__/room.check.js \
  lib/llm/__tests__/offline-scenario.check.js \
  lib/negotiation/__tests__/fairness.check.js \
  lib/negotiation/__tests__/redaction.check.js
do
  printf '\n\033[1m== %s ==\033[0m\n' "$suite"
  if node "$OUT/$suite"; then :; else failed=1; fi
done

rm -rf "$OUT"
if [ "$failed" -ne 0 ]; then
  printf '\n\033[31mFAIL\033[0m\n'
  exit 1
fi
printf '\n\033[32mAll suites passed.\033[0m\n'
