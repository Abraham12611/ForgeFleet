// Static rule mirroring the upstream no-push check (FF-001, from upstream
// packages/adapters AUTHORING.md + scripts/check-no-git-push.mjs): adapter
// source must never invoke a git remote-push. Opt-out only via an explicit
// `// paperclip:allow-git-push: <reason>` comment on the same line.
// Run: `node ./check-no-push.mjs` (also asserted in the test suite).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ALLOW = 'paperclip:allow-git-push:';

function jsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) jsFiles(p, out);
    else if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

// Built dynamically so this check's own source is not self-matching.
const pushCmd = ['git', 'push'].join(' ');
let failures = 0;
for (const file of jsFiles(here)) {
  const src = readFileSync(file, 'utf8');
  src.split('\n').forEach((line, i) => {
    if (line.includes(pushCmd) && !line.includes(ALLOW)) {
      console.error(`forbidden remote-push invocation: ${file}:${i + 1}`);
      failures += 1;
    }
  });
}
if (failures > 0) {
  console.error(`${failures} forbidden invocation(s); add '${ALLOW} <reason>' only with contract review.`);
  process.exit(1);
}
console.log(`OK: no remote-push invocations across ${jsFiles(here).length} source files`);
