# Deployment, backup and rollback checklist

## Before deployment

- [ ] Exact Orca service is healthy; its current worktrees/sessions inventoried nonintrusively.
- [ ] Paperclip pinned release, license/NOTICE reviewed, schema migration plan ready.
- [ ] Tailscale administrative access and application auth tested; bridge binds loopback only.
- [ ] Vercel frontend separation spike passes auth, upload, redirect, SSE/WebSocket and API-origin tests before live web deployment.
- [ ] Public HTTPS API ingress to Vultr is protected; only required backend endpoints are reachable, never Orca/bridge.
- [ ] Native Android release/Play listing has its own test and owner-approval checklist.
- [ ] Backend service credential and GitHub App secret injected from secrets manager, not repo.
- [ ] DB and context store backups confirmed with restore test.
- [ ] Resource limits/alerts and no-new-dispatch kill switch available.
- [ ] GitHub test repo selected and protections configured.

## After deployment

- [ ] Health live/ready/capabilities show correct distinct states.
- [ ] Read-only Orca discovery does not mutate live sessions.
- [ ] Fake bridge contract tests pass; real disposable Muse smoke passes.
- [ ] Web and Android-width UI do not expose credentials/logs.
- [ ] Owner-only action protection verified.
- [ ] Worker/bridge restart recovery tested.
- [ ] Rollback commands and snapshots documented.

## Rollback

Pause new dispatch, snapshot correlated state, revert Paperclip/bridge binaries to pinned previous revision, run reversible DB migration or restore tested backup, reconcile Orca and GitHub and only then resume admissions. Never revert the Orca background service blindly as part of Paperclip rollback.
