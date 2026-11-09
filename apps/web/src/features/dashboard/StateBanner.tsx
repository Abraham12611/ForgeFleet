// FF-015 (E12) — screen-state banner covering all seven UX states.
import type { ScreenResolution } from "./state";

const TONE: Record<ScreenResolution["state"], "neutral" | "bad" | "warn"> = {
  loading: "neutral",
  ready: "neutral",
  empty: "neutral",
  "recoverable-error": "bad",
  "permission-denied": "bad",
  offline: "warn",
  stale: "warn",
};

export function StateBanner({
  screen,
  onRetry,
}: {
  screen: ScreenResolution;
  onRetry?: () => void;
}) {
  if (screen.state === "ready" && !screen.copy) return null;
  return (
    <div className="ff-state" role="status" data-tone={TONE[screen.state]}>
      <p>{screen.copy}</p>
      {screen.retryable && onRetry && (
        <button type="button" onClick={onRetry}>
          Retry (safe: read-only probe, no side effects)
        </button>
      )}
      {screen.escalation && (
        <p>Retry is not available. Escalate to the operator with this page.</p>
      )}
    </div>
  );
}
