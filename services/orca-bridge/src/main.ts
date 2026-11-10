/**
 * FF-031 integration: bridge daemon entrypoint (env-configured).
 *
 * Production path: resolves the Orca executable per E02, runs real
 * subprocesses via `spawn` (argv vectors only, never a shell), and serves
 * the authenticated HTTP API on loopback. No test surface is enabled
 * unless explicitly requested:
 *
 * - `FORGEFLEET_FAKE_ORCA=1`: use the deterministic in-process fake backend
 *   (integration tests, Vultr smoke without touching real Orca).
 * - `FORGEFLEET_TEST_BLOCK_LAUNCH=<dir>`: launcher writes a `sentinel` file
 *   then polls for `release` before running (kill-after-accept test hook).
 * - `FORGEFLEET_TEST_COUNT_LAUNCHES=<file>`: append one line per launcher
 *   invocation (cross-process single-launch proof).
 * - `FORGEFLEET_FAKE_ORCA_SEQ_START=<n>`: start the fake dispatch counter
 *   at `n` so sibling bridge processes mint non-colliding fake dispatch ids.
 * - `FORGEFLEET_ALLOW_TEST_INGEST=1`: enable the test event-ingest route.
 *
 * Required env: `FORGEFLEET_BRIDGE_TOKEN`.
 * Optional: `FORGEFLEET_BRIDGE_DATA_DIR` (default `./bridge-data`),
 * `FORGEFLEET_BRIDGE_HOST` (default `127.0.0.1`), `PORT` (default 4387).
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BridgeServer, type RuntimeBackend } from "./server.ts";
import type { CommandResult } from "./runtime/dispatch.ts";
import { FakeOrca } from "./runtime/fake-orca.ts";

const OUTPUT_CAP_BYTES = 256 * 1024;

function runReal(executable: string, argv: readonly string[], opts: { timeoutMs?: number }): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (exitCode: number, errText: string): void => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, stdout, stderr: errText ? `${stderr}\n${errText}` : stderr });
    };
    let child;
    try {
      child = spawn(executable, [...argv], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: opts.timeoutMs ?? 60_000,
      });
    } catch (err) {
      finish(127, err instanceof Error ? err.message : String(err));
      return;
    }
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < OUTPUT_CAP_BYTES) stdout += d.toString("utf-8").slice(0, OUTPUT_CAP_BYTES - stdout.length);
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < OUTPUT_CAP_BYTES) stderr += d.toString("utf-8").slice(0, OUTPUT_CAP_BYTES - stderr.length);
    });
    child.on("error", (err) => finish(127, err.message));
    child.on("close", (code) => finish(code ?? 1, ""));
  });
}

function waitForRelease(dir: string, timeoutMs: number): Promise<void> {
  const release = join(dir, "release");
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (existsSync(release)) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("launch blocked: release file never arrived; failing closed"));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

async function main(): Promise<void> {
  const token = process.env.FORGEFLEET_BRIDGE_TOKEN ?? "";
  if (!token) {
    console.error("FORGEFLEET_BRIDGE_TOKEN is required");
    process.exitCode = 1;
    return;
  }
  const dataDir = process.env.FORGEFLEET_BRIDGE_DATA_DIR ?? "./bridge-data";
  const host = process.env.FORGEFLEET_BRIDGE_HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? "4387");

  let backend: RuntimeBackend;
  if (process.env.FORGEFLEET_FAKE_ORCA === "1") {
    const seqStart = Number(process.env.FORGEFLEET_FAKE_ORCA_SEQ_START ?? "0");
    const fake = new FakeOrca(Number.isInteger(seqStart) && seqStart >= 0 ? seqStart : 0);
    const countFile = process.env.FORGEFLEET_TEST_COUNT_LAUNCHES;
    const blockDir = process.env.FORGEFLEET_TEST_BLOCK_LAUNCH;
    const innerRun = fake.run.bind(fake);
    backend = {
      run: async (executable, argv, opts) => {
        // Test hook: block only real dispatches, never boot probes.
        if (blockDir && argv[0] === "orchestration" && argv[1] === "worker-start") {
          writeFileSync(join(blockDir, "sentinel"), "launcher-entered\n");
          await waitForRelease(blockDir, 10_000);
        }
        // Count actual worker-start commands, not launcher entries: a
        // launcher killed mid-flight must not count as a launch.
        if (countFile && argv[0] === "orchestration" && argv[1] === "worker-start") {
          appendFileSync(countFile, `launch ${Date.now()}\n`);
        }
        return innerRun(executable, argv, opts);
      },
      listSessions: () => fake.listSessions(),
    };
    // Keep the fake reachable for in-process tests that import main? No:
    // cross-process tests observe via HTTP only. The instance lives here.
    void fake;
  } else {
    backend = { run: runReal };
  }

  const server = await BridgeServer.create({
    dataDir,
    token,
    backend,
    host,
    port,
  });
  const url = await server.listen();
  console.log(`orca-bridge listening on ${url}`);

  const shutdown = (): void => {
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
