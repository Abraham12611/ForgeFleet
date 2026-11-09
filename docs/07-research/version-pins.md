# Version pin registry (to fill with evidence)

**OPEN:** Engineering agents should populate after read-only inspection. Do not guess current deployment versions.
FF-001 pinned the Paperclip rows below from read-only upstream inspection on 2026-11-08; all other rows remain OPEN.

| Dependency | Desired pin | Source of evidence | Status |
|---|---|---|---|
| Paperclip commit SHA/tag | Tag `v2026.1106.0` = commit `d69631b01b9c658f80bf8bed389863dce82643e1` (committed 2026-10-23) | `git ls-remote` tags + GitHub commit API; re-verified by `scripts/paperclip-pin-smoke.sh` | PINNED (FF-001) |
| Paperclip adapter API | External plugin exporting `createServerAdapter` (`./server/index.js`); `runtime.sessionParams` in / `sessionParams` out; `clearSession` recovery; capability flags via `GET /api/adapters`; no-remote-git cwd contract | `docs/adapters/creating-an-adapter.md`, `docs/adapters/http.md`, `docs/adapters/process.md`, `packages/adapters/AUTHORING.md` at the pinned tag; asserted by `examples/paperclip-adapter-smoke/` | PINNED (FF-001) |
| Existing Orca service binary | TBD | `orca-ide` or selected executable `--version` | OPEN |
| Orca orchestration CLI guide | version-matched | `skills get orchestration` | OPEN |
| Muse Code CLI | TBD | runtime capability probe | OPEN |
| Devin CLI | TBD | runtime capability probe | OPEN |
| Node.js toolchain | TBD | Paperclip package engines / lockfile | OPEN |
| PostgreSQL major version | TBD | deployed Paperclip requirement | OPEN |
| Capacitor SDK | TBD | Android phase release | DEFERRED |

## Upgrade rule

Upstream version upgrades need a branch and smoke tests covering start/status/event/resume/finalize, no unreviewed auto-upgrades on operational host. Version mismatch must yield capability error, not silent fallback to an unrelated executable.
