// FF-015 (E12) — state-model tests. Run from apps/web with `npm test`.
import { describe, expect, it } from "vitest";
import {
  EMPTY_COPY,
  getCommandCenterSummary,
  getProjectOverview,
  navModelForWidth,
  resolveScreenState,
  resolveSource,
  SCREEN_STATES,
  SIGNOFF_WIDTHS,
  workerDisplayState,
} from "./state";
import { fixtureCommandCenter } from "./fixtures";

describe("resolveScreenState", () => {
  it("covers all seven required states", () => {
    const seen = new Set([
      resolveScreenState({ loading: true }).state,
      resolveScreenState({}).state,
      resolveScreenState({ empty: true }).state,
      resolveScreenState({ error: "boom" }).state,
      resolveScreenState({ permissionDenied: true }).state,
      resolveScreenState({ offline: true }).state,
      resolveScreenState({ stale: true }).state,
    ]);
    expect([...seen].sort()).toEqual([...SCREEN_STATES].sort());
  });

  it("uses the contracted copy strings", () => {
    expect(resolveScreenState({ empty: true }).copy).toBe(EMPTY_COPY);
    expect(resolveScreenState({ empty: true }).copy).toBe(
      "No active projects. Start with a goal and a repository.",
    );
    expect(resolveScreenState({ offline: true }).copy).toMatch(/read-only/);
    expect(resolveScreenState({ permissionDenied: true }).copy).toBe(
      "You do not have access to this project.",
    );
  });

  it("marks non-retryable errors for escalation, not retry", () => {
    const r = resolveScreenState({ error: "denied", retryable: false });
    expect(r.retryable).toBe(false);
    expect(r.escalation).toBe(true);
  });
});

describe("workerDisplayState", () => {
  it("never coerces unknown to working", () => {
    expect(workerDisplayState("unknown")).toBe("unknown");
    expect(workerDisplayState("mystery")).toBe("unknown");
    expect(workerDisplayState(undefined)).toBe("unknown");
    expect(workerDisplayState("running")).toBe("running");
  });
});

describe("getCommandCenterSummary", () => {
  it("aggregates the healthy fixture set", () => {
    const s = getCommandCenterSummary({
      ...fixtureCommandCenter("healthy"),
      dataSource: "fixture",
    });
    expect(s.projectCount).toBe(2);
    expect(s.verifiedCompleted).toBe(5);
    expect(s.readyTasks).toBe(8);
    expect(s.failingChecks).toBe(1);
    // 20 workers round-robin over 5 states: 4 unknown, 8 active.
    expect(s.unknownWorkers).toBe(4);
    expect(s.activeWorkers).toBe(8);
    expect(s.sleepMode).toBe(false);
  });

  it("uses the throttled provider notice verbatim", () => {
    const s = getCommandCenterSummary({
      ...fixtureCommandCenter("throttled"),
      dataSource: "fixture",
    });
    expect(s.providerNotice).toBe(
      "Workers are waiting for provider capacity. Independent tasks will resume automatically within limits.",
    );
  });

  it("refuses to render unbound shapes as live", () => {
    expect(() =>
      getCommandCenterSummary({
        ...fixtureCommandCenter("healthy"),
        dataSource: "live",
      }),
    ).toThrow(/not bound/);
    expect(() =>
      getProjectOverview({ dataSource: "live", project: null }),
    ).toThrow(/not bound/);
  });
});

describe("getProjectOverview", () => {
  it("returns empty copy without a project", () => {
    expect(
      getProjectOverview({ dataSource: "fixture", project: null }).state,
    ).toBe("empty");
  });
});

describe("navModelForWidth", () => {
  it("covers every sign-off width", () => {
    const models = new Map(SIGNOFF_WIDTHS.map((w) => [w, navModelForWidth(w)]));
    expect(models.get(360)).toEqual({
      layout: "compact",
      tabs: "bottom",
      columns: 1,
    });
    expect(models.get(412)).toEqual({
      layout: "compact",
      tabs: "bottom",
      columns: 1,
    });
    expect(models.get(768)).toEqual({
      layout: "standard",
      tabs: "none",
      columns: 2,
    });
    expect(models.get(1280)).toEqual({
      layout: "wide",
      tabs: "none",
      columns: 3,
    });
    expect(models.get(1440)).toEqual({
      layout: "wide",
      tabs: "none",
      columns: 3,
    });
  });
});

describe("resolveSource", () => {
  it("labels explicit preview as fixture", () => {
    const r = resolveSource({
      fixtureMode: true,
      online: true,
      healthOk: false,
      fetchFailed: true,
      hadPriorData: false,
    });
    expect(r.source).toBe("fixture");
  });

  it("requires a successful check for live", () => {
    expect(
      resolveSource({
        fixtureMode: false,
        online: true,
        healthOk: true,
        fetchFailed: false,
        hadPriorData: false,
      }).source,
    ).toBe("live");
  });

  it("resolves failure to unknown with error / stale / offline screens", () => {
    const fresh = resolveSource({
      fixtureMode: false,
      online: true,
      healthOk: false,
      fetchFailed: true,
      hadPriorData: false,
    });
    expect(fresh.source).toBe("unknown");
    expect(fresh.screen.state).toBe("recoverable-error");

    const stale = resolveSource({
      fixtureMode: false,
      online: true,
      healthOk: false,
      fetchFailed: true,
      hadPriorData: true,
    });
    expect(stale.source).toBe("unknown");
    expect(stale.screen.state).toBe("stale");

    const offline = resolveSource({
      fixtureMode: false,
      online: false,
      healthOk: false,
      fetchFailed: true,
      hadPriorData: false,
    });
    expect(offline.source).toBe("unknown");
    expect(offline.screen.state).toBe("offline");
  });

  it("stays in loading while the first probe is pending", () => {
    const r = resolveSource({
      fixtureMode: false,
      online: true,
      healthOk: false,
      fetchFailed: false,
      hadPriorData: false,
    });
    expect(r.source).toBe("unknown");
    expect(r.screen.state).toBe("loading");
  });
});
