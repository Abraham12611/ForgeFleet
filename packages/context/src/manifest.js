/**
 * ForgeFleet context file ingestion and immutable manifests (FF-011).
 *
 * Pipeline (see `docs/03-architecture/context-and-memory.md`):
 * upload metadata -> `validateSource` -> `ingestSource` (hash + redact +
 * excerpt) -> `createManifest` (immutable, revision-pinned) ->
 * `bindTask` (task-scoped) -> `manifestForTask` (project-ACL-checked
 * retrieval). Later edits go through `addSources` / `bindTask` and emit an
 * explicit `refreshEvent`; the previous revision object is never mutated,
 * so an `attempt` that references the old revision keeps proving exactly
 * what it saw (`attemptIsCurrent` reports the drift).
 *
 * Deterministic: no clock, no randomness, no I/O. The same inputs always
 * yield the same revision, and sources are canonically ordered by
 * `sourceId`, so independently built manifests with the same content agree.
 *
 * NOTE (E07 dependency): `packages/policy` owns authorization. The actor
 * check in `manifestForTask` is intentionally minimal — owner spans
 * projects, everyone else must be scoped to the manifest project (mirrors
 * the AUTO_SAFE `context.read` row of
 * `docs/05-contracts/policy-matrix.md`). Reconcile with the E07 policy
 * engine before using this past v0.2 fixtures.
 */

import { createHash } from 'node:crypto';
import { redactSecrets } from './redact.js';

export const CONTEXT_VERSION = '0.1.0';
export const MANIFEST_KIND = 'forgefleet.context-manifest/v1';

/** Largest single file accepted into context (10 MiB). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Cap on sources per manifest: manifests pin references, not dumps. */
export const MAX_SOURCES_PER_MANIFEST = 200;
/** Cap on sources bound to one task: least-necessary excerpts only. */
export const MAX_SOURCES_PER_TASK = 25;
/** Excerpt handed toward model context is bounded; the rest stays linked. */
export const MAX_EXCERPT_CHARS = 8000;

/** Text kinds stored with a redacted excerpt (`extraction: 'ready'`). */
export const TEXT_MIMES = Object.freeze([
  'text/markdown',
  'text/plain',
  'text/csv',
  'application/json',
  'application/yaml',
]);

/**
 * Binary kinds accepted for reference only. No excerpt is produced —
 * extraction (PDF text, image description) is asynchronous and lands via
 * an explicit refresh, so agents receive links, never raw bytes.
 */
export const EXTRACTABLE_MIMES = Object.freeze([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
]);

/** Exact filenames that must never enter project context. */
const BLOCKED_BASENAMES = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  'secrets.json',
  'credentials.json',
]);

/** Private key material basenames (public halves, e.g. `id_rsa.pub`, pass). */
const BLOCKED_KEY_BASENAMES = new Set([
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
]);

const BLOCKED_SUFFIXES = ['.pem', '.key', '.p12', '.pfx'];
const BLOCKED_SEGMENTS = new Set(['.git', 'node_modules']);
const SOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Error with a stable machine-readable `code` for every rejection.
 * Codes are part of the contract: `BLOCKED_FILENAME`, `BLOCKED_PATH`,
 * `UNSUPPORTED_MEDIA_TYPE`, `FILE_TOO_LARGE`, `INVALID_SIZE`,
 * `INVALID_SOURCE`, `DUPLICATE_SOURCE_ID`, `TOO_MANY_SOURCES`,
 * `UNKNOWN_SOURCE`, `TASK_NOT_BOUND`, `INVALID_TASK`, `TOO_MANY_TASK_SOURCES`,
 * `CROSS_PROJECT_DENIED`, `UNKNOWN_ACTOR`, `REVISION_MISMATCH`,
 * `INVALID_MANIFEST`, `NO_CHANGE`.
 */
export class ContextError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'ContextError';
    this.code = code;
  }
}

