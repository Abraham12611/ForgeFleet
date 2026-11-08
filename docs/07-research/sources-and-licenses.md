# Open-source source inventory, licensing and provenance

Verified from repository README/docs during planning (2026-11-08); **not** a compatibility guarantee for deployed versions. Reverify tags, licenses, dependencies and operational constraints before vendoring or forking.

| Candidate | Canonical source | Observed license | Intended use | Caveat |
|---|---|---|---|---|
| Paperclip | https://github.com/paperclipai/paperclip | MIT (repo metadata) | Primary control plane and React UI | Pin a tested commit; rapidly evolving APIs |
| Orca | https://github.com/stablyai/orca | MIT (README) | Existing local execution and worktrees | Version-matched CLI required, avoid internal APIs |
| Vespin | https://github.com/ReviewStage/vespin | Apache-2.0 (README) | Messaging/inbox/PR UX reference | Contribution guide states backend self-hosting not supported yet |
| Gas City | https://github.com/gastownhall/gascity | MIT (README) | Future advanced DAG execution reference | Do not run two independent schedulers for same tasks |
| MCP Agent Mail | https://github.com/Dicklesworthstone/mcp_agent_mail_rust | Check actual LICENSE before copying | Optional inter-agent messaging patterns | May duplicate Paperclip task threads |
| Vibe Kanban | https://github.com/BloopAI/vibe-kanban | Check actual LICENSE before copying | Optional board/worktree UX reference | Potential redundant task store |
| Temporal | https://github.com/temporalio/temporal | Check component licenses | Optional durable orchestration at scale | Operationally heavy for MVP |

## Key primary sources

- Paperclip README: https://github.com/paperclipai/paperclip/blob/master/README.md
- Paperclip adapter guide: https://github.com/paperclipai/paperclip/blob/master/docs/adapters/creating-an-adapter.md
- Paperclip HTTP adapter: https://github.com/paperclipai/paperclip/blob/master/docs/adapters/http.md
- Paperclip generic process adapter: https://github.com/paperclipai/paperclip/blob/master/docs/adapters/process.md
- Paperclip no-remote-git adapter invariants: https://github.com/paperclipai/paperclip/blob/master/packages/adapters/AUTHORING.md
- Orca orchestration discovery stub: https://github.com/stablyai/orca/blob/main/skills/orchestration/SKILL.md
- Orca CLI discovery stub: https://github.com/stablyai/orca/blob/main/skills/orca-cli/SKILL.md
- Vespin contribution constraints: https://github.com/ReviewStage/vespin/blob/main/CONTRIBUTING.md
- Gas City README: https://github.com/gastownhall/gascity/blob/main/README.md

## License process

No third-party source code has been copied into this scaffold. When adding upstream code: review LICENSE + NOTICE + transitive dependencies, preserve headers/attributions, capture upstream commit and patch set, and check proprietary CLI/provider terms separately. Keep actual included code licenses rather than choosing a project license that mistakenly overrides them. ForgeFleet's own public license to be decided before a public release.
