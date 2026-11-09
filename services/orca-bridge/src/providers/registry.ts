/**
 * E19 — Provider registry and dispatch router (FF-010).
 *
 * Pure, dependency-free policy: records the capability status of each
 * worker provider (`muse`, `devin`, future runtimes) and decides whether
 * a dispatch request may use supervised launch, a controlled-terminal
 * fallback, or must be rejected.
 *
 * Safety rules (from `docs/03-architecture/orca-bridge.md` and contract
 * test #4 in `docs/05-contracts/contract-test-cases.md`):
 *
 * - Unknown provider names are rejected (HTTP 422), never defaulted.
 * - `unsupported` providers are never routed to `supervised`, even when
 *   the caller asks for it. The only permitted path is an explicitly
 *   allowed controlled-terminal fallback.
 * - `unknown` / `unavailable` providers reject every dispatch until a
 *   capability probe records `verified` or `unsupported`.
 * - This module never constructs CLI argv. There is deliberately no
 *   function here that builds supervised launch flags for any provider.
 */

import type {
  DispatchRoute,
  ProviderCapability,
  ProviderStatus,
} from "./types.ts";

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function checkedNotes(notes: string): string {
  const trimmed = notes.trim();
  if (!trimmed) throw new Error("provider notes must be non-empty");
  return trimmed;
}

export class ProviderRegistry {
  private readonly entries = new Map<string, ProviderCapability>();

  constructor(initial: readonly ProviderCapability[] = []) {
    for (const entry of initial) this.register(entry);
  }

  register(entry: ProviderCapability): void {
    const name = normalizeName(entry.name);
    if (!name) throw new Error("provider name must be non-empty");
    if (this.entries.has(name)) {
      throw new Error(`provider "${name}" is already registered`);
    }
    this.entries.set(name, {
      name,
      status: entry.status,
      supervisedSupported: entry.supervisedSupported,
      terminalFallbackAllowed: entry.terminalFallbackAllowed,
      notes: checkedNotes(entry.notes),
    });
  }

  get(name: string): ProviderCapability | null {
    return this.entries.get(normalizeName(name)) ?? null;
  }

  setStatus(name: string, status: ProviderStatus, notes: string): void {
    const key = normalizeName(name);
    const current = this.entries.get(key);
    if (!current) throw new Error(`unknown provider "${key}"`);
    this.entries.set(key, {
      ...current,
      status,
      // Only `verified` may carry supervised support; any other status
      // clears it so stale `true` flags cannot leak across transitions.
      supervisedSupported:
        status === "verified" ? current.supervisedSupported : false,
      // `unknown` / `unavailable` close the terminal fallback too until
      // a probe records an explicit verdict.
      terminalFallbackAllowed:
        status === "verified" || status === "unsupported"
          ? current.terminalFallbackAllowed
          : false,
      notes: checkedNotes(notes),
    });
  }

  list(): ProviderCapability[] {
    return [...this.entries.values()];
  }

  /** Emit the OpenAPI-compatible `providers[]` payload (status + notes). */
  toRuntimeProviders(): { name: string; status: ProviderStatus; notes: string }[] {
    return this.list().map(({ name, status, notes }) => ({
      name,
      status,
      notes,
    }));
  }

  /**
   * Route a dispatch request for `workerKind`. Pure policy: no spawning,
   * no flag construction. Callers translate `terminal-fallback` into a
   * controlled-terminal attempt through E03-owned dispatch code; this
   * function never supplies the argv for that attempt.
   */
  routeDispatch(workerKind: string): DispatchRoute {
    const key = normalizeName(workerKind);
    const capability = this.entries.get(key);
    if (!capability) {
      return {
        route: "reject",
        httpStatus: 422,
        reason: `unknown provider "${key}": no capability record; refusing to guess launch flags`,
      };
    }
    if (capability.status === "verified" && capability.supervisedSupported) {
      return {
        route: "supervised",
        httpStatus: 202,
        reason: `provider "${key}" verified for supervised launch`,
      };
    }
    if (capability.status === "unsupported") {
      if (capability.terminalFallbackAllowed) {
        return {
          route: "terminal-fallback",
          httpStatus: 202,
          reason:
            `provider "${key}" has no verified supervised launch; ` +
            `controlled-terminal fallback only, no supervised flags attempted`,
        };
      }
      return {
        route: "reject",
        httpStatus: 422,
        reason: `provider "${key}" unsupported and terminal fallback is disabled`,
      };
    }
    if (capability.status === "unknown") {
      return {
        route: "reject",
        httpStatus: 422,
        reason:
          `provider "${key}" capability is unknown: complete the read-only ` +
          `probe before dispatch; refusing to guess launch flags`,
      };
    }
    return {
      route: "reject",
      httpStatus: 422,
      reason: `provider "${key}" is unavailable: ${capability.notes}`,
    };
  }
}

/** Default registry: Muse is E03's lane (unknown here), Devin is E19's spike. */
export function createDefaultRegistry(): ProviderRegistry {
  return new ProviderRegistry([
    {
      name: "muse",
      status: "unknown",
      supervisedSupported: false,
      terminalFallbackAllowed: false,
      notes: "owned by E03; E19 must not set Muse capability",
    },
    {
      name: "devin",
      status: "unknown",
      supervisedSupported: false,
      terminalFallbackAllowed: false,
      notes: "FF-010 spike pending: no live probe evidence on this host",
    },
  ]);
}
