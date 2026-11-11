/**
 * FF-031 integration tests: bridge HTTP server round trip (fake backend).
 *
 * Deterministic, no live Orca. The canonical SQLite ledger is file-backed
 * here (real WAL durability, not `:memory:`), so restart tests prove crash
 * durability rather than simulating it. Covers the FF-031 exit criteria:
 *
 * - Paperclip-shaped task -> POST /v1/attempts -> fake Orca dispatch ->
 *   event receipt -> GET status (dispatching -> running -> finished).
 * - Restart preserves idempotency keys, mappings and fencing; the same
 *   key never launches a second worker (dispatchCount stays 1).
 * - Launcher fate unknown (502) replays without relaunching; the retry
 *   reconciles instead of duplicating.
 * - Runtime loss surfaces as `unknown`, never a silent relaunch; ambiguous
 *   history blocks new LIVE dispatch (429) while the fake backend stays
 *   exact for tests.
 * - Auth, capability gate, cancel policy, messageability and SSE resume.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeServer } from "./server.ts";
import { FakeOrca, asRunner } from "./runtime/fake-orca.ts";
import type { CommandRunner } from "./runtime/dispatch.ts";
import type { BackendAuthPort } from "../../../packages/messaging/src/mcp.ts";

const TOKEN = "test-bridge-token-ff031";
const BASE_BODY = {
  projectId: "proj-ff031",
  paperclipTaskId: "task-1",
  paperclipRunId: "r1",
  workerKind: "muse",
  taskTitle: "probe task",
  instruction: "do the thing",
  contextManifestId: "ctx-1",
  lease: { fencingEpoch: 1, leaseToken: "task-1:r1:1" },
};

let dataDir: string;
let server: BridgeServer | null = null;
let baseUrl = "";
let fake: FakeOrca;

function headers(key?: string): Record<string, string> {
  const h: Record<string, string> = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  };
  if (key) h["idempotency-key"] = key;
  return h;
}

/**
 * Test sender auth: attests the coordinator for the test project, exactly
 * like a backend would after verifying the service credential. Production
 * wires the real BackendAuthPort; the server default denies everything.
 */
function testMessageAuth(): BackendAuthPort {
  return {
    verify: () => ({
      actor: { type: "agent", id: "coordinator", role: "coordinator", projects: ["proj-ff031"] },
      via: "service-token",
    }),
  };
}

function denyMessageAuth(): BackendAuthPort {
  return {
    verify: (): never => {
      throw new Error("no backend auth configured; credential rejected");
    },
  };
}

const TEST_PROVIDERS = [
  { name: "muse", status: "verified" as const },
  { name: "devin", status: "unknown" as const },
];

async function startServer(opts: {
  runner?: FakeOrca | CommandRunner;
  dir?: string;
  noTestIngest?: boolean;
  /** Trust bindings under test. Empty array = unconfigured (fail closed). */
  trustedProjects?: string[];
  /** Omit (with failClosedProviders) to exercise the server fail-closed default. */
  providers?: typeof TEST_PROVIDERS;
  failClosedProviders?: boolean;
  messageAuth?: BackendAuthPort;
  denyMessages?: boolean;
} = {}): Promise<void> {
  if (opts.noTestIngest) delete process.env.FORGEFLEET_ALLOW_TEST_INGEST;
  else process.env.FORGEFLEET_ALLOW_TEST_INGEST = "1";
  const extra = {
    trustedProjects: opts.trustedProjects ?? ["proj-ff031"],
    ...(opts.failClosedProviders ? {} : { providers: opts.providers ?? TEST_PROVIDERS }),
    messageAuth: opts.denyMessages ? denyMessageAuth() : (opts.messageAuth ?? testMessageAuth()),
  };
  // Keep the FakeOrca instance itself as the backend so the server sees the
  // full runtime inventory (reconcile/adopt, sessions); bare functions model
  // backends without inventory (ambiguity gate).
  if (!opts.runner || opts.runner instanceof FakeOrca) {
    fake = opts.runner ?? new FakeOrca();
    server = await BridgeServer.create({
      dataDir: opts.dir ?? dataDir,
      token: TOKEN,
      executable: "fake-orca-ide",
      backend: { run: asRunner(fake), listSessions: () => fake.listSessions() },
      port: 0,
      ...extra,
    });
  } else {
    fake = new FakeOrca();
    server = await BridgeServer.create({
      dataDir: opts.dir ?? dataDir,
      token: TOKEN,
      executable: "fake-orca-ide",
      run: opts.runner,
      port: 0,
      ...extra,
    });
  }
  baseUrl = await server.listen();
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "ff031-bridge-"));
});

