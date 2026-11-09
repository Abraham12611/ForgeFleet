/**
 * E19 — Devin capability probe and safe fallback (FF-010).
 *
 * Fixture-level spike: E02/E03 have no landed implementation on this
 * branch, and no live Devin evidence exists on this host, so every
 * function here is pure and read-only. Nothing spawns a process or
 * constructs supervised launch argv — deliberately, so an `unsupported`
 * verdict can never degrade into guessed `--devin` flags.
 *
 * Flow: `planDevinProbe()` (read-only argv) -> operator runs the plan
 * through E02-owned discovery plumbing -> `assessDevinCapability()`
 * folds the sanitized outputs into a `ProviderCapability` -> the
 * registry routes `devin` dispatches to `supervised`, the
 * controlled-terminal fallback, or `reject`.
 */

import type { ProviderCapability } from "./types.ts";

export const DEVIN_PROVIDER_NAME = "devin";

/**
 * Ordered read-only probe plan for one resolved Orca executable. Every
 * entry must satisfy `isMutationFreeProbeArgv`; anything that starts,
 * steers, creates, or deletes runtime state is out of scope.
 */
export function planDevinProbe(): readonly (readonly string[])[] {
  return [
    ["--version"],
    ["status", "--json"],
    ["skills", "list", "--json"],
    ["skills", "get", "orchestration"],
    ["skills", "get", "orca-cli"],
    ["agent-context", "--json"],
    ["account", "list", "--json"],
    ["orchestration", "worker-list", "--json"],
  ];
}

/**
 * Mutation verbs that must never appear in a capability probe. Kept local
 * (instead of importing E02-owned discovery code) so this spike stays
 * inside `services/orca-bridge/src/providers/**`.
 */
const MUTATION_TOKENS: readonly string[] = [
  "open",
  "serve",
  "search",
  "terminal",
  "send",
  "create",
  "rm",
  "set",
  "dispatch",
  "worker-start",
  "worker-stop",
  "cancel",
  "delete",
  "restart",
  "start",
  "stop",
];

/** True when the argv contains no state-changing verb. */
export function isMutationFreeProbeArgv(argv: readonly string[]): boolean {
  const tokens = argv.join(" ").toLowerCase().split(/[\s=]+/);
  return !tokens.some((token) => (MUTATION_TOKENS as readonly string[]).includes(token));
}

/**
 * Sanitized evidence folded into a capability verdict. All fields are
 * booleans/nulls derived from redacted probe output — never raw CLI text.
 */
export interface DevinEvidence {
  /** False when the Orca binary itself is unreachable. */
  binaryReachable: boolean | null;
  /** True when `--version` produced a parseable version line. */
  versionObserved: boolean;
  /** Devin auth presence from `account list` (null when not probed). */
  devinAccountPresent: boolean | null;
  /** Supervised worker verbs (`worker-start` et al.) in `agent-context`. */
  supervisedVerbsPresent: boolean | null;
  /**
   * Version-matched `orchestration`/`orca-cli` guide explicitly documents
   * supervised Devin launch (null when guides not read).
   */
  guideMentionsDevinSupervised: boolean | null;
  /** A disposable supervised Devin attempt reached `running` (S-06). */
  liveSupervisedSmokeSucceeded: boolean | null;
}

/**
 * Fold evidence into a registry-ready capability record.
 *
 * - `verified` requires BOTH schema verbs AND a live supervised smoke
 *   (docs never count as verification).
 * - `unsupported` requires positive evidence against supervised launch:
 *   the version-matched guide denies it, or the schema was read and the
 *   verbs are absent. Missing evidence alone yields `unknown`, never
 *   `unsupported`.
 * - `unavailable` means the binary itself is unreachable; no fallback.
 */
export function assessDevinCapability(
  evidence: DevinEvidence,
): ProviderCapability {
  if (evidence.binaryReachable === false) {
    return {
      name: DEVIN_PROVIDER_NAME,
      status: "unavailable",
      supervisedSupported: false,
      terminalFallbackAllowed: false,
      notes:
        "Orca executable unreachable; Devin supervised and terminal-fallback dispatch both unavailable",
    };
  }
  if (
    evidence.liveSupervisedSmokeSucceeded === true &&
    evidence.supervisedVerbsPresent === true
  ) {
    return {
      name: DEVIN_PROVIDER_NAME,
      status: "verified",
      supervisedSupported: true,
      terminalFallbackAllowed: true,
      notes:
        "supervised Devin launch verified by live smoke plus schema verbs; fallback remains available",
    };
  }
  if (
    evidence.guideMentionsDevinSupervised === false ||
    evidence.supervisedVerbsPresent === false
  ) {
    return {
      name: DEVIN_PROVIDER_NAME,
      status: "unsupported",
      supervisedSupported: false,
      terminalFallbackAllowed: true,
      notes:
        "no verified supervised Devin launch; controlled-terminal fallback only, never guessed supervised flags",
    };
  }
  return {
    name: DEVIN_PROVIDER_NAME,
    status: "unknown",
    supervisedSupported: false,
    terminalFallbackAllowed: false,
    notes:
      "insufficient Devin evidence: run the read-only probe and S-06 smoke before dispatch",
  };
}

export interface DevinFallback {
  /** Fixed descriptor: the bridge must route through controlled-terminal dispatch. No argv is supplied here. */
  mode: "controlled-terminal";
  supervised: false;
  reason: string;
}

/**
 * Describe the safe fallback for an `unsupported` Devin capability.
 * Returns `null` for any other status. The result intentionally carries
 * no `argv`, flags, or command strings: E03-owned dispatch code owns the
 * terminal-launch shape, and this module must never invent it.
 */
export function fallbackForDevin(
  capability: ProviderCapability,
): DevinFallback | null {
  if (
    capability.name.trim().toLowerCase() !== DEVIN_PROVIDER_NAME ||
    capability.status !== "unsupported" ||
    !capability.terminalFallbackAllowed
  ) {
    return null;
  }
  return {
    mode: "controlled-terminal",
    supervised: false,
    reason:
      "Devin supervised launch is unsupported; dispatch via controlled terminal only, with scoped context, lease, and idempotency key",
  };
}
