# `@forgefleet/paperclip-orca-adapter` (FF-008, engineer E04)

External Paperclip adapter plugin: **Task → worker → status in Paperclip**.
Paperclip owns desired task state; this adapter translates each Paperclip
wake into typed calls against the ForgeFleet orca-bridge (`POST /v1/attempts`,
`GET /v1/attempts/{id}`, `POST …/cancel`, `POST …/messages`,
`GET /v1/events` SSE, `GET /v1/runtime/capabilities`) and returns a pinned
`AdapterExecutionResult` whose `sessionParams` resume the worker on the next
heartbeat.

## Contract sources (do not re-derive from this README)

- Plugin shape verified against the **pinned upstream tag `v2026.1106.0`**
  (`https://github.com/paperclipai/paperclip`,
  `docs/adapters/creating-an-adapter.md` at that tag, fetched 2026-11-09;
  no upstream code vendored): `createServerAdapter` from `./server/index.js`
  on a `ServerAdapterModule` (`type`, `execute`, `sessionCodec`, capability
  flags defaulting to `false`); `execute()` takes ONE
  `AdapterExecutionContext`
  (`runId`, `agent`, `runtime:{sessionId, sessionParams}`, `config`,
  `context`, `onLog`, …) and returns an `AdapterExecutionResult`
  (`exitCode`, `signal`, `timedOut`, `errorMessage?`, `sessionParams?`,
  `sessionDisplayId?`, `provider?`, `clearSession?`). Status travels in
  `sessionParams` + `onLog` lines: the pinned result has no free-form
  status field. `test/pinned-context.test.js` pins this surface.
- Bridge HTTP shapes: frozen `docs/05-contracts/bridge.openapi.yaml` v0.1;
  adapter-built payloads are checked by the E05 validator
  (`test/contract-schema.test.js`).
- Event envelope/dedupe/fencing: `docs/05-contracts/events.md`.
- Task/attempt state machines (incl. `unknown` gating, `finished` ≠ verified):
  `docs/05-contracts/state-machines.md`.
- Crash recovery (F05): `docs/04-flows/failure-and-reconciliation.md` and
  E15's `tools/test-fixtures/reconciliation_fixture.py`.
- Leases: `packages/scheduler/src/leases.js` (generation monotonic from 1;
  stale generations ignored; idempotency key + request hash).

## Layout (E04-owned paths only)

- `server/index.js` — `createServerAdapter()` plugin entry (`execute`,
  `testEnvironment`, `cancel`, `sendMessage`, `sessionCodec`, flags).
- `src/context.js` — pinned-context extraction; `runId`/`taskId`/`projectId`/
  `cwd` required, path segments allowlisted, scheduler lease with provenance.
- `src/bridge-client.js` — typed bridge HTTP client (injectable `fetch`) +
  pure `buildCreateAttemptRequest` for schema validation.
- `src/session.js` — v2 session-params codec + deterministic idempotency keys
  (`ff8-<project>-<task>-<run>-e<epoch>`; the epoch is part of the key so a
  fenced relaunch never collides with the fenced generation).
- `src/journal.js` — atomic pending-intent + quarantine journal.
- `src/status-map.js` — attempt-state mapping + event dedupe/fencing.
- `src/workspace.js` — confined prepare/restore cwd round-trip (no remote).
- `src/errors.js` — typed errors.
- `check-no-push.mjs` — static no-remote-push rule (upstream parity).
- `test/` — `node:test` suite with in-process fake bridge (`fake-bridge.js`).

## Round-trip semantics

1. **First wake** (no `sessionParams`): capability gate first — a non-`verified`
   provider returns an error result with zero dispatches. Then the intent
   (idempotency key + exact payload) is journaled atomically, the local cwd
   is staged out to the confined root, and `POST /v1/attempts` fires.
2. **Crash after accept**: on POST failure the journal and staging dir are
   LEFT INTACT — a confirmed-live worker may still own them. The next wake
   with the same (project, task, run) re-issues the IDENTICAL payload and
   the bridge replays the original receipt: exactly one worker, reconciled
   before any relaunch.