afterEach(async () => {
  delete process.env.FORGEFLEET_ALLOW_TEST_INGEST;
  if (server) {
    await server.close();
    server = null;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

async function createAttempt(key: string, body: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${baseUrl}/v1/attempts`, {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify({ ...BASE_BODY, ...body }),
  });
}

async function getAttempt(attemptId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/v1/attempts/${attemptId}`, { headers: headers() });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("health is unauthenticated and pins the contract version", async () => {
  await startServer();
  const res = await fetch(`${baseUrl}/v1/health/live`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; contractVersion: string };
  assert.equal(body.ok, true);
  assert.equal(body.contractVersion, "0.1.0");
});

test("ledger and extras databases are file-backed with WAL", async () => {
  await startServer();
  assert.ok(existsSync(join(dataDir, "attempts.db")));
  assert.ok(existsSync(join(dataDir, "bridge-extras.db")));
});

test("protected routes require the service token", async () => {
  await startServer();
  const res = await fetch(`${baseUrl}/v1/runtime/capabilities`);
  assert.equal(res.status, 401);
  const authed = await fetch(`${baseUrl}/v1/runtime/capabilities`, { headers: headers() });
  assert.equal(authed.status, 200);
  const caps = (await authed.json()) as {
    reachable: boolean;
    providers: { name: string; status: string }[];
  };
  assert.equal(caps.reachable, true);
  assert.equal(caps.providers.find((p) => p.name === "muse")?.status, "verified");
  assert.equal(caps.providers.find((p) => p.name === "devin")?.status, "unknown");
});

test("unsupported workerKind fails closed without dispatch", async () => {
  await startServer();
  const res = await createAttempt("key-cap-1", { workerKind: "devin" });
  assert.equal(res.status, 422);
  assert.equal(fake.dispatchCount, 0);
});

test("no provider is verified by default: muse dispatch refuses without operator verification", async () => {
  await startServer({ failClosedProviders: true });
  const caps = (await (
    await fetch(`${baseUrl}/v1/runtime/capabilities`, { headers: headers() })
  ).json()) as { providers: { name: string; status: string }[] };
  assert.equal(caps.providers.find((p) => p.name === "muse")?.status, "unknown");
  assert.equal(caps.providers.find((p) => p.name === "devin")?.status, "unknown");
  const res = await createAttempt("key-cap-default-1");
  assert.equal(res.status, 422);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "capability_unavailable");
  assert.equal(fake.dispatchCount, 0);
});

test("dispatch without any trusted project binding is refused fail-closed", async () => {
  await startServer({ trustedProjects: [] });
  const res = await createAttempt("key-bind-1");
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "project_not_bound");
  assert.equal(fake.dispatchCount, 0);
});

test("dispatch for a forged projectId outside the trusted bindings is refused", async () => {
  await startServer();
  const res = await createAttempt("key-bind-2", { projectId: "proj-evil" });
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "project_not_bound");
  assert.equal(fake.dispatchCount, 0);
  // The bound project still dispatches on the same server.
  const ok = await createAttempt("key-bind-3");
  assert.equal(ok.status, 202);
  assert.equal(fake.dispatchCount, 1);
});

test("full round trip: dispatching -> running -> finished via event receipts", async () => {
  await startServer();
  const created = await createAttempt("key-rt-1");
  assert.equal(created.status, 202);
  const receipt = (await created.json()) as {
    attemptId: string;
    state: string;
    orcaDispatchId: string;
  };
  assert.equal(receipt.state, "dispatching");
  assert.ok(receipt.orcaDispatchId);
  assert.equal(fake.dispatchCount, 1);

  fake.setStatus(receipt.orcaDispatchId, "running");
  const running = await getAttempt(receipt.attemptId);
  assert.equal(running.body.state, "running");

  const ingest = await fetch(`${baseUrl}/v1/test/events/ingest`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      attemptId: receipt.attemptId,
      eventType: "attempt.question",
      source: "fake-orca",
      sourceEventId: "evt-q-1",
      fencingEpoch: 1,
      payload: { text: "need input" },
    }),
  });
  assert.equal(ingest.status, 202);

  fake.setStatus(receipt.orcaDispatchId, "finished");
  const done = await getAttempt(receipt.attemptId);
  assert.equal(done.body.state, "finished");
});

