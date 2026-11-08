# Experience IA and navigation principles

App is organized by **Projects**, not by raw terminal session. An agent is a worker on an objective; its terminal is an inspectable implementation detail.

```mermaid
flowchart TD
  A[Sign in / private access] --> B[Command Center]
  B --> C[Projects]
  B --> D[Agent Fleet]
  B --> E[Decision Inbox]
  B --> F[Activity / Audit]
  B --> G[Settings]
  C --> H[Project Overview]
  H --> I[Coordinator Chat]
  H --> J[Task Board / DAG]
  H --> K[PRs and CI]
  H --> L[Project Context]
  I --> M[Thread / Agent Detail]
  J --> M
  D --> M
  G --> N[Approvals, budget, runtimes, sleep, integrations]
```

## Shared building blocks

Project switcher, persistent status summary, command composer, decision badge, task detail drawer/sheet, source-linked context viewer, agent roster, provider capacity, PR reviewer, audit trail, global search, system-health banner.

## Global actions

Create project, upload context, send goal, pause/resume project, toggle sleep mode, see approvals, inspect/stop agent (policy controlled), adjust concurrency/budget ceiling, open GitHub PR, view safe-run evidence.

## Navigation rules

- One global header on desktop; compact title + project switcher on mobile.
- Critical approvals and runtime failures surfaced separately from normal inbox chatter.
- Project pages cross-link to task, attempts, worktrees, messages, commits, PRs.
- Every status presents timestamp and source-of-truth so stale data is identifiable.
- Responsive, keyboard accessible; bottom tabs on Android narrow screens, not a desktop sidebar squeezed smaller.
