# Split-UI compatibility matrix (E01 + E12 + E17 + E07)

**Status: OPEN.** No Vercel production traffic and no `deploy-split.sh --apply`
until every row below is PASS against the pinned Paperclip SHA. While any
row is OPEN/FAIL, releases use the private single-origin stack
(`deploy-private.sh`; `edge` profile stays down).

| # | Gate (owner) | Probe | Pass condition | Status |
|---|---|---|---|---|
| S-01 | Independent Vite build (E01) | `npm run` build in the real `apps/web` / upstream `ui` path | byte-stable `dist/`, no API import at build time | OPEN |
| S-02 | SPA fallback (E12) | GET deep route on Vercel preview | serves `index.html`, no 404 | OPEN |
| S-03 | Auth session/cookies (E07) | login → refresh → logout across `app.*` / `api.*` | session persists, `SameSite=None; Secure` only on HTTPS, CSRF enforced | OPEN |
| S-04 | OAuth callbacks (E07) | provider round-trip to preview + production URLs | allowlisted redirect, no token in URL fragment logs | OPEN |
| S-05 | Streaming/reconnect (E12) | 15-min SSE/WebSocket session + reconnect with `Last-Event-ID` | no gaps, resume exact | OPEN |
| S-06 | Uploads (E12) | 25 MB upload + preview/download via Vercel | limits enforced, no secret in browser bundle | OPEN |
| S-07 | Preview isolation (E17) | preview build with staging env | cannot reach production DB or mutate production | OPEN |
| S-08 | No open bridge (E17) | `verify-split.sh` (real `caddy validate` + adapt) + canonical guards | bridge loopback-only (user unit + `guard-loopback.sh`), edge 404s `/v1/*`, no `8787` upstream in adapted JSON | PASS (static + real-caddy; no live ingress) |
| S-09 | Restore rehearsal (E17) | `verify-restore.sh` on canonical `backup.sh`/`restore.sh` fixture mode | byte-identical restore, manifest sha256 OK, leases fenced | PASS (fixture) |

`deploy-split.sh --apply` additionally enforces S-01…S-07 mechanically: it
refuses while any of those rows contains `OPEN`.

Evidence for S-08/S-09 in this PR is **static + real-binary config
validation + fixture rehearsal only** — see `verify-split.sh` output
(`caddy validate`: Valid configuration) and `verify-restore.sh` output.
Live Vultr/Vercel evidence requires E01 pins and owner-approved preview
URLs, tracked as follow-up. Issue #60 owns the integrated bridge API; the
openapi `4387` server URL vs the canonical host bind `8787` is an E05/E06
follow-up, not resolved here.