/**
 * @typedef {object} SourceValidation
 * @property {'ready'|'pending_extraction'|'rejected'} status
 * @property {string[]} reasons - stable reason codes; empty unless rejected.
 * @property {string} mediaType - normalized `type/subtype` (params stripped).
 */

/**
 * Normalize `Text/Markdown; charset=utf-8` -> `text/markdown`.
 * @param {unknown} mediaType
 */
export function normalizeMediaType(mediaType) {
  if (typeof mediaType !== 'string') return '';
  return mediaType.split(';', 1)[0].trim().toLowerCase();
}

function basenameOf(name) {
  return String(name).split('/').pop() ?? '';
}

/**
 * Validate upload metadata before any bytes are stored. Pure function —
 * reports the per-file extraction/validation state required by
 * `docs/03-architecture/context-and-memory.md` ("surface per-file
 * extraction/validation states").
 *
 * @param {{name: string, mediaType: string, byteSize: number}} input
 * @returns {SourceValidation}
 */
export function validateSource(input) {
  const name = input?.name;
  const mediaType = normalizeMediaType(input?.mediaType);
  const byteSize = input?.byteSize;
  const rejected = (...reasons) => ({ status: 'rejected', reasons, mediaType });

  if (typeof name !== 'string' || name.length === 0 || name.length > 512) {
    return rejected('INVALID_SOURCE');
  }
  if (name.startsWith('/') || name.startsWith('\\')) {
    return rejected('BLOCKED_PATH');
  }
  const segments = name.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    return rejected('BLOCKED_PATH');
  }
  if (segments.some((s) => BLOCKED_SEGMENTS.has(s))) {
    return rejected('BLOCKED_PATH');
  }
  const base = basenameOf(name);
  const lowerBase = base.toLowerCase();
  if (
    BLOCKED_BASENAMES.has(lowerBase) ||
    lowerBase.startsWith('.env.') ||
    BLOCKED_SUFFIXES.some((s) => lowerBase.endsWith(s)) ||
    BLOCKED_KEY_BASENAMES.has(lowerBase)
  ) {
    return rejected('BLOCKED_FILENAME');
  }
  if (typeof byteSize !== 'number' || !Number.isFinite(byteSize) || byteSize < 0) {
    return rejected('INVALID_SIZE');
  }
  if (byteSize > MAX_FILE_BYTES) {
    return rejected('FILE_TOO_LARGE');
  }
  if (TEXT_MIMES.includes(mediaType)) {
    return { status: 'ready', reasons: [], mediaType };
  }
  if (EXTRACTABLE_MIMES.includes(mediaType)) {
    return { status: 'pending_extraction', reasons: [], mediaType };
  }
  return rejected('UNSUPPORTED_MEDIA_TYPE');
}

/**
 * Hash bytes with SHA-256. Accepts string, Buffer, or Uint8Array.
 * @param {string|Uint8Array} data
 */
export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function toBytes(bytes) {
  if (typeof bytes === 'string') return Buffer.from(bytes, 'utf8');
  if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  throw new TypeError('ingestSource expects bytes as string or Uint8Array');
}

function freezeDeep(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) freezeDeep(v);
    Object.freeze(value);
  }
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * @typedef {object} SourceRecord content-addressed, hash-pinned source.
 * @property {string} sourceId
 * @property {string} name
 * @property {string} mediaType
 * @property {number} byteSize
 * @property {string} sha256 - over the original bytes (provenance pin).
 * @property {string} visibility - always `'project'`.
 * @property {string} storeKey - deterministic `ctx/<sha256>` object-store key.
 * @property {'ready'|'pending_extraction'} extraction
 * @property {string|null} excerpt - redacted, bounded text for ready
 *   sources; null while extraction is pending (links only, never raw bytes).
 * @property {boolean} excerptTruncated
 * @property {{kind: string, occurrences: number}[]} redactions
 */

/**
 * Ingest one file: validate, hash, redact, excerpt. Throws ContextError
 * when validation rejects the file (never stores-then-rejects).
 *
 * @param {{name: string, mediaType: string, bytes: string|Uint8Array, sourceId?: string}} input
 * @returns {SourceRecord} frozen.
 */
