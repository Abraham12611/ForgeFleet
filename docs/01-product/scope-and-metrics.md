# Scope, milestones, metrics and explicit non-goals

## Initial MVP includes

A single authenticated owner, one Vultr host, one Paperclip deployment, existing Orca instance, Muse end-to-end execution, dashboard/decision inbox, task delegation, basic GitHub repo + PR links, and durable event mapping. Devin discovery and launch fallback must be documented; full supervised parity is contingent on a spike.

## Not in v0.1

A full Slack clone, marketplace, multi-tenant billing, distributed auto-scaling, voice chats, real-time screen recording, Play Store publication, model provider billing automation, every possible CLI harness, independent project knowledge graph or rewriting Orca itself.

## Success metrics

- **Time to verified value:** from creating a goal to a PR passing CI.
- **Human interruptions / task:** count unique decisions escalated to operator.
- **Verified task throughput:** accepted/merged deliverables per calendar day, not agent-generated task count.
- **Agent utilization:** running vs waiting vs blocked vs abandoned; compare with useful ready-task count.
- **Recovery correctness:** duplicate dispatches, lost messages, leaked worktrees and unresolved leases during injected failures.
- **Cost efficiency:** actual billed cost per accepted task; show unknown if costs cannot be measured.
- **Merge quality:** post-merge rollback/incidents, CI flakiness, independent reviewer defect escape rate.

## SLO proposals (not yet guarantees)

99.9% durable event ingest under healthy DB; UI freshness within 5 sec for healthy websocket/SSE path; no privilege bypass across integration tests; no duplicate GitHub writes from retries. Numeric operational SLOs must be calibrated on the deployment before claiming them.

## Stop conditions

Stop autonomous loops when acceptance criteria satisfied, budget exhausted, risk approval needed, no useful ready tasks remain, or repeated failures exceed policy. 'Never stop working' is not a requirement to invent new work.
