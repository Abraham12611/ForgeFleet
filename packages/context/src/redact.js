/**
 * Secret redaction for ForgeFleet context ingestion (FF-011).
 *
 * Layered backstop, NOT the security boundary. Regex redaction alone
 * cannot guarantee that no credential reaches an agent: novel token
 * formats will always exist. The actual boundaries are:
 *
 * 1. Default-deny upload validation in `manifest.js` (mime allowlist plus
 *    blocked secret-bearing filenames/paths) — known secret files never
 *    enter context at all.
 * 2. No serving without an E07 policy allow-decision (`manifestForTask`
 *    requires `options.authorization`; see `manifest.js`). Excerpts are
 *    not exposed to real workers until that integration lands.
 * 3. This module: excerpts are ALWAYS derived from post-redaction text
 *    (see `ingestSource`), so a pattern miss degrades to a smaller leak
 *    surface, never to raw-bytes-in-prompt.
 *
 * Residual risk: an unrecognized high-entropy format below the entropy
 * floor, or credentials split across chunk boundaries, may pass through.
 * Treat excerpts as untrusted input on the agent side as well.
 */

/**
 * @typedef {object} RedactionHit
 * @property {string} kind - stable machine-readable pattern name.
 * @property {number} occurrences - how many matches were replaced.
 */

/**
 * @typedef {object} RedactionResult
 * @property {string} text - redacted text for excerpting/model handoff.
 * @property {RedactionHit[]} redactions - one entry per pattern that hit,
 *   in pattern-application order. Empty when the input was clean.
 */

// Matches `api_key` inside `OPENAI_API_KEY` too: the lookbehind rejects only
// alnum-adjacent hits (`myapi_key2` stays), unlike `\b` which also rejects
// underscore-adjacent hits. Values already redacted (`[...]`) are skipped so
// sequential patterns do not stack markers.
const CREDENTIAL_NAME = String.raw`api[_-]?key|api[_-]?secret|client[_-]?secret|access[_-]?token|auth[_-]?token|secret|password|passwd|pwd`;
const NAME_BOUND = String.raw`(?<![A-Za-z0-9])(?:${CREDENTIAL_NAME})`;

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
    kind: 'vendor-api-token',
    // Standalone vendor tokens such as `sk-...` / `sk-proj-...` shapes:
    // `sk-` prefix plus a long token body. Kept generic (not vendor-tied)
    // so similar shapes are caught without enumerating providers.
    re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
    replacement: '[REDACTED:vendor-api-token]',
  },
  {
    kind: 'bearer-token',
    re: /\bBearer\s+[A-Za-z0-9\-._~+/=]{8,}/g,
    replacement: '[REDACTED:bearer-token]',
  },
  {
    kind: 'url-credentials',
    // `https://user:pass@host` — the userinfo never reaches an excerpt.
    re: /([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/\s:@?#]+):([^/\s@?#]+)@/g,
    replacement: '$1[REDACTED:url-credentials]@',
  },
  {
    kind: 'credential-header',
    // `X-Api-Key: value` / `Authorization: <non-bearer scheme value>`.
    // Bearer values are handled above; the negative lookahead skips values
    // an earlier pattern already redacted.
    re: new RegExp(`(${String.raw`(?<![A-Za-z0-9])(?:x-)?(?:${CREDENTIAL_NAME})`})\\s*:\\s*(?!\\[)[^\\s;,]+`, 'gi'),
    replacement: (_match, name) => `${name}: [REDACTED:credential]`,
  },
  {
    kind: 'credential-assignment',
    // `password = hunter2`, `OPENAI_API_KEY=...`, `secret:'x'` — the key
    // name is preserved so the excerpt stays readable; the value is not.
    re: new RegExp(`(${NAME_BOUND})\\b(\\s*[:=]\\s*)(?!\\[)(['"]?)[^\\s'";,\\]}]+(['"]?)`, 'gi'),
    replacement: (_match, key, gap) => `${key}${gap}[REDACTED:credential]`,
  },
];

/** Entropy floor: random base64-ish material sits near 6 bits/char, hex
 *  digests cannot exceed 4.0, English long words sit near 3.5. */
const ENTROPY_MIN_LENGTH = 20;
const ENTROPY_BITS_PER_CHAR = 4.5;

function shannonPerChar(token) {
  const freq = new Map();
  for (const ch of token) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / token.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Defense in depth for token formats no pattern names: redact long,
 * high-entropy tokens. Hex digests (pinned SHAs, etc.) and ordinary words
 * are explicitly spared; everything else random-looking is redacted.
 */
function redactHighEntropy(text) {
  let occurrences = 0;
  const out = text.replace(/[A-Za-z0-9+/=_-]{20,}/g, (token) => {
    if (/^[0-9a-fA-F]+$/.test(token)) return token;
    if (shannonPerChar(token) >= ENTROPY_BITS_PER_CHAR) {
      occurrences += 1;
      return '[REDACTED:high-entropy-secret]';
    }
    return token;
  });
  return { text: out, occurrences };
}

/**
 * Redact secrets from text before excerpting, logging, or model handoff.
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
  const entropy = redactHighEntropy(out);
  out = entropy.text;
  if (entropy.occurrences > 0) {
    redactions.push({ kind: 'high-entropy-secret', occurrences: entropy.occurrences });
  }
  return { text: out, redactions };
}

/** Pattern kinds, in application order. Introspection helper for audits. */
export function redactionKinds() {
  return [...PATTERNS.map((p) => p.kind), 'high-entropy-secret'];
}
