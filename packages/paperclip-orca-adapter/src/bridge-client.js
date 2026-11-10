// Typed client for the ForgeFleet orca-bridge HTTP API v0.1.
// Contract: docs/05-contracts/bridge.openapi.yaml (proposed, E05-owned).
// Loopback-only base URL; service Bearer token, backend only.
//
// `fetchImpl` is injectable so tests can drive a fake bridge without
// sockets. Every mutating call requires an explicit idempotencyKey.

import {
  BridgeRejectedError,
  CapabilityError,
  IdempotencyConflictError,
} from './errors.js';

export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:4387';

function joinUrl(base, path) {
  return `${base.replace(/\/+$/, '')}${path}`;
}

async function readJsonSafe(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// Pure builder for POST /v1/attempts bodies (exported so the E05 frozen
// contract validator can check adapter output; field set mirrors
// CreateAttemptRequest incl. additionalProperties:false).
export function buildCreateAttemptRequest(t, idempotencyKey, { fencingEpoch, leaseToken }) {
  const leaseTokenValue = leaseToken ?? `adapter:${idempotencyKey}`;
  const req = {
    projectId: t.projectId,
    paperclipTaskId: t.taskId,
    paperclipRunId: String(t.runId),
    workerKind: t.workerKind,
    taskTitle: t.title,
    instruction: t.instruction,
    contextManifestId: t.contextManifestId,
    lease: { fencingEpoch, leaseToken: leaseTokenValue },
  };
  if (t.repositoryId) req.repositoryId = t.repositoryId;
  return req;
}

export function createBridgeClient({ baseUrl = DEFAULT_BRIDGE_URL, token = '', fetchImpl = fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl must be a function');

  function headers(idempotencyKey) {
    const h = { 'content-type': 'application/json' };
    if (token) h.authorization = `Bearer ${token}`;
    if (idempotencyKey) h['idempotency-key'] = idempotencyKey;
    return h;
  }

  async function throwForStatus(res, context) {
    if (res.status === 409 && context === 'createAttempt') {
      throw new IdempotencyConflictError('(see request key)');
    }
    if (res.status === 401 || res.status === 403 || res.status === 422 || res.status === 429) {
      const body = await readJsonSafe(res);
      const reason =
        (body && (body.error || body.message || body.code)) || res.statusText || '';
      throw new BridgeRejectedError(res.status, String(reason));
    }
    const body = await readJsonSafe(res);
    throw new BridgeRejectedError(
      res.status,
      (body && JSON.stringify(body)) || res.statusText || 'unexpected bridge response',
    );
  }

  return {
    // GET /v1/runtime/capabilities. Throws CapabilityError when the
    // requested workerKind is anything but verified (fail closed).
    async checkCapabilities(workerKind) {
      const res = await fetchImpl(joinUrl(baseUrl, '/v1/runtime/capabilities'), {
        method: 'GET',
        headers: headers(),
      });
      if (!res.ok) await throwForStatus(res, 'capabilities');
      const caps = await res.json();
      const provider = (caps?.providers ?? []).find((p) => p.name === workerKind);
      const status = provider ? provider.status : 'unknown';
      if (status !== 'verified') {
        throw new CapabilityError(workerKind, status, provider?.notes ?? '');
      }
      return caps;
    },

    // POST /v1/attempts. 202 -> AttemptReceipt. Same key + same payload
    // replays to the same attemptId (bridge-owned idempotency); same key +
    // different payload -> 409 -> IdempotencyConflictError, no side effect.
    async createAttempt(request, idempotencyKey) {
      const res = await fetchImpl(joinUrl(baseUrl, '/v1/attempts'), {
        method: 'POST',
        headers: headers(idempotencyKey),
        body: JSON.stringify(request),
      });
      if (res.status === 202) return res.json();
      await throwForStatus(res, 'createAttempt');
    },

    // GET /v1/runtime/sessions?projectId=. Read-only inventory used ONLY
    // for session-loss reconciliation (finding a possibly-live worker for a
    // task whose cursor is gone). Never used to mutate anything.
    async listSessions(projectId) {
      const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
      const res = await fetchImpl(joinUrl(baseUrl, `/v1/runtime/sessions${q}`), {
        method: 'GET',
        headers: headers(),
      });
      if (!res.ok) await throwForStatus(res, 'sessions');
      const body = await res.json();
      return Array.isArray(body?.sessions) ? body.sessions : [];
    },

    // GET /v1/attempts/{attemptId}. 200 -> AttemptReceipt, 404 -> null
    // (caller quarantines; null is never proof of absence).
    async getAttempt(attemptId) {
      const res = await fetchImpl(
        joinUrl(baseUrl, `/v1/attempts/${encodeURIComponent(attemptId)}`),
        { method: 'GET', headers: headers() },
      );
      if (res.status === 200) return res.json();
      if (res.status === 404) return null;
      await throwForStatus(res, 'getAttempt');
    },

    // POST /v1/attempts/{id}/cancel. Requires authorized actor; 202 means
    // requested, NOT confirmed (runtime confirmation arrives via events).
    async cancelAttempt(attemptId, { reason, approvedBy, idempotencyKey }) {
      const res = await fetchImpl(
        joinUrl(baseUrl, `/v1/attempts/${encodeURIComponent(attemptId)}/cancel`),
        {
          method: 'POST',
          headers: headers(idempotencyKey),
          body: JSON.stringify({ reason, approvedBy }),
        },
      );
      if (res.status === 202) return true;
      await throwForStatus(res, 'cancelAttempt');
    },

    // POST /v1/attempts/{id}/messages. Queued for authorized delivery.
    async sendAttemptMessage(attemptId, { projectId, threadId, actorId, body, kind }, idempotencyKey) {
      const res = await fetchImpl(
        joinUrl(baseUrl, `/v1/attempts/${encodeURIComponent(attemptId)}/messages`),
        {
          method: 'POST',
          headers: headers(idempotencyKey),
          body: JSON.stringify({ projectId, threadId, actorId, body, kind }),
        },
      );
      if (res.status === 202) return true;
      await throwForStatus(res, 'sendMessage');
    },

    // GET /v1/events (SSE). Sends Last-Event-ID for resume; parses
    // `id:` / `data:` frames into [{ eventId, event }]. State GET remains
    // the authoritative fallback (stream status is never task status).
    async streamEvents(sinceEventId = null) {
      const h = headers();
      if (sinceEventId) h['last-event-id'] = sinceEventId;
      const res = await fetchImpl(joinUrl(baseUrl, '/v1/events'), {
        method: 'GET',
        headers: { ...h, accept: 'text/event-stream' },
      });
      if (!res.ok) await throwForStatus(res, 'events');
      const text = await res.text();
      return parseSseFrames(text);
    },
  };
}

// Minimal SSE frame parser: frames separated by blank lines; each frame
// carries `id: <eventId>` and `data: <json>`. Malformed frames are skipped,
// never thrown: a partial stream must not fail reconciliation.
export function parseSseFrames(text) {
  const out = [];
  for (const frame of String(text ?? '').split(/\r?\n\r?\n/)) {
    let id = null;
    const dataLines = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (id === null || dataLines.length === 0) continue;
    try {
      out.push({ eventId: id, event: JSON.parse(dataLines.join('\n')) });
    } catch {
      continue;
    }
  }
  return out;
}
