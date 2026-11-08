#!/bin/sh
# FF-001 reproducible pin + plugin smoke.
# Verifies the pinned Paperclip upstream tag, asserts the adapter contract
# strings in the pinned sources, then runs the fixture shape smoke.
# Usage: scripts/paperclip-pin-smoke.sh
set -eu

PIN_TAG="v2026.1106.0"
PIN_SHA="d69631b01b9c658f80bf8bed389863dce82643e1"
UPSTREAM="https://github.com/paperclipai/paperclip.git"
RAW="https://raw.githubusercontent.com/paperclipai/paperclip/${PIN_TAG}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "== 1. tag ${PIN_TAG} resolves to ${PIN_SHA}"
resolved="$(git ls-remote "${UPSTREAM}" "refs/tags/${PIN_TAG}" | cut -f1)"
echo "   ls-remote: ${resolved}"
test "${resolved}" = "${PIN_SHA}" || { echo "PIN MISMATCH"; exit 1; }

echo "== 2. fetch pinned sources"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT INT TERM
for f in LICENSE "docs/adapters/creating-an-adapter.md" "docs/adapters/http.md" \
         "docs/adapters/process.md" "packages/adapters/AUTHORING.md"; do
  curl -fsSL "${RAW}/${f}" -o "${work}/$(echo "$f" | tr / _)"
done

echo "== 3. assert contract strings"
grep -q "MIT License" "${work}/LICENSE"
grep -q "Copyright (c) 2025 Paperclip AI" "${work}/LICENSE"
grep -q "build an external adapter plugin" "${work}/docs_adapters_creating-an-adapter.md"
grep -q "createServerAdapter" "${work}/docs_adapters_creating-an-adapter.md"
grep -q "sessionParams" "${work}/docs_adapters_creating-an-adapter.md"
grep -q "clearSession" "${work}/docs_adapters_creating-an-adapter.md"
grep -q "The local execution-workspace cwd is the" "${work}/packages_adapters_AUTHORING.md"
grep -q "restoreWorkspaceFromSshExecution" "${work}/packages_adapters_AUTHORING.md"
grep -q "check-no-git-push" "${work}/packages_adapters_AUTHORING.md"
grep -q "not suited for deep real-time stdout capture" "${work}/docs_adapters_http.md" \
  || grep -qi "real-time" "${work}/docs_adapters_http.md"
echo "   upstream contract strings present"

echo "== 4. fixture plugin smoke"
node "${ROOT}/examples/paperclip-adapter-smoke/smoke.mjs"

echo "PIN+SMOKE PASS ${PIN_TAG} ${PIN_SHA}"
