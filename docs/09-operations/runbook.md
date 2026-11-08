# Operations runbook — private alpha

Do not execute any command that changes or restarts the user's existing Orca daemon until operator has approved a maintenance plan. Initial tasks are *read-only* and can run under a dedicated diagnostic session.

## Inspect existing Orca (read-only)

```bash
systemctl --user status orca-serve.service
systemctl --user show orca-serve.service -p ExecStart -p Environment -p User
command -v orca-ide || true
printf 'ORCA_CLI_COMMAND=%s\n' "${ORCA_CLI_COMMAND:+[set]}"
```

Then choose the trusted installed Orca executable as documented in `skills/orchestration/SKILL.md`. Request its version-matched CLI guide and supported commands; do not use blind `orca ...` on Linux host shell.

## Incident: no Orca connectivity

1. Stop **new dispatch** only, leave existing workers untouched.
2. Record last successful probe and any pending/outstanding dispatch IDs.
3. Check user service/logs and Tailscale connectivity read-only.
4. Reconcile sessions after connectivity returns; do not presume missing process.
5. Escalate any ambiguous orphan before retry.

## Incident: duplicate or unowned attempts

Pause project new dispatch; compare task lease and fencing epochs, bridge event receipts, Orca runtime IDs and worktree status. If ambiguity remains, quarantine rather than terminate arbitrary sessions.

## Incident: GitHub merge disagreement

Disable merges, inspect exact head SHA/checks/protection; do not force-merge. Verify policy decision and owner approval record. Reopen required decision on changed head.

## Incident: cost spike

Set global admission to zero; do not indiscriminately kill existing operations that can corrupt state. Evaluate provider token usage, dispatch loops and duplicated attempts. Resume with reduced cap after evidence.

## Incident: security breach

Revoke service/GitHub tokens and disable privileged actions; preserve sanitized logs and audit; isolate bridge network; inform owner; investigate prompt injection and unauthorized access; rotate credentials and restore from known-good artifact if necessary.

## Disaster recovery

Restore PostgreSQL and object store to a consistent point; never restore stale leases as immediately runnable; reconcile Orca/GitHub state before any scheduling. Re-enable dispatch only after verification.
