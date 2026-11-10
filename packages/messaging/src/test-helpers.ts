/**
 * Shared test-only backend auth: maps fixed test credentials to actors.
 * Mirrors what the real backend adapter (#60) must do against its own
 * session table. Never shipped; never imported by production code.
 */
import { MessageError, type Actor } from "./types.ts";
import type { BackendAuthPort, BackendCredential } from "./mcp.ts";

export const TEST_SERVICE: Actor = { type: "service", id: "orca-bridge", role: "service", projects: ["p1"] };
export const TEST_OWNER: Actor = { type: "human", id: "owner", role: "owner" };
export const TEST_COORD: Actor = { type: "agent", id: "coord-1", role: "coordinator", projects: ["p1"] };

export const TEST_OUTSIDER: Actor = { type: "agent", id: "worker-x", role: "worker", projects: ["p2"] };

const TOKENS: Record<string, Actor> = {
  "tok-bridge": TEST_SERVICE,
  "tok-coord": TEST_COORD,
  "tok-x": TEST_OUTSIDER,
};
const BINDINGS: Record<string, Array<{ workerId: string; projectId: string }>> = {
  "tok-bridge": [
    { workerId: "worker-a", projectId: "p1" },
    { workerId: "worker-b", projectId: "p1" },
  ],
};

export function fakeAuth(): BackendAuthPort {
  return {
    verify(credential: BackendCredential) {
      if (credential.transport === "service-token") {
        const actor = TOKENS[credential.token];
        if (!actor) {
          throw new MessageError("FORBIDDEN", 403, "unknown service token");
        }
        const binding = (BINDINGS[credential.token] ?? []).find(
          (b) => b.workerId === credential.workerId,
        );
        return {
          actor,
          via: "service-token",
          ...(binding ? { onBehalfOf: binding } : {}),
        };
      }
      if (credential.transport === "owner-session" && credential.sessionId === "sess-owner") {
        return { actor: TEST_OWNER, via: "owner-session" };
      }
      throw new MessageError("FORBIDDEN", 403, "unknown owner session");
    },
  };
}

export const OWNER_CRED = { transport: "owner-session", sessionId: "sess-owner" } as const;
export const BRIDGE_CRED = { transport: "service-token", token: "tok-bridge" } as const;
export const COORD_CRED = { transport: "service-token", token: "tok-coord" } as const;
export const OUTSIDER_CRED = { transport: "service-token", token: "tok-x" } as const;
