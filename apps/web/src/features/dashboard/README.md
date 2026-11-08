# Dashboard fixtures — Command Center + project overview (FF-015 / E12)

Fixture-only spike. Prerequisites E01 (Paperclip upstream) and E05 (frozen
contracts) are **not** satisfied, so this directory renders **mock status
only** and labels every payload `dataSource: 'fixture'`. Live Orca/Paperclip
state is refused loudly (`dashboard.js` throws on `dataSource: 'live'`)
rather than misrendered.

## Files (all under exclusive E12 ownership `apps/web/src/features/dashboard/`)

- `fixtures.js` — deterministic factories: 20/200 workers, 30 inbox items,
  PR with 12 checks, healthy/empty/offline/throttled/sleeping command
  centers, Atlas project overview. No clock, no randomness.
- `dashboard.js` — pure state logic: 7 screen states
  (`loading/ready/empty/recoverable-error/permission-denied/offline/stale`),
  command-center summary, project overview, `unknown`-preserving worker
  states, responsive nav model for sign-off widths 360/412/768/1280/1440.
- `dashboard.css` — mobile-first responsive styles, bottom tabs on narrow
  screens, focus-visible + reduced-motion support, text-labelled statuses.
- `index.html` — self-contained demo: open directly in a browser, switch
  screen states with the picker, resize to verify breakpoints. No build step.
- `dashboard.test.js` — `node --test` suite (10 tests).

## Contracts followed

- Copy: `docs/02-experience/screens-states-and-copy.md`
- Routes/IA: `docs/02-experience/web-app-map.md`,
  `docs/02-experience/information-architecture.md`,
  `docs/02-experience/mobile-app-map.md`
- States: `docs/05-contracts/state-machines.md` (`unknown` stays unknown)
- Scope: `docs/06-delivery/dispatch/E12.md`, `docs/06-delivery/work-breakdown.md` FF-015

## Run

```sh
node --test apps/web/src/features/dashboard/dashboard.test.js
open apps/web/src/features/dashboard/index.html
```

## Unverified assumptions / next steps for coordinator

- No Paperclip components reused yet (E01 spike pending); CSS/classes here
  are throwaway-compatible and must be reconciled with upstream tokens.
- No bridge types consumed (E05 draft OpenAPI only, unpinned).
- Task/fleet/inbox full screens belong to E13/E14 — only summary counts
  are exposed here for cross-linking.
