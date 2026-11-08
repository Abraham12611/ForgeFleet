# Policy decisions and GitHub action matrix

| Action | Worker | Lead | Coordinator | Human owner | Default guard |
|---|---|---|---|---|---|
| Read assigned task/context | Yes | Own team | Project | Yes | Project-scoped ACL |
| Message assigned peer | Yes | Yes | Yes | Yes | Same project + thread ACL |
| Propose subtask | Yes | Yes | Yes | Yes | DAG validation, budgets |
| Dispatch new agent | Proposal only | Proposal only | Proposal + scheduler | May override limit within hard caps | Capacity and lease check |
| Open PR | Yes (repo-scoped) | Yes | Yes | Yes | Branch restrictions |
| Approve independent review | No self-approval | Independent only | Independent only | Yes | Not author, head SHA stable |
| Merge into develop | No | No | Allowed by policy service | Yes | Required checks + reviewer + protected branch |
| Merge into main | No | No | Request only | Yes | Explicit owner action, exact SHA |
| Production deploy | No | No | Request only | Yes | Separate deployment gate |
| Create worker host/budget increase | No | Request | Request | Yes | Approved budget + provider limits |
| Rotate secrets / grant permissions | No | No | Request only | Yes | Owner session reauth |
| Destroy DB / remove resource | No | No | No | Yes after confirmation | Explicit resource id + audit |

Approval is **not** a chat utterance. It must be a signed, auditable control-plane action against exact target resource state. An AI's recommendation never bypasses policy.
