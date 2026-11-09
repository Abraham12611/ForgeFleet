"""ForgeFleet bridge contracts v0.1 — frozen API schemas and validation."""

from ._generated import CONTRACT_VERSION, OPENAPI_VERSION, SCHEMAS
from .validate import (
    ValidationError,
    dedupe_key,
    is_valid,
    validate_attempt_receipt,
    validate_bridge_event,
    validate_by_name,
    validate_cancel_attempt_request,
    validate_create_attempt_request,
    validate_idempotency_key,
    validate_runtime_capabilities,
    validate_send_message_request,
)

__all__ = [
    "CONTRACT_VERSION",
    "OPENAPI_VERSION",
    "SCHEMAS",
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
