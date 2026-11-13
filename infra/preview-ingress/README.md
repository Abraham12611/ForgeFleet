# Vercel preview -> Vultr staging API ingress (FF-028)

E17 scope: `infra/preview-ingress/**` (this directory) plus `scripts/deploy/**`.
Depends on E01 (Paperclip UI separability) and E07 (session auth) for live
proof; both still open, so live Vercel↔Vultr evidence is **not** claimed. What
this delivers is a validated ingress contract plus a real local round-trip
through the actual Caddy binary (stub backend, localhost) on top of static
policy checks.

## One ingress design (review response)

This PR previously proposed nginx. E17 siblings #45 (FF-005) and #51 (FF-022)
both chose Caddy, and the coordinator asked for ONE design, so this directory
now ships Caddy only: `nginx.preview-ingress.conf` is deleted in favor of
[Caddyfile.preview](Caddyfile.preview). Convergence notes for the coordinator:

- Structure mirrors #51's edge (`handle` blocks, `forward_auth`, explicit
  bridge-path 404s, default deny, security headers, JSON logs).
- Two corrections vs #51, both verified against pinned
  `paperclipai/paperclip @ 088bdf7` (read-only GitHub API inspection):
  1. The session gate is `GET /api/auth/get-session` (pinned
     `server/src/routes/auth.ts`: throws `unauthorized` without a board
     session; mounted at `/api/auth` per `server/src/app.ts`), not the
     unverified `/auth/verify` path #51 forwards to.
  2. Realtime is `wss:///api/companies/<id>/events/ws` with a `live.hello`
     handshake plus revision resync (pinned
     `ui/src/context/LiveUpdatesProvider.tsx`), falling back to 15s HTTPS
     polling — not generic SSE and not `/socket.io/*`.
- `/api/auth/*` (login/callback/get-session) proxies WITHOUT `forward_auth`
  because get-session itself 401s anonymously; everything else under `/api/*`
  goes through `forward_auth` first, including WS upgrades.

## Files

- [Caddyfile.preview](Caddyfile.preview): staging ingress. `forward_auth`
  on product routes, exact-host CORS allowlist (anchored alternation, never a
  broad wildcard), preflight 204/403, foreign-Origin 403, unauthenticated 401
  before any upgrade, explicit bridge-path 404s, default deny, 1GB ingress
  safety ceiling (per-route limits stay with the backend: 10mb default, 64mb,
  1GiB zip max per pinned `server/src/http/body-limits.ts`).
- [ingress-policy.yaml](ingress-policy.yaml): declarative source of truth.
- [vercel-preview.env.example](vercel-preview.env.example): browser-safe
  preview env (`VITE_PUBLIC_API_URL` staging only, no secrets).

## Verify

```bash
caddy validate --config infra/preview-ingress/Caddyfile.preview --adapter caddyfile
python3 scripts/deploy/preview_ingress_check.py
python3 scripts/deploy/test_preview_ingress.py
python3 scripts/deploy/preview_roundtrip.py
```

`caddy validate` passes (Caddy v2.11.9). `preview_roundtrip.py` boots the real
Caddy binary on localhost against a stdlib stub Paperclip backend and drives
the matrix end to end: 401 without session, 200 with session, 403 on foreign
Origin, exact CORS echo on allowlisted origins, 204/403 preflight, WS upgrade
101 + echo + close through the session gate, unauth WS rejected pre-upgrade,
oversize JSON rejected 413 through the proxy, `/bridge/*` and `/` 404,
`/api/liveness` 200 without auth. All fixture-local (stub backend,
loopback) — it proves ingress behavior, not Vultr/Vercel reachability.

## Preview-host rotation (explicit hosts, no broad trust)

1. When Vercel issues a preview deployment, the operator adds its EXACT
   `https://<deployment>.vercel.app` host to the `@allowed_origin` alternation
   in [Caddyfile.preview](Caddyfile.preview) and to the
   `cors.allowed_origins_exact` list in [ingress-policy.yaml](ingress-policy.yaml).
2. Register the SAME exact host in the Paperclip staging config that feeds
   `deriveAuthTrustedOrigins` (pinned `server/src/auth/better-auth.ts` builds
   `trustedOrigins` from configured base URLs), and set cross-site session
   cookies `Secure` + `SameSite=None` for preview origins (sibling-subdomain
   staging `app`/`api` hosts are same-site and keep working with `Lax`).
   E07 owns the auth wiring; this ingress only enforces the same allowlist.
3. Remove the host when the preview is torn down. `preview_ingress_check.py`
   fails the build on any wildcard origin entry.
4. The Vercel rewrite-first pattern (`/api/:path*` → Vultr ingress, per
   FF-027) keeps cookies same-site and needs no per-preview CORS entry; the
   allowlist above covers direct absolute-`VITE_PUBLIC_API_URL` previews.

## Rollback

Ingress config is additive and unapplied: no live service reads these files
yet. To roll back, revert this directory, `scripts/deploy/preview_ingress_check.py`,
`scripts/deploy/test_preview_ingress.py` and
`scripts/deploy/preview_roundtrip.py`; no data migration or service restart is
involved. Do not restart the operator's existing Orca service for this change.

## Live evidence still needed (blocked on E01/E07 + owner approval)

Staging TLS endpoint, Vercel preview URL, authenticated login, 15m+ WS session
with forced reconnect, and a real upload round-trip. Record those in #28 when
the staging backend exists; do not present the local round-trip as live proof.
Do not deploy until security gates and owner approval are recorded.
