// FF-015 (E12) — fixture determinism + labelling tests.
import { describe, expect, it } from "vitest";
import {
  CHECKED_AT,
  fixtureCommandCenter,
  findFixtureProject,
  FIXTURE_VARIANTS,
  inbox4,
  projectsFixture,
  workers20,
} from "./fixtures";

describe("dashboard fixtures", () => {
  it("are deterministic across calls", () => {
    expect(workers20()).toEqual(workers20());
    expect(inbox4()).toEqual(inbox4());
    expect(fixtureCommandCenter("healthy")).toEqual(
      fixtureCommandCenter("healthy"),
    );
    expect(workers20()).toHaveLength(20);
    expect(inbox4()).toHaveLength(4);
  });

  it("label every payload fixture, never live", () => {
    for (const w of workers20()) expect(w.dataSource).toBe("fixture");
    for (const i of inbox4()) expect(i.dataSource).toBe("fixture");
    for (const p of projectsFixture) expect(p.dataSource).toBe("fixture");
  });

  it("cover all preview variants including empty/offline/sleeping/denied", () => {
    expect([...FIXTURE_VARIANTS].sort()).toEqual(
      ["denied", "empty", "healthy", "offline", "sleeping", "throttled"].sort(),
    );
    expect(fixtureCommandCenter("empty").projects).toHaveLength(0);
    expect(fixtureCommandCenter("offline").offline).toBe(true);
    expect(fixtureCommandCenter("sleeping").sleepMode).toBe(true);
    expect(fixtureCommandCenter("denied").permissionDenied).toBe(true);
  });

  it("resolve the Atlas project with its reconciliation timestamp", () => {
    const atlas = findFixtureProject("proj-atlas");
    expect(atlas?.lastReconciledAt).toBe(CHECKED_AT);
    expect(findFixtureProject("nope")).toBeNull();
  });
});
