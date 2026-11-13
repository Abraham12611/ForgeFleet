// FF-015 (E12) — Command Center route (`/projects`).
//
// Two modes, both labelled:
// - fixture preview (default): deterministic fixtures for design review and
//   owner-run screenshots, including empty / offline / sleeping variants.
// - auto: real control-plane binding. Only connection truth is live-capable
//   (health + live channel); project-level fields stay `unknown` until E05/E08
//   bind project endpoints. Nothing renders as live without a check.
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  fixtureCommandCenter,
  FIXTURE_VARIANTS,
  type FixtureVariant,
} from "./fixtures";
import { SourceBadge } from "./SourceBadge";
import { StateBanner } from "./StateBanner";
import {
  getCommandCenterSummary,
  resolveScreenState,
} from "./state";
import { useControlPlane } from "./useControlPlane";

const API_ENV = import.meta.env.VITE_PUBLIC_API_URL as string | undefined;

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="ff-stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function FixturePreview() {
  const [variant, setVariant] = useState<FixtureVariant>("healthy");
  const data = fixtureCommandCenter(variant);
  const screen = resolveScreenState({
    offline: data.offline,
    permissionDenied: data.permissionDenied,
    empty: data.projects.length === 0,
    stale: false,
  });
  const summary =
    data.projects.length === 0
      ? null
      : getCommandCenterSummary({ ...data, dataSource: "fixture" });

  return (
    <>
      <label>
        Fixture variant (for review + owner screenshots)
        <select
          aria-label="Fixture variant"
          value={variant}
          onChange={(e) => setVariant(e.target.value as FixtureVariant)}
        >
          {FIXTURE_VARIANTS.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <StateBanner screen={screen} />
      {summary && (
        <div className="ff-grid">
          <section className="ff-card" aria-label="Project health">
            <h2>
              Project health ({summary.projectCount} fixture projects)
            </h2>
            <dl className="ff-stat-row">
              <Stat label="Verified completed" value={summary.verifiedCompleted} />
              <Stat label="Active workers" value={summary.activeWorkers} />
              <Stat label="Ready tasks" value={summary.readyTasks} />
              <Stat label="Blocked decisions" value={summary.blockedDecisions} />
              <Stat label="Failing checks" value={summary.failingChecks} />
              <Stat label="Unknown workers" value={summary.unknownWorkers} />
            </dl>
          </section>
          <section className="ff-card" aria-label="Projects">
            <h2>Projects</h2>
            <ul>
              {data.projects.map((p) => (
                <li key={p.projectId}>
                  <Link to={`/projects/${p.projectId}`}>{p.name}</Link>{" "}
                  <small>
                    {p.verifiedCompleted} verified · {p.activeWorkers} active ·{" "}
                    {p.blockedDecisions} blocked · budget {p.budgetRemaining}%
                    remaining (estimated)
                  </small>
                </li>
              ))}
            </ul>
          </section>
          <section className="ff-card" aria-label="Decisions and runtime">
            <h2>Decisions &amp; runtime</h2>
            <p>
              {summary.blockedDecisions} inbox items need the owner · sleep
              mode {summary.sleepMode ? "on" : "off"}.
            </p>
            {summary.providerNotice && <p>{summary.providerNotice}</p>}
            <p>
              <small>
                Reconciled {data.projects[0]?.lastReconciledAt ?? "—"} ·
                spending figures are estimates until E18 binds metering.
              </small>
            </p>
          </section>
        </div>
      )}
    </>
  );
}

function LiveBinding() {
  const binding = useControlPlane(API_ENV, false);
  return (
    <>
      <SourceBadge source={binding.source} />
      <StateBanner screen={binding.screen} onRetry={binding.retry} />
      {binding.source === "live" && (
        <div className="ff-grid">
          <section className="ff-card" aria-label="Control plane">
            <h2>Control plane (live)</h2>
            <dl className="ff-stat-row">
              <Stat label="API base" value={binding.apiBase} />
              <Stat label="Live channel" value={binding.liveStatus ?? "…"} />
            </dl>
            <p>
              <small>
                Project-level status is not bound yet (E05/E08 endpoints
                pending): project fields render as unknown, never as live.
              </small>
            </p>
          </section>
        </div>
      )}
    </>
  );
}

export function CommandCenter() {
  const [mode, setMode] = useState<"fixture" | "auto">("fixture");
  return (
    <main className="ff-dashboard">
      <div className="ff-header">
        <div>
          {mode === "fixture" && <SourceBadge source="fixture" />}
          <h1>Command Center</h1>
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
      {mode === "fixture" ? <FixturePreview /> : <LiveBinding />}
      <nav className="ff-bottom-tabs" aria-label="Primary">
        <Link to="/projects" aria-current="page">
          Home
        </Link>
        <Link to="/projects">Projects</Link>
        <Link to="/inbox">Inbox</Link>
        <Link to="/fleet">Fleet</Link>
        <Link to="/system">More</Link>
      </nav>
    </main>
  );
}
