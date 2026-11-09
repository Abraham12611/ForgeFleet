# Vercel preview -> Vultr staging API ingress (FF-028)

E17 scope: `infra/preview-ingress/**` (this directory) plus `scripts/deploy/**`.
Depends on E01 (Paperclip UI separability) and E07 (session auth) -- both still
open in this repo, so live preview evidence is **not** claimed. What this delivers
is a reviewable ingress contract with automated policy checks plus reconnect and
upload tests against fixtures.

## Files

- [ingress-policy.yaml](ingress-policy.yaml): declarative source of truth (public vs denied paths, auth, CORS, reconnect, upload limits).
- [nginx.preview-ingress.conf](nginx.preview-ingress.conf): staging ingress implementation. Terminates TLS on 443, enforces `auth_request` on every public location, echoes only Vercel-preview/staging origins (never `*`), streams `/api/events` unbuffered with `Last-Event-ID` resume, bounds `/api/uploads` to `10m` + POST/PUT.
- [vercel-preview.env.example](vercel-preview.env.example): browser-safe preview env (`VITE_PUBLIC_API_URL` staging only, no secrets).

## Guarantees

- Authenticated preview: every public location has `auth_request /internal/auth/session`; anonymous access is denied; previews point at staging, never production.
- No exposed bridge: bridge stays loopback/Unix socket; ingress has no bridge/Orca/private upstream and explicitly denies `/bridge`, `/internal` (except the internal-only auth subrequest), `/metrics-private`, `/orca`.
- Reconnect: SSE location disables buffering/caching, holds the connection 15m, forwards `Last-Event-ID`; clients fall back to state GET on resume failure.
- Uploads: authenticated POST/PUT only, `client_max_body_size 10m`, CORS-safe, proxied to Paperclip staging (context store), never to the bridge.

## Verify

```bash
python3 scripts/deploy/preview_ingress_check.py
python3 scripts/deploy/test_preview_ingress.py
```

Both use stdlib only and run against the files in this repo (fixtures, not live infra).

## Rollback

Ingress config is additive and unapplied: no live service reads these files yet.
To roll back, revert this directory and `scripts/deploy/preview_ingress_check.py`
plus its test; no data migration or service restart is involved. Do not restart
the operator's existing Orca service as part of this change.

## Live evidence still needed (blocked on E01/E07)

Staging TLS endpoint, Vercel preview URL, authenticated login, 15m+ stream with
forced reconnect, and a real upload round-trip. Record those in the owning issue
when the staging backend exists; do not present fixture checks as live proof.
