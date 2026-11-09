import { test } from "node:test";
import assert from "node:assert/strict";
import { combineHealth, summarizeCapabilities, summarizeReadiness } from "../src/health.js";

const AT = "2026-11-09T00:00:00Z";

test("readiness with no checks is unknown, never healthy", () => {
  assert.equal(summarizeReadiness([], AT).status, "unknown");
});

test("readiness is the worst of its checks", () => {
  const r = summarizeReadiness(
    [
      { name: "db", status: "healthy", checkedAt: AT },
      { name: "queue", status: "degraded", checkedAt: AT },
    ],
    AT,
  );
  assert.equal(r.status, "degraded");
});

test("capabilities: unreachable runtime degrades; unavailable provider unhealthies", () => {
  assert.equal(
    summarizeCapabilities({ reachable: false, checkedAt: AT, cliVersion: null, commandPath: null, providers: [] }),
    "degraded",
  );
  assert.equal(
    summarizeCapabilities({
      reachable: true,
      checkedAt: AT,
      cliVersion: "1.2.3",
      commandPath: "/usr/bin/agent",
      providers: [{ name: "x", status: "unavailable" }],
    }),
    "unhealthy",
  );
});

test("combined healthy only when every leg is present and healthy", () => {
  const h = combineHealth({
    live: { alive: true, startedAt: AT, uptimeMs: 1, version: "0.1.0" },
    ready: summarizeReadiness([{ name: "db", status: "healthy", checkedAt: AT }], AT),
    capabilities: { reachable: true, checkedAt: AT, cliVersion: "1", commandPath: null, providers: [] },
  });
  assert.equal(h.status, "healthy");
  assert.deepEqual(h.unknownLegs, []);
});

test("missing or unknown leg renders overall unknown, not healthy", () => {
  const missing = combineHealth({
    live: { alive: true, startedAt: AT, uptimeMs: 1, version: "0.1.0" },
    ready: null,
    capabilities: { reachable: true, checkedAt: AT, cliVersion: "1", commandPath: null, providers: [] },
  });
  assert.equal(missing.status, "unknown");
  assert.ok(missing.unknownLegs.includes("ready"));

  const unknownChecks = combineHealth({
    live: { alive: true, startedAt: AT, uptimeMs: 1, version: "0.1.0" },
    ready: summarizeReadiness([], AT),
    capabilities: { reachable: true, checkedAt: AT, cliVersion: "1", commandPath: null, providers: [] },
  });
  assert.equal(unknownChecks.status, "unknown");
});

test("confirmed unhealthy wins over unknown legs", () => {
  const h = combineHealth({
    live: { alive: true, startedAt: AT, uptimeMs: 1, version: "0.1.0" },
    ready: null,
    capabilities: {
      reachable: true,
      checkedAt: AT,
      cliVersion: "1",
      commandPath: null,
      providers: [{ name: "x", status: "unavailable" }],
    },
  });
  assert.equal(h.status, "unhealthy");
  assert.ok(h.unknownLegs.includes("ready"));
});
