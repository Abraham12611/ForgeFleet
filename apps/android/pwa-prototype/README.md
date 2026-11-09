# FF-019 — Responsive mobile workflow PWA (fixture prototype)

**Status: FIXTURE SPIKE, not production UI.** All screens render
deterministic mock data from [fixtures.json](fixtures.json). Nothing here
calls a backend, Orca, Paperclip, or GitHub.

## Why a fixture spike

FF-019 depends on E12 (FF-015 dashboard) and E14 (FF-017 inbox), which have
no implementation in this repository yet (no `apps/` tree exists). Per the
[E20 dispatch brief](../../../docs/06-delivery/dispatch/E20.md), E20 proceeds
with a read-only/design/fixture spike while blocked.

## What it proves

The [mobile acceptance walkthrough](../../../docs/02-experience/mobile-app-map.md#mobile-acceptance-walkthrough):
at 360×800 the owner can launch a new task, attach context, send a
coordinator message, see live progress, toggle sleep, answer one question,
review a PR summary, and inspect a failure — with no horizontal scrolling.

Walkthrough map (each step names its route):

| Step | Route | Fixture |
|---|---|---|
| Launch new task | `#/project/demo/chat` composer | sent message, `queued` delivery |
| Attach context | chat file picker | stored attachment names |
| Send coordinator message | `#/project/demo/chat` | owner message thread |
| See live progress | `#/project/demo/tasks`, `#/fleet` | running task, heartbeats, freshness |
| Toggle sleep | `#/more` | persisted toggle, queue note |
| Answer one question | `#/inbox` | `decision` with all 8 required fields |
| Review PR summary | `#/project/demo/prs` | 12 checks, 1 failing, merge disabled + reason |
| Inspect failure | `#/project/demo/tasks` → failed task | error banner, safe-retry action |

## Run it

```sh
cd apps/android/pwa-prototype
python3 -m http.server 8137
# open http://localhost:8137/index.html#/home in a browser
```

No build step, no dependencies. Service worker registers on `http://localhost`
for the offline shell demo.

## Tests

```sh
python3 -m unittest discover -s apps/android/pwa-prototype/tests -t . -v
```

Plus a headless-Chrome 360px pass (see PR evidence): per-route
`screenshot` at 360×800 and an overflow assertion
(`document.scrollingElement.scrollWidth <= 360`).

## Explicit non-goals (later issues)

- Capacitor AAB, device testing, push notifications → FF-025 (v1.1).
- Google Play internal track → FF-029 (v1.1).
- Backend auth, streaming, real data → E12/E14 follow-ups.
- No changes to `apps/web` (E12–E14 ownership) or shared contracts.
