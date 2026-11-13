/**
 * FF-031 integration: authenticated trusted scheduler lease verifier.
 *
 * Trust boundary (coordinator P0 direction on PR #63): `handleCreate`
 * previously checked the request `projectId` against a static server
 * allowlist and accepted `taskId`/`runId`/`fencingEpoch`/`leaseToken`
 * straight from JSON. The canonical store only checks the lease against
 * its own previously stored client-provided history, so a bearer-token
 * holder on an allowed project could mint an arbitrary new task+epoch+token
 * and reach worker launch once live dispatch is enabled.
 *
 * This module closes that hole at the server boundary: dispatch requires a
 * Paperclip-scheduler-authenticated grant for the EXACT
 * (projectId, taskId, runId, fencingEpoch) tuple. Grants are HMAC-SHA256
 * envelopes minted by the scheduler authority with `issueSchedulerLease`
 * and verified here with the operator-configured secret. The v0.1 wire
 * shape is unchanged (`lease: { fencingEpoch, leaseToken }`): the signed
 * envelope travels inside the opaque `leaseToken` string, so no contract
 * change and no E05 review is needed.
 *
 * Fail-closed defaults:
 * - `denyAllLeaseVerifier()` refuses every dispatch (`lease_unverified`).
 *   `BridgeServer.create` uses it unless the operator injects a verifier,
 *   and `main.ts` only builds an HMAC verifier from the server-side
 *   `FORGEFLEET_BRIDGE_LEASE_SECRET` env. No secret configured means no
 *   dispatch, never an unsigned bypass.
 * - Unknown/forged grants, expired grants, wrong-run presentation, stale
 *   epochs, and token reuse under a different idempotency key all refuse.
 *   Same-token same-key retries (crash/502 reconcile) verify idempotently
 *   so the durable accept-prefix replay path keeps working.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface SchedulerLeaseGrant {
  projectId: string;
  taskId: string;
  runId: string;
  fencingEpoch: number;
  leaseToken: string;
}

export type SchedulerLeaseRejectCode =
  | "lease_unverified"
  | "lease_expired"
  | "lease_run_mismatch"
  | "lease_stale_epoch"
  | "lease_replay";

export type SchedulerLeaseVerifyResult =
  | { ok: true }
  | { ok: false; code: SchedulerLeaseRejectCode; message: string };

export interface SchedulerLeaseVerifier {
  verify(
    grant: SchedulerLeaseGrant,
    opts: { idempotencyKey: string; nowMs?: number },
  ): SchedulerLeaseVerifyResult;
}

interface SignedLeasePayload {
  v: 1;
  projectId: string;
  taskId: string;
  runId: string;
  fencingEpoch: number;
  nonce: string;
  exp: number;
}

function b64urlEncode(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64url");
}

function b64urlDecodeToString(segment: string): string | null {
  if (!segment) return null;
  try {
    return Buffer.from(segment, "base64url").toString("utf-8");
  } catch {
    return null;
  }
}

function signLeaseToken(secret: string, payloadB64: string): string {
  return createHmac("sha256", secret).update(payloadB64, "utf-8").digest("hex");
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Mint a scheduler-authenticated lease token for exactly one
 * (projectId, taskId, runId, fencingEpoch) grant. The scheduler authority
 * (and tests standing in for it) call this; the bridge only verifies.
 */
export function issueSchedulerLease(input: {
  secret: string;
  projectId: string;
  taskId: string;
  runId: string;
  fencingEpoch: number;
  ttlMs: number;
  nowMs?: number;
  nonce?: string;
}): { leaseToken: string; expiresAtMs: number } {
  const { secret, projectId, taskId, runId, fencingEpoch, ttlMs } = input;
  if (!nonEmpty(secret)) throw new Error("issueSchedulerLease requires a non-empty secret");
  if (!nonEmpty(projectId) || !nonEmpty(taskId) || !nonEmpty(runId)) {
    throw new Error("issueSchedulerLease requires projectId, taskId and runId");
  }
  if (!Number.isInteger(fencingEpoch) || fencingEpoch < 1) {
    throw new Error("issueSchedulerLease requires fencingEpoch integer >= 1");
  }
  if (!Number.isFinite(ttlMs)) throw new Error("issueSchedulerLease requires a finite ttlMs");
  const nowMs = input.nowMs ?? Date.now();
  const expiresAtMs = nowMs + ttlMs;
  if (!Number.isFinite(expiresAtMs)) throw new Error("issueSchedulerLease expiry overflow");
  const payload: SignedLeasePayload = {
    v: 1,
    projectId,
    taskId,
    runId,
    fencingEpoch,
    nonce:
      input.nonce ??
      `${nowMs.toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`,
    exp: expiresAtMs,
  };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const sig = signLeaseToken(secret, payloadB64);
  return { leaseToken: `${payloadB64}.${sig}`, expiresAtMs };
}

function decodeLeaseToken(leaseToken: string): SignedLeasePayload | null {
  const dot = leaseToken.lastIndexOf(".");
  if (dot <= 0 || dot === leaseToken.length - 1) return null;
  const payloadText = b64urlDecodeToString(leaseToken.slice(0, dot));
  if (payloadText === null) return null;
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(payloadText);
    if (typeof parsed !== "object" || parsed === null) return null;
    payload = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (payload.v !== 1) return null;
  if (
    !nonEmpty(payload.projectId) ||
    !nonEmpty(payload.taskId) ||
    !nonEmpty(payload.runId) ||
    !nonEmpty(payload.nonce)
  ) {
    return null;
  }
  if (!Number.isInteger(payload.fencingEpoch) || (payload.fencingEpoch as number) < 1) return null;
  if (!Number.isFinite(payload.exp)) return null;
  return payload as unknown as SignedLeasePayload;
}

