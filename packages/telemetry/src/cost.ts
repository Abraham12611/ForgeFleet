/**
 * Cost ledger (FF-020, FR-10, scope-and-metrics "Cost efficiency").
 *
 * Contract: docs/03-architecture/observability-and-cost.md ("Cost ledger").
 * Tracks provider, model, inputTokens, outputTokens, billedUsd, source,
 * confidence. Never fabricates costs and never equates token consumption
 * with billed USD when no price data exists.
 *
 * Label rule (display distinction, unchanged by admission policy):
 * - billedUsd == null            -> "unknown" (shown as unknown, never $0)
 * - source is provider-invoice
 *   or provider-api              -> "actual"
 * - otherwise (price-table,
 *   manual-entry, unknown source) -> "estimated"
 *
 * Admission rule (fail-closed, per coordinator review on PR #49):
 * - The gate evaluates known + reserved + requested spend atomically
 *   against the budget in a single call. Use checkAndReserve() so a
 *   successful check holds its reservation without a TOCTOU gap.
 * - Unknown spend denies new billable dispatches by default
 *   (unknownPolicy "deny"). The only exception is an explicit,
 *   owner-authenticated conservative quota (unknownPolicy "reserve" with
 *   an OwnerQuotaPolicy), under which requested + already-reserved spend
 *   must fit inside the owner's unknownCapUsd.
 * - All money inputs (billedUsd, budgetUsd, requestedUsd, reservation
 *   amounts, quotas, caps) must be finite non-negative numbers.
 * - Hard ceilings: per-dispatch budgetUsd plus stored owner-signed
 *   provider quotas, per-project caps and one global cap; exposure must
 *   fit every applicable ceiling.
 * - Lifecycle: checkAndReserve() holds; settle() consumes the hold into a
 *   recorded entry on success; release() frees it on failure; reconcile()
 *   drops holds with no live owner after a failure or restart.
 *   importReservations() reloads holds from the durable journal.
 */

import type { ActorIdentity, CostLabel, CostSource, IsoDateTimeString } from "./types.ts";

export interface CostEntry {
  entryId: string;
  projectId: string;
  taskId?: string;
  attemptId?: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Billed USD, or null when the provider reported no billable figure. */
  billedUsd: number | null;
  source: CostSource;
  recordedAt: IsoDateTimeString;
  recordedBy: ActorIdentity;
}

export interface CostValidationError {
  field: string;
  message: string;
}

