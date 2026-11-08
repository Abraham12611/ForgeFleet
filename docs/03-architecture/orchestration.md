# Orchestration, dependency DAG and admission control

## Single authoritative scheduler

Paperclip task/goal model drives desired work. The scheduler computes ready work and dispatches through adapters. Orca's built-in orchestration primitives may manage subworkers **within an explicitly owned attempt**, but cannot independently spin up tasks outside the Paperclip task ledger.

## Task readiness predicate

A task is dispatchable iff: status `ready`, all required predecessors `verified` or `merged` according to dependency type, no active fenced attempt, budget available, matching runtime online, project not paused, worktree lease obtainable, permission policy passes, and no blocking owner decision.

## DAG rules

Tasks have explicit dependencies (`blocks`, `requires_contract`, `integration_after`, `informational`). Reject cycles; distinguish gating and informational edges. A coordinator can propose a DAG revision but changes to active contracts or assignments require transactional validation. Re-run readiness after every completion/decision/PR merge or lease timeout.

## Task lifecycle

`draft -> ready -> reserved -> dispatched -> running -> submitted -> verifying -> verified -> merged/closed`; failures can enter `blocked`, `retry_wait`, `failed`, `cancelled`. See [state machines](../05-contracts/state-machines.md) for authoritative transitions.

## Allocation

Initial per-project `max_active_workers` conservative (e.g. 3–5 for proof of concept); global admission checks host resources, cost ceilings, provider concurrency and ready task cardinality. Leases carry monotonic generation/fencing token. Retries use exponential backoff with jitter and max attempts. `unknown` runtime state is **not** immediately retried.

## Human and AI responsibilities

Coordinator: recommend tasks, scope, priority and assignee; propose recovery. Scheduler: authorize and commit lease/dispatch; retry within fixed policy; block actions when gated. Human: approve privileges, main merges, production deploys and expensive capacity changes.

## No busy-work policy

No automatically invented tasks after acceptance criteria are fulfilled. 'Continue building' means choose useful remaining unblocked work, not endlessly polish design or generate self-referential issues.

## Large fleets

Scheduling considers useful parallelism and worktree conflict domains; 200 workers can be registered without 200 running. For v1.1 capacity fan-out, use independently secured worker hosts. See `scaling-and-recovery.md`.
