# Dashboard — Command Center + project overview (FF-015 / E12)

React port on the version-pinned `apps/web` composition (upstream
`paperclipai/paperclip` @ `088bdf7`; foundation from PR #56, E01-owned).
This directory supersedes the first-commit standalone JS/HTML spike, which
has been removed. **Not the complete product dashboard; FF-015 is not
claimed complete.**

## Files (exclusive E12 ownership `apps/web/src/features/dashboard/`)

- `types.ts` — `DataSource` (`fixture` | `unknown` | `live`), screen-state
  and payload shapes.
- `state.ts` — pure accepted screen/state model: 7 screen states, summary,
  overview, `unknown`-preserving worker states, nav model for 360–1440px,
  honest-source binding policy (`resolveSource`).
- `fixtures.ts` — deterministic fixtures + preview variants
  (healthy/empty/offline/throttled/sleeping/denied).
- `useControlPlane.ts` — real binding via `src/lib/api.ts` + `src/lib/live.ts`
  (read-only). `live` requires a successful health check this session.
- `CommandCenter.tsx` — `/projects` route (fixture preview + binding modes).
- `ProjectOverview.tsx` — `/projects/:id` route.
- `SourceBadge.tsx`, `StateBanner.tsx` — explicit source labels, 7-state UI.
- `routes.tsx` — route exports for the shell (see touchpoint below).
- `dashboard.css` — mobile-first styles, bottom tabs, focus + reduced motion.
- `state.test.ts`, `fixtures.test.ts` — vitest suites.
- `MANUAL-UI-CHECKLIST.md` — **owner-executed** UI tests + screenshot list.

## Shared-entry touchpoint (coordinator sign-off requested, PR #38)

`src/App.tsx` (E01-owned): added the `dashboardRoutes` import, a
`Projects` nav link, and `{dashboardRoutes}` inside `<Routes>` — additive
only. `/` probe and `/fleet` placeholder untouched (E01/E13).

## Run (from `apps/web`)

```sh
npm install
npm test        # vitest, incl. dashboard suites
npm run typecheck
npm run build
npm run dev     # :5173; /api proxied to $PAPERCLIP_DEV_API or localhost:3100
```

## Contracts followed

- Copy/IA/routes: `docs/02-experience/screens-states-and-copy.md`,
  `web-app-map.md`, `information-architecture.md`, `mobile-app-map.md`,
  `design-direction.md`.
- States: `docs/05-contracts/state-machines.md` (`unknown` stays unknown).
- Scope: `docs/06-delivery/dispatch/E12.md`, work-breakdown FF-015.

## Unverified assumptions / limits

- No live Vultr backend exists: the `live` code path is wired but
  unverified against staging (E17); reachable states today are
  `fixture` / `unknown` / `offline` / `stale`.
- Project-level endpoints unbound (E05/E08): project fields render as
  `unknown` in binding mode, never as `live` — enforced by throws in
  `state.ts`.
- Spending figures are labelled estimates until E18 binds metering.
- Task/fleet/inbox full screens stay E13/E14; only summary counts here.
- Manual UI verification + screenshots are owner-executed per
  `MANUAL-UI-CHECKLIST.md`; the agent claims only the automated gates.
