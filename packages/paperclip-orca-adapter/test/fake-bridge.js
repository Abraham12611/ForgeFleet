// In-process fake of the orca-bridge HTTP API v0.1 for adapter tests.
//
// Implements the shapes in docs/05-contracts/bridge.openapi.yaml with
// deterministic UUIDs and an inspectable dispatch count, so tests can assert
// the no-duplicate-dispatch invariant. NOT a live integration: every claim
// backed by this fake is fixture evidence (see README).
//
// Usage:
//   const fake = createFakeBridge();
//   const adapter = createServerAdapter({ bridgeClient: ..., fetchImpl: fake.fetch });
//   fake.emit({...}); fake.advanceAttempt(id, 'running');

const REQUIRED_ATTEMPT_FIELDS = [
  'projectId',
  'paperclipTaskId',
  'paperclipRunId',
  'workerKind',
  'contextManifestId',
  'lease',
];

function fakeUuid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function jsonResponse(status, body, extraHeaders = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 202 ? 'Accepted' : status === 200 ? 'OK' : 'Error',
    headers: extraHeaders,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

export function createFakeBridge({ providers = null, requireToken = '' } = {}) {
  let seq = 0;
  let eventSeq = 0;
  const attempts = new Map(); // attemptId -> receipt
  const byIdempotencyKey = new Map(); // key -> { payloadHash, attemptId }
  const events = []; // { eventId, event }
  const messages = [];
  const cancels = [];
  let dispatchCount = 0;
  const providerState =
    providers ?? [{ name: 'muse', status: 'verified' }, { name: 'devin', status: 'unknown' }];

  function emitEvent(partial) {
    eventSeq += 1;
    const eventId = `evt-${String(eventSeq).padStart(4, '0')}`;
    const full = {
      schemaVersion: '0.1',
      occurredAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      source: 'orca-bridge',
      correlationId: eventId,
      fencingEpoch: 1,
      actor: { type: 'service', id: 'orca-bridge' },
      ...partial,
    };
    events.push({ eventId, event: full });
    return eventId;
  }

  function receiptFor(attemptId) {
    return attempts.get(attemptId);
  }

  // Crash simulation (FF-009 semantics): the next POST records the dispatch
  // (Orca accepted) and then throws like a severed connection, so the caller
  // observes an ambiguous fate. Re-issuing the identical payload must replay
  // the original receipt with no second dispatch.
  let crashNextCreate = false;
  const fake = {
    get dispatchCount() {
      return dispatchCount;
    },
    crashNextCreateAfterAccept() {
      crashNextCreate = true;
    },
    get attempts() {
      return attempts;
    },
    get messages() {
      return messages;
    },
    get cancels() {
      return cancels;
    },
    setProviderStatus(name, status, notes = '') {
      const p = providerState.find((x) => x.name === name);
      if (p) {
        p.status = status;
        p.notes = notes;
      } else providerState.push({ name, status, notes });
    },
    emit: emitEvent,
    advanceAttempt(attemptId, state, data = {}) {
      const r = attempts.get(attemptId);
      if (!r) throw new Error(`fake: unknown attempt ${attemptId}`);
      r.state = state;
      r.observedAt = new Date().toISOString();
      const type = { running: 'attempt.started', finished: 'attempt.finished', failed: 'attempt.failed', cancelled: 'attempt.cancelled', unknown: 'attempt.unknown' }[state];
      if (type) {
        emitEvent({
          eventType: type,
          projectId: r.projectId,
          taskId: r.paperclipTaskId,
          attemptId,
          fencingEpoch: 1,
          data: { externalDispatchId: r.orcaDispatchId, ...data },
        });
      }
      return r;
    },

    async fetch(url, init = {}) {
      const method = (init.method ?? 'GET').toUpperCase();
      const headers = Object.fromEntries(
        Object.entries(init.headers ?? {}).map(([k, v]) => [String(k).toLowerCase(), v]),
      );
      if (requireToken && headers.authorization !== `Bearer ${requireToken}`) {
        return jsonResponse(401, { error: 'unauthorized' });
      }
      const path = String(url).replace(/^https?:\/\/[^/]+/, '');

      if (method === 'GET' && path === '/v1/runtime/capabilities') {
        return jsonResponse(200, {
          reachable: true,
          checkedAt: new Date().toISOString(),
          cliVersion: 'fake-0.0.0',
          commandPath: '/usr/bin/fake-orca',
          providers: providerState,
        });
      }

      if (method === 'POST' && path === '/v1/attempts') {
        const key = headers['idempotency-key'] ?? '';
        let body = {};
        try {
          body = JSON.parse(init.body ?? '{}');
        } catch {
          return jsonResponse(422, { error: 'invalid-json' });
        }
        const missing = REQUIRED_ATTEMPT_FIELDS.filter((f) => body[f] === undefined);
        if (missing.length > 0 || !key || key.length < 8) {
          return jsonResponse(422, { error: 'validation', missing });
        }
        const hash = JSON.stringify(body);
        const existing = byIdempotencyKey.get(key);
        if (existing) {
          if (existing.payloadHash !== hash) {
            return jsonResponse(409, { error: 'idempotency-key-conflict' });
          }
          return jsonResponse(202, receiptFor(existing.attemptId));
        }
        seq += 1;
        if (crashNextCreate) {
          crashNextCreate = false;
          const attemptId = fakeUuid(seq);
          const receipt = {
            attemptId,
            projectId: body.projectId,
            paperclipTaskId: body.paperclipTaskId,
            state: 'accepted',
            observedAt: new Date().toISOString(),
            orcaRunId: `fake-run-${seq}`,
            orcaTaskId: `fake-task-${seq}`,
            orcaDispatchId: `fake-dispatch-${seq}`,
            worktreeId: `fake-worktree-${seq}`,
            errorCode: null,
          };
          // Orca accepted: record the dispatch, then die before the reply.
          dispatchCount += 1;
          attempts.set(attemptId, receipt);
          byIdempotencyKey.set(key, { payloadHash: hash, attemptId });
          throw new Error('fake: connection reset after accept (crash window)');
        }
        const attemptId = fakeUuid(seq);
        const receipt = {
          attemptId,
          projectId: body.projectId,
          paperclipTaskId: body.paperclipTaskId,
          state: 'accepted',
          observedAt: new Date().toISOString(),
          orcaRunId: `fake-run-${seq}`,
          orcaTaskId: `fake-task-${seq}`,
          orcaDispatchId: `fake-dispatch-${seq}`,
          worktreeId: `fake-worktree-${seq}`,
          errorCode: null,
        };
        dispatchCount += 1;
        attempts.set(attemptId, receipt);
        byIdempotencyKey.set(key, { payloadHash: hash, attemptId });
        return jsonResponse(202, receipt);
      }

      const attemptMatch = path.match(/^\/v1\/attempts\/([^/]+)(\/cancel|\/messages)?$/);
      if (attemptMatch) {
        const attemptId = decodeURIComponent(attemptMatch[1]);
        const suffix = attemptMatch[2] ?? '';
        const receipt = attempts.get(attemptId);
        if (method === 'GET' && suffix === '') {
          if (!receipt) return jsonResponse(404, { error: 'unknown-attempt' });
          return jsonResponse(200, receipt);
        }
        if (method === 'POST' && suffix === '/cancel') {
          if (!receipt) return jsonResponse(404, { error: 'unknown-attempt' });
          let body = {};
          try {
            body = JSON.parse(init.body ?? '{}');
          } catch {
            body = {};
          }
          if (!body.reason || !body.approvedBy) {
            return jsonResponse(403, { error: 'cancel-requires-authorized-actor' });
          }
          cancels.push({ attemptId, ...body });
          return jsonResponse(202, { accepted: true });
        }
        if (method === 'POST' && suffix === '/messages') {
          if (!receipt) return jsonResponse(404, { error: 'unknown-attempt' });
          messages.push({ attemptId, body: init.body });
          return jsonResponse(202, { queued: true });
        }
      }

      if (method === 'GET' && path === '/v1/events') {
        const since = headers['last-event-id'] ?? null;
        let selected = events;
        if (since) {
          const idx = events.findIndex((e) => e.eventId === since);
          selected = idx >= 0 ? events.slice(idx + 1) : events;
        }
        const sse = selected
          .map(({ eventId, event }) => `id: ${eventId}\ndata: ${JSON.stringify(event)}\n`)
          .join('\n');
        return jsonResponse(200, sse, { 'content-type': 'text/event-stream' });
      }

      return jsonResponse(404, { error: 'fake: unknown route' });
    },
  };
  return fake;
}
