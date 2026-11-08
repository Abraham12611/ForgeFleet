# Security and trust model

## Threat boundaries

**Untrusted:** task prompts, attached documents, repo source, PR review comments, agent output, web pages, logs, GitHub webhook body before signature verification. **Trusted components:** authenticated owner UI, control plane policy evaluator, bridge service, GitHub App auth, secrets manager (subject to appropriate isolation).

## Threats and mitigations

| Threat | Mitigation |
|---|---|
| Worker prompt injection requests deployment/secrets | Agent lacks permission; policy engine checks actor/operation/context; never let messages confer authority |
| GitHub webhook forgery/replay | HMAC verification, delivery-ID dedupe, installation/repository allowlist, timestamps |
| Agent duplicates task after timeout | Idempotency key, lease fencing, reconciliation before retry |
| Two workers edit one worktree | Exclusive lease, unique path, owner token and cleanup checks |
| Private context leaks between projects | Project ACLs, scoped retrieval, separate storage namespace and audit |
| CLI command injection | Bridge accepts typed operations only, fixed executable/args, no shell interpolation |
| Compromised agent reads GitHub credentials | GitHub App operations via policy API, no raw token forwarded |
| Public-exposed runtime bridge | Bind loopback/private network, mTLS/service auth, firewall, Tailscale |
| Malicious dependency or upstream update | Pinned commits, license review, dependency audit, staged rollout |
| Privilege escalation via sleep mode | Sleep never approves gated actions; explicit owner-authenticated consent |
| Over-spend | Hard budget ceilings, admission policy, provider rate limits, alert thresholds |
| Log exfiltration | Redact secrets at source and on ingest; private retention controls |

## AuthN / AuthZ proposal

Single-owner private alpha; Paperclip auth is required even over Tailscale. Roles: `owner`, `coordinator`, `lead`, `worker`, `reviewer`, `service`. Permissions are scoped to project + operation + resource. No implicit superuser privilege for a coordinator LLM.

## Approval classes

`AUTO_SAFE` (read/ordinary task operations), `AUTO_CHECKED` (merge into develop after tests), `OWNER_REQUIRED` (main, production, major spend, permissions), `DENY` (cross-tenant secrets, bypass protection). Approval includes action kind, resource IDs, expected state hash, expiry, actor and audit record.

## Privacy and retention

Uploads remain private to workspace; preserve hashes and citations; redact secrets before model handoff and logs. Define configurable retention for worker logs and archived attachments; deletion must purge derived context references or document any remaining audit metadata.

## Minimum ship gates

Role enforcement tests; webhook replay/forgery tests; denial of privileged actions from agents; secrets scanning; cross-project isolation tests; restart recovery; Tailscale/firewall access check; dependency license inventory; incident kill switch.
