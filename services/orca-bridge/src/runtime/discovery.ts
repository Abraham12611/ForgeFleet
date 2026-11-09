/**
 * E02 — Orca read-only discovery (FF-002).
 *
 * Pure, dependency-free helpers for probing the installed Orca runtime
 * nonintrusively. No function here spawns a process, writes state, or
 * touches Orca sessions: callers execute the planned argv read-only and
 * feed raw outputs back into `summarizeProbe`.
 *
 * Executable resolution follows the version-matched orchestration skill:
 * `ORCA_CLI_COMMAND` first, then `orca-dev` in a dev checkout, then
 * `orca-ide` on Linux outside an Orca-managed terminal (bare `orca` there
 * usually resolves to the GNOME screen reader), otherwise `orca`.
 */

export type Platform = "linux" | "darwin" | "win32" | string;

export interface ResolveEnv {
  ORCA_CLI_COMMAND?: string;
  ORCA_DEV_REPO_ROOT?: string;
}

export interface ResolvedExecutable {
  executable: string;
  reason: string;
}

/** Resolve the single Orca executable for this session. Reuse it verbatim. */
export function resolveOrcaExecutable(
  env: ResolveEnv,
  platform: Platform,
): ResolvedExecutable {
  const override = (env.ORCA_CLI_COMMAND ?? "").trim();
  if (override) {
    return {
      executable: override,
      reason: "ORCA_CLI_COMMAND is set (Orca-managed session export)",
    };
  }
  const devRoot = (env.ORCA_DEV_REPO_ROOT ?? "").trim();
  if (devRoot) {
    return {
      executable: "orca-dev",
      reason: "ORCA_DEV_REPO_ROOT is exposed (dev checkout)",
    };
  }
  if (platform === "linux") {
    return {
      executable: "orca-ide",
      reason:
        "Linux outside an Orca-managed terminal: bare `orca` may be the GNOME screen reader",
    };
  }
  return { executable: "orca", reason: `default for platform ${platform}` };
}

/**
 * Allowlist of read-only argv (tokens after the executable). Anything not
 * listed here — including `open`, `serve`, `search`, terminal read/send,
 * worktree create/rm/set, and all orchestration mutations — is forbidden
 * to the discovery probe.
 */
const READONLY_COMMANDS: readonly string[] = [
  "--version",
  "--help",
  "status",
  "skills list",
  "skills installed",
  "skills get",
  "agent-context",
  "host list",
  "repo list",
  "worktree list",
  "worktree ps",
  "worktree current",
  "environment list",
  "automations list",
  "plugin list",
  "account list",
  "orchestration --help",
  "worktree --help",
  "orchestration run-list",
  "orchestration task-list",
  "orchestration worker-list",
  "orchestration gate-list",
];

