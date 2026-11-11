import { describe, expect, it } from "vitest";
import { apiUrl, resolveApiBase } from "./api";

describe("resolveApiBase", () => {
  it("defaults to same-origin /api when unset", () => {
    expect(resolveApiBase(undefined)).toBe("/api");
    expect(resolveApiBase("   ")).toBe("/api");
  });

  it("accepts a public https origin", () => {
    // Fixture hostname for shape validation only — not a real ingress.
    expect(resolveApiBase("https://api.forgefleet.dev")).toBe(
      "https://api.forgefleet.dev/api",
    );
    expect(resolveApiBase("https://api.forgefleet.dev/")).toBe(
      "https://api.forgefleet.dev/api",
    );
  });

  it("rejects relative and non-http values", () => {
    expect(() => resolveApiBase("/api")).toThrow(/absolute http/);
    expect(() => resolveApiBase("api.example.com")).toThrow(/absolute http/);
  });

  it("rejects loopback and tailnet hosts a Vercel browser cannot reach", () => {
    for (const bad of [
      "http://localhost:3100",
      "http://127.0.0.1:3100",
      "https://vultr-host.ts.net",
    ]) {
      expect(() => resolveApiBase(bad)).toThrow(/public HTTPS origin/);
    }
  });

  it("rejects plain HTTP for deployed/cross-origin use", () => {
    for (const bad of ["http://api.example.com", "http://8.8.8.8"]) {
      expect(() => resolveApiBase(bad)).toThrow(/public HTTPS origin/);
    }
  });

  it("rejects IP literals, userinfo and placeholder domains", () => {
    for (const bad of [
      "https://8.8.8.8",
      "https://[::1]",
      "https://user:pass@api.example.com",
      "https://api.forgefleet.example",
      "ftp://api.example.com/api",
    ]) {
      expect(() => resolveApiBase(bad)).toThrow(/public HTTPS|credentials/);
    }
  });

  it("allows plain-HTTP loopback only behind the local-dev flag", () => {
    expect(
      resolveApiBase("http://localhost:3100", {
        allowInsecureLocalhost: true,
      }),
    ).toBe("http://localhost:3100/api");
    // The flag never opens non-loopback origins.
    expect(() =>
      resolveApiBase("http://api.example.com", {
        allowInsecureLocalhost: true,
      }),
    ).toThrow(/public HTTPS origin/);
    expect(() =>
      resolveApiBase("https://localhost", { allowInsecureLocalhost: true }),
    ).toThrow(/public HTTPS origin/);
  });
});

describe("apiUrl", () => {
  it("joins base and path", () => {
    expect(apiUrl("/health", "https://api.forgefleet.dev")).toBe(
      "https://api.forgefleet.dev/api/health",
    );
    expect(apiUrl("health", undefined)).toBe("/api/health");
  });
});