3. **Later wakes**: `GET` the original attempt and replay `GET /v1/events`
   since `lastEventId` — never a second POST for an owned session.
   Duplicates collapse on `(source,eventId)`; older fencing epochs are
   ignored; `unknown` renders as unknown.
4. **Terminal receipt** (`finished`/`failed`/`cancelled`): sync the remote
   side back into the local cwd **before** reporting. A failed restore
   returns `workspace_finalize=failed` with no completion, so dependent tasks
   stay gated; pre-existing local files are never deleted. `finished` maps to
   `submitted` with `exitCode: 0`: runtime completion is review input, not
   verification.
5. **Ambiguous fate** (bridge 404 on reconcile, corrupt journal, changed
   input after a crash): the key is QUARANTINED (`status: unknown`,
   `exitCode: null`), never silently cleared — a fresh session could
   duplicate a still-live worker. The Paperclip task context is UNTRUSTED
   for recovery, so bare strings authorize nothing. Release requires a
   structured `context.recoveryDecision`
   `{action, decidedBy, schedulerEpoch, schedulerToken?, proof:{kind, detail}}`
   plus bridge-verified old-worker fate: relaunch is refused while the
   original is live, needs a strictly fresh scheduler epoch + token, and a
   404 pairs only with `lease-fenced`/`operator-attested` proof; adoption
   re-attaches a GET-verified attempt and never spawns. Every resolution is
   written to the audit journal and the new session cursor. Journal re-posts
   always send the exact original bytes and refuse on any input drift.
6. Operational failures use the pinned `errorMessage` result channel; only
   malformed execution contexts throw (`invalid_context`). `cancel` requires
   `context.cancel.{reason, approvedBy}`; `sendMessage` requires a stable
   caller-supplied `context.message.messageId` (never a wall-clock value).

## Configuration

- `FORGEFLEET_BRIDGE_URL` (default `http://127.0.0.1:4387`, loopback-only).
- `FORGEFLEET_BRIDGE_TOKEN` (service Bearer token; backend only, never logged
  or echoed into outputs; never accepted from task input).
- `FORGEFLEET_ADAPTER_STATE` (durable state root for staging + journal;
  default under the OS temp dir survives process crashes, not host reboots —
  production must set durable storage; bridge-side durability is E06-owned).

## Run

```sh
node --test 'test/*.test.js'
node ./check-no-push.mjs
```

Engine: `node >= 24.11.0`. Zero runtime dependencies (stdlib only).

## Evidence status (fixture vs live)

- **Fixture (this PR):** 44 `node:test` assertions pass against the
  in-process fake bridge — pinned-shape conformance, round trip, crash-after-
  accept reconcile (one dispatch, staging intact), 409 conflict, dedupe/
  fencing, quarantine + verified recovery decisions (malicious-string hold,
  old-worker-running refusal, stale-epoch/proof/token holds, verified
  relaunch + adopt, intent-change and tamper refusal), finalize gate with cwd
  intact, fail-closed capability, cancel/message auth, E05 schema validation,
  and the no-push static check.
- **Live (explicitly NOT claimed):** no Vultr host, Orca service, or
  Paperclip instance was touched. Live spikes S-04 (resume against real
  Paperclip) and S-05 (Orca worktree sync-back on a disposable repo) remain
  for the coordinator to schedule with E01/E03; this package swaps the fake's
  `fetch` for the real bridge URL with no logic change.

## Security / contract notes

- No git remote is invoked anywhere (`check-no-push.mjs` enforced).
- Staging is confined to the state root; task/run/project segments are
  allowlisted and realpath containment is asserted.
- Mutations carry idempotency keys; same key + different payload is a typed
  conflict, never a silent second worker.
- `cancel` requires an authorized actor; HTTP 202 means requested,
  confirmation arrives via events and is never assumed.
- Secrets (bridge token, prompts) never enter session params, logs, or
  outputs. Session cursors are bound to (project, task, run); cross-task or
  cross-run replay is rejected with `clearSession:true`.
