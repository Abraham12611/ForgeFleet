// Minimal external-adapter-shaped fixture for FF-001.
//
// This is NOT a live Paperclip integration: it mirrors the plugin contract
// verified at pinned upstream tag v2026.1106.0
// (docs/adapters/creating-an-adapter.md, packages/adapters/AUTHORING.md)
// so E04 can build the real `packages/paperclip-orca-adapter` against a
// frozen, smoke-tested shape. In the real adapter, "remoteWorktreeDir" will
// be an Orca-owned worktree and the round-trip helpers come from
// `@paperclipai/adapter-utils`; here both sides are temp dirs standing in
// for the Paperclip local cwd and the Orca worktree.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function prepareWorkspaceForLocalExecution(localCwd, remoteWorktreeDir) {
  mkdirSync(remoteWorktreeDir, { recursive: true });
  cpSync(localCwd, remoteWorktreeDir, { recursive: true });
}

export function restoreWorkspaceFromLocalExecution(remoteWorktreeDir, localCwd) {
  cpSync(remoteWorktreeDir, localCwd, { recursive: true });
}

// Plugin-loader convention: external adapters export createServerAdapter
// from ./server/index.js (here index.mjs, same shape).
export function createServerAdapter() {
  return {
    capabilities: {
      supportsLocalAgentJwt: false,
    },
    sessionCodec: {
      deserialize(raw) {
        if (raw && typeof raw.sessionId === 'string') return raw;
        return null;
      },
      getDisplayId(params) {
        return `orca-session ${params.sessionId}`;
      },
    },
    async execute({ taskId, cwd }, runtime) {
      const incoming = runtime?.sessionParams ?? null;
      // Unknown/stale session: force a fresh session on next wake.
      if (incoming && incoming.stale === true) {
        return { sessionId: null, sessionParams: null, clearSession: true };
      }
      const sessionId = incoming?.sessionId ?? `sess-${taskId}`;
      const sessionParams = { sessionId };

      // Round-trip: sync local cwd out, do the "work", sync back before
      // returning. The no-remote-git invariant: everything the next run
      // needs must live in the local cwd at return; no git remote involved.
      const remoteDir = join(tmpdir(), `orca-remote-${taskId}`);
      rmSync(remoteDir, { recursive: true, force: true });
      prepareWorkspaceForLocalExecution(cwd, remoteDir);
      const runCount = (incoming?.runCount ?? 0) + 1;
      writeFileSync(join(remoteDir, 'ATTEMPT.md'), `# attempt ${runCount} for ${taskId}\n`);
      restoreWorkspaceFromLocalExecution(remoteDir, cwd);
      rmSync(remoteDir, { recursive: true, force: true });

      if (!existsSync(join(cwd, 'ATTEMPT.md'))) {
        throw new Error('workspace_finalize=failed: sync-back missing');
      }
      return {
        sessionId,
        sessionParams: { ...sessionParams, runCount },
        output: readFileSync(join(cwd, 'ATTEMPT.md'), 'utf8'),
      };
    },
  };
}
