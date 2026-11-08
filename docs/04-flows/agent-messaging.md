# F02: Worker communication, questions and sub-delegation

```mermaid
sequenceDiagram
  participant A as Worker A
  participant B as Bridge
  participant M as Message Ledger
  participant W as Worker B
  participant C as Coordinator
  actor H as Human
  A->>B: Ask Worker B: API response format?
  B->>M: Save task-linked question
  M->>W: Deliver message / wake if appropriate
  W-->>M: Answer with contract reference
  M-->>A: Deliver answer
  alt Peer resolves
    M-->>C: Summarized progress event
  else Cross-team ambiguity
    A->>M: Escalation with options/evidence
    M->>C: Request resolution
    alt Coordinator has authority
      C-->>A: Decision with rationale
    else Owner-only decision
      C->>M: Create human decision item
      M->>H: Queue approval / question
    end
  end
```

## Contract

Each message has unique ID and task/thread correlation; receipt acknowledged after persistence; recipient may be individual worker, lead, coordinator, owner or allowed group. Questions need deadline/severity. Agent-to-agent messages do not modify tasks or authority automatically; follow-up actions use separate typed API calls.

## Subdelegation

Lead can recommend spawning child tasks/agents, but the scheduler accepts only if within scope, budget, and DAG validity. A child worker inherits only minimal context and permissions. The root coordinator can revoke task claims or transfer ownership; cancellation must be reconciled with actual Orca process.

## No answer behavior

If peer unavailable or message expires, route to lead/coordinator. If human absent, block only dependent task. A blocked task may move back to ready after a reply; maintain original message and answer audit.
