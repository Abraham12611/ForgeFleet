/**
 * Cost ledger (FF-020, FR-10, scope-and-metrics "Cost efficiency").
 *
 * Contract: docs/03-architecture/observability-and-cost.md ("Cost ledger").
 * Tracks provider, model, inputTokens, outputTokens, billedUsd, source,
 * confidence. Never fabricates costs and never equates token consumption
 * with billed USD when no price data exists.
 *
 * Label rule (the FF-020 acceptance criterion):
 * - billedUsd == null            -> "unknown" (shown as unknown, never $0)
 * - source is provider-invoice
 *   or provider-api              -> "actual"
 * - otherwise (price-table,
 *   manual-entry, unknown source) -> "estimated"
 */

import type { ActorIdentity, CostLabel, CostSource, IsoDateTimeString } from "./types.js";

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
  if (entry.billedUsd !== null && !(entry.billedUsd >= 0)) {
    errors.push({ field: "billedUsd", message: "billedUsd must be null or a non-negative number" });
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

export interface BudgetDecision {
  allowed: boolean;
  reason: string;
  spendKnownUsd: number | null;
  spendLabel: CostLabel;
  budgetUsd: number;
}

/**
 * Append-only in-memory ledger. Durable persistence belongs to E06;
 * this class owns labeling, aggregation and budget gating only.
 */
export class CostLedger {
  private readonly entries: CostEntry[] = [];
  private readonly seenIds = new Set<string>();

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
   * Pre-dispatch budget gate. Denials (including missing authorization)
   * are returned as data so the caller can surface them; this method never
   * dispatches anything itself.
   */
  checkBudget(args: {
    summary: CostSummary;
    budgetUsd: number;
    authorized: boolean;
    requestedUsd?: number | null;
  }): BudgetDecision {
    const { summary, budgetUsd, authorized } = args;
    const spendKnownUsd = summary.totalKnownUsd;
    if (!authorized) {
      return {
        allowed: false,
        reason: "denied: missing budget authorization",
        spendKnownUsd,
        spendLabel: summary.label,
        budgetUsd,
      };
    }
    if (spendKnownUsd !== null && spendKnownUsd >= budgetUsd) {
      return {
        allowed: false,
        reason: `denied: recorded spend ${spendKnownUsd} ${summary.label} >= budget ${budgetUsd}`,
        spendKnownUsd,
        spendLabel: summary.label,
        budgetUsd,
      };
    }
    if (summary.label === "unknown") {
      return {
        allowed: true,
        reason: "allowed with caution: spend is unknown (no priced entries); within nominal budget",
        spendKnownUsd,
        spendLabel: summary.label,
        budgetUsd,
      };
    }
    return {
      allowed: true,
      reason: `allowed: recorded spend ${spendKnownUsd} ${summary.label} < budget ${budgetUsd}`,
      spendKnownUsd,
      spendLabel: summary.label,
      budgetUsd,
    };
  }
}
