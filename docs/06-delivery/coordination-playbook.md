# Coordinator operational playbook for 20 engineers

## Intake

Every engineering task gets an issue with: objective, owner E##, phase/milestone, branch target, allowed files, dependencies, explicit acceptance, test evidence, no-merge instruction, and security constraints. Coordinator posts kickoff messages in issues, not ephemeral chat alone.

## Day-to-day loop

1. Refresh task DAG and open PR/CI status.
2. Triage issues blocked by requirements, contract, permissions or infrastructure.
3. Assign only ready tasks with owned files to engineer agents; keep busy count under useful capacity.
4. Read worker comments and PR evidence; route cross-team questions to the relevant custodian.
5. Request reviewers; check actual tests and required statuses before merging into `develop` under configured policy.
6. Confirm dependency readiness and dispatch next wave; post human digest of verified outcomes.

## Engineer handoff requirements

When an agent is done it posts to its issue/PR: branch, PR link, changed files, acceptance criteria, test evidence, integration dependencies, unsolved issues, source version, required next action. The agent **does not merge its own PR** and does not claim its task is complete until coordinator verifies.

## Parallel safety

- No shared writable worktrees.
- No simultaneous uncoordinated changes to API/event contracts, core Paperclip bootstrap files or DB migrations.
- All contract modifications require custodian review before downstream updates.
- Integration lead chooses merge order; refresh/rebase if branch protection or conflicts require it.
- Workers may message each other for clarification, but only coordinator/scheduler can commit new task ownership.

## Human communication

Ask the human only for owner-only decisions, unavailable credentials not already connected, or true requirements ambiguity. During sleep, queue those questions and continue independent work. Never claim a future result was achieved before an artifact/test proves it.

## Weekly/noise-control metric

Track verified work and open decisions, not number of messages or how many agents appear busy. If blocked ratio rises, reduce agent count and improve shared contracts.
