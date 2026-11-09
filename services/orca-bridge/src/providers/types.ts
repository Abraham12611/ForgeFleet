/**
 * E19 — Provider registry shared types (FF-010).
 *
 * Mirrors the `RuntimeCapabilities.providers[]` shape in
 * `docs/05-contracts/bridge.openapi.yaml`. Pure types only: no process
 * spawning, no network, no Orca imports. E02 owns executable discovery and
 * E03 owns Muse dispatch; this module only tracks per-provider capability
 * and routes dispatch decisions so unsupported providers can never be
 * given guessed CLI flags.
 */

/** Capability states from the bridge OpenAPI contract (exact strings). */
export type ProviderStatus =
  | "verified"
  | "unsupported"
  | "unknown"
  | "unavailable";

export interface ProviderCapability {
  /** Lowercase provider key, e.g. `muse` or `devin`. */
  name: string;
  status: ProviderStatus;
  /** True only after live smoke evidence of supervised launch. */
  supervisedSupported: boolean;
  /**
   * True when a controlled-terminal fallback is permitted. Never implies
   * supervised launch is available.
   */
  terminalFallbackAllowed: boolean;
  /** Human-readable evidence summary; must not contain secrets. */
  notes: string;
}

export type DispatchRouteKind =
  | "supervised"
  | "terminal-fallback"
  | "reject";

/** HTTP mapping follows the bridge contract: 202 accepted, 422 capability/policy rejected. */
export interface DispatchRoute {
  route: DispatchRouteKind;
  httpStatus: 202 | 422 | 429;
  reason: string;
}
