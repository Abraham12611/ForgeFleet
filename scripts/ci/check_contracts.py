#!/usr/bin/env python3
"""Contract/schema consistency gate (standard library only).

Validates, without third-party YAML/JSON-schema dependencies:
1. Every `examples/*.json` fixture parses and carries its required keys.
2. `docs/05-contracts/bridge.openapi.yaml` has no duplicated paths,
   operationIds, or component schema names.
3. Every local `$ref: '#/components/schemas/<Name>'` resolves to a schema
   defined under `components/schemas/`.

Exits nonzero on the first class of problem found, listing all instances.
"""
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(os.environ.get("FF_CI_ROOT", Path(__file__).resolve().parent.parent.parent))
OPENAPI = ROOT / "docs/05-contracts/bridge.openapi.yaml"
EXAMPLES = ROOT / "examples"

REQUIRED_FIXTURE_KEYS = {
    "bridge-event.example.json": {
        "eventId",
        "schemaVersion",
        "eventType",
        "occurredAt",
        "projectId",
        "taskId",
        "attemptId",
        "correlationId",
        "fencingEpoch",
    },
    "task-graph.example.json": {"goal", "planRevision", "tasks"},
    "context-manifest.example.json": {
        "projectId",
        "revision",
        "sources",
        "taskBindings",
    },
}


def check_fixtures(errors: list[str]) -> None:
    if not EXAMPLES.is_dir():
        errors.append(f"missing required directory: {EXAMPLES.relative_to(ROOT)}/")
        return
    for name, required in REQUIRED_FIXTURE_KEYS.items():
        path = EXAMPLES / name
        if not path.is_file():
            errors.append(f"missing required fixture: examples/{name}")
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            errors.append(f"examples/{name}: invalid JSON: {exc}")
            continue
        if not isinstance(data, dict):
            errors.append(f"examples/{name}: top level must be an object")
            continue
        missing = required - set(data)
        if missing:
            errors.append(
                f"examples/{name}: missing keys: {sorted(missing)}"
            )


def parse_openapi_sections(lines: list[str]):
    """Split top-level `paths:` and `components/schemas:` line ranges."""
    paths_range: list[int] | None = None
    schemas_range: list[int] | None = None
    top_level: list[tuple[int, str]] = []
    for i, line in enumerate(lines):
        match = re.match(r"^(\S[^:]*):\s*(.*)$", line)
        if match:
            top_level.append((i, match.group(1)))
    for idx, (start, name) in enumerate(top_level):
        end = top_level[idx + 1][0] if idx + 1 < len(top_level) else len(lines)
        if name == "paths":
            paths_range = [start, end]
        elif name == "components":
            for j in range(start, end):
                if re.match(r"^  schemas:\s*$", lines[j]):
                    schemas_range = [j, end]
    return paths_range, schemas_range


def check_openapi(errors: list[str]) -> None:
    if not OPENAPI.is_file():
        errors.append(
            "missing required contract: "
            f"{OPENAPI.relative_to(ROOT)}"
        )
        return
    lines = OPENAPI.read_text(encoding="utf-8").splitlines()
    if not any(line.startswith("openapi:") for line in lines):
        errors.append(f"{OPENAPI.name}: missing top-level `openapi:` version")

    paths_range, schemas_range = parse_openapi_sections(lines)

    seen_paths: dict[str, int] = {}
    if paths_range is None:
        errors.append(f"{OPENAPI.name}: missing top-level `paths:` section")
    else:
        for i in range(paths_range[0], paths_range[1]):
            match = re.match(r"^  (/[^:\s]*):\s*$", lines[i])
            if match:
                path = match.group(1)
                if path in seen_paths:
                    errors.append(
                        f"{OPENAPI.name}:{i + 1}: duplicated path "
                        f"`{path}` (first at line {seen_paths[path]})"
                    )
                else:
                    seen_paths[path] = i + 1

    seen_op_ids: dict[str, int] = {}
    for i, line in enumerate(lines):
        match = re.match(r"^\s+operationId:\s*(\S+)\s*$", line)
        if match:
            op_id = match.group(1)
            if op_id in seen_op_ids:
                errors.append(
                    f"{OPENAPI.name}:{i + 1}: duplicated operationId "
                    f"`{op_id}` (first at line {seen_op_ids[op_id]})"
                )
            else:
                seen_op_ids[op_id] = i + 1

    defined_schemas: set[str] = set()
    if schemas_range is None:
        errors.append(f"{OPENAPI.name}: missing `components/schemas:` section")
    else:
        for i in range(schemas_range[0], schemas_range[1]):
            match = re.match(r"^    ([A-Za-z0-9_]+):\s*$", lines[i])
            if match:
                name = match.group(1)
                if name in defined_schemas:
                    errors.append(
                        f"{OPENAPI.name}:{i + 1}: duplicated schema `{name}`"
                    )
                defined_schemas.add(name)

    for i, line in enumerate(lines):
        match = re.search(r"\$ref:\s*'#/components/schemas/([^']+)'", line)
        if match:
            ref = match.group(1)
            if ref not in defined_schemas:
                errors.append(
                    f"{OPENAPI.name}:{i + 1}: unresolvable "
                    f"$ref to schema `{ref}`"
                )


def main() -> int:
    errors: list[str] = []
    check_fixtures(errors)
    check_openapi(errors)
    if errors:
        print("Contract consistency FAILED:")
        for error in errors:
            print(f"  - {error}")
        return 1
    print("OK: fixtures valid, no duplicated paths/operationIds/schemas, all $refs resolve")
    return 0


if __name__ == "__main__":
    sys.exit(main())
