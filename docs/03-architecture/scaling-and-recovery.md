# Scaling, availability and recovery strategy

## Phased capacity

1. v0.1 single VPS, strict active workers cap (3–5 for test), isolated bridge, existing Orca service.
2. v0.4 durable store, outbox, background reconcilers, lease fencing, load and restart tests.
3. v1.0 stabilize one host and multiple projects; host resource monitors and quotas.
4. v1.1 worker-host registry and additional Vultr instances; secure heartbeat and capacity admission.

## Capacity model

`eligible_active = min(ready_tasks, project_limit, global_limit, provider_available, host_free_capacity, budget_capacity)`; admission uses estimates and runtime observation (CPU/RAM/disk/PTY/sockets). Provider limitations and pricing must be measured, not guessed. Registered agents can exceed active workers.

## Failure matrix

| Fault | Expected behavior |
|---|---|
| Paperclip server restart | Persist tasks/approvals; on return reconcile outstanding attempts |
| Bridge restart | Replay outbox; discover Orca runtime; no blind relaunch |
| Orca service unreachable | Mark unknown; pause new dispatch; retry probes with backoff |
| Worker killed | Confirm loss + fence lease; safe retry in new attempt if allowed |
| GitHub webhook missing | Poll/reconcile repo state and head SHA |
| CI failure | Create bounded repair task or block for review |
| DB unavailable | Stop privileged dispatch; queue only within bounded durable buffer |
| Provider rate limit | Backoff, respect reset, optionally use configured alternate runtime |
| Owner sleeping | Continue independent safe work; queue owner-only decisions |
| Partial sync-back | Mark finalize failed; block dependent tasks; do not declare done |

## Recovery protocol

On boot: identify instance epoch -> load leased attempts -> read-only query Orca -> compare persisted external IDs -> categorize `running`, `terminal`, `unknown`, `orphan` -> fence stale owners -> reconnect/replay events -> reconcile GitHub PRs -> dispatch only genuinely unowned ready tasks.

## Scale safety

Use per-host admission, bounded queue and event retention, no unbounded `Promise.all` for 200 workers, circuit breakers for provider outages, and clean workspace GC only after no active leases or refs. Never scale down a host with active unmanaged Orca sessions.
