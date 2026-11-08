#!/usr/bin/env bash
# Run locally/in your Vultr environment after extracting this scaffold.
# This script does not run automatically and needs YOUR own gh auth.
set -euo pipefail
OWNER="${GITHUB_OWNER:-Abraham12611}"
NAME="${GITHUB_REPO:-ForgeFleet}"
VISIBILITY="${GITHUB_VISIBILITY:-private}"
if ! command -v gh >/dev/null 2>&1; then
  echo 'GitHub CLI not found. Install gh and run gh auth login, or create a blank repo in GitHub UI.' >&2
  exit 1
fi
if [[ "$VISIBILITY" != 'private' && "$VISIBILITY" != 'public' ]]; then
  echo 'GITHUB_VISIBILITY must be private or public.' >&2
  exit 1
fi
gh auth status >/dev/null
cd "$(dirname "$0")/.."
if [[ ! -d .git ]]; then
  git init -b main
  git add .
  git commit -m "docs: bootstrap ForgeFleet architecture and 20-agent build plan"
fi
if gh repo view "$OWNER/$NAME" >/dev/null 2>&1; then
  echo "Repository $OWNER/$NAME already exists. Refusing to overwrite or repoint it." >&2
  echo 'Push manually after verifying its state.' >&2
  exit 1
fi
# Explicit create action under your authenticated account.
gh repo create "$OWNER/$NAME" "--$VISIBILITY" --source . --remote origin --push
echo "Created: https://github.com/$OWNER/$NAME"
echo 'Next: create a develop branch and enforce PR/branch protections before dispatching agents.'
