# Flow catalog

All flows include **human path**, **agent path**, **service side effects**, **failure path**, and **recovery path**. Referenced detailed flows:

- [Goal → plan → worker](goal-to-worker.md)
- [Agent-to-agent messaging and escalation](agent-messaging.md)
- [PR review, CI and controlled merge](github-delivery.md)
- [Sleep / wake / decision queue](sleep-and-decisions.md)
- [Failure injection and recovery](failure-and-reconciliation.md)

## Status vocabulary

`planned`, `ready`, `reserved`, `dispatched`, `running`, `blocked`, `awaiting_review`, `verified`, `merged`, `failed`, `retry_wait`, `cancelled`, `unknown`. Separate **task** state from **runtime attempt** state and **GitHub PR** state to avoid false completion.

## Service interaction matrix

| Trigger | Paperclip | Bridge | Orca | GitHub | Human |
|---|---|---|---|---|---|
| Submit goal | Save context, propose DAG | — | — | Read repo metadata | Provide objective |
| Dispatch ready task | Validate readiness/lease | Dedup, dispatch | Start worker/worktree | — | — |
| Worker asks peer | Thread/route | Observe/forward | Deliver message | — | — |
| Worker submits PR | Update task | Correlate worker | Finalize worktree | Store PR/checks | — |
| Main merge | Enforce policy | — | — | Merge exact SHA | Explicit approve |
| Sleep | Queue decisions | Continue safe work | Continue current workers | CI continues | Offline |
| Restart | Reconcile | Replay/inspect | Existing sessions survive if service up | Poll truth | Digest later |
