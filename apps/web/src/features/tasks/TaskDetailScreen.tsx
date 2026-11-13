/**
 * E13 — Tasks/fleet UX (FF-016): task detail screen.
 *
 * Mounted at `/projects/:projectId/tasks/:taskId`. Props-driven and
 * SSR-safe (no effects, no fetching): route containers feed it a
 * `TaskDetailViewModel` built through `bridge-adapter.ts`. Every status is
 * text-first so color is never the sole signal (design-direction).
 */
import { Link } from "react-router-dom";
import "./screens.css";
import type { TaskDetailViewModel } from "./task-detail.ts";

export function TaskDetailScreen({ vm }: { vm: TaskDetailViewModel }) {
  if (vm.state === "loading") {
    return (
      <main aria-busy="true" aria-label="Task detail loading">
        <h1>Task detail</h1>
        <p>Loading task…</p>
      </main>
    );
  }
  if (vm.state === "permission-denied") {
    return (
      <main>
        <h1>Task detail</h1>
        <p role="alert">
          Access denied. {vm.stateNote ?? "Viewing this task needs a project role."}
        </p>
      </main>
    );
  }
  if (vm.state === "recoverable-error") {
    return (
      <main>
        <h1>Task detail</h1>
        <p role="alert">
          Couldn&apos;t load this task. {vm.stateNote ?? "Retry is safe."}
        </p>
      </main>
    );
  }

  return (
    <main aria-label={`Task: ${vm.task.title}`}>
      <h1>{vm.task.title}</h1>
      <dl className="ff-facts">
        <dt>Task status (verification)</dt>
        <dd>{vm.task.status}</dd>
        <dt>Project</dt>
        <dd>{vm.task.projectId}</dd>
      </dl>

      {vm.state === "offline" && (
        <p role="status" className="ff-banner">
          Offline — {vm.stateNote}
        </p>
      )}
      {vm.state === "stale" && (
        <p role="status" className="ff-banner">
          Stale data — {vm.stateNote}
        </p>
      )}
      {vm.traceConflict && (
        <p role="alert" className="ff-banner ff-banner-alert">
          Lease conflict: more than one attempt claims this task. The older
          lease must be fenced before retry.
        </p>
      )}

      <section aria-labelledby="ff-acceptance">
        <h2 id="ff-acceptance">Acceptance</h2>
        <ul>
          {vm.acceptance.map((item) => (
            <li key={item.criterion}>
              {item.satisfied ? "Satisfied: " : "Pending: "}
              {item.criterion}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="ff-attempts">
        <h2 id="ff-attempts">Attempts ({vm.attempts.length})</h2>
        {vm.state === "empty" || vm.attempts.length === 0 ? (
          <p>No attempts yet. Dispatch creates the first attempt.</p>
        ) : (
          <ol>
            {vm.attempts.map((entry) => (
              <li key={entry.attempt.attemptId}>
                <article aria-label={`Attempt ${entry.attempt.attemptId}`}>
                  <p>
                    <Link to={entry.links.attemptRoute ?? entry.links.taskRoute}>
                      Attempt {entry.attempt.generation} ({entry.attempt.state})
                    </Link>
                    {entry.isActive && " — holds the task lease"}
                  </p>
                  <p>
                    Runtime: {entry.livenessLabel}
                    {entry.lastSeenText ? ` — ${entry.lastSeenText}` : ""}
                  </p>
                  <p>
                    {entry.links.agentRoute ? (
                      <Link to={entry.links.agentRoute}>
                        Agent: {entry.agentDisplayName ?? entry.attempt.agentId}
                      </Link>
                    ) : (
                      "Agent: unassigned — no runtime owner yet"
                    )}
                  </p>
                </article>
              </li>
            ))}
          </ol>
        )}
      </section>

      {vm.pullRequests.length > 0 && (
        <section aria-labelledby="ff-prs">
          <h2 id="ff-prs">Pull requests</h2>
          <ul>
            {vm.pullRequests.map((pr) => (
              <li key={`${pr.repo}#${pr.prNumber}`}>
                {pr.repo}#{pr.prNumber} — {pr.statusSummary} (head{" "}
                {pr.headSha.slice(0, 12)})
              </li>
            ))}
          </ul>
        </section>
      )}

      {vm.messages.length > 0 && (
        <section aria-labelledby="ff-messages">
          <h2 id="ff-messages">Messages</h2>
          <ul>
            {vm.messages.map((m) => (
              <li key={m.messageId}>
                [{m.authorKind}] {m.bodyPreview}
              </li>
            ))}
          </ul>
        </section>
      )}

      {vm.timeline.length > 0 && (
        <section aria-labelledby="ff-timeline">
          <h2 id="ff-timeline">Timeline</h2>
          <ol>
            {vm.timeline.map((entry) => (
              <li key={`${entry.source}:${entry.eventId}`}>
                {entry.occurredAt} — {entry.eventType}: {entry.summary}
              </li>
            ))}
          </ol>
        </section>
      )}
    </main>
  );
}
