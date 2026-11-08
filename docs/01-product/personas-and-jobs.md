# Personas and jobs-to-be-done

## Operator (primary)

Environment: Android phone, intermittent connectivity, Tailscale private access; may be away/sleeping while engineering work continues. Wants to state an objective once, avoid manually traversing dozens of agents, review consequential decisions and see verified progress. Success: one crisp status summary, a manageable decision queue, and reliable builds.

## Coordinator agent

Receives goal/context, maintains plan and task DAG, delegates to team leads, manages exceptions and integration, proposes merge/deploy actions. Needs task/agent state that does not depend on context window memory and a policy API that tells it what actions are allowed.

## Team lead

Owns a workstream with an explicit API contract and merge dependencies. Needs to message other leads and notify coordinator of cross-cutting decisions, file conflicts, contract changes and completion evidence.

## Engineer worker

Receives narrow scoped task, branch/worktree and acceptance criteria. Needs relevant context, peer messaging, test results, and a clear mechanism to post blockers and final artifacts. Does not need organization admin credentials.

## Reviewer / QA

Needs changes, test results, acceptance criteria, failures, reproducible verification. Can reject claims even if a worker marked itself finished.

## Core JTBD

- When I have an idea, I want to attach specs and start coordinated execution with minimal setup.
- When I wake up, I want a compact 'what shipped / what blocked / what needs me' digest.
- When many engineers are active, I want to locate one task and trace all messages/commits tied to it.
- When an agent fails, I want the system to recover or escalate without silently duplicating expensive work.
- When a PR is ready, I want explicit proof of quality and a configurable review/merge gate.
