# Build dependency graph and integration checkpoints

```mermaid
flowchart LR
  A[Phase 0: Specs + source pin] --> B[E05 API/contracts]
  A --> C[E01 Paperclip proof]
  A --> D[E02 Orca read-only probe]
  B --> E[E06 persistence/events]
  B --> F[E07 auth/policy]
  D --> G[E03 Muse dispatch]
  E --> G
  C --> H[E04 adapter]
  G --> H
  H --> I[Milestone v0.1: one worker]
  E --> J[E10 messaging]
  F --> K[E08 coordinator]
  K --> L[E09 scheduler]
  I --> L
  L --> M[Milestone v0.2: three workers]
  J --> M
  M --> N[E16 GitHub delivery]
  M --> O[E14 inbox/sleep]
  N --> P[v0.3 reviewed PR flow]
  O --> P
  P --> Q[E15 fail/restart tests]
  Q --> R[v0.4 durable automation]
  R --> S[E17 production hardening]
  S --> T[v1.0 private production]
  T --> U[E20 Android, distributed capacity]
```

## Hard integration gates

- G0: contract owner accepts API/event schema and field meaning.
- G1: bridge verifies exact version-matched installed Orca executable and safe command arguments.
- G2: one Muse attempt starts and returns exact durable IDs.
- G3: original attempt safely reconciled after injected bridge restart.
- G4: three-worker task graph completes with nontrivial dependency and peer message.
- G5: GitHub PR review/CI/head SHA gates pass; `main` remains owner-protected.
- G6: owner sleep mode allows independent work while queuing questions.
- G7: finalization recovery and no-side-effect duplication across restarts.
- G8: security, backup/restore, performance and acceptance signoff.

## Risk register

| Risk | Probability / impact | Mitigation |
|---|---|---|
| Paperclip/Orca both own worktree | high/high | Explicit workspace contract and finalize test |
| CLI behavior differs by installed Orca version | high/medium | Version-matched skill, capability adapter |
| Devin unsupported supervised launch | medium/medium | Terminal dispatch fallback, capability status |
| 20 engineers edit same UI bootstrap | high/high | Path ownership, integration lead |
| Agent prompt injection from repo | high/high | Policy engine gate and secrets isolation |
| VPS resource exhaustion | medium/high | Low initial active limit, admission metrics |
| Missing event after crash | medium/high | Inbox/outbox, reconciliation |
| Paperclip upstream changes quickly | high/medium | Pin commit, integration tests, upgrade schedule |
