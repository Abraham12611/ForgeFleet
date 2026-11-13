# Backup policy — daily snapshots, tested restores (FF-022 delta on FF-005)

The canonical live scripts are `scripts/deploy/backup.sh` / `restore.sh`
(FF-005, `--apply`-gated). This policy constrains how they are used in the
split phase; it does not replace them.

- **Cadence:** `systemd/backup.timer` (daily) runs `backup.sh --apply` with
  `BACKUP_DIR=/var/backups/forgefleet`, plus a manual snapshot before every
  release/rollback (`RESTORE_FENCED=1` operator hold applies to restores and
  rollbacks, not to snapshot-taking).
- **Contents:** PostgreSQL logical dump (`pg.dump`), context-store tarball
  (`context.tgz`), native bridge-state tarball when present, and
  `manifest.json` (`sha256` per artifact, `API_CONTRACT_VERSION`, image SHAs,
  UTC timestamp). Restores verify the manifest before touching anything.
- **Retention:** 14 daily + 4 pre-release snapshots on the Vultr host,
  replicated off-host before `v1.0` signoff. Snapshots are chmod 700/600 by
  the script. Snapshots contain production data: encrypt at rest, never
  attach to PRs, never copy into agent contexts or screenshots.
- **Restore rule (unchanged):** `restore.sh --apply` requires
  `BACKUP_SNAPSHOT=<dir>` **and** `RESTORE_FENCED=1`. Restored state
  never resumes leases as runnable: restart the bridge, verify
  `/v1/attempts`, and reconcile Orca/GitHub state before re-enabling
  dispatch (see runbook disaster-recovery section).
- **Rehearsal:** `verify-restore.sh` exercises the fixture modes
  (`backup.sh --fixture`, `restore.sh --manifest/--target-dir`) into an
  isolated dir and diffs every file. The release gate requires a passing
  rehearsal younger than 24h; a live staging restore rehearsal is still
  required before first production promotion.
