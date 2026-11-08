# Agent messaging and coordination

## Design choice

Paperclip task threads remain the primary durable conversation; the bridge normalizes Orca messages and may expose MCP agent tools. Do not create a separate Slack-like authoritative task system. Channels are a **view/filter** over a persisted message transport, not a second scheduler.

## Channels and recipients

- `project/general`: human + coordinator + leads.
- `team/<name>`: team lead/assigned engineers.
- `task/<taskId>`: mandatory thread for a task, including Q&A, blockers, output evidence.
- `reviews`: PR review questions and CI failure explanations.
- `decisions`: only human-escalated questions/approvals.

Message envelope: messageId, threadId, projectId, taskId?, attemptId?, actorType, actorId, recipientIds, type (`text`, `question`, `answer`, `blocker`, `status`, `artifact`, `system`), text/attachments, createdAt, traceId, idempotencyKey, visibility and delivery state.

## Messaging policy

Peer-to-peer cross-team clarifications allowed. Coordinator sees summary of routine peer exchanges, not full raw spam, unless it subscribes to the thread. Workers may not impersonate owner/coordinator, grant permissions, or send a task to another project. Agent responses must be scoped and cited when derived from files.

## MCP tools (future, scoped)

`send_message`, `read_thread`, `ask_coordinator`, `create_blocker`, `request_decision`, `post_artifact`, `mark_task_ready_for_review`; each validates caller identity, project, task ownership, schema and permissions. MCP is the agent-facing interface; service-to-service lifecycle uses adapter/HTTP APIs.

## Delivery

Durable event receipt, outbox, at-least-once with dedupe. Question wakeups should not repeatedly awaken idle agents for every duplicate event. Thread reply wakes the intended task/worker and records read/ack states where supported.

## Moderation and security

Treat all agent text, repository content, PR comments and attachments as untrusted input. No chat message can override privileged policy or control-plane permissions. Strip secrets, limit body size, validate attachment MIME, and audit cross-project mentions.
