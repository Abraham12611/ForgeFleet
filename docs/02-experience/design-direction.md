# Design direction and accessibility

**Brand:** ForgeFleet = a fleet of makers coordinated toward one outcome. Visual language: reliable operations center, not videogame dashboard. This file is design direction rather than finalized brand assets.

## Information hierarchy

1. Human decisions and system failures.
2. Project outcomes and verified progress.
3. Work that is running/blocked and why.
4. Inspectable detail: messages, terminals, diffs, artifacts.

Use density controls (comfortable/compact), neutral surfaces, restrained status colors, strongly labeled interactive states, motion only when useful to signal state. Project summary is readable within a few seconds.

## Foundation

Prefer Paperclip's existing components and design tokens, customizing incrementally. Shared React components should serve responsive web and Android shell. Avoid duplicating variants with separate mobile logic when CSS/layout can handle it.

## Accessibility

WCAG 2.2 AA target: keyboard navigation, focus visibility, sufficiently large touch targets, ARIA role for live updates, reduced motion, color-independent state labels and proper empty/error announcements. A red/green difference alone may not represent success/failure.

## UI sign-off fixtures

At 360px, 412px, 768px, 1280px, 1440px: Dashboard with 20 workers, 200 workers (virtualized), 30 inbox items, offline condition, 1 PR with 12 checks, empty project, sleeping owner. Use deterministic fixtures and screenshot diff inspection.
