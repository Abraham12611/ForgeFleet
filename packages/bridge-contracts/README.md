# Bridge contracts v0.1 (E05)

Frozen Orca bridge API contract and generated validation for ForgeFleet v0.0.

- Source of truth: `docs/05-contracts/bridge.openapi.yaml` (`info.version: 0.1.0`)
  and the normative JSON Schemas in `schemas/`.
- Normative payloads: `schemas/bridge-api.schema.json`
- Normative event envelope: `schemas/bridge-events.schema.json`
- Generated (do not edit): `src/bridge_contracts/_generated.py`,
  `generated/bridge.types.ts`, `generated/contract-manifest.json`

## Freeze policy

v0.1 is frozen. Compatible clarifications only within `0.1.x`. Any breaking
field change requires a contract version bump, regenerated outputs, and
explicit downstream acknowledgement (E06 persistence/events, E07
policy, E10 messaging, E03 dispatch, E04 adapter).

## Regenerate

```sh
python3 scripts/generate.py           # regenerate outputs
python3 scripts/generate.py --check   # fail if outputs are stale
```

## Test

```sh
python3 -m unittest discover -s tests -v   # stdlib only, no dependencies
```

## Use (Python, stdlib only)

```python
from bridge_contracts import validate_create_attempt_request, validate_bridge_event

errors = validate_create_attempt_request(payload)  # [] when valid
for error in errors:
    print(error.path, error.message)
```

## Use (TypeScript)

Import the generated types from `generated/bridge.types.ts` until a packaged
client exists. `Idempotency-Key` header values must satisfy the
`IdempotencyKey` schema (8–160 chars); servers return `409` on key reuse with
a conflicting payload and exactly one Orca dispatch on key + payload match.
