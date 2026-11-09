"""Stdlib-only validation for the frozen ForgeFleet bridge contract v0.1.

Validates request/response payloads and normalized event envelopes against
the embedded schemas generated from ``schemas/*.schema.json``. This module
implements a small JSON Schema subset interpreter (``type``, ``required``,
``properties``, ``additionalProperties``, ``enum``, ``const``, ``minLength``,
``maxLength``, ``minimum``, ``maximum``, ``items``, ``format`` for ``uuid``
and ``date-time``) so validation has no third-party dependencies.

Typed errors carry a JSON-pointer-style ``path`` (e.g. ``/lease/fencingEpoch``)
suitable for the ``Error.details`` object in the frozen OpenAPI spec.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from ._generated import CONTRACT_VERSION, SCHEMAS

UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
DATETIME_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$"
)

# (source, eventId) is the documented dedupe key for at-least-once delivery.
DEDUPE_KEY_FIELDS: Tuple[str, ...] = ("source", "eventId")


class ValidationError:
    """One typed validation failure at a JSON-pointer-style path."""

    def __init__(self, path: str, message: str) -> None:
        self.path = path or "/"
        self.message = message

    def to_dict(self) -> Dict[str, str]:
        return {"path": self.path, "message": self.message}

    def __str__(self) -> str:
        return "%s: %s" % (self.path, self.message)

    def __repr__(self) -> str:
        return "ValidationError(%r, %r)" % (self.path, self.message)


def _resolve_ref(schema: Dict[str, Any]) -> Dict[str, Any]:
    while isinstance(schema, dict) and "$ref" in schema:
        ref = schema["$ref"]
        if not ref.startswith("#/"):
            raise ValueError("only local refs supported, got %r" % ref)
        node: Any = {"$defs": SCHEMAS}
        for part in ref[2:].split("/"):
            node = node[part]
        schema = node
    return schema


def _check_type(value: Any, expected: Any) -> bool:
    if isinstance(expected, list):
        return any(_check_type(value, item) for item in expected)
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "null":
        return value is None
    return True


def _check_format(value: str, fmt: str) -> bool:
    if fmt == "uuid":
        return bool(UUID_RE.match(value))
    if fmt == "date-time":
        if not DATETIME_RE.match(value):
            return False
        try:
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return False
        return True
    return True


def _validate(
    value: Any, schema: Dict[str, Any], path: str, errors: List[ValidationError]
) -> None:
    schema = _resolve_ref(schema)
    if not isinstance(schema, dict):
        return

    if "const" in schema and value != schema["const"]:
        errors.append(ValidationError(path, "must equal %r" % (schema["const"],)))
        return
    if "enum" in schema and value not in schema["enum"]:
        errors.append(
            ValidationError(path, "must be one of %s" % (sorted(map(str, schema["enum"])),))
        )
        return

    expected_type = schema.get("type")
    if expected_type is not None and not _check_type(value, expected_type):
        errors.append(ValidationError(path, "must be of type %s" % (expected_type,)))
        return

    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            errors.append(
                ValidationError(
                    path, "shorter than minLength %d" % schema["minLength"]
                )
            )
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errors.append(
                ValidationError(
                    path, "longer than maxLength %d" % schema["maxLength"]
                )
            )
        if "format" in schema and not _check_format(value, schema["format"]):
            errors.append(
                ValidationError(
                    path, "must match format %r" % schema["format"]
                )
            )
    elif isinstance(value, bool):
        pass
    elif isinstance(value, (int, float)):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(
                ValidationError(path, "smaller than minimum %s" % schema["minimum"])
            )
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(
                ValidationError(path, "greater than maximum %s" % schema["maximum"])
            )
    elif isinstance(value, dict):
        required = schema.get("required", [])
        properties = schema.get("properties", {})
        for name in required:
            if name not in value:
                errors.append(
                    ValidationError(
                        path + "/" + name if path else "/" + name,
                        "missing required property",
                    )
                )
        for name, item in value.items():
            child = (path + "/" + name) if path else "/" + name
            if name in properties:
                _validate(item, properties[name], child, errors)
            elif schema.get("additionalProperties") is False:
                errors.append(ValidationError(child, "additional property not allowed"))
    elif isinstance(value, list):
        items = schema.get("items")
        if items is not None:
            for index, item in enumerate(value):
                _validate(item, items, "%s/%d" % (path, index), errors)


def validate_by_name(name: str, value: Any) -> List[ValidationError]:
    """Validate ``value`` against the named frozen schema; return failures."""
    if name not in SCHEMAS:
        raise KeyError("unknown contract schema: %r" % name)
    errors: List[ValidationError] = []
    _validate(value, SCHEMAS[name], "", errors)
    return errors


def is_valid(name: str, value: Any) -> bool:
    """Return True when ``value`` satisfies the named frozen schema."""
    return not validate_by_name(name, value)


def validate_create_attempt_request(value: Any) -> List[ValidationError]:
    return validate_by_name("CreateAttemptRequest", value)


def validate_attempt_receipt(value: Any) -> List[ValidationError]:
    return validate_by_name("AttemptReceipt", value)


def validate_send_message_request(value: Any) -> List[ValidationError]:
    return validate_by_name("SendMessageRequest", value)


def validate_cancel_attempt_request(value: Any) -> List[ValidationError]:
    return validate_by_name("CancelAttemptRequest", value)


def validate_bridge_event(value: Any) -> List[ValidationError]:
    return validate_by_name("BridgeEvent", value)


def validate_runtime_capabilities(value: Any) -> List[ValidationError]:
    return validate_by_name("RuntimeCapabilities", value)


def validate_idempotency_key(value: Any) -> List[ValidationError]:
    """Validate an ``Idempotency-Key`` header value (8..160 chars)."""
    errors: List[ValidationError] = []
    _validate(value, SCHEMAS["IdempotencyKey"], "", errors)
    return errors


def dedupe_key(event: Dict[str, Any]) -> Optional[Tuple[Any, Any]]:
    """Return the ``(source, eventId)`` dedupe key, or None when absent.

    Consumers must treat redelivery of the same key as a no-op (at-least-once
    delivery); this helper keeps that rule in one tested place.
    """
    if not isinstance(event, dict):
        return None
    source = event.get("source")
    event_id = event.get("eventId")
    if not source or not event_id:
        return None
    return (source, event_id)


__all__ = [
    "CONTRACT_VERSION",
    "DEDUPE_KEY_FIELDS",
    "ValidationError",
    "dedupe_key",
    "is_valid",
    "validate_attempt_receipt",
    "validate_bridge_event",
    "validate_by_name",
    "validate_cancel_attempt_request",
    "validate_create_attempt_request",
    "validate_idempotency_key",
    "validate_runtime_capabilities",
    "validate_send_message_request",
]
