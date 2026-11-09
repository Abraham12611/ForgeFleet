# Google Play internal testing — policy and submission checklist

Source of truth for each item: [release runbook](../../../docs/09-operations/vercel-and-play-release.md#android--google-play), gated by [ADR-0006](../../../docs/08-decisions/ADR-0006-vercel-and-android.md).
All boxes are unchecked in this PR — this is the work list, not evidence of completion.

## 1. Release identity (owner decision required)

- [ ] Reverse-DNS application ID chosen **with the owner** (runbook §Android-1). Do not commit `com.example.*` or any guessed ID.
- [ ] Play app signing enrolled; upload key and app-signing key handled per Play Console guidance. No keystore passwords in git.
- [ ] `versionCode` (monotonic integer) and `versionName` assigned for this internal release.
- [ ] Signed Android App Bundle (`.aab`) built from the **same web source** as the reviewed web release (runbook §Android-2), produced by FF-025 — not present yet.

## 2. Store listing and policy artifacts

- [ ] User-facing privacy policy published at a public `https://` URL.
- [ ] Play Data safety form completed (data types, collection, sharing, security practices).
- [ ] App access instructions for reviewers (sign-in method, test accounts, restricted areas) — credentials delivered via Play Console, never committed.
- [ ] Adaptive icons, feature graphic, and screenshots meet current Console requirements.
- [ ] Permission declarations completed for any sensitive permission; no undeclared background location or package-visibility needs.
- [ ] Target SDK / API level meets the current Play minimum (verify in Console at submission time; do not hardcode a stale number here).
- [ ] Content rating questionnaire completed; target audience and news-app declarations reviewed if applicable.

## 3. Internal testing track setup

- [ ] Internal testing release created in the owner's Play Console (owner action only).
- [ ] Release notes supplied for testers.
- [ ] Internal tester list / Google Group configured; opt-in link verified.
- [ ] Pre-launch report and Console warnings reviewed; blocking errors resolved.

## 4. Real-device smoke (evidence template in SMOKE_PROTOCOL.md)

- [ ] Runbook §Android-3 device pass completed on a real device (owner's Samsung class device at minimum): sign-in, expiring sessions, app background/foreground, deep links, alerts, context uploads, sleep/awake toggles, PR approvals.
- [ ] Offline/reconnect and lifecycle behavior recorded.
- [ ] Smoke evidence file attached to the release issue with device model, OS version, app version, timestamps, and per-step pass/fail.

## 5. Promotion guardrails (explicitly NOT this issue)

- [ ] No closed/public promotion without explicit owner approval and Play review evidence (runbook §Android-6, ADR-0006 §5–6).
- [ ] Rollback plan recorded: compatible web/API versions, staged-rollout halt procedure.

**Rule: a checked box without linked evidence (Console screenshot reference, artifact hash, or signed smoke file) does not count.**
