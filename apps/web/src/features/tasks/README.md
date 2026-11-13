# Tasks feature (E13, FF-016)

Task detail screens for ForgeFleet. See [FF-016](https://github.com/Abraham12611/ForgeFleet/issues/16).

## Routes mounted

- `/projects/:projectId/tasks/:taskId` (`TaskDetailRoute` → `TaskDetailScreen`)

## Files (owned by E13)

- `types.ts` — view-model types from the frozen contracts (state machines,
  bridge OpenAPI, domain model, web-app-map).
- `trace.ts` — route builders for the Task → attempt → agent chain.
- `liveness.ts` — liveness vs verification separation (bare dispatch never
  reports live; 5s NFR-05 default threshold).
- `task-detail.ts` — detail view-model builder (generation-ordered attempts,
  single-active-lease resolution, fencing-conflict banner, deduped timeline,
  7 screen states).
- `bridge-adapter.ts` — typed boundary from frozen bridge/Paperclip payloads
  (`AttemptReceipt`, `RuntimeSession`, event envelope) into view-model inputs.
  Unknown lifecycle strings map to `unknown`; missing IDs throw
  `AdapterError`; unknown event types pass through.
- `TaskDetailScreen.tsx` / `TaskDetailRoute.tsx` — mounted screen + fixture
  container. Every render carries a fixture notice.
- `fixtures.ts` — deterministic login-flow fixtures + seeded 200-agent roster
  (virtualization checks only, not worker-capacity evidence).
- `screens.css` — restrained scoped styles (text-first statuses, system fonts,
  reduced-motion support).

## Tests

- `node --test apps/web/src/features/tasks/*.test.ts` — pure view-model +
  adapter suites (stdlib only).
- `npm test` (vitest, from `apps/web`) — `screens.test.tsx` SSR route tests
  through the real `App` route table (accessible landmarks, link targets,
  live-region roles). No new test dependencies.

## What this does NOT claim

No live Paperclip/Orca data. Route containers feed fixture payloads through
the same adapter boundary live data will use; generation assignment is
provisional (`observedAt` order) until E06/E09 persist fencing generations.
