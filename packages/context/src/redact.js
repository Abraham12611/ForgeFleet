/**
 * Secret redaction for ForgeFleet context ingestion (FF-011).
 *
 * Text excerpts handed to agents, logs, or prompts must never carry raw
 * credentials. `redactSecrets()` applies deterministic, content-based
 * patterns: anything plausibly a secret is replaced with a
 * `[REDACTED:<kind>]` marker, never passed through. The allowlist shape is
 * inverted on purpose — unknown sensitive-looking material is redacted
 * (fail closed); only text with no pattern hit passes through unchanged.
 *
 * This is a backstop, not the boundary: blocked filenames (`.env`,
 * `*.pem`, private keys) are rejected at validation time in
 * `manifest.js`, and the original hashed bytes stay behind the project
 * ACL. Redaction covers what validation cannot see — secrets pasted
 * inside otherwise innocent Markdown or specs.
 */

/**
 * @typedef {object} RedactionHit
 * @property {string} kind - stable machine-readable pattern name.
 * @property {number} occurrences - how many matches were replaced.
 */

/**
 * @typedef {object} RedactionResult
 * @property {string} text - redacted text safe for model handoff.
 * @property {RedactionHit[]} redactions - one entry per pattern that hit,
 *   in pattern-application order. Empty when the input was clean.
 */

const PATTERNS = [
  {
    kind: 'private-key',
    // PEM/OpenSSH private key blocks, multiline and non-greedy.
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED:private-key]',
  },
  {
    kind: 'aws-access-key',
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED:aws-access-key]',
  },
  {
    kind: 'github-token',
    re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{10,}\b/g,
    replacement: '[REDACTED:github-token]',
  },
  {
    kind: 'bearer-token',
    re: /\bBearer\s+[A-Za-z0-9\-._~+/=]{8,}/g,
    replacement: '[REDACTED:bearer-token]',
  },
  {
    kind: 'credential-assignment',
    // `password = hunter2`, `api_key: "abc"`, `secret:'x'` — the key name
    // is preserved so the excerpt stays readable; the value never is.
    re: /\b(api[_-]?key|api[_-]?secret|client[_-]?secret|access[_-]?token|auth[_-]?token|secret|password|passwd|pwd)\b(\s*[:=]\s*)(['"]?)[^\s'";,\]}]+(['"]?)/gi,
    replacement: (_match, key, gap) => `${key}${gap}[REDACTED:credential]`,
  },
];

/**
 * Redact secrets from text before model handoff, logging, or excerpting.
 * Pure function: same input always yields the same output.
 *
 * @param {string} text
 * @returns {RedactionResult}
 */
export function redactSecrets(text) {
  if (typeof text !== 'string') {
    throw new TypeError('redactSecrets expects a string');
  }
  /** @type {RedactionHit[]} */
  const redactions = [];
  let out = text;
  for (const { kind, re, replacement } of PATTERNS) {
    re.lastIndex = 0;
    let occurrences = 0;
    out = out.replace(re, (...args) => {
      occurrences += 1;
      return typeof replacement === 'function'
        ? replacement(...args)
        : replacement;
    });
    if (occurrences > 0) {
      redactions.push({ kind, occurrences });
    }
  }
  return { text: out, redactions };
}

/** Pattern kinds, in application order. Introspection helper for audits. */
export function redactionKinds() {
  return PATTERNS.map((p) => p.kind);
}
