// Workspace round-trip: Paperclip local cwd <-> Orca staging worktree.
//
// The no-remote-git invariant (pinned by FF-001 from upstream
// packages/adapters/AUTHORING.md): the local execution cwd is the ONLY
// persistence boundary across runs. This module bundles the cwd out to the
// remote side before the run and syncs everything back into the local cwd
// before execute() returns, so a dependent task's wake sees the
// predecessor's state without any git remote. A failed restore is a
// run-level error (workspace_finalize=failed), never a silent skip.
//
// Safety rules (coordinator review on PR #34):
// - Staging dirs live ONLY under an explicit, dedicated state root
//   (default <tmpdir>/forgefleet-orca-staging, override via stateRoot /
//   FORGEFLEET_ADAPTER_STATE). Segments are validated by the caller
//   (see context.js SEGMENT_RE); resolveRemoteDir additionally asserts the
//   realpath stays contained under the root realpath.
// - Staging is adapter-owned scratch, never an Orca-owned live worktree:
//   fresh staging may recreate its own dir, but an ambiguous failure path
//   must NEVER delete it (a confirmed-live worker may still be writing).
//
// NOTE: this file must never invoke a remote-push command. The static check
// `check-no-push.mjs` enforces that; see the test suite.

import { cpSync, existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';

export function defaultStateRoot() {
  return process.env.FORGEFLEET_ADAPTER_STATE ?? join(tmpdir(), 'forgefleet-orca-staging');
}

// Resolve the adapter-owned staging dir for (taskId, runId). Both segments
// must already be validated; containment is asserted on the realpath as
// defense in depth (symlinked TMPDIR, case-folding mounts, etc.).
export function resolveRemoteDir(stateRoot, taskId, runId) {
  mkdirSync(stateRoot, { recursive: true });
  const rootReal = realpathSync(stateRoot);
  const candidate = join(rootReal, 'work', `${taskId}-${runId}`);
  if (candidate !== rootReal && !candidate.startsWith(rootReal + sep)) {
    throw new Error(`staging dir escapes state root: ${candidate}`);
  }
  return candidate;
}

// Copy the local cwd into the staging dir before the worker runs.
// When `reuse` is set (crash reconcile), the existing staging dir is left
// intact: wiping it could destroy pre-crash state a live worker still owns.
export function prepareWorkspaceForExecution(localCwd, remoteWorktreeDir, { reuse = false } = {}) {
  if (!reuse) {
    rmSync(remoteWorktreeDir, { recursive: true, force: true });
    mkdirSync(remoteWorktreeDir, { recursive: true });
    cpSync(localCwd, remoteWorktreeDir, { recursive: true });
  } else if (!existsSync(remoteWorktreeDir)) {
    mkdirSync(remoteWorktreeDir, { recursive: true });
    cpSync(localCwd, remoteWorktreeDir, { recursive: true });
  }
}

// Sync everything the worker produced back into the local cwd, then verify
// the marker the worker was required to write. Pre-existing local files are
// never deleted by this step; on failure an error is thrown before any
// completion is reported, so dependent work stays gated.
export function restoreWorkspaceFromExecution(remoteWorktreeDir, localCwd, { expectMarker = null } = {}) {
  if (!existsSync(remoteWorktreeDir)) {
    throw new Error(`remote staging dir missing: ${remoteWorktreeDir}`);
  }
  cpSync(remoteWorktreeDir, localCwd, { recursive: true });
  if (expectMarker !== null && !existsSync(join(localCwd, expectMarker))) {
    throw new Error(`sync-back marker missing: ${expectMarker}`);
  }
  return true;
}

// Remove the staging dir after a CONFIRMED terminal restore only.
// Best-effort: cleanup failure must not fail finalization (state already
// landed locally). Never call this on an ambiguous (unknown-fate) path.
export function cleanupRemoteDir(remoteWorktreeDir) {
  try {
    rmSync(remoteWorktreeDir, { recursive: true, force: true });
  } catch {
    // intentional no-op: local cwd already holds the result
  }
}
