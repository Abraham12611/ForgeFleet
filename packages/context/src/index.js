/**
 * Public entry for `@forgefleet/context` (FF-011).
 */
export {
  CONTEXT_VERSION,
  MANIFEST_KIND,
  MAX_FILE_BYTES,
  MAX_SOURCES_PER_MANIFEST,
  MAX_SOURCES_PER_TASK,
  MAX_EXCERPT_CHARS,
  TEXT_MIMES,
  EXTRACTABLE_MIMES,
  ContextError,
  normalizeMediaType,
  validateSource,
  sha256Hex,
  ingestSource,
  computeRevision,
  createManifest,
  verifyManifest,
  addSources,
  bindTask,
  manifestForTask,
  attemptIsCurrent,
  refreshEvent,
} from './manifest.js';
export { redactSecrets, redactionKinds } from './redact.js';
