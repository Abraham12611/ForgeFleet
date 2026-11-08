# ADR-0002 — Keep existing Orca and integrate with an external bridge

**Status:** Accepted as initial direction, exact integration mode pending spike.

## Context

Existing Orca is a working background user service on Vultr. Muse/Devin are already configured. Reinstallation or daemon replacement would risk active work.

## Decision

Build a separate `orca-bridge` daemon and Paperclip external adapter. Use documented/version-matched Orca CLI capabilities. Use Paperclip HTTP/process adapter only for a proof of concept; graduate to external adapter for long-lived session state and output. Orca owns runtime processes; scheduler owns desired assignments.

## Critical caveat

Paperclip local cwd must remain cross-run persistence boundary, whereas Orca owns worktrees. Resolve sync-back and ownership before production task dependency fan-out.

## Consequences

Can reuse working Orca config/sessions. Adds a correlation store, event normalization, capability gating and service credential boundary. Existing sessions initially discoverable read-only, not automatically managed.
