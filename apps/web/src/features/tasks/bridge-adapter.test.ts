/**
 * E13 — Tasks/fleet UX (FF-016): bridge adapter boundary tests.
 * Stdlib only (`node:test`); run with `node --test` from the repo root.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AdapterError,
  adaptAgent,
  adaptAttempt,
  adaptAttemptState,
  adaptFleetInput,
  adaptPaperclipTask,
  adaptTaskDetailInput,
  adaptTaskStatus,
  adaptTimelineEvent,
  adaptWorkerState,
  assignGenerations,
  type BridgeAttemptPayload,
} from "./bridge-adapter.ts";

function receipt(overrides: Partial<BridgeAttemptPayload> = {}): BridgeAttemptPayload {
  return {
    attemptId: "attempt_1",
    projectId: "project_1",
    state: "running",
    observedAt: "2026-11-08T12:00:00Z",
    ...overrides,
  };
}

describe("state adaptation", () => {
  it("passes known lifecycle states through", () => {
    assert.equal(adaptAttemptState("running"), "running");
    assert.equal(adaptTaskStatus("verifying"), "verifying");
  });

  it("maps unknown strings to unknown instead of guessing", () => {
    assert.equal(adaptAttemptState("hyperdrive"), "unknown");
    assert.equal(adaptTaskStatus("shipped-ish"), "unknown");
    assert.equal(adaptWorkerState("teleporting"), "disconnected");
  });

  it("maps runtime session states to worker states explicitly", () => {
    assert.equal(adaptWorkerState("running"), "busy");
    assert.equal(adaptWorkerState("waiting"), "assigned");
    assert.equal(adaptWorkerState("stopped"), "available");
    assert.equal(adaptWorkerState("failed"), "quarantined");
    assert.equal(adaptWorkerState("unknown"), "disconnected");
  });
});

describe("identity enforcement", () => {
  it("throws AdapterError on missing attempt/task/agent IDs", () => {
    assert.throws(
      () =>
        adaptAttempt({ ...receipt(), attemptId: "" }, {
          taskId: "t",
          generation: 1,
          fencingEpoch: 1,
          provider: "muse",
          workerKind: "muse",
        }),
      AdapterError,
    );
    assert.throws(
      () =>
        adaptPaperclipTask({ id: "", projectId: "p", title: "t", status: "ready" }),
      AdapterError,
    );
    assert.throws(() => adaptAgent({ externalId: "", state: "running", managed: true }), AdapterError);
    assert.throws(
      () => adaptTimelineEvent({ source: "", eventId: "e", eventType: "x", occurredAt: "t" }),
      AdapterError,
    );
  });

  it("preserves unknown event types for forward compatibility", () => {
    const entry = adaptTimelineEvent({
      source: "orca-bridge",
      eventId: "e9",
      eventType: "attempt.teleported",
      occurredAt: "2026-11-08T12:00:00Z",
    });
    assert.equal(entry.eventType, "attempt.teleported");
  });
});

describe("generation assignment", () => {
  it("numbers receipts monotonically per task by observation time", () => {
    const gen = assignGenerations([
      { ...receipt({ attemptId: "b", observedAt: "2026-11-08T12:02:00Z" }), taskId: "t" } as BridgeAttemptPayload & { taskId: string },
      { ...receipt({ attemptId: "a", observedAt: "2026-11-08T12:01:00Z" }), taskId: "t" } as BridgeAttemptPayload & { taskId: string },
    ]);
    assert.equal(gen.get("a")?.generation, 1);
    assert.equal(gen.get("b")?.generation, 2);
  });
});

describe("full input adaptation", () => {
  it("builds a traceable task detail input from frozen payloads", () => {
    const input = adaptTaskDetailInput({
      task: { id: "t1", projectId: "p1", title: "Do it", status: "running" },
      receipts: [receipt({ attemptId: "a1" })],
      taskIdByAttemptId: new Map([["a1", "t1"]]),
      agentByAttemptId: new Map([["a1", "agent_1"]]),
      agentsById: new Map([["agent_1", { displayName: "Worker 1" }]]),
    });
    assert.equal(input.task.id, "t1");
    assert.equal(input.attempts[0]!.agentId, "agent_1");
    assert.equal(input.attempts[0]!.generation, 1);
  });

  it("builds a fleet input linking sessions to attempts", () => {
    const input = adaptFleetInput({
      sessions: [
        {
          externalId: "agent_1",
          provider: "muse",
          state: "running",
          managed: true,
          taskId: "t1",
          lastObservedAt: "2026-11-08T12:00:00Z",
        },
      ],
      projectByTaskId: new Map([["t1", "p1"]]),
      tasks: [
        { id: "t1", projectId: "p1", title: "Do it", status: "running", acceptance: [], dependsOn: [] },
      ],
      attempts: [
        {
          attemptId: "a1",
          taskId: "t1",
          projectId: "p1",
          generation: 1,
          fencingEpoch: 1,
          state: "running",
          provider: "muse",
          workerKind: "muse",
          agentId: "agent_1",
        },
      ],
    });
    assert.equal(input.agents[0]!.workerState, "busy");
    assert.deepEqual(input.agents[0]!.attemptIds, ["a1"]);
    assert.equal(input.agents[0]!.currentProjectId, "p1");
  });
});