export function ingestSource(input) {
  const bytes = toBytes(input?.bytes);
  const validation = validateSource({
    name: input?.name,
    mediaType: input?.mediaType,
    byteSize: bytes.length,
  });
  if (validation.status === 'rejected') {
    throw new ContextError(
      validation.reasons[0] ?? 'INVALID_SOURCE',
      `Source '${input?.name}' rejected: ${(validation.reasons).join(', ')}.`,
    );
  }
  let sourceId = input?.sourceId;
  const sha256 = sha256Hex(bytes);
  if (sourceId === undefined) {
    sourceId = `src-${sha256.slice(0, 12)}`;
  }
  if (typeof sourceId !== 'string' || !SOURCE_ID_RE.test(sourceId)) {
    throw new ContextError('INVALID_SOURCE', `Invalid sourceId '${sourceId}'.`);
  }
  /** @type {SourceRecord} */
  const record = {
    sourceId,
    name: input.name,
    mediaType: validation.mediaType,
    byteSize: bytes.length,
    sha256,
    visibility: 'project',
    storeKey: `ctx/${sha256}`,
    extraction: validation.status,
    excerpt: null,
    excerptTruncated: false,
    redactions: [],
  };
  if (validation.status === 'ready') {
    const { text, redactions } = redactSecrets(bytes.toString('utf8'));
    record.excerpt = text.slice(0, MAX_EXCERPT_CHARS);
    record.excerptTruncated = text.length > MAX_EXCERPT_CHARS;
    record.redactions = redactions;
  }
  return freezeDeep(record);
}

/**
 * @typedef {object} TaskBinding pins the sources one task may see.
 * @property {string} taskKey
 * @property {string[]} sourceIds
 * @property {string} goalRevision - goal revision this binding was made against.
 */

/**
 * @typedef {object} ContextManifest immutable, revision-pinned manifest.
 * @property {string} kind
 * @property {string} projectId
 * @property {string} revision - `ctx-<16 hex>` over canonical content.
 * @property {string} goalRevision
 * @property {SourceRecord[]} sources - sorted by sourceId.
 * @property {TaskBinding[]} taskBindings - sorted by taskKey.
 */

function checkSourceShape(source) {
  return (
    source !== null &&
    typeof source === 'object' &&
    typeof source.sourceId === 'string' &&
    SOURCE_ID_RE.test(source.sourceId) &&
    typeof source.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(source.sha256) &&
    (source.extraction === 'ready' || source.extraction === 'pending_extraction')
  );
}

/**
 * Compute the manifest revision: `ctx-` + 16 hex chars of SHA-256 over the
 * canonical (key-sorted, id-sorted) content. Timestamps are deliberately
 * excluded so identical content always yields identical revisions.
 */
export function computeRevision({ projectId, goalRevision, sources, taskBindings }) {
  const digest = sha256Hex(canonicalize({
    kind: MANIFEST_KIND,
    projectId,
    goalRevision,
    sources: [...sources].sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1)),
    taskBindings: [...taskBindings].sort((a, b) => (a.taskKey < b.taskKey ? -1 : 1)),
  }));
  return `ctx-${digest.slice(0, 16)}`;
}

/**
 * Build an immutable manifest. Throws on bad project/goal ids, malformed
 * sources, duplicate ids, or over-cap manifests.
 *
 * @param {{projectId: string, goalRevision: string, sources?: SourceRecord[]}} input
 * @returns {ContextManifest} frozen.
 */
