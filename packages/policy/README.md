# @forgefleet/policy (FF-004)

Deterministic least-privilege authorization. Pure logic, zero dependencies;
tests run on stdlib `node:test` (`npm test`).

**Status: design prototype, not a deployed security gate.** It decides
`allow | deny | require_owner` from caller-supplied inputs and cannot
verify identity or provenance itself. See `docs/03-architecture/security-policy.md`
for the threat model and the server boundary obligations (E16/services)
that must hold before this engine fronts any real API.
