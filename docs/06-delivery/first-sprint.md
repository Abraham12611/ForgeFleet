# Immediate execution sprint: prove the bridge

## Mission

Create a safe read-only integration baseline and demonstrate one round-trip Muse task without disrupting the existing Orca daemon.

### Day-zero prerequisites (engineers can parallelize)

- E01: inspect pinned Paperclip package versions/adapter APIs; choose minimal integration path.
- E02: inspect exact Vultr environment using sanitized read-only commands; never restart Orca.
- E05: generate bridge schemas/client from `docs/05-contracts/bridge.openapi.yaml`; build fake server.
- E06: implement idempotency + outbox persistence fixture; test duplicate calls.
- E07: service auth policy and deny tests.
- E17: isolated private Paperclip deployment plan and systemd bridge unit draft.
- E15: fake Orca script and crash-after-launch test.
- E12/E20: UI mock of one project and worker status (clearly labeled fixture).

### Integration sequence

1. E02 produces version-matched capabilities, supported Muse agent start syntax, and sanitized command transcripts.
2. E03 binds commands to typed bridge operations; E06 persists attempt mappings and receipts.
3. E04 attaches Paperclip process/HTTP prototype and returns job status; demonstrate at least one actual Muse run.
4. E15 kills bridge and checks no duplicate work; E01 confirms Paperclip workspace finalized correctly.
5. Owner validates web/mobile project status and one task outcome.

### Explicit acceptance trace

Project created; single task exists; one accepted idempotency key; one Orca dispatch ID; one isolated worktree; actual worker progress; actual completion evidence; no premature task verification; dashboard status with last sync timestamp; restart replay no second launch.

### Stop / blockers

If installed Orca CLI flags differ, stop and fix adapter map based on that binary's `skills get` and `--help`. If Paperclip/Orca workspace models conflict, stop attempts with full GitHub write permissions until sync-back contract is resolved. If Devin cannot launch supervised, record issue; do not block Muse MVP.
