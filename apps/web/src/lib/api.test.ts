import { describe, expect, it } from "vitest";
import { apiUrl, resolveApiBase } from "./api";

describe("resolveApiBase", () => {
  it("defaults to same-origin /api when unset", () => {
    expect(resolveApiBase(undefined)).toBe("/api");
    expect(resolveApiBase("   ")).toBe("/api");
  });

  it("accepts a public https origin", () => {
    expect(resolveApiBase("https://api.forgefleet.example")).toBe(
      "https://api.forgefleet.example/api",
    );
    expect(resolveApiBase("https://api.forgefleet.example/")).toBe(
      "https://api.forgefleet.example/api",
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
});

describe("apiUrl", () => {
  it("joins base and path", () => {
    expect(apiUrl("/health", "https://api.forgefleet.example")).toBe(
      "https://api.forgefleet.example/api/health",
    );
    expect(apiUrl("health", undefined)).toBe("/api/health");
  });
});
