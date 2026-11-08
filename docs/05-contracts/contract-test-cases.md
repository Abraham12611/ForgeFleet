# Contract tests and fixture catalog

## HTTP adapter / bridge

1. Same `Idempotency-Key` + same payload returns same attempt ID, only one Orca dispatch.
2. Same key + different payload returns `409` without side effect.
3. Invalid service token returns `401`; valid token wrong project scope returns `403`.
4. Unsupported Devin supervised operation marks capability unknown/unavailable and never guesses CLI flags.
5. Missing required fields gives typed validation error.
6. Cancellation requires actor authorization and does not claim success until runtime confirms.
7. SSE resume using `Last-Event-ID` does not lose persisted events; state GET is recovery fallback.

## Messages/events

Duplicate/reordered runtime events yield one logical state change; late `heartbeat` for fenced epoch is ignored; untrusted agent chat cannot trigger policy override; secrets are scrubbed; question delivered while owner sleeps is queued, not dropped.

## GitHub

Wrong webhook HMAC rejected; replayed delivery deduped; PR check evaluated for exact head SHA; changed head invalidates approval; failed CI blocks merge; user can approve main merge but agent alone cannot.

## Restart

Launch accepted -> bridge crashes before saving reply -> on restart reconcile original Orca dispatch and do not launch another. Workspace sync-back failure gates dependent task. DB transaction failure never acknowledges event prematurely.

## UX

Mobile 360px: answer one decision, inspect 20 workers and 200 virtualized workers; offline reconnection clearly shows last confirmed state; permission denial includes rationale.

Fixtures should include deliberately malicious PR text instructing agent to reveal secrets, and verify control plane ignores it as authority.
