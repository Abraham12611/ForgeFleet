# Documentation index / routing map

This tree is designed to let approximately 20 engineers work concurrently without having to reread a long transcript.

| Section | Owner concern | Read first |
| --- | --- | --- |
| `00-foundation` | Terms, assumptions, priorities, change management | `project-charter.md` |
| `01-product` | Outcomes, use cases, requirements, scope, success | `product-requirements.md` |
| `02-experience` | App IA, human journeys, mobile/web views, states | `information-architecture.md` |
| `03-architecture` | Boundaries, model, persistence, integrations, scaling, security | `system-architecture.md` |
| `04-flows` | Human, coordinator, worker, GitHub, recovery, sleep | `flow-catalog.md` |
| `05-contracts` | Proposed API/event/state contracts | `bridge.openapi.yaml` |
| `06-delivery` | Phases, tasks, 20-engineer slices, DoD and release checks | `roadmap.md` |
| `07-research` | Upstream sources, compatibility gates, verification | `compatibility-and-spikes.md` |
| `08-decisions` | Explicit and revisitable architectural decisions | `ADR-0001-control-plane.md` |
| `09-operations` | Vercel web, Vultr backend, Google Play Android, secrets and recovery runbooks | `vercel-and-play-release.md` |

**Labels:** `DECIDED` is an accepted architecture direction; `PROPOSED` needs implementation verification; `OPEN` requires a spike/decision; `GATE` blocks a release. These labels in docs are not GitHub issue statuses.

**Primary ownership:** Paperclip owns task authority; Orca owns its runtime processes; ForgeFleet bridge owns correlation/delivery; GitHub owns repository truth. Human owns privileged approvals. Never let two services independently make the same scheduling decision.

**For agents:** Begin from the 20-engineer allocation, find your assigned subsection, then read its referenced contract and flow. Design improvements should be submitted as an ADR, not silently implemented across teams.