test("same key replays without a second dispatch; same key plus new payload conflicts", async () => {
  await startServer();
  const first = (await (await createAttempt("key-idem-1")).json()) as { attemptId: string };
  const replay = await createAttempt("key-idem-1");
  assert.equal(replay.status, 202);
  const replayBody = (await replay.json()) as { attemptId: string };
  assert.equal(replayBody.attemptId, first.attemptId);
  assert.equal(fake.dispatchCount, 1);

  const conflict = await createAttempt("key-idem-1", { instruction: "different" });
  assert.equal(conflict.status, 409);
  assert.equal(fake.dispatchCount, 1);
});

test("active lease blocks a second attempt for the same task", async () => {
  await startServer();
  await createAttempt("key-lease-1");
  const second = await createAttempt("key-lease-2", { paperclipRunId: "r2" });
  assert.equal(second.status, 409);
  assert.equal(fake.dispatchCount, 1);
});

test("launcher fate unknown (502) replays on retry without relaunching", async () => {
  await startServer();
  fake.failNextStart = true;
  const failed = await createAttempt("key-502-1");
  assert.equal(failed.status, 502);
  const failedBody = (await failed.json()) as { error: string };
  assert.equal(failedBody.error, "dispatch_unknown");
  assert.equal(fake.dispatchCount, 0);

  // Same-key retry: the durable accept prefix replays; with a complete
  // inventory proving absence, exactly one launch happens in total.
  const retry = await createAttempt("key-502-1");
  assert.equal(retry.status, 202);
  const retryBody = (await retry.json()) as { attemptId: string; state: string; orcaDispatchId: string };
  assert.ok(retryBody.orcaDispatchId);
  assert.equal(fake.dispatchCount, 1);

  // And a third identical retry replays the recorded dispatch.
  const third = await createAttempt("key-502-1");
  const thirdBody = (await third.json()) as { attemptId: string };
  assert.equal(thirdBody.attemptId, retryBody.attemptId);
  assert.equal(fake.dispatchCount, 1);
});

test("restart preserves state and never duplicates dispatch", async () => {
  await startServer();
  const created = (await (await createAttempt("key-restart-1")).json()) as {
    attemptId: string;
    orcaDispatchId: string;
  };
  fake.setStatus(created.orcaDispatchId, "running");
  await getAttempt(created.attemptId);
  assert.equal(fake.dispatchCount, 1);

  // Restart the bridge; the fake Orca runtime outlives it (shared instance).
  const liveRunner = fake;
  await server!.close();
  server = null;
  await startServer({ runner: liveRunner, dir: dataDir });

  const after = await getAttempt(created.attemptId);
  assert.equal(after.body.state, "running");
  assert.equal(after.body.orcaDispatchId, created.orcaDispatchId);

  const replay = await createAttempt("key-restart-1");
  assert.equal(replay.status, 202);
  assert.equal(fake.dispatchCount, 1);
});

test("runtime loss across restart surfaces as unknown with no relaunch", async () => {
  await startServer();
  const created = (await (await createAttempt("key-loss-1")).json()) as {
    attemptId: string;
    orcaDispatchId: string;
  };
  assert.equal(fake.dispatchCount, 1);
  await server!.close();
  server = null;

  // Fresh runtime: the old dispatch is gone and unprovable.
  await startServer({ runner: new FakeOrca(), dir: dataDir });
  const after = await getAttempt(created.attemptId);
  assert.equal(after.body.state, "unknown");
  assert.equal(fake.dispatchCount, 0);
});

test("ambiguous history blocks new live dispatch (429) on backends without inventory", async () => {
  await startServer();
  await createAttempt("key-amb-1");
  await server!.close();
  server = null;

  const deadRunner: CommandRunner = async (): Promise<never> => {
    throw new Error("runtime down");
  };
  await startServer({ runner: deadRunner, dir: dataDir });
  const blocked = await createAttempt("key-amb-2", { paperclipTaskId: "task-2" });
  assert.equal(blocked.status, 429);
});

