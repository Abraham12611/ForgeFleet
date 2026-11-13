/**
 * E13 — Tasks/fleet UX (FF-016): route-level accessible tests for the
 * fleet center and agent detail screens. Same SSR approach as
 * `tasks/screens.test.tsx`: real route table, accessible landmarks, link
 * targets, and live-region roles.
 */
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import App from "../../App";

function renderRoute(path: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe("fleet center route /fleet", () => {
  const html = renderRoute("/fleet");

  it("renders the fleet heading and the virtualized window note", () => {
    expect(html).toContain("<h1>Agent fleet</h1>");
    expect(html).toContain("Showing 1–24 of 200 agents (virtualized list).");
  });

  it("links visible agents to their detail screens", () => {
    expect(html).toContain('href="/fleet/agent_fleet_000"');
    expect(html).not.toContain("agent_fleet_199");
  });

  it("links busy agents to their current tasks", () => {
    expect(html).toContain("/tasks/task_fleet_");
  });

  it("labels the data as fixture, not live state", () => {
    expect(html).toContain("Fixture data");
    expect(html).toContain("not 200 concurrent workers");
  });
});

describe("project fleet route /projects/:projectId/agents", () => {
  const html = renderRoute("/projects/project_login_flow/agents");

  it("renders the project roster with agent and task links", () => {
    expect(html).toContain("<h1>Agent fleet</h1>");
    expect(html).toContain('href="/fleet/agent_muse_01"');
    expect(html).toContain("/tasks/task_auth_ui");
  });
});

describe("agent detail route /fleet/:agentId", () => {
  const html = renderRoute("/fleet/agent_muse_01");

  it("renders identity, current task, and attempt back-links", () => {
    expect(html).toContain("<h1>Muse worker 01</h1>");
    expect(html).toContain("/tasks/task_auth_ui");
    expect(html).toContain("Attempt history (2)");
  });

  it("labels measured cost and the redacted terminal reference", () => {
    expect(html).toContain("$0.42");
    expect(html).toContain("orca_terminal_aaa");
    expect(html).toContain("server-redacted");
  });

  it("marks telemetry freshness as a status message", () => {
    expect(html).toContain("Last seen");
  });
});

describe("agent detail route for an unknown agent", () => {
  const html = renderRoute("/fleet/agent_ghost");

  it("renders explicit unknown copy, never a guessed worker", () => {
    expect(html).toContain("(agent record unavailable)");
    expect(html).toContain("disconnected");
  });
});