export function createManifest(input) {
  const { projectId, goalRevision, sources = [] } = input ?? {};
  if (typeof projectId !== 'string' || projectId.trim() === '') {
    throw new ContextError('INVALID_MANIFEST', 'projectId must be a non-empty string.');
  }
  if (typeof goalRevision !== 'string' || goalRevision.trim() === '') {
    throw new ContextError('INVALID_MANIFEST', 'goalRevision must be a non-empty string.');
  }
  if (!Array.isArray(sources)) {
    throw new ContextError('INVALID_MANIFEST', 'sources must be an array.');
  }
  if (sources.length > MAX_SOURCES_PER_MANIFEST) {
    throw new ContextError('TOO_MANY_SOURCES', `Manifest caps at ${MAX_SOURCES_PER_MANIFEST} sources.`);
  }
  const seen = new Set();
  for (const s of sources) {
    if (!checkSourceShape(s)) {
      throw new ContextError('INVALID_SOURCE', `Malformed source record '${s?.sourceId}'.`);
    }
    if (seen.has(s.sourceId)) {
      throw new ContextError('DUPLICATE_SOURCE_ID', `Duplicate sourceId '${s.sourceId}'.`);
    }
    seen.add(s.sourceId);
  }
  const sortedSources = [...sources].sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1));
  const taskBindings = [];
  const manifest = {
    kind: MANIFEST_KIND,
    projectId,
    goalRevision,
    revision: computeRevision({ projectId, goalRevision, sources: sortedSources, taskBindings }),
    sources: sortedSources,
    taskBindings,
  };
  return freezeDeep(manifest);
}

/**
 * Structural + pin verification. Recomputes the revision and checks that
 * every binding references known sources. Throws ContextError otherwise.
 * @param {unknown} manifest
 * @returns {true}
 */
export function verifyManifest(manifest) {
  if (manifest === null || typeof manifest !== 'object') {
    throw new ContextError('INVALID_MANIFEST', 'Manifest must be an object.');
  }
  const m = /** @type {ContextManifest} */ (manifest);
  if (m.kind !== MANIFEST_KIND) {
    throw new ContextError('INVALID_MANIFEST', `Unknown manifest kind '${m.kind}'.`);
  }
  if (typeof m.projectId !== 'string' || m.projectId.trim() === '') {
    throw new ContextError('INVALID_MANIFEST', 'Manifest projectId is missing.');
  }
  if (typeof m.goalRevision !== 'string' || m.goalRevision.trim() === '') {
    throw new ContextError('INVALID_MANIFEST', 'Manifest goalRevision is missing.');
  }
  if (!Array.isArray(m.sources) || !Array.isArray(m.taskBindings)) {
    throw new ContextError('INVALID_MANIFEST', 'Manifest sources/taskBindings must be arrays.');
  }
  const ids = new Set();
  for (const s of m.sources) {
    if (!checkSourceShape(s)) {
      throw new ContextError('INVALID_SOURCE', `Malformed source record '${s?.sourceId}'.`);
    }
    if (ids.has(s.sourceId)) {
      throw new ContextError('DUPLICATE_SOURCE_ID', `Duplicate sourceId '${s.sourceId}'.`);
    }
    ids.add(s.sourceId);
  }
  for (const b of m.taskBindings) {
    if (!b || typeof b.taskKey !== 'string' || b.taskKey === '') {
      throw new ContextError('INVALID_TASK', 'Task binding has an invalid taskKey.');
    }
    for (const id of b.sourceIds ?? []) {
      if (!ids.has(id)) {
        throw new ContextError('UNKNOWN_SOURCE', `Task '${b.taskKey}' references unknown source '${id}'.`);
      }
    }
  }
  const expected = computeRevision({
    projectId: m.projectId,
    goalRevision: m.goalRevision,
    sources: m.sources,
    taskBindings: m.taskBindings,
  });
  if (m.revision !== expected) {
    throw new ContextError(
      'REVISION_MISMATCH',
      `Manifest revision '${m.revision}' does not match content (expected '${expected}'): tampered or hand-edited.`,
    );
  }
  return true;
}

function buildManifest(projectId, goalRevision, sources, taskBindings) {
  const sortedSources = [...sources].sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1));
  const sortedBindings = [...taskBindings]
    .map((b) => ({ taskKey: b.taskKey, sourceIds: [...b.sourceIds], goalRevision: b.goalRevision }))
    .sort((a, b) => (a.taskKey < b.taskKey ? -1 : 1));
  return freezeDeep({
    kind: MANIFEST_KIND,
    projectId,
    goalRevision,
    revision: computeRevision({ projectId, goalRevision, sources: sortedSources, taskBindings: sortedBindings }),
    sources: sortedSources,
    taskBindings: sortedBindings,
  });
}

