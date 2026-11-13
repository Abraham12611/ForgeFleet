/**
 * E13 — Tasks/fleet UX (FF-016): task detail view-model tests.
 *
 * Acceptance under test: Task → attempt → agent link traceable. Every
 * attempt in the detail view must resolve to an agent route (or be
 * explicitly flagged via `fullyTraceable === false`), ordered by monotonic
 * generation, with exactly one active lease holder.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Task, TaskAttempt } from "./types.ts";
import { buildTaskDetail, dedupeTimeline, resolveScreenState } from "./task-detail.ts";
import {
  FIXTURE_NOW,
  fixtureAgentRefs,
  fixtureAttempts,
  fixtureMessages,
  fixturePullRequests,
  fixtureTasks,
  fixtureTimeline,
  PROJECT_ID,
} from "./fixtures.ts";

function taskDetailInput(overrides: Record<string, unknown> = {}) {
  const tasks = fixtureTasks();
  return {
    task: tasks[0]!,
    attempts: fixtureAttempts().filter((a) => a.taskId === "task_auth_api"),
    agentsById: fixtureAgentRefs(),
    timeline: fixtureTimeline(),
    pullRequests: fixturePullRequests(),
    messages: [],
    now: FIXTURE_NOW,
    ...overrides,
  };
}

describe("task → attempt → agent trace", () => {
  it("links every attempt to its task route and agent route", () => {
    const vm = buildTaskDetail(taskDetailInput());
    assert.equal(vm.attempts.length, 2);
    for (const entry of vm.attempts) {
      assert.equal(
        entry.links.taskRoute,
        `/projects/${PROJECT_ID}/tasks/task_auth_api`,
      );
      assert.ok(entry.links.attemptRoute?.includes(`#attempt-${entry.attempt.attemptId}`));
      assert.ok(entry.links.agentRoute?.startsWith("/fleet/"));
    }
    assert.equal(vm.fullyTraceable, true);
  });

  it("flags attempts with no runtime owner instead of fabricating a link", () => {
    const attempts = fixtureAttempts().filter((a) => a.taskId === "task_auth_api");
    const unassigned: TaskAttempt = {
      ...attempts[0]!,
      attemptId: "attempt_auth_api_g0",
      generation: 0,
      state: "requested",
      agentId: null,
    };
    const vm = buildTaskDetail(taskDetailInput({ attempts: [unassigned] }));
    assert.equal(vm.attempts[0]!.links.agentRoute, null);
    assert.equal(vm.fullyTraceable, false);
  });

  it("orders attempts by monotonic generation, newest first", () => {
    const vm = buildTaskDetail(taskDetailInput());
    assert.deepEqual(
      vm.attempts.map((a) => a.attempt.generation),
      [2, 1],
    );
  });

  it("resolves exactly one active lease holder", () => {
    const vm = buildTaskDetail(taskDetailInput());
    assert.equal(vm.active?.attempt.attemptId, "attempt_auth_api_g2");
    assert.equal(vm.traceConflict, false);
  });

  it("banners a fencing violation when two attempts claim the lease", () => {
    const attempts = fixtureAttempts().filter((a) => a.taskId === "task_auth_api");
    const rogue: TaskAttempt = {
      ...attempts[0]!,
      attemptId: "attempt_auth_api_rogue",
      generation: 3,
      state: "running",
    };
    const vm = buildTaskDetail(
      taskDetailInput({ attempts: [...attempts, rogue] }),
    );
    assert.equal(vm.traceConflict, true);
  });
});

describe("verification vs runtime-ended", () => {
  it("finished runtime on an unverified task is not acceptance", () => {
    const tasks = fixtureTasks();
    const ui = tasks.find((t) => t.id === "task_auth_ui")!;
    const vm = buildTaskDetail({
      ...taskDetailInput(),
      task: ui,
      attempts: fixtureAttempts().filter((a) => a.taskId === "task_auth_ui"),
    });
    assert.equal(vm.attempts[0]!.liveness, "live");
    assert.ok(vm.acceptance.every((item) => item.satisfied === false));
  });

  it("marks acceptance satisfied only for verified/merged/closed tasks", () => {
    const verified: Task = { ...fixtureTasks()[0]!, status: "verified" };
    const vm = buildTaskDetail(taskDetailInput({ task: verified }));
    assert.ok(vm.acceptance.every((item) => item.satisfied === true));
  });
});

describe("timeline dedupe", () => {
  it("collapses duplicate (source, eventId) deliveries and sorts by time", () => {
    const deduped = dedupeTimeline(fixtureTimeline());
    assert.equal(deduped.length, 2);
    assert.deepEqual(
      deduped.map((e) => e.eventId),
      ["evt-001", "evt-002"],
    );
  });
});

describe("screen states", () => {
  const base = { now: FIXTURE_NOW, isEmpty: false };

  it("prioritises loading, then denial, then error", () => {
    assert.equal(
      resolveScreenState({ ...base, loading: true, denied: "no", error: "x" }).state,
      "loading",
    );
    assert.equal(
      resolveScreenState({ ...base, denied: "need role", error: "x" }).state,
      "permission-denied",
    );
    assert.equal(
      resolveScreenState({ ...base, error: "timeout, retry safe" }).state,
      "recoverable-error",
    );
  });

  it("renders offline with cached data and stale past the sync threshold", () => {
    assert.equal(resolveScreenState({ ...base, offline: true }).state, "offline");
    assert.equal(
      resolveScreenState({ ...base, lastSyncAt: FIXTURE_NOW - 60_000 }).state,
      "stale",
    );
    assert.equal(
      resolveScreenState({ ...base, lastSyncAt: FIXTURE_NOW - 1_000 }).state,
      "ready",
    );
  });

  it("renders empty for a task with no attempts yet", () => {
    const vm = buildTaskDetail(taskDetailInput({ attempts: [], timeline: [] }));
    assert.equal(vm.state, "empty");
    assert.equal(vm.active, null);
    assert.equal(vm.traceConflict, false);
  });

  it("passes PRs and messages through to the detail view", () => {
    const vm = buildTaskDetail(
      taskDetailInput({ messages: fixtureMessages() }),
    );
    assert.equal(vm.pullRequests[0]!.prNumber, 42);
    assert.equal(vm.messages[0]!.authorKind, "worker");
  });
});
