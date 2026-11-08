# Paperclip integration strategy — fork-vs-plugin spike (FF-001)

**Status:** `DECIDED` (see [ADR-0007](../08-decisions/ADR-0007-paperclip-integration-strategy.md)) —
external adapter **plugin first**, narrow UI fork only on proven need.
**Pinned upstream:** tag `v2026.1106.0`, commit
`d69631b01b9c658f80bf8bed389863dce82643e1` (2026-10-23).
Pin registry: [version-pins.md](version-pins.md).
**Smoke:** [`scripts/paperclip-pin-smoke.sh`](../../scripts/paperclip-pin-smoke.sh)
plus fixture [`examples/paperclip-adapter-smoke/`](../../examples/paperclip-adapter-smoke/README.md).

## 1. Upstream verification (evidence, not README claims)

All facts below were read from the pinned tag's actual files on
2026-11-08 (fetched via `raw.githubusercontent.com/.../v2026.1106.0/...`;
the smoke script re-verifies them reproducibly):

- **Source / license:** `https://github.com/paperclipai/paperclip`, MIT,
  copyright 2025 Paperclip AI. `LICENSE` file present at tag. No upstream
  code has been copied into this repository.
- **Toolchain:** root `package.json` requires `node >= 24.11.0`,
  `packageManager pnpm@9.15.4`. ForgeFleet bridge/adapter packages must
  target the same floor.
- **Upstream's own recommendation** (`docs/adapters/creating-an-adapter.md`):
  "For most cases, **build an external adapter plugin**. It's cleaner,
  independently versioned, and doesn't require modifying Paperclip's source."
  Built-in adapters live in `packages/adapters/<name>/` and require edits to
  three registries (`server/src/adapters/registry.ts`,
  `ui/src/adapters/registry.ts`, `cli/src/adapters/registry.ts`).
  External adapters register automatically through the plugin loader.
- **Plugin module contract** (same doc): the plugin exports
  `createServerAdapter` from `./server/index.js` (plugin-loader convention);
  `execute()` receives
  `runtime: { sessionId, sessionParams }` and returns `sessionParams` that
  persist across heartbeats; optional `sessionCodec` validates raw session
  data and supplies a display id; unknown-session errors are handled by
  retrying fresh with `clearSession: true`; optional capability flags
  (`supportsLocalAgentJwt`, …) are exposed via `GET /api/adapters`, and
  external adapters that omit them default to `false`.
- **What the stock adapters cannot do** (`docs/adapters/http.md`,
  `docs/adapters/process.md`): the `http` adapter is fire-and-forget and
  "not suited for deep real-time stdout capture"; the `process` adapter has
  "no session persistence across runs". Both are adequate only for the
  Phase-0 proof-of-concept (spikes S-03); long-lived Orca workers need the
  external adapter (spike S-04).
- **No-remote-git contract** (`packages/adapters/AUTHORING.md`, the load-bearing
  invariant for ForgeFleet): the local execution-workspace cwd is the **only**
  persistence boundary across runs. Adapters must never `git push` and never
  assume a remote exists; remote execution uses the round-trip helpers
  `prepareWorkspaceForSshExecution` / `restoreWorkspaceFromSshExecution` from
  `@paperclipai/adapter-utils`, and a failed sync-back records
  `workspace_finalize=failed`, which gates dependent wakes. The rule is pinned
  by `packages/adapter-utils/src/ssh-fixture.test.ts` and enforced statically
  by `scripts/check-no-git-push.mjs` (opt-out only via an explicit
  `// paperclip:allow-git-push: <reason>` comment).

Floating `HEAD` at inspection time (`66a2cba`) is deliberately **not** tracked:
Paperclip "changes quickly" (risk register), so upgrades are a branched,
smoke-tested activity per the upgrade rule in [version-pins.md](version-pins.md).

## 2. Decision: plugin first, fork narrow and late

| Surface | Strategy | Rationale |
|---|---|---|
| Orca execution | External adapter plugin (`packages/paperclip-orca-adapter/`, owner E04) | Upstream-recommended path; independent versioning; auto-registration; keeps Orca worktree ownership explicit |
| Proof of concept | Stock `process`/`http` adapter calls into the bridge | Zero upstream commitment while E02/E03 probe Orca (spike S-03) |
| Paperclip UI (`apps/web`) | Compose first; fork only the UI entry, never core, and only after the Phase-0.E Vercel split spike proves separation is viable | Minimizes merge burden from a fast-moving upstream; fork surface = patch set with recorded upstream commit |
| Control-plane internals | No fork, no direct DB writes | Paperclip owns task authority; bridge owns correlation (authority table) |

**Fork rules if a fork becomes necessary:** pin the exact upstream commit,
preserve `LICENSE`/`NOTICE` headers and attribution, keep the patch set
reviewable as a branch (not a snapshot), rebase through the upgrade rule
(start/status/event/resume/finalize smoke, no auto-upgrades), and route all
upstream-touching changes through the E01 integration branch per the
shared-file protocol.

## 3. Orca worktree reconciliation (the high/high risk)

The risk register flags "Paperclip/Orca both own worktree" as high/high. The
upstream contract resolves it: **Paperclip owns desired state, Orca owns the
actual process/worktree, and the local cwd is the handoff point.** The Orca
adapter must therefore implement the `prepare → execute → restore` round-trip:
bundle the Paperclip cwd to the Orca worktree before the run, run the worker,
and sync changes back into the local cwd before `execute()` returns, so a
dependent task's wake sees the predecessor's state without any git remote.
A failed restore is a run-level error (`workspace_finalize=failed`), never a
silent skip — this is exactly the `unknown`-state gating our
[state machines](../05-contracts/state-machines.md) require. Spikes S-05/S-07
prove this on disposable repos; the smoke fixture asserts the shape.

## 4. `apps/web` foundation plan (no source yet — plan only)

`apps/` does not exist in this scaffold yet, and Wave-0 UI workers (E12, E20)
are restricted to fixtures, so this spike creates **no** `apps/web` source —
only the plan E04/E12/E17 execute after gates:

1. **Phase-0.E spike first:** prove the pinned Paperclip Vite UI builds and
   deploys to Vercel separately from the Vultr API, with auth and streaming
   intact. If it fails, the fallback (already in the README) stands: keep the
   complete Paperclip UI/API together on Vultr and record blockers.
2. **On success:** `apps/web` becomes a thin composition target (ForgeFleet
   routes/components) consuming the pinned upstream UI, owned per
   `engineer-assignments.md`; any forked upstream UI file is listed in the
   patch set with its upstream commit.
3. **Never:** duplicate Paperclip's task store, bypass scoped backend identity
   from the browser, or ship raw shell/GitHub tokens to the client.

## 5. What this unblocks / leaves open

- **Unblocks:** E04 adapter scaffolding against a frozen contract, E05
  contract baseline referencing exact `sessionParams`/`clearSession`/
  capability semantics, E02/E03 Orca probes with a known sync-back target.
- **Explicitly still open:** live compatibility (no Vultr host or Orca service
  was touched — all evidence here is upstream-source plus fixture; live spikes
  S-01/S-02/S-04 need the operator's environment), Devin parity (spike S-06),
  and the Vercel split proof (Phase-0.E).
- **Upgrade watch:** re-run `scripts/paperclip-pin-smoke.sh` against any new
  tag before adopting it; a `createServerAdapter` signature change or
  capability-flag change is a contract-review event with E04/E05.