function taskScopeOf(projectId: string, taskId: string): string {
  return `${projectId}::${taskId}`;
}

/**
 * HMAC scheduler lease verifier. `secret` is operator/server-side config
 * (daemon env), never request JSON. Tracks verified token->key bindings
 * (replay domain) and per-task max verified epoch (staleness) in memory;
 * durable single-launch and idempotency stay with the canonical store.
 */
export function createHmacLeaseVerifier(opts: { secret: string }): SchedulerLeaseVerifier {
  const { secret } = opts;
  if (!nonEmpty(secret)) throw new Error("createHmacLeaseVerifier requires a non-empty secret");
  const tokenKey = new Map<string, string>();
  const maxEpochByTask = new Map<string, number>();
  return {
    verify(grant: SchedulerLeaseGrant, opts2: { idempotencyKey: string; nowMs?: number }) {
      const { projectId, taskId, runId, fencingEpoch, leaseToken } = grant;
      const idempotencyKey = opts2.idempotencyKey;
      const nowMs = opts2.nowMs ?? Date.now();
      if (
        !nonEmpty(projectId) ||
        !nonEmpty(taskId) ||
        !nonEmpty(runId) ||
        !nonEmpty(leaseToken) ||
        !nonEmpty(idempotencyKey)
      ) {
        return {
          ok: false,
          code: "lease_unverified",
          message: "scheduler lease grant is incomplete; refusing dispatch",
        };
      }
      if (!Number.isInteger(fencingEpoch) || (fencingEpoch as number) < 1) {
        return {
          ok: false,
          code: "lease_unverified",
          message: "scheduler lease fencingEpoch must be an integer >= 1; refusing dispatch",
        };
      }
      const payload = decodeLeaseToken(leaseToken);
      if (payload === null) {
        return {
          ok: false,
          code: "lease_unverified",
          message: "scheduler lease token is malformed; refusing dispatch",
        };
      }
      // Binding: the signed grant authorizes exactly one (project, task).
      // A token minted for another task in an allowed project is forged here.
      if (payload.projectId !== projectId || payload.taskId !== taskId) {
        return {
          ok: false,
          code: "lease_unverified",
          message: "scheduler lease grant does not authorize this project/task; refusing dispatch",
        };
      }
      if (payload.runId !== runId) {
        return {
          ok: false,
          code: "lease_run_mismatch",
          message: "scheduler lease grant was issued for a different run; refusing dispatch",
        };
      }
      if (payload.fencingEpoch !== fencingEpoch) {
        return {
          ok: false,
          code: "lease_unverified",
          message: "scheduler lease grant does not authorize this fencing epoch; refusing dispatch",
        };
      }
      // Authenticity: the envelope must carry the scheduler signature.
      const dot = leaseToken.lastIndexOf(".");
      const payloadB64 = leaseToken.slice(0, dot);
      const presentedSig = Buffer.from(leaseToken.slice(dot + 1), "utf-8");
      const expectedSig = Buffer.from(signLeaseToken(secret, payloadB64), "utf-8");
      if (presentedSig.length !== expectedSig.length || !timingSafeEqual(presentedSig, expectedSig)) {
        return {
          ok: false,
          code: "lease_unverified",
          message: "scheduler lease signature is invalid; refusing dispatch",
        };
      }
      if (!Number.isFinite(payload.exp) || payload.exp <= nowMs) {
        return {
          ok: false,
          code: "lease_expired",
          message: "scheduler lease grant has expired; refusing dispatch",
        };
      }
      // Replay domain: a verified token is bound to the idempotency key
      // that first presented it. The crash/502 retry path re-presents the
      // identical (token, key) pair and stays accepted without touching
      // epoch state; any other key reusing the token is a replay. Binding,
      // signature and expiry are checked first so a cross-task or forged
      // reuse reports its true cause rather than a generic replay.
      const boundKey = tokenKey.get(leaseToken);
      if (boundKey !== undefined) {
        if (boundKey === idempotencyKey) return { ok: true };
        return {
          ok: false,
          code: "lease_replay",
          message: "scheduler lease token was already used under a different idempotency key; refusing",
        };
      }
      const scope = taskScopeOf(projectId, taskId);
      const maxEpoch = maxEpochByTask.get(scope) ?? 0;
      if (fencingEpoch < maxEpoch) {
        return {
          ok: false,
          code: "lease_stale_epoch",
          message: `scheduler lease epoch ${fencingEpoch} is superseded for this task (max ${maxEpoch}); refusing dispatch`,
        };
      }
      maxEpochByTask.set(scope, Math.max(maxEpoch, fencingEpoch));
      tokenKey.set(leaseToken, idempotencyKey);
      return { ok: true };
    },
  };
}

/** Fail-closed default: no scheduler lease authority configured, no dispatch. */
export function denyAllLeaseVerifier(): SchedulerLeaseVerifier {
  return {
    verify() {
      return {
        ok: false,
        code: "lease_unverified",
        message: "no scheduler lease verifier configured on this bridge; refusing dispatch",
      };
    },
  };
}
