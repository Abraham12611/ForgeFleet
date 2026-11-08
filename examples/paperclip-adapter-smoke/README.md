# FF-001 fixture: minimal external-adapter plugin shape (NOT live integration)

Mirrors the plugin contract pinned in
[`docs/07-research/paperclip-integration-strategy.md`](../../docs/07-research/paperclip-integration-strategy.md)
at upstream tag `v2026.1106.0`, so E04 can build the real
`packages/paperclip-orca-adapter` against a frozen shape.

- `server/index.mjs` — exports `createServerAdapter` (plugin-loader
  convention) with `execute()`, `sessionCodec`, capability flags,
  `sessionParams` continuity, `clearSession` recovery, and a
  prepare/restore cwd round-trip standing in for the Orca worktree sync-back.
- `ui-parser.mjs` — self-contained UI parser stub (no upstream `ui/`
  registry edit).
- `smoke.mjs` — six assertions run with plain `node` (stdlib only).

Run: `node examples/paperclip-adapter-smoke/smoke.mjs`, or the full
pin + fixture check via `scripts/paperclip-pin-smoke.sh`.
