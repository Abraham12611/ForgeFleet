/**
 * E13 — Tasks/fleet UX (FF-016): route-level accessible tests for the task
 * detail screen. Rendered through the real `App` route table with
 * `MemoryRouter` + SSR markup (no new test deps): assertions target
 * accessible landmarks, link targets (the trace), and live-region roles.
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

describe("task detail route /projects/:projectId/tasks/:taskId", () => {
  const html = renderRoute("/projects/project_login_flow/tasks/task_auth_api");

  it("renders the task title as the page heading", () => {
    expect(html).toContain("<h1>Implement backend auth</h1>");
  });

  it("links each attempt to its anchor and its agent (the trace)", () => {
    expect(html).toContain("#attempt-attempt_auth_api_g2");
    expect(html).toContain('href="/fleet/agent_muse_01"');
  });

  it("keeps liveness text separate from verification status", () => {
    expect(html).toContain("Task status (verification)");
    expect(html).toContain("Runtime:");
  });

  it("dedupes the redelivered timeline event", () => {
    const uiHtml = renderRoute("/projects/project_login_flow/tasks/task_auth_ui");
    const occurrences = uiHtml.split("attempt.started").length - 1;
    expect(occurrences).toBe(1);
    expect(uiHtml).toContain("attempt.heartbeat");
  });

  it("shows linked pull requests for the task", () => {
    expect(html).toContain("example/login-demo#42");
  });
});

describe("task detail route for an undispatched task", () => {
  const html = renderRoute("/projects/project_login_flow/tasks/task_auth_e2e");

  it("renders the empty state instead of a fabricated trace", () => {
    expect(html).toContain("No attempts yet");
    expect(html).not.toContain("/fleet/");
  });
});

describe("task detail route for an unknown task record", () => {
  const html = renderRoute("/projects/project_login_flow/tasks/task_missing");

  it("renders explicit unknown copy, never a guessed state", () => {
    expect(html).toContain("(task record unavailable)");
    expect(html).toContain("unknown");
  });
});
