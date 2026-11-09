// CI-discovery entry for the repo inventory (`scripts/ci/inventory.py`
// runs root `*.test.mjs` files explicitly; directory discovery does not
// load `.test.ts`). Imports the TypeScript suites so the same tests run
// locally (`npm test`) and in CI. Node >= 24 strips types natively.
import "./src/thread-store.test.ts";
import "./src/router-escalation.test.ts";
import "./src/mcp.test.ts";
import "./src/persistence.test.ts";
import "./src/policy-compat.test.ts";
import "./src/contract-compat.test.ts";