/** Finite non-negative money guard. Rejects NaN, Infinity and negatives. */
export function isValidMoney(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function validateCostEntry(entry: CostEntry): CostValidationError[] {
  const errors: CostValidationError[] = [];
  if (!entry.entryId) errors.push({ field: "entryId", message: "entryId is required" });
  if (!entry.projectId) errors.push({ field: "projectId", message: "projectId is required" });
  if (!entry.provider) errors.push({ field: "provider", message: "provider is required" });
  if (!entry.model) errors.push({ field: "model", message: "model is required" });
  if (!Number.isInteger(entry.inputTokens) || entry.inputTokens < 0) {
    errors.push({ field: "inputTokens", message: "inputTokens must be a non-negative integer" });
  }
  if (!Number.isInteger(entry.outputTokens) || entry.outputTokens < 0) {
    errors.push({ field: "outputTokens", message: "outputTokens must be a non-negative integer" });
  }
  if (entry.billedUsd !== null && !isValidMoney(entry.billedUsd)) {
    errors.push({ field: "billedUsd", message: "billedUsd must be null or a finite non-negative number" });
  }
  if (!entry.recordedAt || Number.isNaN(Date.parse(entry.recordedAt))) {
    errors.push({ field: "recordedAt", message: "recordedAt must be a valid date-time string" });
  }
  return errors;
}

/** Operator-facing label for one entry. Pure function of source + presence. */
export function labelCostEntry(entry: Pick<CostEntry, "billedUsd" | "source">): CostLabel {
  if (entry.billedUsd === null) return "unknown";
  if (entry.source === "provider-invoice" || entry.source === "provider-api") return "actual";
  return "estimated";
}

export interface CostSummary {
  projectId: string | null;
  entryCount: number;
  /** Sum of non-null billedUsd. Null when no entry carries a USD figure. */
  totalKnownUsd: number | null;
  actualUsd: number;
  estimatedUsd: number;
  /** Entries with no USD figure. Their spend is unknown, not zero. */
  uncoveredCount: number;
  label: CostLabel;
  asOf: IsoDateTimeString;
}

export interface Reservation {
  reservationId: string;
  projectId: string;
  taskId?: string;
  provider?: string;
  amountUsd: number;
  authorizedBy: string;
  at: IsoDateTimeString;
}

export interface ReservationInput {
  reservationId: string;
  projectId: string;
  taskId?: string;
  provider?: string;
  amountUsd: number;
  authorizedBy: string;
  at?: IsoDateTimeString;
}

/** Fail-closed admission policy for unmeasured spend. Default "deny". */
export type UnknownSpendPolicy = "deny" | "reserve";

/**
 * Explicit owner quota for unmeasured spend. Required when unknownPolicy
 * is "reserve": the gate allows a dispatch only while
 * reserved + requested fits inside unknownCapUsd.
 */
export interface OwnerQuotaPolicy {
  unknownCapUsd: number;
  authorizedBy: string;
}

export interface BudgetCheckArgs {
  summary: CostSummary;
  budgetUsd: number;
  authorized: boolean;
  requestedUsd?: number | null;
  provider?: string;
  unknownPolicy?: UnknownSpendPolicy;
  ownerPolicy?: OwnerQuotaPolicy;
}

export interface BudgetDecision {
  allowed: boolean;
  reason: string;
  spendKnownUsd: number | null;
  spendLabel: CostLabel;
  budgetUsd: number;
  reservedUsd: number;
  /** known + reserved + requested: the atomic exposure the gate decided on. */
  exposureUsd: number;
  requestedUsd: number;
}

export interface CheckAndReserveResult {
  decision: BudgetDecision;
  /** Reservation id held on success when requestedUsd > 0, else null. */
  reservationId: string | null;
}

/**
 * Append-only in-memory ledger. Durable persistence belongs to E06;
 * this class owns labeling, aggregation, reservations and gating only.
 * All admission methods are synchronous so each check-and-reserve is
 * atomic with respect to other calls on this instance.
 */
export interface MutationResult {
  accepted: boolean;
  errors: CostValidationError[];
  /** True when the call replayed an identical earlier mutation (no double-count). */
  duplicate?: boolean;
}

export class CostLedger {
  private readonly entries: CostEntry[] = [];
  private readonly seenIds = new Set<string>();
  private readonly reservations = new Map<string, Reservation>();
  private readonly providerQuotas = new Map<string, number>();
  private globalCapUsd: number | null = null;
  private readonly projectCaps = new Map<string, number>();

  /** Records one entry. Duplicate entryIds are rejected (idempotent ingest). */
  record(entry: CostEntry): { accepted: boolean; errors: CostValidationError[] } {
    const errors = validateCostEntry(entry);
    if (errors.length > 0) return { accepted: false, errors };
    if (this.seenIds.has(entry.entryId)) {
      return {
        accepted: false,
        errors: [{ field: "entryId", message: "duplicate entryId; already recorded" }],
      };
    }
    this.seenIds.add(entry.entryId);
    this.entries.push({ ...entry });
    return { accepted: true, errors: [] };
  }

  summarize(projectId: string | null, asOf: IsoDateTimeString = new Date().toISOString()): CostSummary {
    const scoped = projectId === null ? this.entries : this.entries.filter((e) => e.projectId === projectId);
    let actualUsd = 0;
    let estimatedUsd = 0;
    let uncoveredCount = 0;
    let hasActual = false;
    let hasEstimated = false;
    for (const e of scoped) {
      const label = labelCostEntry(e);
      if (label === "unknown" || e.billedUsd === null) {
        uncoveredCount += 1;
      } else if (label === "actual") {
        actualUsd += e.billedUsd;
        hasActual = true;
      } else {
        estimatedUsd += e.billedUsd;
        hasEstimated = true;
      }
    }
    const totalKnownUsd = hasActual || hasEstimated ? actualUsd + estimatedUsd : null;
    const label: CostLabel =
      scoped.length === 0 || totalKnownUsd === null
        ? "unknown"
        : !hasEstimated && uncoveredCount === 0
          ? "actual"
          : "estimated";
    return { projectId, entryCount: scoped.length, totalKnownUsd, actualUsd, estimatedUsd, uncoveredCount, label, asOf };
  }

  /**
   * Holds spend against a project budget. Requires an authorizing owner
   * identity. Idempotent: replaying the identical hold (same id, project,
   * amount, provider, task) returns accepted with duplicate: true and does
   * not double-count. Reusing an id for different terms is rejected.
   */
  reserve(input: ReservationInput): MutationResult {
    const errors: CostValidationError[] = [];
    if (!input.reservationId) errors.push({ field: "reservationId", message: "reservationId is required" });
    if (!input.projectId) errors.push({ field: "projectId", message: "projectId is required" });
    if (!isValidMoney(input.amountUsd)) {
      errors.push({ field: "amountUsd", message: "amountUsd must be a finite non-negative number" });
    }
    if (!input.authorizedBy) {
      errors.push({ field: "authorizedBy", message: "reservation requires an authorizing owner identity" });
    }
    if (errors.length > 0) return { accepted: false, errors };
    const held = this.reservations.get(input.reservationId);
    if (held !== undefined) {
      if (
        held.projectId === input.projectId &&
        held.amountUsd === input.amountUsd &&
        (held.provider ?? null) === (input.provider ?? null) &&
        (held.taskId ?? null) === (input.taskId ?? null)
      ) {
        return { accepted: true, errors: [], duplicate: true };
      }
      return {
        accepted: false,
        errors: [{ field: "reservationId", message: "duplicate reservationId with different terms; rejected" }],
      };
    }
    this.reservations.set(input.reservationId, {
      reservationId: input.reservationId,
      projectId: input.projectId,
      taskId: input.taskId,
      provider: input.provider,
      amountUsd: input.amountUsd,
      authorizedBy: input.authorizedBy,
      at: input.at ?? new Date().toISOString(),
    });
    return { accepted: true, errors: [] };
  }

  release(reservationId: string): boolean {
    return this.reservations.delete(reservationId);
  }

  /**
   * Consumes a held reservation on dispatch success: atomically releases the
   * hold and records the actual cost entry. Validates first, so a bad entry
   * keeps the hold (fail-closed, no half-state). Fails when no matching
   * hold exists: spend must be admitted before it is consumed.
   */
  settle(reservationId: string, entry: CostEntry): MutationResult {
    const errors = validateCostEntry(entry);
    if (errors.length > 0) return { accepted: false, errors };
    const held = this.reservations.get(reservationId);
    if (held === undefined) {
      return {
        accepted: false,
        errors: [{ field: "reservationId", message: "no held reservation for this id; admit before consuming" }],
      };
    }
    if (held.projectId !== entry.projectId) {
      return {
        accepted: false,
        errors: [{ field: "projectId", message: "entry projectId does not match the held reservation" }],
      };
    }
    if (this.seenIds.has(entry.entryId)) {
      return {
        accepted: false,
        errors: [{ field: "entryId", message: "duplicate entryId; already recorded" }],
      };
    }
    this.reservations.delete(reservationId);
    this.seenIds.add(entry.entryId);
    this.entries.push({ ...entry });
    return { accepted: true, errors: [] };
  }

  /**
   * Restart/failure recovery: drops every held reservation that is not in
   * the live set (e.g. attempts still running after a crash) and returns
   * the released ids. Active holds are untouched.
   */
  reconcile(activeReservationIds: Iterable<string>): { released: string[] } {
    const active = new Set(activeReservationIds);
    const released: string[] = [];
    for (const id of this.reservations.keys()) {
      if (!active.has(id)) {
        this.reservations.delete(id);
        released.push(id);
      }
    }
    return { released: released.sort() };
  }

  /**
   * Bulk-loads held reservations (e.g. replaying the durable journal after
   * a restart). Invalid rows are skipped fail-closed; duplicate ids keep
   * the already-held terms. Returns per-row skip reasons for auditability.
   */
  importReservations(list: Reservation[]): { imported: number; skipped: Array<{ reservationId: string; reason: string }> } {
    let imported = 0;
    const skipped: Array<{ reservationId: string; reason: string }> = [];
    for (const r of list) {
      if (!r.reservationId || !r.projectId || !r.authorizedBy || !isValidMoney(r.amountUsd)) {
        skipped.push({ reservationId: r.reservationId ?? "", reason: "invalid reservation row; skipped" });
        continue;
      }
      if (this.reservations.has(r.reservationId)) {
        skipped.push({ reservationId: r.reservationId, reason: "duplicate reservationId; already held" });
        continue;
      }
      this.reservations.set(r.reservationId, { ...r });
      imported += 1;
    }
    return { imported, skipped };
  }

  reservedFor(projectId: string | null, provider?: string): number {
    let total = 0;
    for (const r of this.reservations.values()) {
      if (projectId !== null && r.projectId !== projectId) continue;
      if (provider !== undefined && r.provider !== undefined && r.provider !== provider) continue;
      total += r.amountUsd;
    }
    return total;
  }

  /** Sets (or overwrites) a hard provider quota in USD. Must be finite. */
  setProviderQuota(provider: string, quotaUsd: number): { accepted: boolean; errors: CostValidationError[] } {
    if (!provider) return { accepted: false, errors: [{ field: "provider", message: "provider is required" }] };
    if (!isValidMoney(quotaUsd)) {
      return { accepted: false, errors: [{ field: "quotaUsd", message: "quotaUsd must be a finite non-negative number" }] };
    }
    this.providerQuotas.set(provider, quotaUsd);
    return { accepted: true, errors: [] };
  }

  providerQuota(provider: string): number | null {
    return this.providerQuotas.get(provider) ?? null;
  }

  /**
   * Hard global ceiling across all projects (owner-signed). Overwrites any
   * previous global cap. Enforced on every admission alongside the
   * per-dispatch budget.
   */
  setGlobalCap(capUsd: number, authorizedBy: string): MutationResult {
    if (!isValidMoney(capUsd)) {
      return { accepted: false, errors: [{ field: "capUsd", message: "capUsd must be a finite non-negative number" }] };
    }
    if (!authorizedBy) {
      return { accepted: false, errors: [{ field: "authorizedBy", message: "cap requires an authorizing owner identity" }] };
    }
    this.globalCapUsd = capUsd;
    return { accepted: true, errors: [] };
  }

  globalCap(): number | null {
    return this.globalCapUsd;
  }

  /**
   * Hard per-project ceiling (owner-signed). Overwrites any previous cap
   * for the project. Enforced on every admission scoped to that project.
   */
  setProjectCap(projectId: string, capUsd: number, authorizedBy: string): MutationResult {
    if (!projectId) {
      return { accepted: false, errors: [{ field: "projectId", message: "projectId is required" }] };
    }
    if (!isValidMoney(capUsd)) {
      return { accepted: false, errors: [{ field: "capUsd", message: "capUsd must be a finite non-negative number" }] };
    }
    if (!authorizedBy) {
      return { accepted: false, errors: [{ field: "authorizedBy", message: "cap requires an authorizing owner identity" }] };
    }
    this.projectCaps.set(projectId, capUsd);
    return { accepted: true, errors: [] };
  }

  projectCap(projectId: string): number | null {
    return this.projectCaps.get(projectId) ?? null;
  }

  private providerKnownUsd(projectId: string | null, provider: string): number {
    let total = 0;
    for (const e of this.entries) {
      if (projectId !== null && e.projectId !== projectId) continue;
      if (e.provider !== provider || e.billedUsd === null) continue;
      total += e.billedUsd;
    }
    return total;
  }

  /**
   * Pre-dispatch budget gate. Evaluates known + reserved + requested
   * atomically against the budget. Fail-closed on unknown spend unless an
   * explicit owner quota policy covers the request. Denials are returned
   * as data so the caller can surface them; this method never dispatches.
   */
  checkBudget(args: BudgetCheckArgs): BudgetDecision {
    return this.evaluate(args, this.reservedFor(args.summary.projectId, args.provider));
  }

  /**
   * Shared admission evaluation over an explicit reserved total. Keeping
   * the reserved input explicit lets checkAndReserve re-evaluate an
   * idempotent replay without double-counting its own prior hold.
   */
  private evaluate(args: BudgetCheckArgs, reserved: number): BudgetDecision {
    const { summary } = args;
    const unknownPolicy: UnknownSpendPolicy = args.unknownPolicy ?? "deny";
    const base = {
      spendKnownUsd: summary.totalKnownUsd,
      spendLabel: summary.label,
      budgetUsd: args.budgetUsd,
      reservedUsd: 0,
      exposureUsd: 0,
      requestedUsd: 0,
    };
    if (!isValidMoney(args.budgetUsd)) {
      return { ...base, allowed: false, reason: "denied: budgetUsd must be a finite non-negative number" };
    }
    const requested = args.requestedUsd ?? 0;
    if (!isValidMoney(requested)) {
      return { ...base, allowed: false, reason: "denied: requestedUsd must be a finite non-negative number" };
    }
    if (!args.authorized) {
      return { ...base, allowed: false, requestedUsd: requested, reason: "denied: missing budget authorization" };
    }
    const known = summary.totalKnownUsd ?? 0;
    const exposure = known + reserved + requested;
    const withAmounts = { ...base, reservedUsd: reserved, exposureUsd: exposure, requestedUsd: requested };

    if (summary.label === "unknown") {
      if (unknownPolicy === "deny") {
        return {
          ...withAmounts,
          allowed: false,
          reason: `denied: spend is unknown (no priced entries); fail-closed without an owner-authorized unknown-spend quota (known ${known}, reserved ${reserved}, requested ${requested})`,
        };
      }
      const cap = args.ownerPolicy?.unknownCapUsd;
      if (!args.ownerPolicy || !args.ownerPolicy.authorizedBy || !isValidMoney(cap)) {
        return {
          ...withAmounts,
          allowed: false,
          reason: "denied: reserve policy requires an explicit owner quota (finite unknownCapUsd + authorizedBy)",
        };
      }
      if (reserved + requested > (cap as number)) {
        return {
          ...withAmounts,
          allowed: false,
          reason: `denied: reserved ${reserved} + requested ${requested} exceeds owner unknown-spend cap ${cap}`,
        };
      }
    }

    if (exposure > args.budgetUsd) {
      return {
        ...withAmounts,
        allowed: false,
        reason: `denied: exposure ${exposure} (known ${known} + reserved ${reserved} + requested ${requested}) exceeds budget ${args.budgetUsd}`,
      };
    }

    if (this.globalCapUsd !== null && exposure > this.globalCapUsd) {
      return {
        ...withAmounts,
        allowed: false,
        reason: `denied: exposure ${exposure} exceeds global hard cap ${this.globalCapUsd}`,
      };
    }

    if (summary.projectId !== null) {
      const projectCap = this.projectCaps.get(summary.projectId);
      if (projectCap !== undefined && exposure > projectCap) {
        return {
          ...withAmounts,
          allowed: false,
          reason: `denied: exposure ${exposure} exceeds project hard cap ${projectCap} for ${summary.projectId}`,
        };
      }
    }

    if (args.provider !== undefined) {
      const quota = this.providerQuota(args.provider);
      if (quota !== null) {
        const pKnown = this.providerKnownUsd(summary.projectId, args.provider);
        const pReserved = this.reservedFor(summary.projectId, args.provider);
        if (pKnown + pReserved + requested > quota) {
          return {
            ...withAmounts,
            allowed: false,
            reason: `denied: provider quota exhausted for ${args.provider} (known ${pKnown} + reserved ${pReserved} + requested ${requested} exceeds quota ${quota})`,
          };
        }
      }
    }

    return {
      ...withAmounts,
      allowed: true,
      reason: `allowed: exposure ${exposure} (known ${known} + reserved ${reserved} + requested ${requested}, ${summary.label}) within budget ${args.budgetUsd}`,
    };
  }

  /**
   * Atomic check-and-hold: runs checkBudget and, on success with a
   * positive requestedUsd, records the reservation before returning, so
   * concurrent admissions cannot both spend the same headroom.
   * Idempotent: retrying with the same reservationId and identical terms
   * re-evaluates without double-counting the existing hold and returns the
   * same reservationId. Reusing the id for different terms is denied.
   */
  checkAndReserve(
    args: BudgetCheckArgs & { reservationId: string; taskId?: string },
  ): CheckAndReserveResult {
    const requested = args.requestedUsd ?? 0;
    const held = this.reservations.get(args.reservationId);
    if (held !== undefined) {
      const identical =
        held.projectId === args.summary.projectId &&
        held.amountUsd === requested &&
        (held.provider ?? null) === (args.provider ?? null) &&
        (held.taskId ?? null) === (args.taskId ?? null);
      if (!identical) {
        return {
          decision: {
            ...this.checkBudget(args),
            allowed: false,
            reason: `denied: reservationId ${args.reservationId} is already held with different terms; retry with a fresh id`,
          },
          reservationId: null,
        };
      }
      const reservedExSelf = this.reservedFor(args.summary.projectId, args.provider) - held.amountUsd;
      const replay = this.evaluate(args, reservedExSelf);
      if (!replay.allowed || replay.requestedUsd <= 0) {
        return { decision: replay, reservationId: null };
      }
      return {
        decision: {
          ...replay,
          reason: `${replay.reason} (idempotent replay; hold ${args.reservationId} already recorded)`,
        },
        reservationId: args.reservationId,
      };
    }
    const decision = this.checkBudget(args);
    if (!decision.allowed || decision.requestedUsd <= 0) {
      return { decision, reservationId: null };
    }
    if (args.summary.projectId === null) {
      return {
        decision: {
          ...decision,
          allowed: false,
          reason: "denied: holding a reservation requires a project scope; re-check with a project summary",
        },
        reservationId: null,
      };
    }
    const placed = this.reserve({
      reservationId: args.reservationId,
      projectId: args.summary.projectId,
      taskId: args.taskId,
      provider: args.provider,
      amountUsd: decision.requestedUsd,
      authorizedBy: "budget-gate",
      at: new Date().toISOString(),
    });
    if (!placed.accepted) {
      return {
        decision: {
          ...decision,
          allowed: false,
          reason: `denied: admission passed but reservation failed (${placed.errors.map((e: { message: string }) => e.message).join("; ")})`,
        },
        reservationId: null,
      };
    }
    return { decision, reservationId: args.reservationId };
  }
}
