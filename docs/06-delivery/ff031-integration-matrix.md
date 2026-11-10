# FF-031 integration matrix (v0.1 assembly, rework)

**Status:** integration baseline for the v0.1 round trip, rebased per
coordinator review on #63. This branch contains **integration-owned files
only** (bridge HTTP server, fake backend, extras DB, finalization and
cross-process tests, docs, additive CI job). It consumes the canonical
E06/E03/E04 modules by path. #37 (SQLite WAL attempts) and #35
(dispatch v2) are merged into `develop`; the branch stays red until the
coordinator's remaining sequence lands: #33 (policy), #34 (journaled
adapter). Contract version is locked at
**0.1.0** (`packages/bridge-contracts/CONTRACT-VERSION`); no schema change
is made or needed by this assembly.

## 1. Assembled seams (this branch: new files only)

| File(s) | Owner | Depends on (canonical; #37/#35 merged, #33/#34 pending) |
|---|---|---|
| `services/orca-bridge/src/server.ts` — authenticated HTTP server | E01 integration | #37 `AttemptStore` (SQLite), #33 `authorize`, #35 argv/status/cancel, E02 discovery (merged) |
| `services/orca-bridge/src/main.ts` — env daemon entry (real spawn; fake + test hooks only via explicit env) | E01 integration | server |
| `services/orca-bridge/src/runtime/fake-orca.ts` — deterministic fake backend | E01 integration | #35 argv shapes (type-only import; no runtime dep) |
| `services/orca-bridge/src/persistence/bridge-extras.ts` — SQLite WAL extras DB (attempt index, message/cancel idempotency, SSE replay buffer) | E01 integration | node:sqlite stdlib |
| `services/orca-bridge/src/server.test.ts` — 16 HTTP round-trip tests | E01 integration | server |
| `services/orca-bridge/test/ff031-adapter-roundtrip.test.js` — 4 finalization tests vs canonical adapter ctx | E01 integration | #34 adapter, server |
| `services/orca-bridge/test/ff031-cross-process.test.js` — concurrent same-key + kill-after-accept proof | E01 integration | main entry, canonical store |
| `services/orca-bridge/package.json` | E01 integration | — |
| `.github/workflows/ci.yml` — additive `bridge-integration` job only | E01 integration (+FF-030 baseline untouched) | — |
| `docs/06-delivery/ff031-integration-matrix.md`, `ff031-live-smoke-plan.md`, `docs/07-research/paperclip-pin-reconciliation.md` | E01 integration | — |

No copies of other engineers' packages exist in this diff. Dependency
order: contracts -> discovery -> persistence (#37) -> policy (#33) ->
dispatch (#35) -> server -> adapter (#34). The adapter is the last link:
it only speaks HTTP to the bridge, never to Orca directly.

## 2. Durability design (answers review item 2)

- The **attempt ledger is #37's SQLite store** (`attempts.db`: WAL,
  `synchronous=FULL`, unique-key single-launch claim, `close`/reopen =
  restart, `assertSafeDbFile` ownership check wired at server boot).
- `bridge-extras.db` (same WAL discipline, same ownership check) holds
  strictly bridge-level correlation: the attempt index (backing sessions
  inventory and the ambiguous-history gate), message/cancel idempotency,
  and the SSE replay buffer. It is never the attempt ledger: fate is read
  from `AttemptStore`, and the extras mirror is resynced from the
  canonical reconcile report on every boot.
- Launcher fate unknown surfaces as **502 `dispatch_unknown`** with the
  durable `accepted` prefix standing. A same-key retry replays without
  relaunching; the server then reconciles (inventory adopt, or a single
  inventory-proven dispatch, or fail-closed `unknown`). Never a silent
  relaunch. 502 is surfaced as-is; adopting it into the frozen contract
  is E05's call (proposed, not made here).
- Concurrent first boot on a fresh data dir retries DB open briefly
  (creation race); steady-state locking is the store's `BEGIN IMMEDIATE`.

## 3. Cancellation semantics (locked, unchanged)

1. `POST /v1/attempts/{id}/cancel` requires `Idempotency-Key` plus
   non-empty `reason` and `approvedBy`; missing fields are 422.
2. Authority is the service Bearer [REDACTED] + project-scoped `dispatch.execute`
   allow; `approvedBy` is audit evidence only, never authority.
3. Cancel keys are bound per attempt and persisted (replay 202, cross-use 409).
4. A confirmed runtime stop records `cancelled` with fate evidence; an
   unproven stop records `unknown` with `confirmation: "pending"`.
5. Adapter `cancel()` forwards `{ reason, approvedBy }`; 202 means
   requested, confirmation arrives via events.

## 4. Capability errors (locked, unchanged)

- Unknown `workerKind`, or any provider whose status is not `verified`,
  is 422 `capability_unavailable` with no side effect and no dispatch.
- The bridge advertises `muse: verified` (only E03-verified agent) and
  `devin: unknown` (FF-010 deny-by-default). Version mismatch is a
  capability error, never a fallback to an unrelated executable.

## 5. Calculated findings (open, owned)

1. **Cross-process first boot races DB creation** (two daemons, one fresh
   data dir): handled by a bounded open-retry in the server; proven by the
   concurrent test sharing one data dir.
2. **`GET /v1/events` is a finite replay buffer in v0.1**, not a live
   socket (the pinned adapter client awaits the full body per wake).
   State GET stays authoritative.
3. **No workspace/packaging layer.** Cross-package imports use relative
   paths. Do not add one here; propose it through E05/E01 review.
4. **Ambiguous-history gate is backend-sensitive.** Backends with a full
   inventory (fake) adopt-or-dispatch exactly; backends without one fail
   closed with 429 while any non-terminal `unknown` attempt exists.
   Clearing requires `confirmTermination` proof or a fenced replacement.
5. **Terminal re-wake after finalize fails closed**
   (`workspace_finalize=failed`): Paperclip must not re-wake `done`
   sessions, or E04 should make finalize idempotent (E04-owned).

## 6. Downstream PR rebase instructions

- #33/#37/#35/#34 owners: this branch consumes your modules unmodified.
   If this assembly exposed a gap, open a bounded follow-up in your
   workstream — do not re-litigate the seam inside a rebase.
- #33/#35 reviewer note: server authorizes as the service actor with a
  project-scoped `dispatch.execute`; worker-supplied IDs/approvals never
  authorize. Flag any catalog change that alters that path.
- E05 (#46): 502 `dispatch_unknown` is a candidate contract addition;
  wire shape is unchanged otherwise.
- E17: deployment units are `services/orca-bridge` (`node src/main.js`,
  env `FORGEFLEET_BRIDGE_TOKEN`, `FORGEFLEET_BRIDGE_DATA_DIR`, loopback
  bind). Never place the bridge or its token on Vercel/serverless.
- FF-027 (UI split) stays independent (see
  `paperclip-pin-reconciliation.md`).
- FF-030 (CI): this branch only appends the `bridge-integration` job;
  baseline jobs are untouched.

## 7. What is deliberately NOT claimed

No live Orca, Paperclip, or Vultr touch happened here. All runtime evidence
is fake-backend (deterministic, including two real separate OS processes)
plus static pin verification design. The owner-authorized live smoke is
planned separately in `docs/06-delivery/ff031-live-smoke-plan.md`. The
existing Orca service was not probed, started, stopped, or listed by any
test in this branch. No Mac-side run counts as Vultr G1.