test("cancel requires reason and approvedBy, then confirms via the runtime", async () => {
  await startServer();
  const created = (await (await createAttempt("key-cancel-1")).json()) as { attemptId: string };
  const missing = await fetch(`${baseUrl}/v1/attempts/${created.attemptId}/cancel`, {
    method: "POST",
    headers: headers("key-cancel-op-1"),
    body: JSON.stringify({ reason: "no longer needed" }),
  });
  assert.equal(missing.status, 422);

  const cancelled = await fetch(`${baseUrl}/v1/attempts/${created.attemptId}/cancel`, {
    method: "POST",
    headers: headers("key-cancel-op-1"),
    body: JSON.stringify({ reason: "no longer needed", approvedBy: "owner:abc" }),
  });
  assert.equal(cancelled.status, 202);
  const status = await getAttempt(created.attemptId);
  assert.equal(status.body.state, "cancelled");

  const replay = await fetch(`${baseUrl}/v1/attempts/${created.attemptId}/cancel`, {
    method: "POST",
    headers: headers("key-cancel-op-1"),
    body: JSON.stringify({ reason: "no longer needed", approvedBy: "owner:abc" }),
  });
  assert.equal(replay.status, 202);
});

test("messages queue while running and replay idempotently; terminal attempts refuse", async () => {
  await startServer();
  const created = (await (await createAttempt("key-msg-1")).json()) as {
    attemptId: string;
    orcaDispatchId: string;
  };
  fake.setStatus(created.orcaDispatchId, "running");
  await getAttempt(created.attemptId);

  const post = (k: string): Promise<Response> =>
    fetch(`${baseUrl}/v1/attempts/${created.attemptId}/messages`, {
      method: "POST",
      headers: headers(k),
      body: JSON.stringify({
        projectId: "proj-ff031",
        threadId: "thread-1",
        actorId: "coordinator",
        body: "proceed",
      }),
    });
  const first = (await (await post("key-msg-op-1")).json()) as { messageId: string; state: string };
  assert.equal(first.state, "queued");
  const replay = (await (await post("key-msg-op-1")).json()) as { messageId: string };
  assert.equal(replay.messageId, first.messageId);

  fake.setStatus(created.orcaDispatchId, "finished");
  await getAttempt(created.attemptId);
  const refused = await post("key-msg-op-2");
  assert.equal(refused.status, 409);
});

test("messages with a forged projectId are refused and never queued", async () => {
  await startServer();
  const created = (await (await createAttempt("key-msgf-1")).json()) as {
    attemptId: string;
    orcaDispatchId: string;
  };
  fake.setStatus(created.orcaDispatchId, "running");
  await getAttempt(created.attemptId);

  const forged = await fetch(`${baseUrl}/v1/attempts/${created.attemptId}/messages`, {
    method: "POST",
    headers: headers("key-msgf-op-1"),
    body: JSON.stringify({
      projectId: "proj-evil",
      threadId: "thread-1",
      actorId: "coordinator",
      body: "proceed",
    }),
  });
  assert.equal(forged.status, 403);
  assert.equal(((await forged.json()) as { error: string }).error, "forged_project");
});

test("messages with a forged actorId are refused; the verified sender is recorded", async () => {
  await startServer();
  const created = (await (await createAttempt("key-msga-1")).json()) as {
    attemptId: string;
    orcaDispatchId: string;
  };
  fake.setStatus(created.orcaDispatchId, "running");
  await getAttempt(created.attemptId);

  const forged = await fetch(`${baseUrl}/v1/attempts/${created.attemptId}/messages`, {
    method: "POST",
    headers: headers("key-msga-op-1"),
    body: JSON.stringify({
      projectId: "proj-ff031",
      threadId: "thread-1",
      actorId: "intruder",
      body: "proceed",
    }),
  });
  assert.equal(forged.status, 403);
  assert.equal(((await forged.json()) as { error: string }).error, "forged_actor");

  // The verified sender is accepted under its own id.
  const ok = await fetch(`${baseUrl}/v1/attempts/${created.attemptId}/messages`, {
    method: "POST",
    headers: headers("key-msga-op-2"),
    body: JSON.stringify({
      projectId: "proj-ff031",
      threadId: "thread-1",
      actorId: "coordinator",
      body: "proceed",
    }),
  });
  assert.equal(ok.status, 202);
  assert.equal(((await ok.json()) as { state: string }).state, "queued");
});