/**
 * Add sources to a manifest (ingestion-time growth). Verifies the base
 * first — a tampered base never gets a successor — then returns a NEW
 * frozen manifest; the input is untouched.
 *
 * @param {ContextManifest} manifest
 * @param {SourceRecord[]} newSources
 * @returns {ContextManifest} frozen, with a new revision.
 */
export function addSources(manifest, newSources) {
  verifyManifest(manifest);
  if (!Array.isArray(newSources) || newSources.length === 0) {
    throw new ContextError('INVALID_SOURCE', 'addSources requires a non-empty sources array.');
  }
  const merged = new Map(manifest.sources.map((s) => [s.sourceId, s]));
  for (const s of newSources) {
    if (!checkSourceShape(s)) {
      throw new ContextError('INVALID_SOURCE', `Malformed source record '${s?.sourceId}'.`);
    }
    const existing = merged.get(s.sourceId);
    if (existing && existing.sha256 !== s.sha256) {
      throw new ContextError(
        'DUPLICATE_SOURCE_ID',
        `sourceId '${s.sourceId}' already pins a different hash; use a new sourceId (immutable pins).`,
      );
    }
    merged.set(s.sourceId, s);
  }
  if (merged.size > MAX_SOURCES_PER_MANIFEST) {
    throw new ContextError('TOO_MANY_SOURCES', `Manifest caps at ${MAX_SOURCES_PER_MANIFEST} sources.`);
  }
  return buildManifest(manifest.projectId, manifest.goalRevision, [...merged.values()], manifest.taskBindings);
}

/**
 * Bind a task to its least-necessary sources. Rebinding the same taskKey
 * replaces the binding (explicit per-task refresh). Returns a NEW frozen
 * manifest with a new revision; the input is untouched.
 *
 * @param {ContextManifest} manifest
 * @param {{taskKey: string, sourceIds: string[], goalRevision?: string}} input
 * @returns {ContextManifest} frozen.
 */
export function bindTask(manifest, input) {
  verifyManifest(manifest);
  const taskKey = input?.taskKey;
  const sourceIds = input?.sourceIds;
  const goalRevision = input?.goalRevision ?? manifest.goalRevision;
  if (typeof taskKey !== 'string' || taskKey.trim() === '' || taskKey.length > 64) {
    throw new ContextError('INVALID_TASK', 'taskKey must be a non-empty string up to 64 chars.');
  }
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
    throw new ContextError('INVALID_TASK', `Task '${taskKey}' must bind at least one source.`);
  }
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new ContextError('INVALID_TASK', `Task '${taskKey}' binds a duplicate sourceId.`);
  }
  if (sourceIds.length > MAX_SOURCES_PER_TASK) {
    throw new ContextError(
      'TOO_MANY_TASK_SOURCES',
      `Task '${taskKey}' binds ${sourceIds.length} sources; cap is ${MAX_SOURCES_PER_TASK} (scoped excerpts, not dumps).`,
    );
  }
  const known = new Set(manifest.sources.map((s) => s.sourceId));
  for (const id of sourceIds) {
    if (!known.has(id)) {
      throw new ContextError('UNKNOWN_SOURCE', `Task '${taskKey}' references unknown source '${id}'.`);
    }
  }
  if (typeof goalRevision !== 'string' || goalRevision.trim() === '') {
    throw new ContextError('INVALID_MANIFEST', 'Binding goalRevision must be a non-empty string.');
  }
  const taskBindings = manifest.taskBindings.filter((b) => b.taskKey !== taskKey);
  taskBindings.push({ taskKey, sourceIds: [...sourceIds], goalRevision });
  return buildManifest(manifest.projectId, manifest.goalRevision, manifest.sources, taskBindings);
}

