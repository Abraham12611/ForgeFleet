// FF-015 (E12) — explicit source badge. Status is never color-only: every
// badge carries a text label. LIVE appears only after a successful
// control-plane check this session (see useControlPlane).
import type { DataSource } from "./types";

const LABEL: Record<DataSource, string> = {
  fixture: "Fixture — not live runtime status",
  unknown: "Unknown — unreachable or unproven, not stopped",
  live: "Live — verified this session",
};

export function SourceBadge({ source }: { source: DataSource }) {
  return (
    <span className="ff-fixture-badge" data-source={source}>
      {LABEL[source]}
    </span>
  );
}