test("messages are refused when no sender auth is configured (fail closed)", async () => {
  await startServer({ denyMessages: true });
  const created = (await (await createAttempt("key-msgd-1")).json()) as {
    attemptId: string;
    orcaDispatchId: string;
  };
  fake.setStatus(created.orcaDispatchId, "running");
  await getAttempt(created.attemptId);

  const refused = await fetch(`${baseUrl}/v1/attempts/${created.attemptId}/messages`, {
    method: "POST",
    headers: headers("key-msgd-op-1"),
    body: JSON.stringify({
      projectId: "proj-ff031",
      threadId: "thread-1",
      actorId: "coordinator",
      body: "proceed",
    }),
  });
  assert.equal(refused.status, 403);
});

test("a message idempotency key is bound to its attempt; cross-attempt replay conflicts", async () => {
  await startServer();
  const first = (await (await createAttempt("key-msgk-1")).json()) as {
    attemptId: string;
    orcaDispatchId: string;
  };
  fake.setStatus(first.orcaDispatchId, "running");
  await getAttempt(first.attemptId);

  const post = (attemptId: string, k: string): Promise<Response> =>
    fetch(`${baseUrl}/v1/attempts/${attemptId}/messages`, {
      method: "POST",
      headers: headers(k),
      body: JSON.stringify({
        projectId: "proj-ff031",
        threadId: "thread-1",
        actorId: "coordinator",
        body: "proceed",
      }),
    });
  const queued = await post(first.attemptId, "key-msgk-op-1");
  assert.equal(queued.status, 202);

  const second = (await (
    await createAttempt("key-msgk-2", { paperclipTaskId: "task-2" })
  ).json()) as { attemptId: string; orcaDispatchId: string };
  fake.setStatus(second.orcaDispatchId, "running");
  await getAttempt(second.attemptId);

  const conflict = await post(second.attemptId, "key-msgk-op-1");
  assert.equal(conflict.status, 409);
  assert.equal(((await conflict.json()) as { error: string }).error, "idempotency_conflict");
});

test("sessions inventory reports managed attempts and unknown strangers", async () => {
  await startServer();
  const created = (await (await createAttempt("key-sess-1")).json()) as {
    attemptId: string;
    orcaDispatchId: string;
  };
  // A runtime session the bridge never created (no adoption, stays unknown).
  await fake.run("fake-orca-ide", ["orchestration", "worker-start", "--agent", "muse"], {});

  const res = await fetch(`${baseUrl}/v1/runtime/sessions`, { headers: headers() });
  assert.equal(res.status, 200);
  const { sessions } = (await res.json()) as {
    sessions: { externalId: string; managed: boolean; state: string }[];
  };
  const managed = sessions.find((s) => s.externalId === created.orcaDispatchId);
  assert.ok(managed);
  assert.equal(managed.managed, true);
  const stranger = sessions.find((s) => s.externalId !== created.orcaDispatchId);
  assert.ok(stranger);
  assert.equal(stranger!.managed, false);
  assert.equal(stranger!.state, "unknown");
});

test("events stream replays since Last-Event-ID and dedupes receipts", async () => {
  await startServer();
  const created = (await (await createAttempt("key-evt-1")).json()) as { attemptId: string };
  const first = await fetch(`${baseUrl}/v1/events`, { headers: headers() });
  assert.equal(first.status, 200);
  assert.ok((first.headers.get("content-type") ?? "").includes("text/event-stream"));
  const text = await first.text();
  assert.ok(text.includes("attempt.accepted"));

  const ingestBody = {
    attemptId: created.attemptId,
    eventType: "attempt.heartbeat",
    source: "fake-orca",
    sourceEventId: "evt-hb-1",
    fencingEpoch: 1,
    payload: {},
  };
  const once = await fetch(`${baseUrl}/v1/test/events/ingest`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(ingestBody),
  });
  assert.equal(once.status, 202);
  const twice = await fetch(`${baseUrl}/v1/test/events/ingest`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(ingestBody),
  });
  const twiceBody = (await twice.json()) as { deduplicated: boolean };
  assert.equal(twiceBody.deduplicated, true);

  const lastId = server!.lastEventId!;
  const tail = await fetch(`${baseUrl}/v1/events`, {
    headers: { ...headers(), "last-event-id": lastId },
  });
  assert.equal((await tail.text()).trim(), ": no-events");
});

test("test ingest is forbidden unless explicitly enabled", async () => {
  await startServer({ noTestIngest: true });
  const res = await fetch(`${baseUrl}/v1/test/events/ingest`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ attemptId: "x", eventType: "attempt.heartbeat", fencingEpoch: 1 }),
  });
  assert.equal(res.status, 403);
});
