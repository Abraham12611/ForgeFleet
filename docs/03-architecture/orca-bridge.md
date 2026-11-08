# Paperclip ↔ Orca bridge specification

## Objective

Connect a running Orca service on Linux to the Paperclip control plane without reinstalling, restarting, or mutating existing Orca sessions. `orca-bridge` is an isolated service operating under the Orca-owning OS user with carefully scoped credentials.

## Proven source facts / caveat

Orca's GitHub `skills/orchestration/SKILL.md` says: outside an Orca-managed Linux terminal, prefer `ORCA_CLI_COMMAND` if provided, otherwise `orca-ide` (not bare `orca`, which can invoke the GNOME screen reader). Load **version-matched** help via `skills get orchestration` and `skills get orca-cli` before invoking runtime commands. No checked document establishes exact flags for the user's installed binary; treat examples as illustrative.

Paperclip's current adapter authoring guide recommends external adapter packages with `createServerAdapter`; context includes runId, agent, runtime.sessionParams, context and streaming callbacks. An adapter must return execution result and resumable session params. Paperclip's adapter contract forbids relying on `git push` for cross-run state: local execution cwd must be finalized/synced.

## Initial deployment

- Keep `orca-serve.service` running; do read-only `systemctl --user status orca-serve.service` and CLI discovery.
- Deploy Paperclip in a separately authenticated private container/service.
- Deploy `orca-bridge.service` as a user-level systemd service with locked-down HTTP socket/Unix socket; bind to loopback, not the public internet.
- Bridge resolves executable from trusted operator config and validates `--version` / skills; no user-supplied command execution.
- One actor owns worker lifecycle per attempt: Paperclip requests, bridge dispatches, Orca supervises the process.

## Bridge responsibilities

1. Discover runtime and capabilities; reflect `muse` and `devin` as supported/unknown per actual probe.
2. Spawn worker with task, agent profile, scoped context, project/worktree lease and attempt idempotency key.
3. Store mapping of Paperclip/ForgeFleet IDs to Orca dispatch/worktree/terminal IDs.
4. Observe logs, questions, heartbeats, completion and failures; translate into normalized events.
5. Route coordinator/worker messages and decision replies with authorization.
6. Offer read-only adoption inventory for pre-existing sessions; never assume an existing session is already managed.
7. Reconcile status across restarts, preserve existing attempts where possible, and expose stale/unknown state.
8. Enforce concurrency, cgroup/timeout/resource controls and no arbitrary shell payload from untrusted sources.

## Integration progression

**Spike 1** read-only discovery. **Spike 2** one disposable Muse task via installed command. **Spike 3** one round-trip callback and completion. **Spike 4** process restart/reconciliation. **Spike 5** Devin capability and fallback. Once stable, implement an external Paperclip adapter, not modifications to Orca internals unless required and approved.

## Paperclip workspace vs Orca worktree (critical)

Paperclip adapters use local cwd as the cross-run persistence boundary. Orca creates/manages its own worktree. Avoid a split brain by selecting a single canonical writable checkout for an attempt, and sync all committed/uncommitted output back to the Paperclip-owned execution cwd before adapter finalize; do not rely solely on GitHub push/PR as persistence. If compatible safe sync is not possible, treat Orca as a long-lived external execution backend with an explicit workspace contract and gate dependent work until finalize has succeeded.

## Existing 20-session adoption

Show read-only discovered sessions, correlation confidence and immutable source IDs first. Managed takeover requires user confirmation and proof that the terminal/worktree is in a safe state, no active conflicting controller and all source context is retrievable.

## Failure handling

Timeout → `unknown` → check original dispatch and worktree. Never assume old worker died. Rate limits → `waiting_capacity`. Bridge crash → replay receipts/outbox and reconcile. Unsupported CLI → mark capability unavailable; no guessed flags. Termination → explicit permission and identity verification.
