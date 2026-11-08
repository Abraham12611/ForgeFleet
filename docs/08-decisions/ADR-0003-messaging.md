# ADR-0003 — Durable task threads with MCP facade, not a second chat authority

**Status:** Accepted as initial direction.

## Context

Workers need Slack-like peer Q&A, team channels, coordinator escalations and a consolidated human inbox. Ad hoc terminal chatter loses messages and makes 100-agent supervision impossible.

## Decision

Use Paperclip tasks/threads as durable message authority; normalize Orca events; expose strongly scoped typed tools to workers through MCP later. Shared channels are filtered views over persisted task-linked records. Only explicit authenticated owner decision changes privileged policy.

## Consequences

Fewer conflicting stores, consistent audit history, but may require custom channel UI and notification/translation bridge. Avoid Vespin backend import unless it has a supported deployment model and satisfies the same security controls.
