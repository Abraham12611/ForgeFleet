# ADR-0004 — Default safe autonomy and merge policy

**Status:** Accepted as default, owner can change via authenticated settings.

## Context

The system must continue building overnight but prevent accidental production changes, runaway cost, security incidents and unsafe merges.

## Decision

Unattended ordinary work allowed subject to budgets and policy. PR author cannot self-merge; `develop` merge can be delegated after independent review and required green checks; `main`, production deploys, destructive migrations and permission/budget increases require explicit owner approval. Sleep mode queues human decisions but never silently approves.

## Consequences

Some workflows pause for owner approval; this is desirable. UI must offer consolidated decision inbox and unblock only dependent tasks when the owner answers.
