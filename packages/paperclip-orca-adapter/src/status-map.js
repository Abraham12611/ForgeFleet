// Bridge attempt state -> Paperclip-facing status, plus normalized event
// application with dedupe and fencing. Contract refs:
// docs/05-contracts/state-machines.md, docs/05-contracts/events.md.

// Terminal states end the session (after workspace sync-back succeeds).
export const TERMINAL_STATES = new Set(['finished', 'failed', 'cancelled']);

// Runtime completion is NOT task verification: a finished worker means its
// artifact is delivered for review, so the task moves to `submitted`.
export function mapAttemptState(state) {
  switch (state) {
    case 'accepted':
    case 'dispatching':
      return 'dispatched';
    case 'running':
      return 'running';
    case 'waiting':
      return 'waiting_capacity';
    case 'unknown':
      return 'unknown';
    case 'finished':
      return 'submitted';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

export function isTerminalAttemptState(state) {
  return TERMINAL_STATES.has(state);
}

// Apply one normalized bridge event to tracker state.
// Tracker: { seenEventKeys:Set, lastEventId, status, pendingQuestions:[] }.
// - Dedupe on (source,eventId): duplicates/reordered delivery cause one
//   logical change.
// - Fencing: events carrying an older fencingEpoch than the session are
//   ignored (late heartbeat for a fenced attempt must not mutate state).
// - 'unknown' renders as unknown, never as stopped/failed/healthy.
export function applyBridgeEvent(tracker, frame, session) {
  const { eventId, event } = frame;
  const key = `${event?.source ?? '?'}:${eventId}`;
  if (tracker.seenEventKeys.has(key)) return { applied: false, reason: 'duplicate' };
  tracker.seenEventKeys.add(key);

  const eventEpoch = Number.isInteger(event?.fencingEpoch) ? event.fencingEpoch : session.fencingEpoch;
  if (eventEpoch < session.fencingEpoch) return { applied: false, reason: 'stale-fencing-epoch' };

  tracker.lastEventId = eventId;
  const type = event?.eventType ?? '';

  if (type === 'attempt.question' || (type === 'message.posted' && event?.data?.kind === 'question')) {
    tracker.pendingQuestions.push({
      eventId,
      body: event?.data?.body ?? event?.data?.text ?? '',
      threadId: event?.data?.threadId ?? null,
    });
    return { applied: true, reason: 'question' };
  }
  if (type === 'attempt.unknown') {
    tracker.status = 'unknown';
    return { applied: true, reason: 'unknown' };
  }
  if (type === 'attempt.failed') {
    tracker.status = 'failed';
    return { applied: true, reason: 'failed' };
  }
  if (type === 'attempt.cancelled') {
    tracker.status = 'cancelled';
    return { applied: true, reason: 'cancelled' };
  }
  if (type === 'attempt.finished') {
    tracker.status = 'submitted';
    return { applied: true, reason: 'finished' };
  }
  if (type === 'attempt.started' || type === 'attempt.heartbeat') {
    if (tracker.status === null || tracker.status === 'dispatched') tracker.status = 'running';
    return { applied: true, reason: 'progress' };
  }
  // New event types must be safely ignored by this version (compat rule).
  return { applied: true, reason: 'ignored-unknown-type' };
}

export function createEventTracker() {
  return { seenEventKeys: new Set(), lastEventId: null, status: null, pendingQuestions: [] };
}
