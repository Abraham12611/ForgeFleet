import { describe, expect, it, vi } from "vitest";
import {
  buildLiveSocketUrl,
  connectLive,
  DISCONNECTED_POLL_INTERVAL_MS,
} from "./live";

const loc = { host: "app.forgefleet.example", protocol: "https:" } as Location;

describe("buildLiveSocketUrl", () => {
  it("upgrades a split-origin https base to wss", () => {
    expect(
      buildLiveSocketUrl("https://api.forgefleet.example/api", "/api/live", loc),
    ).toBe("wss://api.forgefleet.example/api/live");
  });

  it("derives wss from the browser location for same-origin bases", () => {
    expect(buildLiveSocketUrl("/api", "/api/live", loc)).toBe(
      "wss://app.forgefleet.example/api/live",
    );
  });

  it("uses ws for http locations", () => {
    expect(
      buildLiveSocketUrl(
        "/api",
        "/api/live",
        { host: "localhost:5173", protocol: "http:" } as Location,
      ),
    ).toBe("ws://localhost:5173/api/live");
  });
});

describe("connectLive", () => {
  it("falls back to polling when the socket constructor throws", () => {
    const poll = vi.fn().mockResolvedValue(undefined);
    const onStatus = vi.fn();
    const conn = connectLive("wss://nope.example/api/live", {
      onEvent: () => undefined,
      onStatus,
      poll,
      pollIntervalMs: 50,
      WebSocketImpl: class {
        constructor(_url: string) {
          throw new Error("blocked");
        }
      } as unknown as typeof WebSocket,
    });
    expect(conn.status).toBe("polling");
    expect(onStatus).toHaveBeenCalledWith("polling");
    conn.stop();
  });

  it("exposes the 15s disconnected poll interval default", () => {
    expect(DISCONNECTED_POLL_INTERVAL_MS).toBe(15_000);
  });
});
