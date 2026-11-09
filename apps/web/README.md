# apps/web — standalone UI foundation (FF-027 spike)

Feasibility scaffold proving a Vite React build can deploy to Vercel
independently of the Vultr Paperclip API. Full evidence and the
auth/streaming compatibility matrix live in
[docs/07-research/paperclip-standalone-vite-ui-vercel.md](../../docs/07-research/paperclip-standalone-vite-ui-vercel.md).

## Run

```bash
cd apps/web
npm install
npm test          # vitest: api-base + live-fallback policy (10 tests)
npm run build     # tsc + vite build -> dist/
npm run dev       # :5173, /api proxied to $PAPERCLIP_DEV_API or localhost:3100
```

Configure the backend origin with `VITE_PUBLIC_API_URL` (public HTTPS only;
see `.env.example`). Unset keeps same-origin `/api` for the Vultr-bundled
fallback and local dev proxy.

## What this is

- `src/lib/api.ts` — env-configurable API base (rejects loopback/tailnet
  hosts a Vercel browser cannot reach), cookie-credential fetch, health probe.
- `src/lib/live.ts` — WebSocket URL builder (split-origin wss upgrade or
  same-origin derivation) plus explicit connect-then-poll fallback matching
  the upstream 15s disconnected-poll policy.
- `src/App.tsx` — status probe + SPA routing shell (`/` `/fleet` catch-all).
- `vercel.json` — `/api/*` rewrite (currently a non-routable `.example`
  placeholder owned by E17/FF-028 ingress work) + SPA fallback to `index.html`.
  Until E17 substitutes the real staging ingress and E07 clears cross-site
  session auth, any preview deploy renders the unreachable-backend panel by
  design — this scaffold is a compile proof, not a functioning preview.
- `scripts/verify-vercel-config.mjs` — fail-closed `prebuild` gate: the build
  refuses while the rewrite points at a placeholder/insecure origin. Local
  work sets `FORGEFLEET_ALLOW_PLACEHOLDER_API=1` (never in Vercel env).
- `VITE_PUBLIC_API_URL` must be a public HTTPS origin. Plain HTTP, IP
  literals, userinfo and placeholder domains throw; plain-HTTP loopback is
  allowed only behind the explicit `allowInsecureLocalhost` dev flag, never
  in a deployed bundle.

## What this is not

Not a fork of `@paperclipai/ui` and not a product surface. E12 owns the real
dashboard build on top of this foundation after the upstream pin review.
