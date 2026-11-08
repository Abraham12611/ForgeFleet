# Governance and document control

This is a versioned, reviewable specification. Changes to API schemas, agent event semantics, task state machines, security posture, or authority boundaries require a PR with an ADR update and impacted-team acknowledgments. User-visible copy and layout can evolve within acceptance criteria.

## Roles

- Human: product owner and final approval for changes to main / production / privileges / spending ceilings.
- Technical coordinator: plans integration, reviews PRs, ensures no two engineers own overlapping files.
- Contract custodian (Eng 05 and Eng 06): API schemas and event compatibility.
- Security custodian (Eng 07): threat models, auth, data handling, privilege boundaries.
- QA lead (Eng 15): acceptance evidence, failure injection and release gate.

## Change process

1. Propose change in issue with affected docs/contracts.
2. Flag backwards compatibility and active workers impacted.
3. Obtain acknowledgement from all affected domain owners.
4. Ship contract/schema + generated types + tests first, then providers/consumers.
5. Note migration and rollback path; update reference docs and changelog.

## Branching

`main` = released/stable. `develop` = integration branch, after it is explicitly created. `feat/*` = engineer branches. No agent merges its own PR. Coordinator may merge clean PRs to `develop` within approved policy, not automatically to `main`.
