# `@forgefleet/coordinator` — task DAG/planner (FF-012)

Deterministic coordinator planner. The LLM coordinator drafts task sets;
this module validates them into immutable, content-hashed plan revisions:

- **Bounded DAG** — at most 50 tasks / 200 edges per plan; every task needs
  a title and at least one acceptance bullet.
- **Cycles rejected** — gating edges (`blocks`, `requires_contract`,
  `integration_after`) are cycle-checked; `informational` edges are validated
  but never block readiness or close a cycle.
- **Goals trace to tasks** — every task names its goal, every `covers`
  reference must exist, and every goal acceptance criterion needs at least
  one covering task. The revision carries the resulting trace map.
- **Duplicate ownership rejected** — two tasks cannot claim the same `owns`
  key (branch, path, or work item).
- **Immutable revisions** — `proposePlan` returns a frozen revision with a
  sha256 content hash; `approvePlan` stamps it; `revisePlan` re-validates
  and bumps the number. `getReadyTasks` offers advisory dispatch order for
  the scheduler (E09 commits actual dispatch).

No workers are launched and no approvals granted here. Plan approval is
structural only until the E07 policy engine gates dispatch.
