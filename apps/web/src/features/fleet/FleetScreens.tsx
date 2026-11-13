/**
 * E13 — Tasks/fleet UX (FF-016): fleet center and agent detail screens.
 *
 * Mounted at `/fleet`, `/projects/:projectId/agents` (FleetScreen) and
 * `/fleet/:agentId` (AgentDetailScreen). Props-driven and SSR-safe like
 * the task screen: containers feed view-models built through
 * `bridge-adapter.ts`. The roster renders one virtualized window with an
 * explicit "showing X–Y of N" note — the 200-agent fixture proves
 * windowing, not 200 concurrent workers.
 */
import { Link } from "react-router-dom";
import "./screens.css";
import { windowSlice, type WindowInput } from "./types.ts";
import type { AgentDetailViewModel, FleetListViewModel } from "./fleet-detail.ts";

export function FleetScreen({
  vm,
  window,
}: {
  vm: FleetListViewModel;
  window?: WindowInput;
}) {
  if (vm.state === "loading") {
    return (
      <main aria-busy="true" aria-label="Fleet loading">
        <h1>Agent fleet</h1>
        <p>Loading fleet…</p>
      </main>
    );
  }
  if (vm.state === "permission-denied") {
    return (
      <main>
        <h1>Agent fleet</h1>
        <p role="alert">
          Access denied. {vm.stateNote ?? "Viewing the fleet needs a project role."}
        </p>
      </main>
    );
  }
  if (vm.state === "recoverable-error") {
    return (
      <main>
        <h1>Agent fleet</h1>
        <p role="alert">
          Couldn&apos;t load the fleet. {vm.stateNote ?? "Retry is safe."}
        </p>
      </main>
    );
  }

  const slice = window
    ? windowSlice({ ...window, total: vm.rows.length })
    : { start: 0, end: vm.rows.length };
  const visible = vm.rows.slice(slice.start, slice.end);

  return (
    <main aria-label="Agent fleet">
      <h1>Agent fleet</h1>
      {vm.state === "offline" && (
        <p role="status" className="ff-banner">
          Offline — {vm.stateNote}
        </p>
      )}
      <p role="status">
        Showing {visible.length === 0 ? 0 : slice.start + 1}–{slice.start + visible.length} of{" "}
        {vm.total} agents (virtualized list).
      </p>
      {vm.rows.length === 0 ? (
        <p>No agents registered.</p>
      ) : (
        <ul>
          {visible.map((row) => (
            <li key={row.agent.agentId}>
              <article aria-label={`Agent ${row.agent.displayName}`}>
                <p>
                  <Link to={row.agentRoute}>
                    {row.agent.displayName} ({row.agent.workerState})
                  </Link>
                </p>
                <p>
                  {row.currentTaskRoute ? (
                    <Link to={row.currentTaskRoute}>
                      Task: {row.currentTaskTitle ?? row.agent.currentTaskId}
                    </Link>
                  ) : (
                    "Task: idle — no task assigned"
                  )}
                </p>
                <p>
                  {row.freshnessText}
                  {row.isStale ? " — telemetry stale" : ""}
                </p>
              </article>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

export function AgentDetailScreen({ vm }: { vm: AgentDetailViewModel }) {
  if (vm.state === "loading") {
    return (
      <main aria-busy="true" aria-label="Agent detail loading">
        <h1>Agent detail</h1>
        <p>Loading agent…</p>
      </main>
    );
  }
  if (vm.state === "permission-denied") {
    return (
      <main>
        <h1>Agent detail</h1>
        <p role="alert">
          Access denied. {vm.stateNote ?? "Viewing this agent needs a project role."}
        </p>
      </main>
    );
  }
  if (vm.state === "recoverable-error") {
    return (
      <main>
        <h1>Agent detail</h1>
        <p role="alert">
          Couldn&apos;t load this agent. {vm.stateNote ?? "Retry is safe."}
        </p>
      </main>
    );
  }

  return (
    <main aria-label={`Agent: ${vm.agent.displayName}`}>
      <h1>{vm.agent.displayName}</h1>
      <dl className="ff-facts">
        <dt>Provider</dt>
        <dd>{vm.agent.provider}</dd>
        <dt>Worker state</dt>
        <dd>{vm.agent.workerState}</dd>
        <dt>Worktree</dt>
        <dd>{vm.agent.worktreeId ?? "none"}</dd>
        <dt>Cost</dt>
        <dd>{vm.costLabel}</dd>
      </dl>

      {vm.state === "offline" && (
        <p role="status" className="ff-banner">
          Offline — {vm.stateNote}
        </p>
      )}
      <p role="status">
        {vm.freshnessText}
        {vm.isStale ? " — telemetry stale, reconciling" : ""}
      </p>

      <section aria-labelledby="ff-current-task">
        <h2 id="ff-current-task">Current task</h2>
        {vm.currentTask ? (
          <Link to={vm.currentTask.route}>{vm.currentTask.title}</Link>
        ) : (
          <p>{vm.idleReason ?? "Idle — no task assigned"}</p>
        )}
      </section>

      <section aria-labelledby="ff-attempt-history">
        <h2 id="ff-attempt-history">Attempt history ({vm.attempts.length})</h2>
        {vm.attempts.length === 0 ? (
          <p>No attempts recorded for this agent.</p>
        ) : (
          <ol>
            {vm.attempts.map((entry) => (
              <li key={entry.attempt.attemptId}>
                {entry.taskRoute ? (
                  <Link to={entry.taskRoute}>
                    Attempt {entry.attempt.generation} ({entry.attempt.state})
                  </Link>
                ) : (
                  <span>
                    Attempt {entry.attempt.generation} ({entry.attempt.state})
                    (task link unavailable)
                  </span>
                )}{" "}
                — {entry.taskTitle ?? "task record unavailable"} — runtime{" "}
                {entry.liveness}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="ff-terminal">
        <h2 id="ff-terminal">Terminal log</h2>
        {vm.terminalRef ? (
          <p>
            Quarantined viewer reference: <code>{vm.terminalRef}</code>.
            Logs are server-redacted before display.
          </p>
        ) : (
          <p>No terminal session attached.</p>
        )}
      </section>
    </main>
  );
}
