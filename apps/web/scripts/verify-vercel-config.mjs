// Fail-closed gate for the Vercel preview rewrite (FF-027 review follow-up).
// Runs as `prebuild`: any `/api/*` rewrite pointing at a placeholder or
// insecure origin fails the build unless the operator explicitly opts into
// local-only work with FORGEFLEET_ALLOW_PLACEHOLDER_API=1 (never set in a
// Vercel project). Dependency-free so it runs anywhere node does.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLACEHOLDER_HOST = /\.example$|\.invalid$|\.local$|\.ts\.net$/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function rewriteProblems(vercelJson) {
  const problems = [];
  const rewrites = vercelJson?.rewrites ?? [];
  for (const rewrite of rewrites) {
    const dest = rewrite?.destination;
    if (typeof dest !== "string" || !/^https?:\/\//.test(dest)) continue; // SPA fallback etc.
    let url;
    try {
      url = new URL(dest);
    } catch {
      problems.push(`${rewrite.source} -> malformed destination: ${dest}`);
      continue;
    }
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      PLACEHOLDER_HOST.test(host) ||
      IPV4.test(host) ||
      host.includes(":") ||
      host === "localhost"
    ) {
      problems.push(
        `${rewrite.source} -> ${dest}: not an owned public HTTPS ingress`,
      );
    }
  }
  return problems;
}

const dir = dirname(fileURLToPath(import.meta.url));
const vercelJson = JSON.parse(
  readFileSync(resolve(dir, "..", "vercel.json"), "utf8"),
);
const problems = rewriteProblems(vercelJson);
if (problems.length === 0) {
  console.log("vercel.json API rewrites point at an owned HTTPS ingress.");
} else if (process.env.FORGEFLEET_ALLOW_PLACEHOLDER_API === "1") {
  console.warn(
    "WARNING: placeholder API rewrite allowed only for local work " +
      "(FORGEFLEET_ALLOW_PLACEHOLDER_API=1):\n- " +
      problems.join("\n- "),
  );
} else {
  console.error(
    "REFUSING BUILD: vercel.json API rewrite is a placeholder, not an owned domain:\n- " +
      problems.join("\n- ") +
      "\nSet the E17 (FF-028) staging ingress, or export " +
      "FORGEFLEET_ALLOW_PLACEHOLDER_API=1 for local-only work (never in Vercel).",
  );
  process.exit(1);
}
