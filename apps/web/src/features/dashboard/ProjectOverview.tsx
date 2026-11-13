// FF-015 (E12) — project overview route (`/projects/:id`).
//
// Fixture mode renders the deterministic Atlas/Beacon overview. Auto mode
// reports connection truth and marks project fields unknown until E05/E08
// bind project endpoints.
import { Link, useParams } from "react-router-dom";
import { findFixtureProject } from "./fixtures";
import { SourceBadge } from "./SourceBadge";
import { StateBanner } from "./StateBanner";
import { getProjectOverview } from "./state";
import { useControlPlane } from "./useControlPlane";
import { useState } from "react";

const API_ENV = import.meta.env.VITE_PUBLIC_API_URL as string | undefined;

function FixtureOverview({ projectId }: { projectId: string }) {
  const project = findFixtureProject(projectId);
  if (!project) {
    return (
      <StateBanner
        screen={{
          state: "empty",
          copy: `No fixture project ${projectId}.`,
          retryable: false,
        }}
      />
    );
  }
  const overview = getProjectOverview({
    dataSource: "fixture",
    project,
    milestones: [
      { id: "ms-1", title: "Login API (fixture)", state: "verified" },
      { id: "ms-2", title: "Login UI (fixture)", state: "running" },
      { id: "ms-3", title: "Login E2E (fixture)", state: "ready" },
    ],
    alerts: [
      {
        severity: "blocking",
        text: "1 failing check on fixture-pr-001 (fixture)",
      },
      { severity: "info", text: "2 decisions need the owner (fixture)" },
    ],
  });
  return (
    <>
      <h2>
        {overview.name} <small>({overview.repository})</small>
      </h2>
      <dl className="ff-stat-row">
        <div className="ff-stat">
          <dt>Verified completed</dt>
          <dd>{overview.counts?.verifiedCompleted}</dd>
        </div>
        <div className="ff-stat">
          <dt>Active workers</dt>
          <dd>{overview.counts?.activeWorkers}</dd>
        </div>
        <div className="ff-stat">
          <dt>Ready tasks</dt>
          <dd>{overview.counts?.readyTasks}</dd>
        </div>
        <div className="ff-stat">
          <dt>Blocked decisions</dt>
          <dd>{overview.counts?.blockedDecisions}</dd>
        </div>
        <div className="ff-stat">
          <dt>Failing checks</dt>
          <dd>{overview.counts?.failingChecks}</dd>
        </div>
      </dl>
      <section className="ff-card" aria-label="Milestones">
        <h2>Milestones</h2>
        <ul>
          {overview.milestones?.map((m) => (
            <li key={m.id}>
              {m.title} — {m.state}
            </li>
          ))}
        </ul>
      </section>
      <p>
        <small>
          Reconciled {overview.lastReconciledAt} · run fixture-run-001 · plan
          rev 1.
        </small>
      </p>
    </>
  );
}

export function ProjectOverview() {
  const { id = "" } = useParams();
  const [mode, setMode] = useState<"fixture" | "auto">("fixture");
  const binding = useControlPlane(API_ENV, mode === "fixture");
  return (
    <main className="ff-dashboard">
      <div className="ff-header">
        <div>
          {mode === "fixture" ? (
            <SourceBadge source="fixture" />
          ) : (
            <SourceBadge source={binding.source} />
          )}
          <h1>Project overview</h1>
          <p>
            <Link to="/projects">← Projects</Link>
          </p>
        </div>
        <label>
          Source
          <select
            aria-label="Status source"
            value={mode}
            onChange={(e) => setMode(e.target.value as "fixture" | "auto")}
          >
            <option value="fixture">Fixture preview</option>
            <option value="auto">Control-plane binding</option>
          </select>
        </label>
      </div>
      {mode === "fixture" ? (
        <FixtureOverview projectId={id} />
      ) : (
        <>
          <StateBanner screen={binding.screen} onRetry={binding.retry} />
          {binding.source === "live" && (
            <p>
              Control plane reachable at {binding.apiBase}. Project fields for{" "}
              <code>{id}</code> stay unknown until E05/E08 bind project
              endpoints — they are not shown as live.
            </p>
          )}
        </>
      )}
    </main>
  );
}
