/**
 * FF-031 pinned upstream adapter registration (offline, fake backend).
 *
 * Coordinator direction on PR #63: prove the bridge integration drives the
 * ACTUAL pinned Paperclip external adapter plugin registration — the
 * documented plugin-loader path — rather than merely calling adapter
 * functions. Network verification of the pin itself (tag -> SHA, contract
 * strings) stays in `scripts/paperclip-pin-smoke.sh`, which is
 * network-dependent by design and runs out of band; this test proves the
 * local side of that registration:
 *
 * 1. The canonical adapter loads through the PINNED entry path
 *    (`packages/paperclip-orca-adapter/server/index.js`) via dynamic
 *    `import()`, exactly as a Paperclip plugin loader resolves it, and
 *    exposes the pinned registration surface (`createServerAdapter`,
 *    `ADAPTER_TYPE`, versioned `sessionCodec`).
 * 2. The pin constants this branch claims (tag + commit) are identical in
 *    the reconciliation doc and the smoke script — no drift between what
 *    the docs promise and what the verification script checks.
 * 3. The registered adapter's first wake dispatches exactly once through a
 *    real bridge HTTP server (fake Orca backend, scheduler-signed lease),
 *    proving the registered plugin — not a stub — drives dispatch.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeServer } from "../src/server.ts";
import { FakeOrca, asRunner } from "../src/runtime/fake-orca.ts";
import { createHmacLeaseVerifier, issueSchedulerLease } from "../src/runtime/scheduler-lease.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..", "..");

// Pinned plugin-loader entry path (docs/adapters/creating-an-adapter.md:
// the loader resolves `./server/index.js` and calls `createServerAdapter`).
const PINNED_ENTRY = "../../../packages/paperclip-orca-adapter/server/index.js";

const PIN_TAG = "v2026.1106.0";
const PIN_SHA = "d69631b01b9c658f80bf8bed389863dce82643e1";

const TOKEN = "test-pinned-reg-token-ff031";
const PROJECT = "proj-ff031";
const TASK = "paperclip-task-pinned";
const RUN = "r1";
const LEASE_SECRET = "test-pinned-reg-lease-secret-ff031";

const { leaseToken } = issueSchedulerLease({
  secret: LEASE_SECRET,
  projectId: PROJECT,
  taskId: TASK,
  runId: RUN,
  fencingEpoch: 1,
  ttlMs: 3_600_000,
  nonce: `${PROJECT}:${TASK}:${RUN}:1`,
});

let root;
let localCwd;
let dataDir;
let stateRoot;
let server = null;
let baseUrl = "";
let fake;

beforeEach(async () => {
  process.env.FORGEFLEET_ALLOW_TEST_INGEST = "1";
  root = mkdtempSync(join(tmpdir(), "ff031-pinned-"));
  localCwd = join(root, "paperclip-cwd");
  dataDir = join(root, "bridge-data");
  stateRoot = join(root, "adapter-state");
  mkdirSync(localCwd, { recursive: true });
  writeFileSync(join(localCwd, "task-input.txt"), "input\n");
  fake = new FakeOrca();
  server = await BridgeServer.create({
    dataDir,
    token: TOKEN,
    executable: "fake-orca-ide",
    backend: { run: asRunner(fake), listSessions: () => fake.listSessions() },
    port: 0,
    trustedProjects: [PROJECT],
    leaseVerifier: createHmacLeaseVerifier({ secret: LEASE_SECRET }),
    providers: [
      { name: "muse", status: "verified" },
      { name: "devin", status: "unknown" },
    ],
  });
  baseUrl = await server.listen();
});

afterEach(async () => {
  delete process.env.FORGEFLEET_ALLOW_TEST_INGEST;
  if (server) {
    await server.close();
    server = null;
  }
  rmSync(root, { recursive: true, force: true });
});

test("adapter registers through the pinned plugin-loader entry path", async () => {
  // Exactly how a Paperclip plugin loader resolves the external adapter:
  // dynamic import of the pinned entry file, then the documented factory.
  const entryUrl = new URL(PINNED_ENTRY, import.meta.url).href;
  const plugin = await import(entryUrl);
  assert.equal(
    typeof plugin.createServerAdapter,
    "function",
    "pinned entry must export createServerAdapter",
  );
  assert.equal(plugin.ADAPTER_TYPE, "forgefleet-orca");
  assert.equal(plugin.ADAPTER_VERSION, "0.1.0");

  const adapter = plugin.createServerAdapter({
    bridgeBaseUrl: baseUrl,
    bridgeToken: TOKEN,
    stateRoot,
  });
  assert.equal(typeof adapter.execute, "function", "registered adapter must expose execute");

  // The versioned session codec is part of the pinned resume contract.
  assert.ok(plugin.sessionCodec, "pinned entry must export the session codec");
});

test("pin constants match between the reconciliation doc and the smoke script", () => {
  const doc = readFileSync(join(ROOT, "docs/07-research/paperclip-pin-reconciliation.md"), "utf-8");
  const smoke = readFileSync(join(ROOT, "scripts/paperclip-pin-smoke.sh"), "utf-8");
  for (const text of [doc, smoke]) {
    assert.ok(text.includes(PIN_TAG), `must reference pin tag ${PIN_TAG}`);
    assert.ok(text.includes(PIN_SHA), `must reference pin commit ${PIN_SHA}`);
  }
});

test("the registered plugin's first wake dispatches exactly once via the bridge", async () => {
  const plugin = await import(new URL(PINNED_ENTRY, import.meta.url).href);
  const adapter = plugin.createServerAdapter({
    bridgeBaseUrl: baseUrl,
    bridgeToken: TOKEN,
    stateRoot,
  });
  const first = await adapter.execute({
    runId: RUN,
    agent: { id: "muse" },
    runtime: { sessionId: `paperclip-${TASK}-${RUN}`, sessionParams: null },
    config: {},
    context: {
      taskId: TASK,
      projectId: PROJECT,
      cwd: localCwd,
      instruction: "prove pinned registration",
      workerKind: "muse",
      contextManifestId: "ctx-1",
      lease: { fencingEpoch: 1, leaseToken },
    },
  });
  assert.equal(first.exitCode, null);
  assert.ok(first.sessionParams?.attemptId, "first wake must return a bridge attempt");
  assert.equal(fake.dispatchCount, 1);

  // The attempt the registered plugin created is a real bridge receipt.
  const res = await fetch(`${baseUrl}/v1/attempts/${first.sessionParams.attemptId}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 200);
  const receipt = await res.json();
  assert.equal(receipt.projectId, PROJECT);
  assert.ok(receipt.orcaDispatchId);
});
