# End-to-end human journeys

## H1. First-run private setup

1. Visit private dashboard over Tailscale; authenticate; see VPS/orchestration connectivity check.
2. Connect GitHub App with least-required repo permissions; select a nonproduction test repo.
3. Probe Orca CLI read-only; display detected version and runtime capabilities.
4. Choose budget, project concurrency, eligible agent providers and merge/deploy approvals.
5. Run one disposable task and inspect mapping and results.

## H2. Create project and delegate

1. New Project > select repo/branch, type objective, upload PRD/reference files.
2. Review extracted file status and constraints; set outcome acceptance criteria.
3. Coordinator proposes milestones/DAG, risks, approximate capacity (estimates marked).
4. Human approves plan or modifies; coordinator creates tasks and assigns ready work.
5. Owner monitors summary rather than every terminal.

## H3. Manage changes

1. Worker notes an unexpected API discrepancy.
2. Lead assesses scope; resolves or raises a task-linked decision.
3. If human-only decision, inbox item is created with choices/context; paused dependency only.
4. Answer is appended as immutable event; all relevant workers receive a context update.

## H4. Go to sleep

1. Owner sets `sleep_mode=true` via UI, specifies optional wake threshold and emergency policy.
2. Coordinator continues ready tasks; does not auto-approve gated operations.
3. Blocking questions queue with ownership and evidence; independent tasks continue.
4. Owner returns; receives concise digest of verified completions and pending decisions.
5. Owner answers; scheduler wakes only affected tasks.

## H5. Review and ship

1. Worker opens PR; CI webhooks update status; reviewer agent compares diff with task acceptance.
2. Reviewer rejects or approves; policy engine evaluates branch, protection and risk.
3. Eligible changes merge into `develop`; `main` awaits owner approval by default.
4. On merge, dependent tasks re-evaluate readiness; release notes and audit timeline update.

## H6. Recover from outage

1. Dashboard marks Orca `unknown`, never `dead` based on timeout alone.
2. Reconciler reconnects, queries session/worktree state and event receipts.
3. Safely adopt original attempts when possible; fence old leases before replacement.
4. Human sees a recovered/blocked report and any unresolved duplicate-risk cases.
