# Signing and release checklist (FF-025)

Planning checklist, not release evidence. Every box below is currently
unchecked — check them only with observed console/device output attached.

## Prerequisites (all must hold before any AAB is cut)

- [ ] Owner has chosen the reverse-DNS application ID (replaces the
  `com.example.forgefleet.placeholder` value).
- [ ] Owner has chosen the web/API domains (replaces `app.example.invalid` and
  serves `assetlinks.json` for App Links verification).
- [ ] Signing credentials exist **only** in the owner's secret manager / protected
  CI store under the names in `release-spec.json`. No keystore, password, or key
  material exists in this repo, in logs, or in worker contexts.
- [ ] `apps/web` (E12/E14) builds reproducibly; the exact web commit is recorded.
- [ ] Authenticated public API ingress (E17) is reachable from a non-tailnet
  network over HTTPS.

## AAB build

- [ ] `npm --prefix apps/web run build` passes.
- [ ] `npx cap sync android` passes with no drift warnings.
- [ ] `./gradlew bundleRelease` produces the artifact path in `release-spec.json`.
- [ ] `bundletool build-apks` succeeds from the AAB.
- [ ] `applicationId` and `versionCode` match the release record; `debuggable`
  is false; no secrets in the bundle.

## Play submission (owner-gated)

- [ ] AAB uploaded to the **internal** track under the owner's Play Console.
- [ ] Privacy policy, data-safety form, app-access instructions, permission
  declarations, and target-SDK compliance reviewed against **current** Play
  rules (re-verify at submission time; do not rely on this doc's date).
- [ ] Promotion to closed, then production, only on explicit owner approval
  per `promotionGates` in `release-spec.json`.

## Rollback note

Android rollouts move slower than web deploys. Keep the previous internal-track
AAB available; version the API so the older client keeps working. Frontend-only
Vercel rollbacks must stay within tested API contract compatibility.
