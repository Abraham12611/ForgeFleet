# FF-027 — Paperclip standalone Vite UI / Vercel feasibility spike

**Status:** SPIKE COMPLETE with coordinator changes requested (PR #56 review) —
re-verified against the agreed pin below; staging proof explicitly OUT OF
SCOPE (owned by E07/E17 with FF-028). Do not merge or deploy yet.  
**Agreed upstream pin (FF-001 / ADR-0007):** tag `v2026.1106.0` = commit
`d69631b01b9c658f80bf8bed389863dce82643e1` (2026-10-23), MIT, pnpm monorepo,
`ui@0.3.1` / `server@0.3.1`, engines `node >= 24.11.0`. Every upstream claim
below was re-checked against that tag in an isolated worktree
(`git worktree add … v2026.1106.0`, SHA confirmed); `scripts/paperclip-pin-smoke.sh`
passes (`PIN+SMOKE PASS v2026.1106.0 d69631b…`). No upstream code vendored.
No floating `master` tracking — an upgrade follows the rule in
`docs/07-research/version-pins.md`, not this spike.

## Objective

Prove whether the pinned Paperclip Vite UI can build and deploy to Vercel
separately from the Vultr Paperclip API (auth + live streaming across split
origins), per ADR-0006 gates, and record the fallback. This is the Phase-0.E
spike ADR-0007 anticipates (`apps/web` stays a thin composition target).

## Upstream layout at the agreed pin (observed, not assumed)

| Area | Observed fact | Source path in pinned tree |
|---|---|---|
| UI package | `@paperclipai/ui`, `vite build` / `vite preview`, React 19 + react-router + TanStack Query | `ui/package.json`, `ui/vite.config.ts` |
| API client base | Hardcoded `const BASE = "/api"` — same-origin only; `credentials: "include"` (cookie session) | `ui/src/api/client.ts:5,55` |
| Build-time env | Only public display keys (`VITE_PAPERCLIP_DESIGN_SANDBOX`, `VITE_FEEDBACK_TERMS_URL`); **no** `VITE_*` API base | `grep VITE_ ui/src` |
| Live channel 1 (company events) | Same-origin WebSocket `wss?://<host>/api/companies/:id/events/ws`; `LiveUpdatesProvider` degrades to **15s polling** when disconnected | `ui/src/lib/websocket-url.ts`, `ui/src/context/LiveUpdatesProvider.tsx:61,2090` |
| Live channel 2 (plugin bridge) | SSE `EventSource` at `/api/plugins/:pluginId/bridge/stream/:channel?companyId=…`, `withCredentials: true` | `ui/src/plugins/bridge.ts:623`, `server/src/routes/plugins.ts:1783` |
| Server route catalog | WS `/api/companies/{companyId}/events/ws` + SSE `/api/plugins/{pluginId}/bridge/stream/{channel}` registered server-side | `server/src/services/native-runtime/runner-api-catalog.ts:125`, `server/src/routes/openapi.ts:10111` |
| Dev split support | Vite dev/preview proxies `/api` (incl. ws) to `localhost:3100`, forwarding `x-forwarded-host`/`x-forwarded-proto` | `ui/src/lib/vite-api-proxy.ts` |
| Server bundling | Express serves built UI + SPA handling; UI and API ship as one unit by default | `server/src/middleware/static-ui.ts`, `server/src/app.ts` |
| Auth | Better Auth session + `trustedOrigins` set derived from configured base URL | `server/src/auth/better-auth.ts:186` |

## Compatibility matrix

| Concern | Same-origin (Vultr-bundled UI) | Split-origin (Vercel UI → Vultr API) | Verdict |
|---|---|---|---|
| Independent `vite build` | Yes | Yes — proven by `apps/web` scaffold (`tsc + vite build`, 260KB / 83KB gzip) | PASS (scaffold compiles) |
| REST via `/api` | Same-origin fetch, cookie session | Requires either a Vercel `/api/*` rewrite to the Vultr ingress (keeps cookie same-site) or an absolute `VITE_PUBLIC_API_URL` + CORS + `trustedOrigins` update | PASS WITH CHANGE, staging proof open (E17) |
| Session cookies | First-party, no extra config | Cross-site: needs `Secure`, `SameSite=None`, HTTPS on both origins, server `trustedOrigins` including preview origins | NOT VERIFIED — needs staging + E07 |
| OAuth/callbacks | Same-origin redirect | Callback URLs must allowlist `app.<domain>` + preview URLs | NOT VERIFIED — needs staging + E07 |
| Live channel 1 (WS) | Same-origin wss | Cross-origin socket to `wss://api.<domain>/api/companies/:id/events/ws`; needs ingress WS support + `x-forwarded-*` handling | NOT VERIFIED — needs staging + E17 |
| Live channel 2 (SSE) | Same-origin EventSource | Cross-origin SSE needs `Vary: Origin`, credential echo, `Last-Event-ID` resume through the ingress | NOT VERIFIED — needs staging + E17 |
| Streaming fallback | 15s React Query poll on socket drop | Same polling works split-origin (plain HTTPS GET), only staler | PASS (degraded, by code inspection) |
| SPA routing | Server SPA fallback | `vercel.json` rewrite `/((?!api/).*) → /index.html` | PASS (scaffold compiles) |
| Uploads/downloads | Same-origin | Vercel rewrite proxies bodies (watch serverless payload ceiling — direct-to-Vultr URLs for large files) | CAUTION, needs staging |
| Secrets hygiene | Server env stays server-side | Only `VITE_PUBLIC_API_URL` is public; `resolveApiBase` rejects loopback/tailnet values | PASS (tested, 10/10) |
| Long sessions (15min+) | Heartbeat cwd persistence server-side | Unaffected by where static assets are hosted in theory; reconnect behavior unproven split-origin | NOT VERIFIED — needs staging |

## What this spike proves vs what it does not

- PROVEN: an independent Vite build of a composition-shell UI compiles and
  bundles; the pinned UI's same-origin assumptions are enumerated to exact
  file/line; the pin smoke passes.
- NOT PROVEN (explicitly): Paperclip auth, cookie, OAuth, WS or SSE delivery
  across a real Vercel↔Vultr split. That requires the staging backend plus
  E07 (session/auth) and E17 (ingress, FF-028) — see "Staging evidence" below.
- **GAP FOUND for E17:** FF-028's ingress policy names `stream_endpoint:
  /api/events` (SSE), but the pinned UI exposes live channels at
  `/api/companies/:id/events/ws` (WS) and
  `/api/plugins/:pluginId/bridge/stream/:channel` (SSE). Neither matches
  `/api/events`. E17 should reconcile the ingress paths with these actual
  pinned endpoints before claiming preview streaming.

## Fallback (if split-UI gates fail)

Keep the complete Paperclip UI + API together on Vultr behind Tailscale
(alpha single-origin proof, roadmap Phase 1) and run Vercel preview-only
until the auth/streaming rows above pass against staging. No Orca bridge,
database, CLI, or service secret ever moves to Vercel or the browser bundle
either way. If upstream's hardcoded `/api` base blocks the fork, prefer the
Vercel rewrite (zero upstream diff) over patching `client.ts`.

## Staging evidence still required (E07/E17, FF-028 — not this spike)

Staging TLS endpoint, Vercel preview URL, authenticated login, 15min+ WS/SSE
stream with forced reconnect, and a real upload round-trip. Record those in
the owning FF-028 issue when the staging backend exists. Until then the
public split-web feasibility remains unproven by agreement, and any preview
deploy of this scaffold will show the built-in "backend unreachable" state.

## What was built (this branch)

- `apps/web/` — standalone Vite + React + react-router scaffold implementing
  the Vercel-compatible pattern: env-configurable API base with
  loopback/tailnet rejection, cookie-credential client, wss-upgrade live
  socket with 15s poll fallback, SPA shell, `vercel.json` (placeholder
  rewrite + SPA fallback — **placeholder is non-routable `.example`, see
  below**), `.env.example` with public-only settings.
- `vercel.json` placeholder: the rewrite target `https://api.forgefleet.example`
  is a reserved non-routable domain, so no preview can function against it;
  E17 (FF-028) substitutes the real staging ingress. A deployed preview today
  renders the unreachable-backend panel by design. Enforcement is fail-closed
  but separate from compilation: `npm run verify:vercel`
  (`scripts/verify-vercel-config.mjs`) exits 1 while the rewrite is a placeholder,
  so CI/deployment cannot promote it; `npm run build` itself stays green
  (bypass `FORGEFLEET_ALLOW_PLACEHOLDER_API=1` is local-only, never set in Vercel).
- API-base hardening (coordinator follow-up): `resolveApiBase` requires a public
  HTTPS origin for any cross-origin base — plain HTTP (e.g. `http://api.example.com`,
  `http://8.8.8.8`), IP literals, userinfo and placeholder domains throw, so session
  cookies can never be sent over plaintext or blocked as mixed content. Plain-HTTP
  loopback works only behind the explicit `allowInsecureLocalhost` dev flag. The live
  socket therefore always upgrades to `wss://` from an HTTPS base (tested).
- Evidence: `npm test` — 2 files / 10 tests pass (vitest); `npm run build`
  — `tsc -b && vite build` succeeds; env injection verified; bundle contains
  no loopback API default (remaining `localhost` strings are react-router
  internals).
- Known limits: scaffold is not the Paperclip UI and claims no product
  surface; no live Vultr backend exists yet.

## Ownership / coordination

- This spike (FF-027/E01): `docs/07-research/paperclip-*.md`, `apps/web`
  shell + `src/lib/*` + root configs.
- PR #38 (E12 fixtures): `apps/web/src/features/dashboard/*` — no file
  overlap; future dashboard work mounts under `src/features/`.
- PR #40 (E13/E14 view-models): `apps/web/src/features/{tasks,fleet}/*` —
  no file overlap.
- PR #57 (E17/FF-028): `infra/preview-ingress/*`, `scripts/deploy/*` —
  owns the ingress contract and preview env; this spike consumes (not
  duplicates) it. Actual endpoint-path mismatch flagged above for E17.

## Recommendation

Accept the split topology as feasible pending staging proof; proceed with
Vercel rewrite-first integration on staging (E12 + E17), Better Auth
cross-site cookie review (E07), and keep the Vultr-bundled UI as the standing
fallback through v0.1. Do not run the coordinator, bridge, or database in
Vercel Functions. Do not merge or deploy this branch until the staging rows
pass.
