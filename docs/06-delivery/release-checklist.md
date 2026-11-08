# Milestone release evidence template

**Version:** `vX.Y`  
**Coordinator:** TBD  
**Built from commit:** TBD  
**Upstream Paperclip/Orca versions:** TBD

## Functional proof

- [ ] Goal/task/agent behavior for this milestone actually observed (not fixture only).
- [ ] Dependencies and versioned context trace to task evidence.
- [ ] Required test suite and mobile screenshots attached.
- [ ] GitHub status/PR head SHA and policy outcome independently verified.
- [ ] Known gaps documented with issue links.

## Safety proof

- [ ] No secrets committed or passed to worker contexts.
- [ ] Lease/retry/idempotency behavior validated.
- [ ] User-only operations blocked from agents.
- [ ] Existing Orca sessions unaffected; rollback/restore rehearsed.
- [ ] Host resource/budget limits respected.

## User acceptance

- [ ] Human can see verified progress and actionable decisions on phone.
- [ ] Sleep mode behavior matches spec.
- [ ] Release approved explicitly when required.

**Decision:** Pass / Fail / Conditional (describe exact unmet gate). Do not mark shipped until pass.
