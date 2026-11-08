# ADR-0001 — Paperclip as control plane

**Status:** Accepted as starting architecture, subject to v0.1 compatibility spike.

## Context

Operator currently supervises ~20 agents in Orca manually and wants one coordinator, project task graph, team communication, approval inbox, mobile access, and unattended safe execution.

## Decision

Use a self-hosted Paperclip deployment as the project/task/coordinator/governance authority. Extend its UI rather than write a new control plane from scratch. Keep Paperclip's upstream code pinned and minimize fork surface.

## Alternatives

Vespin: excellent inbox and PR UX, but self-hosted backend not supported at time of review. Gas City: specialized coding-agent workflow execution, but adopting it as root would require more integration with the existing Orca fleet. Build from scratch: higher risk/time.

## Consequences

Fast initial management UI and task model, but external adapter contracts and workspace persistence need explicit testing. Do not add a second task database with conflicting statuses. Reconsider if Paperclip prevents reliable long-lived external workers.
