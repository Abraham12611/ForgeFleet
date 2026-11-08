# Compatibility matrix, verification spikes and blockers

## Source facts relevant to integration

- Paperclip docs provide `process` and `http` adapters; the HTTP adapter primarily triggers an external service and expects callback, but is not suited for deep real-time stdout capture by itself.
- Paperclip supports external adapters with `createServerAdapter`, session params and an execution context; exact API shape must match pinned commit.
- Paperclip's adapter authoring guidance says local execution cwd is the persistence boundary across heartbeats, and adapters must sync remote execution output back on finalize.
- Orca has orchestration and CLI skills whose discovery stubs require loading a version-matched guide from installed executable.
- On Linux outside managed terminals, Orca may use `orca-ide`; bare `orca` can refer to GNOME Orca screen reader. `ORCA_CLI_COMMAND` can override.
- Orca README lists Muse as supported terminal agent. Actual supported supervised launch flags and Devin behavior require runtime checks.
- Vespin's self-hosting backend is not officially supported as of current contributor docs. Therefore Vespin is not chosen for primary deployment.

## Spike plan

| Spike | Experiment | Pass condition | Rollback |
|---|---|---|---|
| S-01 | Discover service status, Orca CLI executable, skills, worktrees read-only | Accurate sanitized report; no change to running workers | No persistent mutations |
| S-02 | Create disposable Orca supervised Muse attempt | Stable task/dispatch/worktree IDs, observe final event | Cancel only created disposable attempt |
| S-03 | Use Paperclip process adapter as temporary bridge client | Paperclip task causes typed bridge call | Disable adapter, no service replacement |
| S-04 | External Paperclip adapter with proper session handling | Reopen/resume same task, exact event transcript | Revert plugin install |
| S-05 | Verify cwd persistence and Orca worktree sync-back | New local state visible to dependent task without relying on push | Quarantine failing attempt |
| S-06 | Devin launch/capabilities probe | Verified supervised or controlled terminal fallback | Disable Devin runtime |
| S-07 | Two workers same repo on distinct branches | No writable overlap or missing files | Stop test workers and remove test worktrees |
| S-08 | Bridge crash between launch and receipt | One dispatch after recovery | Freeze dispatch, inspect external IDs |
| S-09 | GitHub App webhook + checks + protected main | Fake signature denied; valid status tied to head SHA | Revoke test installation |
| S-10 | Mobile PWA over Tailscale | Reliable auth, file upload, decision answer at 360px | Use desktop web temporarily |

## Deliverable format

Each spike PR attaches: exact CLI/tool version, environment (sanitized), commands or scripts (redacted), test repo, outcome, failure logs (redacted), observed payloads, compatibility verdict, and doc/contract amendments. Never mark a spike passed from README alone.
