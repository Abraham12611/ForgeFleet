# Vercel web and Google Play Android — release runbook

**Planning runbook, not evidence of deployment.** Use the owning E17/E20 issue and obtain approval for promotion/public release.

## Web / Vercel

1. Choose Vercel account/team and connect the **ForgeFleet** GitHub repository. This is not done by creating these docs.
2. Do not configure production until the pinned Paperclip UI can be independently built. Use the correct `apps/web` or upstream `ui` root after E01 identifies the actual implementation layout; avoid blind `vercel.json` assumptions.
3. Configure preview builds on feature PRs with no production service tokens. Authenticate against preview/staging backend, not live production, unless explicitly restricted read-only.
4. Verify SPA fallback on nested routes; auth redirects/cookies; API errors; SSE/WebSocket/streaming; upload limits; mobile widths; and live agent status.
5. Configure production custom domain, HTTPS, secure public API ingress and Vercel project environment settings. Public frontend `VITE_*` is never a place for secrets.
6. Protect `main` with CI and reviewer gates. Only owner-approved release goes live; observe deployment, smoke-test, and keep a tested rollback path.

## Backend / Vultr

1. Keep coordinator, bridge, GitHub webhook receiver, PostgreSQL and agent runtimes here. Do not move stateful execution to Vercel functions.
2. Configure Paperclip's authenticated/public deployment mode after verifying session origin handling, hostname allowlist, HTTPS reverse proxy and request security.
3. Bridge binds loopback or Unix socket; only authenticated Paperclip integration calls it. Keep Orca credentials under Orca owner's user service.
4. Test backend restart while agents are active; verify no duplicate dispatch and that in-flight work reconciles.

## Android / Google Play

1. Choose reverse-DNS application ID and signing scheme with the owner before committing release identifiers. Google Play signing credentials must be protected.
2. Build Capacitor Android from the **same web source**, with native navigation, notifications, deep linking, secure auth storage, file picker and appropriate offline indicators where needed.
3. Test on real Android devices (including the owner's Samsung): sign-in, expiring sessions, app background/foreground, deep links, alerts, context uploads, sleep/awake toggles and PR approvals.
4. Prepare adaptive icons/splash, user-facing privacy policy, data safety form, app access instructions for reviewers, applicable permission declarations and current Play target SDK compliance.
5. Produce signed Android App Bundle (AAB); submit to **internal testing** first under owner's Google Play Console. Some account types may require additional testing before public production access; verify current Play Console rules rather than assuming.
6. Advance to closed/public release only on explicit owner approval and after Play review/test evidence. Do not claim a published app until the console confirms it.

## Rollback and compatibility

Rollback Vercel frontend only to a version compatible with the active Vultr API. Backend rollbacks require database/queue compatibility. Android app updates roll out more slowly than web deployments; version APIs and retain supported old client functionality. Log redacted diagnostics and use staged release tracks.
