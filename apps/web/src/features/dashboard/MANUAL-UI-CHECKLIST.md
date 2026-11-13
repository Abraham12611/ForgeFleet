# Manual UI test checklist — dashboard (FF-015 / E12)

**Executed by the owner, not by the agent.** The agent ran only the
automated gates (`npm test`, `npm run typecheck`, `npm run build`); every
item below requires a human-driven browser session. Record results as a PR
#38 comment with the route screenshots attached.

## Setup (pick one backend posture, report which)

- [ ] A — No backend: `cd apps/web && npm install && npm run dev`
  (expect `unknown` + recoverable-error on Control-plane binding).
- [ ] B — Dev proxy: `PAPERCLIP_DEV_API=http://localhost:3100 npm run dev`
  with a local Paperclip server on :3100 (expect `live` on binding).
- [ ] C — Staging ingress: `VITE_PUBLIC_API_URL=https://<staging-api> npm
  run dev` (expect `live` iff auth/streaming gates pass; record failures
  for E07/E17).

Report: posture (A/B/C), exact backend URL or "none", browser + viewport.

## Routes

| # | Route | Source mode | Expect |
|---|---|---|---|
| 1 | `/projects` | Fixture preview, variant `healthy` | `FIXTURE` badge; 2 projects; counts 5 verified / 8 active / 8 ready / 4 blocked / 1 failing / 4 unknown |
| 2 | `/projects/proj-atlas` | Fixture preview | `FIXTURE` badge; counts 4/6/3/2/1; 3 milestones; reconciled timestamp shown |
| 3 | `/projects/nope` | Fixture preview | Empty state, no crash |
| 4 | `/projects` | Control-plane binding, posture A | `UNKNOWN` badge + recoverable-error + safe retry button |
| 5 | `/projects` | Control-plane binding, posture B/C | `LIVE` badge **only** if the health check succeeded; project fields stay `unknown` with the E05/E08 note |
| 6 | `/` and `/fleet` | — | Unchanged spike probe + E13 placeholder (regression check for the shared-shell edit) |

## States to capture (fixture variant selector on `/projects`)

- [ ] `empty` — shows "No active projects. Start with a goal and a repository."
- [ ] `offline` — shows read-only copy; actions disabled or absent.
- [ ] `sleeping` — sleep mode on; independent-work copy present.
- [ ] `denied` — "You do not have access to this project."
- [ ] `throttled` — provider-capacity notice verbatim.
- [ ] Loading — throttle the network (devtools) and confirm the loading
  state appears before content on binding mode.

## Responsive widths (devtools device emulation or real devices)

- [ ] 360px — single column, bottom tabs visible, no horizontal scroll.
- [ ] 412px — same as 360.
- [ ] 768px — two columns, bottom tabs hidden.
- [ ] 1280px — three columns.
- [ ] 1440px — three columns, max-width container.

## Accessibility spot checks

- [ ] Keyboard-only: reach variant selector, source selector, retry, all
  nav links with visible focus.
- [ ] `prefers-reduced-motion` respected (no animation).
- [ ] Status readable without color (text labels on every badge).

## Screenshot capture list (attach to PR #38)

1. `/projects` healthy (desktop-wide).
2. `/projects/proj-atlas` (desktop-wide).
3. `/projects` empty variant (360px).
4. `/projects` offline variant (360px).
5. `/projects` sleeping variant (360px).
6. Binding mode with posture A (unknown + error) — and posture B/C if
   available (live badge or documented failure).

## Non-goals for this round

- No real project data assertions (no project endpoints bound yet).
- No performance/load claims (20/200-worker virtualization is E13 scope).
- Failures of posture B/C auth or streaming go to E07/E17, not E12.
