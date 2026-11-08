# Version pin registry (to fill with evidence)

**OPEN:** Engineering agents should populate after read-only inspection. Do not guess current deployment versions.

| Dependency | Desired pin | Source of evidence | Status |
|---|---|---|---|
| Paperclip commit SHA/tag | TBD | `git rev-parse HEAD` / release | OPEN |
| Paperclip adapter API | TBD | inspected source + contract suite | OPEN |
| Existing Orca service binary | TBD | `orca-ide` or selected executable `--version` | OPEN |
| Orca orchestration CLI guide | version-matched | `skills get orchestration` | OPEN |
| Muse Code CLI | TBD | runtime capability probe | OPEN |
| Devin CLI | TBD | runtime capability probe | OPEN |
| Node.js toolchain | TBD | Paperclip package engines / lockfile | OPEN |
| PostgreSQL major version | TBD | deployed Paperclip requirement | OPEN |
| Capacitor SDK | TBD | Android phase release | DEFERRED |

## Upgrade rule

Upstream version upgrades need a branch and smoke tests covering start/status/event/resume/finalize, no unreviewed auto-upgrades on operational host. Version mismatch must yield capability error, not silent fallback to an unrelated executable.
