// Fixture smoke for FF-001: asserts the external-adapter plugin shape that
// docs/07-research/paperclip-integration-strategy.md pins. Run with:
//   node examples/paperclip-adapter-smoke/smoke.mjs
// or via scripts/paperclip-pin-smoke.sh (adds upstream pin verification).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { createServerAdapter } = await import('./server/index.mjs');
const { parseOutputToCards } = await import('./ui-parser.mjs');

// 1. Plugin-loader convention: the module exports createServerAdapter.
assert.equal(typeof createServerAdapter, 'function', 'must export createServerAdapter');
const adapter = createServerAdapter();
assert.equal(typeof adapter.execute, 'function', 'adapter must expose execute');
console.log('ok 1 - plugin exports createServerAdapter with execute');

// 2. Session continuity across heartbeats: sessionParams out -> runtime in.
const cwd1 = mkdtempSync(join(tmpdir(), 'pc-cwd-'));
const first = await adapter.execute({ taskId: 'T-1', cwd: cwd1 }, { sessionId: null, sessionParams: null });
assert.ok(first.sessionParams?.sessionId, 'first wake returns sessionParams');
const second = await adapter.execute({ taskId: 'T-1', cwd: cwd1 }, { sessionId: first.sessionId, sessionParams: first.sessionParams });
assert.equal(second.sessionParams.sessionId, first.sessionParams.sessionId, 'session resumes across heartbeats');
assert.equal(second.sessionParams.runCount, 2, 'run count advances on resumed session');
console.log('ok 2 - sessionParams persist across heartbeats, runCount=2');
rmSync(cwd1, { recursive: true, force: true });

// 3. Unknown session recovery: stale params -> clearSession: true.
const cwdStale = mkdtempSync(join(tmpdir(), 'pc-cwd-'));
const stale = await adapter.execute({ taskId: 'T-1', cwd: cwdStale }, {
  sessionId: 'gone',
  sessionParams: { sessionId: 'gone', stale: true },
});
assert.equal(stale.clearSession, true, 'stale session forces fresh session');
console.log('ok 3 - stale session returns clearSession:true');
rmSync(cwdStale, { recursive: true, force: true });

// 4. No-remote-git invariant: predecessor state visible in local cwd at return.
const cwdA = mkdtempSync(join(tmpdir(), 'pc-cwdA-'));
await adapter.execute({ taskId: 'T-2', cwd: cwdA }, { sessionId: null, sessionParams: null });
assert.ok(readFileSync(join(cwdA, 'ATTEMPT.md'), 'utf8').includes('attempt 1'), 'sync-back lands in local cwd');
console.log('ok 4 - cwd round-trip sync-back without any git remote');
rmSync(cwdA, { recursive: true, force: true });

// 5. Static rule mirroring the upstream no-push check: no remote-push invocations.
const forbidden = ['git', 'push'].join(' '); // built dynamically so this check is not self-matching
for (const f of ['server/index.mjs', 'ui-parser.mjs', 'smoke.mjs']) {
  const src = readFileSync(join(here, f), 'utf8');
  assert.ok(!src.includes(forbidden), `${f} must not contain a git-push invocation`);
}
console.log('ok 5 - no remote-push invocation in adapter fixture source');

// 6. Self-contained UI parser present (no upstream ui/ registry edit needed).
assert.equal(parseOutputToCards('hi')[0].kind, 'log');
console.log('ok 6 - self-contained ui-parser stub');

console.log(`fixture files: ${readdirSync(here).join(', ')}`);
console.log('SMOKE PASS: external-adapter plugin shape (fixture, not live integration)');