/**
 * @typedef {object} ContextActor
 * @property {string} id
 * @property {string} role - `owner` spans projects; every other role must
 *   be scoped via `projects` (AUTO_SAFE `context.read` semantics).
 * @property {string[]} [projects]
 */

/**
 * @typedef {object} ScopedContext version-pinned, task-scoped retrieval view.
 * @property {string} kind
 * @property {string} projectId
 * @property {string} revision - pinned manifest revision the attempt must cite.
 * @property {string} taskKey
 * @property {string} goalRevision
 * @property {SourceRecord[]} sources - only the bound sources.
 */

/**
 * Retrieve exactly the sources bound to one task, ACL-checked. This is the
 * only read path workers should use: scoped references, never the whole
 * manifest. Throws ContextError (`TASK_NOT_BOUND`, `CROSS_PROJECT_DENIED`,
 * `UNKNOWN_ACTOR`) instead of returning partial data.
 *
 * @param {ContextManifest} manifest
 * @param {string} taskKey
 * @param {ContextActor} actor
 * @returns {ScopedContext} frozen.
 */
export function manifestForTask(manifest, taskKey, actor) {
  verifyManifest(manifest);
  if (!actor || typeof actor.role !== 'string' || actor.role === '') {
    throw new ContextError('UNKNOWN_ACTOR', 'An authenticated actor with a role is required.');
  }
  if (actor.role !== 'owner') {
    const projects = Array.isArray(actor.projects) ? actor.projects : [];
    if (!projects.includes(manifest.projectId)) {
      throw new ContextError(
        'CROSS_PROJECT_DENIED',
        `Role '${actor.role}' is not scoped to project '${manifest.projectId}'.`,
      );
    }
  }
  const binding = manifest.taskBindings.find((b) => b.taskKey === taskKey);
  if (!binding) {
    throw new ContextError('TASK_NOT_BOUND', `No context bound for task '${taskKey}' at revision '${manifest.revision}'.`);
  }
  const byId = new Map(manifest.sources.map((s) => [s.sourceId, s]));
  const sources = binding.sourceIds.map((id) => byId.get(id));
  return freezeDeep({
    kind: MANIFEST_KIND,
    projectId: manifest.projectId,
    revision: manifest.revision,
    taskKey,
    goalRevision: binding.goalRevision,
    sources,
  });
}

/**
 * True when an attempt's cited revision is still the manifest head. A
 * `false` means the context changed underneath the attempt: the worker
 * must re-fetch via `manifestForTask` under an explicit refresh event,
 * never keep working from the stale snapshot.
 *
 * @param {ContextManifest} manifest
 * @param {string} revision
 */
export function attemptIsCurrent(manifest, revision) {
  verifyManifest(manifest);
  return manifest.revision === revision;
}

/**
 * Build the explicit context-refresh event that must accompany any
 * manifest successor an attempt adopts (per `context-and-memory.md`:
 * "subsequent edits require explicit context-refresh event").
 *
 * @param {{manifest: ContextManifest, prevRevision: string, reason: string, actorId: string}} input
 */
export function refreshEvent(input) {
  const { manifest, prevRevision, reason, actorId } = input ?? {};
  verifyManifest(manifest);
  if (typeof prevRevision !== 'string' || prevRevision === '') {
    throw new ContextError('INVALID_MANIFEST', 'refreshEvent requires the previous revision.');
  }
  if (prevRevision === manifest.revision) {
    throw new ContextError('NO_CHANGE', 'Manifest revision is unchanged; no refresh event needed.');
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new ContextError('INVALID_MANIFEST', 'refreshEvent requires a reason.');
  }
  if (typeof actorId !== 'string' || actorId.trim() === '') {
    throw new ContextError('UNKNOWN_ACTOR', 'refreshEvent requires an actorId.');
  }
  return freezeDeep({
    type: 'context.refreshed',
    projectId: manifest.projectId,
    prevRevision,
    revision: manifest.revision,
    reason,
    actorId,
  });
}
