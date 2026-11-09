/**
 * FF-031 finalization tests: canonical Paperclip adapter -> real bridge
 * HTTP -> fake Orca -> event receipt -> adapter status (real HTTP, no
 * in-process bridge fakes).
 *
 * Written against the canonical E04 adapter (FF-008, journaled intents,
 * fate-verified recovery, exitCode-based results). Drives the pinned
 * `AdapterExecutionContext` shape end to end:
 * first wake dispatches once, later wakes reconcile without re-POSTing,
 * the terminal wake syncs the Orca staging dir back into the Paperclip cwd
 * (finalize), and a bridge restart never launches a duplicate worker.
 *
 * Fixture evidence only: the owner-authorized live Muse smoke is a
 * separate, explicitly gated stage (see ff031-live-smoke-plan.md).
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeServer } from "../src/server.ts";
import { FakeOrca, asRunner } from "../src/runtime/fake-orca.ts";
import { createServerAdapter } from "../../../packages/paperclip-orca-adapter/server/index.js";

const TOKEN = "test-adapter-token-ff031";
const PROJECT = "proj-ff031";
const TASK = "paperclip-task-7";
const RUN = "r1";
const LEASE = { fencingEpoch: 1, leaseToken: "task-7:r1:1" };

let root;
let localCwd;
let dataDir;
let stateRoot;
let server = null;
let baseUrl = "";
let fake;

function ctx(sessionParams = null, overrides = {}) {
  return {
    runId: RUN,
    agent: { id: "muse" },
    runtime: { sessionId: `paperclip-${TASK}-${RUN}`, sessionParams },
    config: {},
    context: {
      taskId: TASK,
      projectId: PROJECT,
      cwd: localCwd,
      instruction: "produce the artifact",
      workerKind: "muse",
      contextManifestId: "ctx-1",
      lease: { ...LEASE },
      ...overrides,
    },
  };
}

function makeAdapter() {
  return createServerAdapter({
    bridgeBaseUrl: baseUrl,
    bridgeToken: TOKEN,
    stateRoot,
  });
}

function remoteDir() {
  return join(stateRoot, "work", `${TASK}-${RUN}`);
}

async function bridgeGetAttempt(attemptId) {
  const res = await fetch(`${baseUrl}/v1/attempts/${attemptId}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 200);
  return res.json();
}

beforeEach(async () => {
  process.env.FORGEFLEET_ALLOW_TEST_INGEST = "1";
  root = mkdtempSync(join(tmpdir(), "ff031-e2e-"));
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

test("paperclip task reaches running, finalizes the workspace, and survives restart without duplication", async () => {
  const adapter = makeAdapter();

  // Wake 1: no session -> capability gate -> journal intent -> dispatch.
  const first = await adapter.execute(ctx(null));
  assert.equal(first.exitCode, null);
  assert.ok(first.sessionParams);
  assert.ok(first.sessionParams.attemptId);
  assert.equal(first.sessionParams.taskId, TASK);
  assert.equal(first.sessionParams.status, "dispatched");
  assert.equal(fake.dispatchCount, 1);
  assert.ok(existsSync(join(remoteDir(), "task-input.txt")));

  // The worker produces output in the Orca staging dir; runtime reports running.
  const receipt = await bridgeGetAttempt(first.sessionParams.attemptId);
  const dispatchId = receipt.orcaDispatchId;
  assert.ok(dispatchId);
  writeFileSync(join(remoteDir(), "result.txt"), "artifact\n");
  fake.setStatus(dispatchId, "running");

  // Wake 2: reconcile only (no re-POST) -> running, exitCode null.
  const second = await adapter.execute(ctx(first.sessionParams));
  assert.equal(second.exitCode, null);
  assert.equal(second.sessionParams.done, false);
  assert.equal(fake.dispatchCount, 1);

  // Worker finishes; the terminal wake syncs back into the Paperclip cwd.
  fake.setStatus(dispatchId, "finished");
  const third = await adapter.execute(ctx(second.sessionParams));
  assert.equal(third.exitCode, 0);
  assert.equal(third.sessionParams.status, "submitted");
  assert.equal(third.sessionParams.done, true);
  assert.equal(readFileSync(join(localCwd, "result.txt"), "utf-8"), "artifact\n");
  assert.equal(existsSync(remoteDir()), false);
  assert.equal(fake.dispatchCount, 1);
});

test("bridge restart preserves the finished attempt; retried first wake replays without duplication", async () => {
  const adapter = makeAdapter();
  const first = await adapter.execute(ctx(null));
  const receipt = await bridgeGetAttempt(first.sessionParams.attemptId);
  fake.setStatus(receipt.orcaDispatchId, "running");
  const second = await adapter.execute(ctx(first.sessionParams));
  fake.setStatus(receipt.orcaDispatchId, "finished");
  const third = await adapter.execute(ctx(second.sessionParams));
  assert.equal(third.exitCode, 0);

  // Restart the bridge; the fake Orca runtime outlives it (shared instance).
  const liveRunner = fake;
  await server.close();
  server = await BridgeServer.create({
    dataDir,
    token: TOKEN,
    executable: "fake-orca-ide",
    backend: { run: asRunner(liveRunner), listSessions: () => liveRunner.listSessions() },
    port: 0,
  });
  baseUrl = await server.listen();
  fake = liveRunner;

  const after = await bridgeGetAttempt(first.sessionParams.attemptId);
  assert.equal(after.state, "finished");
  assert.equal(after.orcaDispatchId, receipt.orcaDispatchId);

  // A retried first wake (same task/run/lease) replays the same attempt.
  const replay = await makeAdapter().execute(ctx(null));
  assert.equal(replay.sessionParams.attemptId, first.sessionParams.attemptId);
  assert.equal(fake.dispatchCount, 1);
});

test("unknown session cursor forces a fresh session instead of guessing", async () => {
  const adapter = makeAdapter();
  const out = await adapter.execute(ctx({ stale: true }));
  assert.equal(out.clearSession, true);
});

test("task binding guard refuses a cursor replayed against another task", async () => {
  const adapter = makeAdapter();
  const first = await adapter.execute(ctx(null));
  const other = ctx(first.sessionParams);
  other.context = { ...other.context, taskId: "paperclip-task-8" };
  const out = await adapter.execute(other);
  assert.equal(out.clearSession, true);
  assert.equal(fake.dispatchCount, 1);
});
