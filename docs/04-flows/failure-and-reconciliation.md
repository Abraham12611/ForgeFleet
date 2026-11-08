# F05: Failures, retries, agent replacement and crash recovery

```mermaid
flowchart TD
  A[Missing heartbeat / bridge outage] --> B[Mark runtime unknown]
  B --> C[Read-only discovery + external ID match]
  C --> D{Original attempt exists?}
  D -- Yes --> E[Reconnect monitor; replay receipts]
  D -- No --> F{Can prove termination?}
  F -- No --> G[Quarantine and escalate ambiguous state]
  F -- Yes --> H{Retry budget and lease available?}
  H -- No --> I[Blocked/failed, owner-visible]
  H -- Yes --> J[Fence prior lease; new attempt]
  J --> K[Reconcile output/worktree, continue]
  E --> K
```

## Failure cases to inject

- Kill bridge immediately after Orca accepted launch but before response persisted.
- Restart Paperclip while 3 workers are active.
- Simulate Orca unavailable for 10 min without killing workers.
- Disconnect GitHub webhook for one PR then restore.
- Duplicate every runtime message 3 times and reorder them.
- Fail Paperclip workspace sync-back after a successful Orca commit.
- Change PR head between human approval and merge request.
- Provider rate-limit worker mid-task; preserve context and notify capacity.
- Owner asleep with two questions while unrelated tasks finish.

## Recovery acceptance

No double-spawn, no double-merge, no lost question, no leaked active worktree, no false 'verified'. Every irrecoverable ambiguity becomes an auditable blocked incident with a clear next action.
