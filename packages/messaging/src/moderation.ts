/**
 * E10 / FF-014 — Moderation: all agent text is untrusted input.
 *
 * Rules from `docs/03-architecture/communications.md` and
 * `docs/05-contracts/contract-test-cases.md`:
 * - strip secrets before events/logs/audit/UI,
 * - limit body size,
 * - validate attachment MIME,
 * - a chat message can never override privileged policy.
 */

import { MESSAGE_KINDS, MESSAGE_LABELS, type AttachmentRef, type MessageKind, type MessageLabel } from "./types.ts";

export const MAX_BODY_CHARS = 20000;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const ALLOWED_MIME_PREFIXES = ["text/", "image/", "application/pdf"];

const ALLOWED_MIME_EXACT = new Set([
  "application/json",
  "application/x-yaml",
  "application/problem+json",
]);

/** Patterns whose matches are replaced with `[REDACTED:<label>]`. */
const SECRET_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "PRIVATE_KEY", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { label: "TOKEN", re: /\b(ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[bpas]-[A-Za-z0-9-]{8,}|sk-[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16})\b/g },
  { label: "BEARER", re: /\b[Bb]earer\s+[A-Za-z0-9\-._~+/]{12,}={0,2}\b/g },
  { label: "SECRET_VALUE", re: /(api[_-]?key|client[_-]?secret|password|passwd|pwd|auth[_-]?token|access[_-]?token|refresh[_-]?token|private[_-]?key|db[_-]?password|database[_-]?url)\s*[:=]\s*['"]?[^\s'";,]{4,}['"]?/gi },
];

export function scrubSecrets(text: string): string {
  let out = text;
  for (const { label, re } of SECRET_PATTERNS) {
    out = out.replace(re, `[REDACTED:${label}]`);
  }
  return out;
}

export function isValidKind(kind: string): kind is MessageKind {
  return (MESSAGE_KINDS as readonly string[]).includes(kind);
}

export function validateLabels(labels: unknown): MessageLabel[] {
  if (labels === undefined) return [];
  if (!Array.isArray(labels)) throw new Error("labels must be an array");
  const allowed = new Set<string>(MESSAGE_LABELS as readonly string[]);
  for (const label of labels) {
    if (!allowed.has(label as string)) throw new Error(`unknown message label: ${String(label)}`);
  }
  return labels as MessageLabel[];
}

export function validateBody(body: unknown): string {
  if (typeof body !== "string" || body.length === 0) {
    throw new Error("body must be a non-empty string");
  }
  if (body.length > MAX_BODY_CHARS) {
    throw new Error(`body exceeds ${MAX_BODY_CHARS} characters`);
  }
  return body;
}

export function validateAttachments(
  attachments: unknown,
): AttachmentRef[] | undefined {
  if (attachments === undefined) return undefined;
  if (!Array.isArray(attachments)) {
    throw new Error("attachments must be an array");
  }
  return attachments.map((a) => {
    if (typeof a !== "object" || a === null) {
      throw new Error("attachment must be an object");
    }
    const { name, mime, bytes } = a as Record<string, unknown>;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("attachment.name must be a non-empty string");
    }
    if (typeof mime !== "string") {
      throw new Error("attachment.mime must be a string");
    }
    const okMime =
      ALLOWED_MIME_PREFIXES.some((p) => mime.startsWith(p)) ||
      ALLOWED_MIME_EXACT.has(mime);
    if (!okMime) {
      throw new Error(`attachment MIME not allowed: ${mime}`);
    }
    if (typeof bytes !== "number" || bytes < 0 || bytes > MAX_ATTACHMENT_BYTES) {
      throw new Error("attachment.bytes out of range");
    }
    return { name, mime, bytes };
  });
}

/**
 * Questions (blockers are questions with the `blocker` label) require
 * severity + deadline so the router can prioritize wakeups and escalate
 * on expiry (`docs/04-flows/agent-messaging.md`: questions need
 * deadline/severity).
 */
export function validateQuestionFields(
  kind: MessageKind,
  severity: unknown,
  deadlineAt: unknown,
): { severity: "low" | "normal" | "high" | "urgent" | undefined; deadlineAt: string | null } {
  if (kind !== "question") {
    return { severity: undefined, deadlineAt: null };
  }
  if (!["low", "normal", "high", "urgent"].includes(severity as string)) {
    throw new Error(`${kind} requires severity low|normal|high|urgent`);
  }
  if (typeof deadlineAt !== "string" || Number.isNaN(Date.parse(deadlineAt))) {
    throw new Error(`${kind} requires an ISO deadlineAt`);
  }
  return {
    severity: severity as "low" | "normal" | "high" | "urgent",
    deadlineAt,
  };
}
