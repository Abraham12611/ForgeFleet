/**
 * FF-031 cross-process proof (fake backend, real OS processes).
 *
 * The in-process suite proves single-launch and recovery logic; these tests
 * prove the OS-level claims the coordinator demanded:
 *
 * 1. Two bridge processes sharing one SQLite ledger file, receiving the
 *    same Idempotency-Key concurrently, produce exactly ONE runtime launch
 *    (UNIQUE-key single-launch claim across processes).
 * 2. Kill -9 between accept-prefix commit and launch completion, then
 *    restart and retry the same key: no duplicate launch, exactly one
 *    eventual dispatch, attempt preserved.
 *
 * Both drive real HTTP against `src/main.ts` child processes. Slow by unit
 * standards (~1s each); that is the point — only separate processes prove
 * cross-process claims.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "test-xproc-token-ff031";
const MAIN = new URL("../src/main.ts", import.meta.url).pathname;

let root;
let dataDir;
/** @type {import("node:child_process").ChildProcess[]} */
const children = [];

function childEnv(extra) {
  return {
    ...process.env,
    FORGEFLEET_BRIDGE_TOKEN: TOKEN,
    FORGEFLEET_BRIDGE_DATA_DIR: dataDir,
    FORGEFLEET_BRIDGE_HOST: "127.0.0.1",
    FORGEFLEET_FAKE_ORCA: "1",
    FORGEFLEET_ALLOW_TEST_INGEST: "1",
    ...extra,
  };
}

function spawnServer(port, extra = {}) {
  const child = spawn("node", [MAIN], {
    env: { ...childEnv(extra), PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

async function waitHealthy(port, timeoutMs = 15_000) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/health/live`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() - start > timeoutMs) throw new Error(`server on ${port} never became healthy`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function waitFile(path, timeoutMs = 15_000) {
  const start = Date.now();
  for (;;) {
    if (existsSync(path)) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function kill9(child) {
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
}

function authed(port, key) {
  const h = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  };
  if (key) h["idempotency-key"] = key;
  return h;
}

const BODY = {
  projectId: "proj-xproc",
  paperclipTaskId: "task-x",
  paperclipRunId: "r1",
  workerKind: "muse",
  taskTitle: "cross-process probe",
  instruction: "do the thing",
  contextManifestId: "ctx-1",
  lease: { fencingEpoch: 1, leaseToken: "task-x:r1:1" },
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ff031-xproc-"));
  dataDir = join(root, "data");
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    kill9(child);
  }
  await new Promise((r) => setTimeout(r, 100));
  rmSync(root, { recursive: true, force: true });
});

test("concurrent same-key dispatch across two processes launches exactly once", async () => {
  const portA = 4531;
  const portB = 4532;
  const countFile = join(root, "launches.txt");
  writeFileSync(countFile, "");
  spawnServer(portA, { FORGEFLEET_TEST_COUNT_LAUNCHES: countFile });
  spawnServer(portB, { FORGEFLEET_TEST_COUNT_LAUNCHES: countFile });
  await waitHealthy(portA);
  await waitHealthy(portB);

  const post = (port) =>
    fetch(`http://127.0.0.1:${port}/v1/attempts`, {
      method: "POST",
      headers: authed(port, "key-xproc-concurrent"),
      body: JSON.stringify(BODY),
    });
  const [resA, resB] = await Promise.all([post(portA), post(portB)]);
  assert.equal(resA.status, 202);
  assert.equal(resB.status, 202);
  const a = await resA.json();
  const b = await resB.json();
  assert.equal(a.attemptId, b.attemptId);

  const launches = readFileSync(countFile, "utf-8").trim().split("\n").filter(Boolean);
  assert.equal(launches.length, 1);
});

test("kill -9 after accept, then restart and retry: one eventual dispatch, no duplicate", async () => {
  const portA = 4533;
  const portB = 4534;
  const countFile = join(root, "launches-kill.txt");
  writeFileSync(countFile, "");
  const blockDir = join(root, "block");
  mkdirSync(blockDir, { recursive: true });

  const doomed = spawnServer(portA, {
    FORGEFLEET_TEST_COUNT_LAUNCHES: countFile,
    FORGEFLEET_TEST_BLOCK_LAUNCH: blockDir,
  });
  await waitHealthy(portA);

  // Launch enters the launcher and blocks; kill mid-flight.
  const attempt = fetch(`http://127.0.0.1:${portA}/v1/attempts`, {
    method: "POST",
    headers: authed(portA, "key-xproc-kill"),
    body: JSON.stringify(BODY),
  });
  await waitFile(join(blockDir, "sentinel"));
  kill9(doomed);
  await assert.rejects(attempt, "killed request must not resolve");

  // Restart on the same data dir. The durable accept prefix replays;
  // the retry reconciles to exactly one dispatch in total.
  spawnServer(portB, { FORGEFLEET_TEST_COUNT_LAUNCHES: countFile });
  await waitHealthy(portB);
  const retry = await fetch(`http://127.0.0.1:${portB}/v1/attempts`, {
    method: "POST",
    headers: authed(portB, "key-xproc-kill"),
    body: JSON.stringify(BODY),
  });
  assert.equal(retry.status, 202);
  const retryBody = await retry.json();
  assert.ok(retryBody.attemptId);
  assert.ok(retryBody.orcaDispatchId);

  const launches = readFileSync(countFile, "utf-8").trim().split("\n").filter(Boolean);
  assert.equal(launches.length, 1);

  // Same key a third time replays the recorded dispatch — still one launch.
  const third = await fetch(`http://127.0.0.1:${portB}/v1/attempts`, {
    method: "POST",
    headers: authed(portB, "key-xproc-kill"),
    body: JSON.stringify(BODY),
  });
  const thirdBody = await third.json();
  assert.equal(thirdBody.attemptId, retryBody.attemptId);
  const launchesAfter = readFileSync(countFile, "utf-8").trim().split("\n").filter(Boolean);
  assert.equal(launchesAfter.length, 1);
});
