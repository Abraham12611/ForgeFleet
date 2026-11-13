/**
 * E13 — Tasks/fleet UX (FF-016): fleet list/detail + virtualization tests.
 *
 * Covers the `/fleet` center, `/fleet/:agentId` agent detail, trace links
 * in both directions (agent → task, attempt → task), cost honesty labels,
 * and the pure windowing helper behind virtualized rendering of 200-agent
 * rosters. Zero dependencies, stdlib only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { windowSlice } from "./types.ts";
import type { FleetAgent } from "./types.ts";
import {
  applyFleetFilter,
  buildAgentDetail,
  buildFleetList,
  costLabelFor,
} from "./fleet-detail.ts";
import {
  FIXTURE_NOW,
  fixtureAgents,
  fixtureAttempts,
  fixtureTasks,
  makeLargeFleet,
  PROJECT_ID,
} from "../tasks/fixtures.ts";

function fleetInput(overrides: Record<string, unknown> = {}) {
  const tasks = fixtureTasks();
  const attempts = fixtureAttempts();
  return {
    agents: fixtureAgents(),
    tasksById: new Map(tasks.map((t) => [t.id, t])),
    attemptsById: new Map(attempts.map((a) => [a.attemptId, a])),
    now: FIXTURE_NOW,
    ...overrides,
  };
}

describe("fleet list", () => {
  it("renders one row per agent with agent and task routes", () => {
    const vm = buildFleetList(fleetInput());
    assert.equal(vm.state, "ready");
    assert.equal(vm.total, 2);
    const busy = vm.rows.find((r) => r.agent.agentId === "agent_muse_01")!;
    assert.equal(busy.agentRoute, "/fleet/agent_muse_01");
    assert.equal(
      busy.currentTaskRoute,
      `/projects/${PROJECT_ID}/tasks/task_auth_ui`,
    );
    assert.equal(busy.currentTaskTitle, "Build login UI");
    assert.match(busy.freshnessText, /Last seen/);
    assert.equal(busy.isStale, false);
  });

  it("marks idle agents with no task route and zero active attempts", () => {
    const vm = buildFleetList(fleetInput());
    const idle = vm.rows.find((r) => r.agent.agentId === "agent_muse_02")!;
    assert.equal(idle.currentTaskRoute, null);
    assert.equal(idle.activeAttempts, 0);
  });

  it("filters by provider, state, query, and active-only", () => {
    const agents = makeLargeFleet(200);
    assert.equal(applyFleetFilter(agents, { provider: "devin" }).length, 40);
    assert.ok(
      applyFleetFilter(agents, { workerState: "busy" }).length > 0,
    );
    assert.equal(
      applyFleetFilter(agents, { query: "fleet worker 7" }).every((a) =>
        `${a.displayName} ${a.agentId}`.toLowerCase().includes("fleet worker 7"),
      ),
      true,
    );
    const active = applyFleetFilter(agents, { activeOnly: true });
    assert.ok(active.length > 0 && active.length < 200);
    assert.ok(active.every((a) => a.currentTaskId !== null));
  });

  it("renders empty, error, denial, and offline states", () => {
    assert.equal(buildFleetList(fleetInput({ agents: [] })).state, "empty");
    assert.equal(
      buildFleetList(fleetInput({ error: "timeout, retry safe" })).state,
      "recoverable-error",
    );
    assert.equal(
      buildFleetList(fleetInput({ denied: "fleet viewer role required" })).state,
      "permission-denied",
    );
    const offline = buildFleetList(fleetInput({ offline: true }));
    assert.equal(offline.state, "offline");
    assert.equal(offline.rows.length, 2);
  });
});

describe("virtualized windowing", () => {
  it("windows the visible slice with overscan on a 200-agent roster", () => {
    const slice = windowSlice({ total: 200, scrollOffset: 50, viewportSize: 20 });
    assert.deepEqual(slice, { start: 46, end: 74 });
    const fleet = makeLargeFleet(200);
    const visible = fleet.slice(slice.start, slice.end);
    assert.equal(visible.length, 28);
    assert.equal(visible[0]!.agentId, "agent_fleet_046");
  });

  it("clamps at the roster edges and handles empty fleets", () => {
    assert.deepEqual(
      windowSlice({ total: 200, scrollOffset: 0, viewportSize: 20 }),
      { start: 0, end: 24 },
    );
    assert.deepEqual(
      windowSlice({ total: 200, scrollOffset: 195, viewportSize: 20 }),
      { start: 191, end: 200 },
    );
    assert.deepEqual(
      windowSlice({ total: 0, scrollOffset: 0, viewportSize: 20 }),
      { start: 0, end: 0 },
    );
  });

  it("is deterministic for sign-off screenshots", () => {
    assert.deepEqual(makeLargeFleet(200)[7], makeLargeFleet(200)[7]);
    assert.equal(makeLargeFleet(200).length, 200);
  });
});

describe("agent detail", () => {
  function detailInput(overrides: Record<string, unknown> = {}) {
    const tasks = fixtureTasks();
    return {
      agent: fixtureAgents()[0]!,
      attempts: fixtureAttempts().filter((a) => a.agentId === "agent_muse_01"),
      tasksById: new Map(tasks.map((t) => [t.id, t])),
      now: FIXTURE_NOW,
      ...overrides,
    };
  }

  it("shows identity, current task, attempt back-links, and terminal ref", () => {
    const vm = buildAgentDetail(detailInput());
    assert.equal(vm.state, "ready");
    assert.equal(vm.agentRoute, "/fleet/agent_muse_01");
    assert.deepEqual(vm.currentTask, {
      title: "Build login UI",
      route: `/projects/${PROJECT_ID}/tasks/task_auth_ui`,
    });
    assert.equal(vm.attempts.length, 2);
    for (const entry of vm.attempts) {
      assert.ok(entry.taskRoute?.includes("/tasks/"));
      assert.ok(entry.taskTitle !== null);
    }
    assert.equal(vm.terminalRef, "orca_terminal_aaa");
    assert.equal(vm.isStale, false);
  });

  it("explains idle agents instead of showing a dead task card", () => {
    const vm = buildAgentDetail(
      detailInput({ agent: fixtureAgents()[1], attempts: [] }),
    );
    assert.equal(vm.currentTask, null);
    assert.equal(vm.idleReason, "Idle — no task assigned");
  });

  it("labels cost honestly: measured figures vs estimates vs unmeasured", () => {
    assert.equal(costLabelFor(fixtureAgents()[0]!.cost), "$0.42");
    assert.match(
      costLabelFor(fixtureAgents()[1]!.cost),
      /estimated/i,
    );
    const unmeasured: FleetAgent = { ...fixtureAgents()[0]!, cost: null };
    assert.equal(costLabelFor(unmeasured.cost), "Cost not measured");
    assert.equal(costLabelFor(undefined), "Cost not measured");
    // Never zero-fills a missing figure.
    assert.notEqual(costLabelFor({ source: "measured" }), "$0.00");
  });

  it("marks stale telemetry on the detail banner", () => {
    const staleAgent: FleetAgent = {
      ...fixtureAgents()[0]!,
      lastObservedAt: new Date(FIXTURE_NOW - 120_000).toISOString(),
    };
    const vm = buildAgentDetail(detailInput({ agent: staleAgent }));
    assert.equal(vm.isStale, true);
    assert.match(vm.freshnessText, /Last seen 2m ago/);
  });
});
