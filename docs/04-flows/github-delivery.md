# F03: Worker submission → CI → independent review → merge

```mermaid
flowchart TD
  A[Worker submits commit/PR] --> B[Correlate task, head SHA, worktree]
  B --> C{CI results available?}
  C -- No --> D[Await checks and reconcile]
  D --> C
  C -- Yes --> E{Required checks pass?}
  E -- No --> F[Bounded repair task]
  F --> G[New commit/head SHA]
  G --> C
  E -- Yes --> H[Independent agent review vs criteria]
  H --> I{Review accepted?}
  I -- No --> F
  I -- Yes --> J{Merge policy gate}
  J -- Human approval needed --> K[Decision inbox, wait]
  K --> L[Revalidate exact SHA and checks]
  J -- Auto permitted --> L
  L --> M{Still valid?}
  M -- No --> C
  M -- Yes --> N[Serialized integration worker merges]
  N --> O[Verify merge event / update task]
```

## Important semantics

Approval binds to `repoId`, `prNumber`, `headSha`, `targetBranch` and policy version. New commits invalidate approval. Failed checks on old heads do not override new results. 'Reviewed by agent' is evidence, not automatically a privileged permission.

## Integration conflict

Merge coordinator serializes PRs touching the same branch. Conflicts create integration tasks; workers do not force push or arbitrarily choose winning code. Repo branch protections remain authoritative even if local policy misconfigured.

## No-PR tasks

Documentation/research tasks may complete via verified artifact; task acceptance criteria explicitly declare whether PR is mandatory. Never force fake PRs to satisfy the workflow.
