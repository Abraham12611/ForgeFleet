import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProviderRegistry, createDefaultRegistry } from "./registry.ts";

describe("ProviderRegistry", () => {
  it("rejects unknown provider names instead of guessing", () => {
    const registry = createDefaultRegistry();
    const route = registry.routeDispatch("codex-evil");
    assert.equal(route.route, "reject");
    assert.equal(route.httpStatus, 422);
    assert.match(route.reason, /unknown provider/);
  });

  it("routes a verified supervised provider to supervised launch", () => {
    const registry = new ProviderRegistry([
      {
        name: "muse",
        status: "verified",
        supervisedSupported: true,
        terminalFallbackAllowed: true,
        notes: "live smoke passed",
      },
    ]);
    const route = registry.routeDispatch("muse");
    assert.equal(route.route, "supervised");
    assert.equal(route.httpStatus, 202);
  });

  it("never routes unsupported Devin to supervised; uses terminal fallback", () => {
    const registry = new ProviderRegistry([
      {
        name: "devin",
        status: "unsupported",
        supervisedSupported: false,
        terminalFallbackAllowed: true,
        notes: "no supervised verbs; terminal fallback only",
      },
    ]);
    const route = registry.routeDispatch("devin");
    assert.equal(route.route, "terminal-fallback");
    assert.equal(route.httpStatus, 202);
    assert.match(route.reason, /fallback only/);
  });

  it("rejects unsupported providers when fallback is disabled", () => {
    const registry = new ProviderRegistry([
      {
        name: "devin",
        status: "unsupported",
        supervisedSupported: false,
        terminalFallbackAllowed: false,
        notes: "unsupported; fallback disabled by policy",
      },
    ]);
    const route = registry.routeDispatch("DEVIN");
    assert.equal(route.route, "reject");
    assert.equal(route.httpStatus, 422);
  });

  it("rejects unknown and unavailable providers on every dispatch", () => {
    const registry = createDefaultRegistry();
    assert.equal(registry.routeDispatch("devin").route, "reject");
    assert.equal(registry.routeDispatch("devin").httpStatus, 422);
    registry.setStatus("devin", "unavailable", "binary unreachable");
    const route = registry.routeDispatch("devin");
    assert.equal(route.route, "reject");
    assert.equal(route.httpStatus, 422);
  });

  it("looks up names case-insensitively and rejects duplicates", () => {
    const registry = createDefaultRegistry();
    assert.ok(registry.get("Devin"));
    assert.throws(() =>
      registry.register({
        name: "DEVIN",
        status: "unknown",
        supervisedSupported: false,
        terminalFallbackAllowed: false,
        notes: "duplicate",
      }),
    );
  });

  it("clears supervised and fallback flags when leaving verified/unsupported", () => {
    const registry = new ProviderRegistry([
      {
        name: "devin",
        status: "verified",
        supervisedSupported: true,
        terminalFallbackAllowed: true,
        notes: "smoke passed",
      },
    ]);
    registry.setStatus("devin", "unknown", "evidence expired");
    const entry = registry.get("devin");
    assert.equal(entry?.supervisedSupported, false);
    assert.equal(entry?.terminalFallbackAllowed, false);
  });

  it("emits the OpenAPI-compatible providers payload", () => {
    const providers = createDefaultRegistry().toRuntimeProviders();
    const names = providers.map((p) => p.name).sort();
    assert.deepEqual(names, ["devin", "muse"]);
    for (const p of providers) {
      assert.ok(["verified", "unsupported", "unknown", "unavailable"].includes(p.status));
      assert.ok(p.notes.length > 0);
    }
  });
});
