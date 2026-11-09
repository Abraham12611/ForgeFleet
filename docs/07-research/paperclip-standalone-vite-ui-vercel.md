# FF-027 — Paperclip standalone Vite UI / Vercel feasibility spike

**Status:** SPIKE COMPLETE — feasible with a small upstream-compatible patch; fallback documented.  
**Pinned upstream:** `paperclipai/paperclip` `master` @ `088bdf7cfa78eda23bdfb4c25dbae90e1861c0dc`
(2026-11-09, `fix(daytona)… (#20212)`), MIT, pnpm monorepo, `ui@0.3.1` /
`server@0.3.1`, engines `node >= 24.11.0`. Verified read-only via the GitHub
API and a shallow blob-less clone on 2026-11-09; no upstream code vendored
into this repo. Local toolchain `node v24.22.0` / `npm 11.19.1` satisfies the
engine range.

## Objective

Prove whether the pinned Paperclip Vite UI can build and deploy to Vercel
separately from the Vultr Paperclip API (auth + live streaming across split
origins), per ADR-0006 gates, and record the fallback if not.

## Upstream layout (observed, not assumed)

| Area | Observed fact | Source path in pinned tree |
|---|---|---|
| UI package | `@paperclipai/ui`, `vite build` / `vite preview`, React 19 + react-router + TanStack Query | `ui/package.json`, `ui/vite.config.ts` |
| API client base | Hardcoded `const BASE = "/api"` — same-origin only; `credentials: "include"` (cookie session) | `ui/src/api/client.ts` |
| Build-time env | Only public display keys (`VITE_PAPERCLIP_DESIGN_SANDBOX`, `VITE_FEEDBACK_TERMS_URL`); **no** `VITE_*` API base | `grep VITE_ ui/src` |
| Realtime | Same-origin socket via `buildSameOriginWebSocketUrl` (ws/wss from `window.location`); `LiveUpdatesProvider` degrades to **15s polling** when disconnected | `ui/src/lib/websocket-url.ts`, `ui/src/context/LiveUpdatesProvider.tsx` |
| Dev split support | Vite dev/preview proxies `/api` (incl. ws) to `localhost:3100`, forwarding `x-forwarded-host`/`x-forwarded-proto` | `ui/src/lib/vite-api-proxy.ts` |
| Server bundling | Express serves built UI + SPA handling; UI and API ship as one unit by default | `server/src/middleware/static-ui.ts`, `server/src/app.ts` |
| Auth | Better Auth session + `trustedOrigins` set derived from configured base URL | `server/src/auth/better-auth.ts` |

## Compatibility matrix

| Concern | Same-origin (Vultr-bundled UI) | Split-origin (Vercel UI → Vultr API) | Verdict |
|---|---|---|---|
| Independent `vite build` | Yes — `ui` builds standalone today | Yes — proven by `apps/web` scaffold (`tsc + vite build`, 260KB / 83KB gzip) | PASS |
| REST via `/api` | Same-origin fetch, cookie session | Requires either a Vercel `/api/*` rewrite to the Vultr ingress (keeps cookie same-site) or an absolute `VITE_PUBLIC_API_URL` + CORS + `trustedOrigins` update | PASS WITH CHANGE (rewrite preferred) |
| Session cookies | First-party, no extra config | Cross-site: needs `Secure`, `SameSite=None`, HTTPS on both origins, server `trustedOrigins` including the Vercel origin(s) incl. previews | PASS WITH CHANGE (E07/E17 config) |
| OAuth/callbacks | Same-origin redirect | Callback URLs must allowlist both `app.<domain>` and preview URLs; login handoff must return to the browser origin | PASS WITH CHANGE |
| Live updates (WS) | Same-origin ws/wss | Cross-origin socket to `wss://api.<domain>/…`; needs ingress WS support + `x-forwarded-*` handling as in the dev proxy | PASS WITH CHANGE, polling fallback available |
| Streaming fallback | 15s React Query polling when socket drops | Same polling works split-origin (plain HTTPS GET), only staler | PASS (degraded, documented) |
| SPA routing | Server SPA fallback | `vercel.json` rewrite `/((?!api/).*) → /index.html` | PASS (in scaffold) |
| Uploads/downloads | Same-origin, no proxy limits | Vercel rewrite proxies bodies (watch 4.5MB serverless payload ceiling — use direct-to-Vultr URLs for large files) | CAUTION, direct-upload path for large files |
| Secrets hygiene | Server env stays server-side | Only `VITE_PUBLIC_API_URL` is public; enforced by `resolveApiBase` rejecting loopback/tailnet values | PASS (tested) |
| Long sessions (15min+) | Heartbeat cwd persistence server-side | Unaffected by where static assets are hosted; reconnect + React Query recovery already upstream behavior | PASS |

## Fallback (if split-UI gates fail)

Keep the complete Paperclip UI + API together on Vultr behind Tailscale
(alpha single-origin proof, roadmap Phase 1) and run Vercel preview-only
until the auth/streaming rows above pass against staging. No Orca bridge,
database, CLI, or service secret ever moves to Vercel or the browser bundle
either way. If upstream's hardcoded `/api` base blocks the fork, prefer the
Vercel rewrite (zero upstream diff) over patching `client.ts`.

## What was built (this branch)

- `apps/web/` — standalone Vite + React + react-router scaffold implementing
  the Vercel-compatible pattern: env-configurable API base with
  loopback/tailnet rejection, cookie-credential client, wss-upgrade live
  socket with 15s poll fallback, SPA shell, `vercel.json` (`/api` rewrite +
  SPA fallback), `.env.example` with public-only settings.
- Evidence: `npm test` — 2 files / 10 tests pass (vitest); `npm run build`
  — `tsc -b && vite build` succeeds, `dist/` 260KB (83KB gzip); env
  injection verified (`VITE_PUBLIC_API_URL` baked at build time); bundle
  contains no loopback API default (remaining `localhost` strings are
  react-router internals).
- Known limits: scaffold is not the Paperclip UI fork; no live Vultr backend
  exists yet so the matrix rows marked PASS WITH CHANGE are proven by code
  path + upstream source inspection, not by a staging deployment. E12/E17
  own the real UI build and ingress verification against staging.

## Recommendation

Accept the split topology as feasible; proceed with Vercel rewrite-first
integration on staging (E12 + E17), Better Auth cross-site cookie review
(E07), and keep the Vultr-bundled UI as the standing fallback through v0.1.
Do not run the coordinator, bridge, or database in Vercel Functions.
