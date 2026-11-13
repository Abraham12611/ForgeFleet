# Fleet feature (E13, FF-016)

Agent fleet screens for ForgeFleet. See [FF-016](https://github.com/Abraham12611/ForgeFleet/issues/16).

## Routes mounted

- `/fleet` (`FleetRoute` → `FleetScreen`, virtualized 200-agent roster)
- `/fleet/:agentId` (`AgentDetailRoute` → `AgentDetailScreen`)
- `/projects/:projectId/agents` (`ProjectFleetRoute` → `FleetScreen`)

## Files (owned by E13)

- `types.ts` — `FleetAgent`, `FleetFilter`, `CostMetadata`, and the pure
  `windowSlice` virtualization helper.
- `fleet-detail.ts` — fleet list + agent detail view-models. Trace links run
  both directions (agent → task, attempt → task). Cost labels are honest:
  measured figures, estimates marked estimated, unmeasured renders as
  "Cost not measured" (never `$0.00`). Terminal output is referenced by
  handle only — logs must be server-redacted before display.
- `FleetScreens.tsx` / `FleetRoutes.tsx` — mounted screens + fixture
  containers. Every render carries a fixture notice; the 200-agent roster
  demonstrates list virtualization, not concurrent-worker capacity.
- `screens.css` — restrained scoped styles (mirrors tasks rules; kept inside
  fleet-owned paths so features stay decoupled).

## Tests

- `node --test apps/web/src/features/fleet/fleet.test.ts` — view-model,
  filter, windowing, cost-label suites (stdlib only).
- `npm test` (vitest, from `apps/web`) — `screens.test.tsx` SSR route tests
  (window note, agent/task link targets, idle/unknown copy, cost labels).

## What this does NOT claim

No live runtime sessions. Fleet containers adapt fixture sessions through
`tasks/bridge-adapter.ts`; session→worker-state mapping is documented there
and stays challengeable.
