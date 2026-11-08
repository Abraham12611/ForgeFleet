# Assumptions, unknowns and decision queue

| ID | Unknown / risk | How to verify | Blocks |
|---|---|---|---|
| U-01 | Actual installed Orca CLI command/version reachable from noninteractive service | `ORCA_CLI_COMMAND` or `orca-ide` read-only commands and version-matched skills | v0.1 |
| U-02 | Existing Orca daemon's socket/auth and user service environment | Read-only process and service inspection | v0.1 |
| U-03 | Muse supervised worker lifecycle and stable event format | Spike with disposable repo | v0.1 |
| U-04 | Devin supervised dispatch or terminal-only fallback | Test capabilities, don't assume same as Muse | v0.2 |
| U-05 | Paperclip external adapter contract under pinned upstream version | Implement small contract fixture + fork smoke test | v0.1 |
| U-06 | Worktree ownership/sync-back compatibility Paperclip ↔ Orca | Run persistence/disconnect tests without remote push | v0.1 |
| U-07 | GitHub App OAuth/installation and branch protections available | Sandbox repository with least privilege | v0.3 |
| U-08 | Budget/provider capacity, actual VPS hardware, 100–200 worker ceiling | Resource/quota audit and staged load test | v1.1 |
| U-09 | Paperclip channel/chat maturity in selected upstream release | Feature flag and persistence test | v0.2 |
| U-10 | Android background notification and Play distribution approach | Capacitor spike and Play console configuration | v1.1 |
| U-11 | Product branding/domain/trademark availability for ForgeFleet | Human legal/domain check before public launch | v1.0 |

No engineer may silently convert these into verified facts. The coordinator should maintain this list and link evidence from completed spike issues.
