// Durable adapter-side intent journal (FF-008, coordinator review PR #34).
//
// Crash-after-acceptance rule (mirrors E15's reconciliation_fixture.py and
// the F05 flow): a crash between "bridge accepted the launch" and "reply
// durably recorded" leaves the dispatch fate UNKNOWN. The adapter therefore
// persists its dispatch intent (idempotency key + exact payload) to disk
// BEFORE POSTing, and the next wake reconciles by re-issuing the IDENTICAL
// payload — the bridge's idempotency replays the original receipt instead
// of spawning a duplicate (contract test case 1).
//
// Layout under <stateRoot>/:
//   journal/pending/<p>_<t>_<r>.json      in-flight first-wake intent
//   journal/quarantine/<p>_<t>_<r>.json   ambiguous session awaiting owner
// Writes are atomic (tmp file + rename). Quarantine records are never
// auto-cleared: only the out-of-band recovery path resolves them.
//
// Durability caveat: the default stateRoot lives under the OS temp dir and
// survives process crashes, not host reboots or disk loss. Production
// deployments must set FORGEFLEET_ADAPTER_STATE (or stateRoot) to durable
// storage. Bridge-side durability is E06-owned; this journal covers the
// adapter side only.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const JOURNAL_VERSION = 1;

export function journalKeyFor(projectId, taskId, runId) {
  return `${projectId}_${taskId}_${runId}`;
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function createJournal(stateRoot) {
  const pendingDir = join(stateRoot, 'journal', 'pending');
  const quarantineDir = join(stateRoot, 'journal', 'quarantine');
  mkdirSync(pendingDir, { recursive: true });
  mkdirSync(quarantineDir, { recursive: true });

  function atomicWrite(path, data) {
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, path);
  }

  function readJson(path) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return null;
    }
  }

  return {
    pendingPath: (key) => join(pendingDir, `${key}.json`),
    readPending: (key) => readJson(join(pendingDir, `${key}.json`)),
    writePending: (key, entry) =>
      atomicWrite(join(pendingDir, `${key}.json`), { version: JOURNAL_VERSION, ...entry }),
    clearPending: (key) => rmSync(join(pendingDir, `${key}.json`), { force: true }),
    readQuarantine: (key) => readJson(join(quarantineDir, `${key}.json`)),
    writeQuarantine: (key, record) =>
      atomicWrite(join(quarantineDir, `${key}.json`), { version: JOURNAL_VERSION, ...record }),
    clearQuarantine: (key) => rmSync(join(quarantineDir, `${key}.json`), { force: true }),
    // Append-only audit of recovery resolutions (who authorized what, when,
    // on which proof). Best-effort: audit failure never blocks a wake.
    writeAudit: (key, record) => {
      try {
        const auditDir = join(stateRoot, 'journal', 'audit');
        mkdirSync(auditDir, { recursive: true });
        atomicWrite(join(auditDir, `${key}-e${record?.schedulerEpoch ?? 'x'}.json`), {
          version: JOURNAL_VERSION,
          resolvedAt: new Date().toISOString(),
          ...record,
        });
      } catch {
        // intentional no-op: audit is evidence, not a gate
      }
    },
    get stateRoot() {
      return stateRoot;
    },
    get pendingDir() {
      return pendingDir;
    },
  };
}

export function isValidJournalPending(entry) {
  return (
    !!entry &&
    entry.version === JOURNAL_VERSION &&
    typeof entry.idempotencyKey === 'string' &&
    entry.idempotencyKey.length >= 8 &&
    entry.payload !== undefined &&
    typeof entry.payloadHash === 'string' &&
    typeof entry.remoteDir === 'string'
  );
}
