# Files, context, memory and retrieval

## Input types

Text goals, Markdown, source files, images, PDFs, diagrams, OpenAPI, repository links, design references and issue/PR comments. Do not assume all can be parsed: surface per-file extraction/validation states.

## Pipeline

Upload via authenticated signed URL -> malware/content-type/size checks -> object store -> textual extraction -> chunk and metadata -> project-scoped index -> immutable content version -> coordinator planning context -> worker task-specific context manifest.

## Context manifest

Each task stores hash-pinned references: project goal revision, requirements/specs, API contracts, design docs, code branch SHA, relevant chat/decisions, acceptance criteria, and a bounded summary. The `attempt` references the exact manifest version; subsequent edits require explicit context-refresh event.

## Memory layers

- Durable **project memory**: goals, decisions, contracts, important architecture and meeting points.
- Durable **task memory**: acceptance criteria, progress, blocker resolution, artifacts, prior attempt summaries.
- Short-lived **session memory**: agent prompt and terminal transcript; never sole source of truth.
- **Knowledge retrieval**: indexed, permission-checked source chunks, citations, recency controls.

## Avoid context flooding

At most necessary excerpts plus source links; chunk by semantic sections; dedupe repeated specs; preserve structured contracts verbatim. On long-running task, summarize decisions without overwriting originals and record context provenance.

## Security

Do not ingest `.env`, credentials, private keys or secrets into project context. Restrict file paths/mime, sanitize markdown/html, quota storage and embedding jobs, protect vector index by project. Embeddings and external model calls must honor data policies.
