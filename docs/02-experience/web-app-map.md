# Desktop/web app map (proposed routes)

| Path | Screen | Main elements | Key actions |
|---|---|---|---|
| `/sign-in` | Authentication | SSO/private sign-in, session state | Authenticate |
| `/` | Command Center | Project health, current runs, throughput, blocked decisions, cost | New goal, browse projects |
| `/projects` | Projects | Grid/list, status, repository, scope | Create, archive, open |
| `/projects/new` | Project wizard | Name, repo, context upload, autonomy, budget | Draft and start |
| `/projects/:id` | Overview | Coordinator card, progress, milestones, task counts, alerts | Chat, pause, inspect |
| `/projects/:id/chat` | Coordinator chat | Goal composer, context citations, plan, decisions | Send, attach, approve plan |
| `/projects/:id/tasks` | Board / DAG | Filtered columns, dependencies, owners, timeline | Assign, reassign, block, inspect |
| `/projects/:id/tasks/:taskId` | Task detail | Acceptance, attempts, timeline, messages, artifacts, PRs | Reply, retry, pause, approve |
| `/projects/:id/agents` | Project fleet | Live workers/leads, provider, cost and liveness | Inspect, pause, reroute |
| `/projects/:id/messages` | Channels | Project channels and task threads | Post, mention, search |
| `/projects/:id/reviews` | PR and CI queue | Diff, reviews, required checks and policy gate | Request changes, merge if allowed |
| `/projects/:id/context` | Context library | Files, extraction status, citations, revision history | Upload, replace, revoke |
| `/fleet` | Fleet center | All agent sessions, runtime filters, status/limits | Filter, inspect, stop |
| `/fleet/:agentId` | Agent detail | Runtime identity, current task, attempts, terminal link | Message, intervene |
| `/inbox` | Human decision inbox | Questions, approvals, urgency, evidence | Answer, delegate, snooze |
| `/activity` | Global audit | Actor, event, time, policy outcome, resource links | Filter/export |
| `/settings/*` | Preferences | Sleeping, permissions, GitHub, runtimes, notifications, budgets | Configure |
| `/system` | Operations | Integrations, queue depth, scheduler, health, versions | Run diagnostics |

## Design notes

Desktop default: 3-column Command Center (project list, coordinator activity, decision panel) with task-focused deep links. Use server-persisted filters where shareable; no direct GitHub writes from UI browser JS; route through backend policy service. File previews sanitize HTML and prevent executing uploaded scripts.