function normalizeArgv(argv: readonly string[]): string {
  return argv
    .filter((t) => t !== "--json" && !t.startsWith("--limit"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the argv is on the read-only discovery allowlist. */
export function isReadOnlyCommand(argv: readonly string[]): boolean {
  const key = normalizeArgv(argv);
  return READONLY_COMMANDS.some(
    (allowed) => key === allowed || key.startsWith(`${allowed} `),
  );
}

/** Ordered read-only probe plan for one resolved executable. */
export function buildProbePlan(): readonly (readonly string[])[] {
  return [
    ["--version"],
    ["status", "--json"],
    ["skills", "list", "--json"],
    ["skills", "get", "orchestration"],
    ["skills", "get", "orca-cli"],
    ["host", "list", "--json"],
    ["repo", "list", "--json"],
    ["worktree", "ps", "--json"],
    ["environment", "list", "--json"],
    ["automations", "list", "--json"],
    ["account", "list", "--json"],
    ["agent-context", "--json"],
  ];
}

/** Commands deliberately NOT probed, with reasons. */
export const SKIPPED_COMMANDS: readonly { command: string; reason: string }[] = [
  {
    command: "open / serve",
    reason: "state-changing: launches or starts a runtime server",
  },
  {
    command: "search",
    reason: "reads full text of agent sessions; unnecessary for capability discovery",
  },
  {
    command: "terminal list/read/send/wait",
    reason: "exposes live session content; counts via `worktree ps` suffice",
  },
  {
    command: "worktree create/rm/set",
    reason: "mutates Orca-managed checkouts and metadata",
  },
  {
    command: "orchestration worker-start/dispatch/send",
    reason: "starts or steers supervised workers; out of scope for FF-002",
  },
  {
    command: "diagnostics memory",
    reason: "heavy snapshot collection; deferred to a targeted spike",
  },
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const TOKEN_RE =
  /\b(bearer\s+[A-Za-z0-9._~+/-]+=*|sk-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_]+|xox[bap]-[A-Za-z0-9-]+)\b/gi;
const HOME_RE = new RegExp(
  `(${"/Users/[A-Za-z0-9_.-]+|/home/[A-Za-z0-9_.-]+|C:\\\\Users\\\\[A-Za-z0-9_.-]+|%h"})`,
  "g",
);

/** Redact PII/secrets from raw CLI output: emails, tokens, home dirs. */
export function redactPii(text: string): string {
  return text
    .replace(EMAIL_RE, "<redacted-email>")
    .replace(TOKEN_RE, "<redacted-secret>")
    .replace(HOME_RE, "~");
}

export interface SanitizedWorktreeSummary {
  repo: string;
  liveTerminalCount: number;
  workspaceStatus: string;
  isArchived: boolean;
}

export interface CapabilityReport {
  orcaVersion: string | null;
  runtime: {
    state: string | null;
    reachable: boolean | null;
    platform: string | null;
    appVersion: string | null;
  };
  hosts: { kind: string; platform: string | null; connected: boolean | null }[];
  skillGuideNames: string[];
  repos: { id: string; displayName: string }[];
  worktrees: SanitizedWorktreeSummary[];
  liveTerminalTotal: number;
  agentAccounts: Record<string, { hasAuth: boolean; accountCount: number }>;
  environments: number;
  automations: number;
  skipped: { command: string; reason: string }[];
  warnings: string[];
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Build a sanitized capability report from raw command outputs keyed by
 * `argv.join(" ")`. Unknown/unparseable outputs yield nulls plus warnings —
 * never thrown errors, never raw passthrough.
 */
export function summarizeProbe(
  outputs: ReadonlyMap<string, string> | Record<string, string>,
  platform: Platform,
): CapabilityReport {
  const get = (key: string): string => {
    if (outputs instanceof Map) return outputs.get(key) ?? "";
    return outputs[key] ?? "";
  };
  const warnings: string[] = [];

  const versionRaw = get("--version").trim();
  const orcaVersion = versionRaw ? versionRaw.split("\n")[0].trim() : null;
  if (!orcaVersion) warnings.push("missing `--version` output");

  const status = asRecord(asRecord(safeJsonParse(get("status --json")))["result"]);
  const runtime = asRecord(status["runtime"]);
  const app = asRecord(status["app"]);

  const hostsRaw = asRecord(
    asRecord(safeJsonParse(get("host list --json")))["result"],
  )["hosts"];
  const hosts = Array.isArray(hostsRaw)
    ? hostsRaw.map((h) => {
        const r = asRecord(h);
        return {
          kind: String(r["kind"] ?? "unknown"),
          platform: typeof r["platform"] === "string" ? r["platform"] : null,
          connected:
            typeof r["connected"] === "boolean" ? r["connected"] : null,
        };
      })
    : [];

  const skillsRaw = asRecord(
    asRecord(safeJsonParse(get("skills list --json")))["result"],
  )["skills"];
  const skillGuideNames =
    typeof skillsRaw === "string"
      ? skillsRaw.split("\n").filter(Boolean)
      : Array.isArray(skillsRaw)
        ? skillsRaw
            .map((s) => {
              const r = asRecord(s);
              return typeof r["name"] === "string" ? r["name"] : null;
            })
            .filter((n): n is string => n !== null)
        : [];
  void app;

  const reposRaw = asRecord(
    asRecord(safeJsonParse(get("repo list --json")))["result"],
  )["repos"];
  const repos = Array.isArray(reposRaw)
    ? reposRaw.map((r) => {
        const rec = asRecord(r);
        return {
          id: String(rec["id"] ?? "unknown"),
          displayName: String(rec["displayName"] ?? rec["name"] ?? "unknown"),
        };
      })
    : [];

  const wtRaw = asRecord(
    asRecord(safeJsonParse(get("worktree ps --json")))["result"],
  )["worktrees"];
  const worktrees: SanitizedWorktreeSummary[] = Array.isArray(wtRaw)
    ? wtRaw.map((w) => {
        const rec = asRecord(w);
        return {
          repo: String(rec["repo"] ?? "unknown"),
          liveTerminalCount:
            typeof rec["liveTerminalCount"] === "number"
              ? rec["liveTerminalCount"]
              : 0,
          workspaceStatus: String(rec["workspaceStatus"] ?? "unknown"),
          isArchived: rec["isArchived"] === true,
        };
      })
    : [];
  const liveTerminalTotal = worktrees.reduce(
    (sum, w) => sum + w.liveTerminalCount,
    0,
  );

  const accounts = asRecord(
    asRecord(safeJsonParse(get("account list --json")))["result"],
  );
  const agentAccounts: CapabilityReport["agentAccounts"] = {};
  for (const [provider, value] of Object.entries(accounts)) {
    if (provider === "rateLimits" || provider === "_meta") continue;
    const rec = asRecord(value);
    const list = rec["accounts"];
    const sysDefault = asRecord(rec["systemDefault"]);
    agentAccounts[provider] = {
      hasAuth:
        sysDefault["hasAuth"] === true ||
        (Array.isArray(list) && list.length > 0),
      accountCount: Array.isArray(list) ? list.length : 0,
    };
  }

  const envRaw = asRecord(
    asRecord(safeJsonParse(get("environment list --json")))["result"],
  )["environments"];
  const autoResult = asRecord(
    asRecord(safeJsonParse(get("automations list --json")))["result"],
  );
  const autoRaw = autoResult["automations"] ?? autoResult["items"];

  return {
    orcaVersion,
    runtime: {
      state:
        typeof runtime["state"] === "string" ? runtime["state"] : null,
      reachable:
        typeof runtime["reachable"] === "boolean"
          ? runtime["reachable"]
          : null,
      platform,
      appVersion:
        typeof runtime["appVersion"] === "string"
          ? runtime["appVersion"]
          : orcaVersion,
    },
    hosts,
    skillGuideNames,
    repos,
    worktrees,
    liveTerminalTotal,
    agentAccounts,
    environments: Array.isArray(envRaw) ? envRaw.length : 0,
    automations: Array.isArray(autoRaw) ? autoRaw.length : 0,
    skipped: [...SKIPPED_COMMANDS],
    warnings,
  };
}
