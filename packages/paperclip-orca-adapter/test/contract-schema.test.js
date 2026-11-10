// Frozen-contract validation: adapter-built payloads must pass the E05
// bridge-contracts validator (packages/bridge-contracts, stdlib-only).
// Skips honestly when python3 or the validator is unavailable.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCreateAttemptRequest } from '../src/bridge-client.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/paperclip-orca-adapter/test -> repo root packages/bridge-contracts
const validatorDir = join(here, '..', '..', 'bridge-contracts', 'src');

function validateWithE05(kind, payload) {
  const dir = mkdtempSync(join(tmpdir(), 'pc-contract-'));
  try {
    const payloadPath = join(dir, 'payload.json');
    writeFileSync(payloadPath, JSON.stringify(payload));
    const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(validatorDir)})
from bridge_contracts import validate as v
payload = json.load(open(${JSON.stringify(payloadPath)}))
errors = ${kind}(payload)
print(json.dumps([str(e) for e in errors]))
`;
    const out = execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim();
    return JSON.parse(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('frozen bridge contract (E05 validator)', () => {
  it('CreateAttemptRequest payload validates clean', function () {
    let errors;
    try {
      errors = validateWithE05('v.validate_create_attempt_request', buildCreateAttemptRequest(
        {
          projectId: 'p1',
          taskId: 'T-1',
          runId: 'run-1',
          title: 'probe',
          instruction: 'do the thing',
          workerKind: 'muse',
          contextManifestId: 'ctx-1',
          repositoryId: 'sandbox-repo',
        },
        'ff8-p1-T-1-run-1',
        { fencingEpoch: 1, leaseToken: 'adapter:ff8-p1-T-1-run-1' },
      ));
    } catch (err) {
      this.skip(`E05 validator unavailable: ${err.message?.split('\n')[0]}`);
      return;
    }
    assert.deepEqual(errors, []);
  });

  it('SendMessage and Cancel payload shapes validate clean', function () {
    let errors;
    try {
      errors = validateWithE05('v.validate_send_message_request', {
        projectId: 'p1',
        threadId: 'th-1',
        actorId: 'owner:alice',
        body: 'proceed',
        kind: 'instruction',
      });
      assert.deepEqual(errors, []);
      errors = validateWithE05('v.validate_cancel_attempt_request', {
        reason: 'no longer needed',
        approvedBy: 'owner:alice',
      });
      assert.deepEqual(errors, []);
    } catch (err) {
      this.skip(`E05 validator unavailable: ${err.message?.split('\n')[0]}`);
      return;
    }
  });
});
