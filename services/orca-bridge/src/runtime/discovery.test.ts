import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildProbePlan,
  isReadOnlyCommand,
  redactPii,
  resolveOrcaExecutable,
  SKIPPED_COMMANDS,
  summarizeProbe,
} from "./discovery.ts";

describe("resolveOrcaExecutable", () => {
  it("prefers ORCA_CLI_COMMAND when set", () => {
    const r = resolveOrcaExecutable(
      { ORCA_CLI_COMMAND: "/custom/orca-bin" },
      "linux",
    );
    assert.equal(r.executable, "/custom/orca-bin");
  });

  it("uses orca-dev when a dev root is exposed", () => {
    const r = resolveOrcaExecutable(
      { ORCA_DEV_REPO_ROOT: "/home/dev/orca" },
      "linux",
    );
    assert.equal(r.executable, "orca-dev");
  });

  it("uses orca-ide on Linux to avoid the GNOME screen reader", () => {
    const r = resolveOrcaExecutable({}, "linux");
    assert.equal(r.executable, "orca-ide");
  });

  it("uses orca on macOS and Windows", () => {
    assert.equal(resolveOrcaExecutable({}, "darwin").executable, "orca");
    assert.equal(resolveOrcaExecutable({}, "win32").executable, "orca");
  });

  it("ignores blank overrides", () => {
    assert.equal(
      resolveOrcaExecutable({ ORCA_CLI_COMMAND: "   " }, "darwin").executable,
      "orca",
    );
  });
});

describe("isReadOnlyCommand", () => {
  it("allows version, status and inventory reads", () => {
    assert.equal(isReadOnlyCommand(["--version"]), true);
    assert.equal(isReadOnlyCommand(["status", "--json"]), true);
    assert.equal(isReadOnlyCommand(["worktree", "ps", "--json"]), true);
    assert.equal(
      isReadOnlyCommand(["skills", "get", "orchestration"]),
      true,
    );
    assert.equal(
      isReadOnlyCommand(["orchestration", "worker-list", "--json"]),
      true,
    );
  });

  it("forbids every mutating or session-content command", () => {
    const forbidden: string[][] = [
      ["open"],
      ["serve"],
      ["search", "query"],
      ["terminal", "send", "--terminal", "t", "--text", "hi"],
      ["terminal", "read", "--terminal", "t"],
      ["worktree", "create", "--name", "x"],
      ["worktree", "rm", "--worktree", "x"],
      ["orchestration", "worker-start", "--spec", "x"],
      ["orchestration", "dispatch", "--task", "t"],
      ["orchestration", "send", "--to", "d", "--body", "m"],
      ["diagnostics", "memory"],
    ];
    for (const argv of forbidden) {
      assert.equal(isReadOnlyCommand(argv), false, argv.join(" "));
    }
  });

  it("every planned probe command is allowlisted", () => {
    for (const argv of buildProbePlan()) {
      assert.equal(isReadOnlyCommand([...argv]), true, argv.join(" "));
    }
  });
});

describe("redactPii", () => {
  it("redacts emails, secrets and home directories", () => {
    const raw =
      "email operator@example.com bearer abc123 token /Users/Apple/orca/x";
    const clean = redactPii(raw);
    assert.match(clean, /<redacted-email>/);
    assert.doesNotMatch(clean, /operator@example\.com/);
    assert.doesNotMatch(clean, /\/Users\/Apple/);
  });
});

describe("summarizeProbe", () => {
  const outputs: Record<string, string> = {
    "--version": "1.4.251\n",
    "status --json": JSON.stringify({
      result: {
        app: { running: true },
        runtime: { state: "ready", reachable: true, appVersion: "1.4.251" },
      },
    }),
    "host list --json": JSON.stringify({
      result: {
        hosts: [
          { kind: "local", name: "MacBook Pro", platform: "darwin" },
          { kind: "ssh", name: "orb", connected: false },
        ],
      },
    }),
    "repo list --json": JSON.stringify({
      result: { repos: [{ id: "repo-1", displayName: "ForgeFleet" }] },
    }),
    "worktree ps --json": JSON.stringify({
      result: {
        worktrees: [
          {
            repo: "ForgeFleet",
            path: "/Users/Apple/orca/workspaces/x",
            liveTerminalCount: 2,
            workspaceStatus: "in-progress",
            isArchived: false,
          },
        ],
      },
    }),
    "account list --json": JSON.stringify({
      result: {
        codex: {
          accounts: [],
          systemDefault: {
            hasAuth: true,
            email: "someone@example.com",
          },
        },
        devin: { accounts: [] },
      },
    }),
    "environment list --json": JSON.stringify({ result: { environments: [] } }),
    "automations list --json": JSON.stringify({
      result: { automations: [], orphanCount: 0 },
    }),
  };

  it("builds a sanitized report without paths or emails", () => {
    const report = summarizeProbe(outputs, "darwin");
    assert.equal(report.orcaVersion, "1.4.251");
    assert.equal(report.runtime.state, "ready");
    assert.equal(report.runtime.reachable, true);
    assert.equal(report.hosts.length, 2);
    assert.equal(report.worktrees.length, 1);
    assert.equal(report.liveTerminalTotal, 2);
    assert.equal(report.agentAccounts["codex"].hasAuth, true);
    assert.equal(report.agentAccounts["devin"].hasAuth, false);
    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /someone@example\.com/);
    assert.doesNotMatch(serialized, /\/Users\/Apple/);
    assert.doesNotMatch(serialized, /MacBook Pro/);
  });

  it("degrades to nulls with warnings on missing output", () => {
    const report = summarizeProbe({}, "linux");
    assert.equal(report.orcaVersion, null);
    assert.equal(report.runtime.reachable, null);
    assert.ok(report.warnings.length > 0);
    assert.ok(report.skipped.length === SKIPPED_COMMANDS.length);
  });
});
