"""Contract tests for the frozen bridge API v0.1.

Covers the schema-enforceable subset of docs/05-contracts/contract-test-cases.md:
typed validation failures, idempotency-key rules, state/event vocabularies,
and freeze sync (schemas == generated code == manifest == OpenAPI version).

Run:  python3 -m unittest discover -s tests -v   (from packages/bridge-contracts)
Standard library only.
"""

import copy
import hashlib
import json
import sys
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
PACKAGE_ROOT = TESTS_DIR.parent
REPO_ROOT = PACKAGE_ROOT.parent.parent

sys.path.insert(0, str(PACKAGE_ROOT / "src"))

from bridge_contracts import (  # noqa: E402
    CONTRACT_VERSION,
    SCHEMAS,
    dedupe_key,
    validate_bridge_event,
    validate_by_name,
    validate_idempotency_key,
)

FIXTURES = TESTS_DIR / "fixtures"
OPENAPI_PATH = REPO_ROOT / "docs/05-contracts/bridge.openapi.yaml"

VALID_ATTEMPT_ID = "00000000-0000-4000-8000-000000000001"


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def paths(errors):
    return [e.path for e in errors]


class FreezeVersionTest(unittest.TestCase):
    def test_contract_version_is_frozen_v0_1(self):
        self.assertEqual(CONTRACT_VERSION, "0.1.0")

    def test_openapi_version_matches_and_is_final(self):
        text = OPENAPI_PATH.read_text(encoding="utf-8")
        self.assertIn("\n  version: 0.1.0\n", text)
        self.assertNotIn("0.1.0-draft", text)
        self.assertNotIn("(proposed)", text)

    def test_openapi_operations_present(self):
        text = OPENAPI_PATH.read_text(encoding="utf-8")
        for operation in (
            "liveness",
            "getCapabilities",
            "listSessions",
            "createAttempt",
            "getAttempt",
            "cancelAttempt",
            "sendAttemptMessage",
            "streamEvents",
        ):
            self.assertIn(operation, text)

    def test_openapi_error_responses_present(self):
        text = OPENAPI_PATH.read_text(encoding="utf-8")
        for token in ("Error:", "Unauthorized:", "Forbidden:", "NotFound:"):
            self.assertIn(token, text)

    def test_manifest_in_sync(self):
        manifest = json.loads(
            (PACKAGE_ROOT / "generated/contract-manifest.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(manifest["contractVersion"], CONTRACT_VERSION)
        self.assertEqual(manifest["openapiVersion"], CONTRACT_VERSION)
        for name, digest in manifest["schemas"].items():
            actual = hashlib.sha256(
                (PACKAGE_ROOT / "schemas" / name).read_bytes()
            ).hexdigest()
            self.assertEqual(actual, digest, "schema drift: %s" % name)
        for name, digest in manifest["generated"].items():
            actual = hashlib.sha256(
                (PACKAGE_ROOT / name).read_bytes()
            ).hexdigest()
            self.assertEqual(actual, digest, "generated drift: %s" % name)

    def test_embedded_schemas_match_sources(self):
        for name in ("bridge-api.schema.json", "bridge-events.schema.json"):
            doc = json.loads(
                (PACKAGE_ROOT / "schemas" / name).read_text(encoding="utf-8")
            )
            for key, schema in doc["$defs"].items():
                self.assertEqual(SCHEMAS[key], schema, "stale embed: %s" % key)

    def test_generated_types_cover_key_exports(self):
        ts = (PACKAGE_ROOT / "generated/bridge.types.ts").read_text(
            encoding="utf-8"
        )
        for token in (
            "CreateAttemptRequest",
            "AttemptReceipt",
            "SendMessageRequest",
            "CancelAttemptRequest",
            "BridgeEvent",
            "EventType",
            "AttemptState",
            "RuntimeCapabilities",
            "Error",
        ):
            self.assertIn(token, ts)


class PayloadValidationTest(unittest.TestCase):
    def test_valid_fixtures_pass(self):
        cases = [
            ("CreateAttemptRequest", "valid_create_attempt.json"),
            ("AttemptReceipt", "valid_attempt_receipt.json"),
            ("SendMessageRequest", "valid_send_message.json"),
            ("CancelAttemptRequest", "valid_cancel.json"),
            ("BridgeEvent", "valid_event.json"),
            ("RuntimeCapabilities", "valid_runtime_capabilities.json"),
        ]
        for schema_name, filename in cases:
            with self.subTest(schema=schema_name):
                self.assertEqual(
                    validate_by_name(schema_name, fixture(filename)), []
                )

    def test_missing_required_fields_give_typed_errors(self):
        errors = validate_by_name("CreateAttemptRequest", {})
        missing = set(paths(errors))
        self.assertTrue(
            {"/projectId", "/paperclipTaskId", "/lease"}.issubset(missing),
            missing,
        )

    def test_unknown_property_rejected(self):
        payload = fixture("valid_create_attempt.json")
        payload["rogueField"] = "injected"
        errors = validate_by_name("CreateAttemptRequest", payload)
        self.assertIn("/rogueField", paths(errors))

    def test_lease_epoch_minimum_one(self):
        payload = fixture("valid_create_attempt.json")
        payload["lease"]["fencingEpoch"] = 0
        errors = validate_by_name("CreateAttemptRequest", payload)
        self.assertIn("/lease/fencingEpoch", paths(errors))

    def test_bad_attempt_id_format_rejected(self):
        payload = fixture("valid_attempt_receipt.json")
        payload["attemptId"] = "not-a-uuid"
        errors = validate_by_name("AttemptReceipt", payload)
        self.assertIn("/attemptId", paths(errors))

    def test_bad_timestamp_rejected(self):
        payload = fixture("valid_attempt_receipt.json")
        payload["observedAt"] = "yesterday-ish"
        errors = validate_by_name("AttemptReceipt", payload)
        self.assertIn("/observedAt", paths(errors))

    def test_unknown_attempt_state_rejected(self):
        payload = fixture("valid_attempt_receipt.json")
        payload["state"] = "exploded"
        errors = validate_by_name("AttemptReceipt", payload)
        self.assertIn("/state", paths(errors))

    def test_message_body_too_long_rejected(self):
        payload = fixture("valid_send_message.json")
        payload["body"] = "x" * 20001
        errors = validate_by_name("SendMessageRequest", payload)
        self.assertIn("/body", paths(errors))

    def test_message_body_empty_rejected(self):
        payload = fixture("valid_send_message.json")
        payload["body"] = ""
        errors = validate_by_name("SendMessageRequest", payload)
        self.assertIn("/body", paths(errors))

    def test_message_kind_vocabulary(self):
        for kind in ("question", "answer", "update", "unblock", "instruction"):
            payload = fixture("valid_send_message.json")
            payload["kind"] = kind
            with self.subTest(kind=kind):
                self.assertEqual(
                    validate_by_name("SendMessageRequest", payload), []
                )
        payload = fixture("valid_send_message.json")
        payload["kind"] = "override-policy"
        self.assertIn("/kind", paths(validate_by_name("SendMessageRequest", payload)))

    def test_cancel_requires_reason_and_actor(self):
        self.assertIn(
            "/reason", paths(validate_by_name("CancelAttemptRequest", {"approvedBy": "human:owner"}))
        )
        self.assertIn(
            "/approvedBy", paths(validate_by_name("CancelAttemptRequest", {"reason": "stale"}))
        )
        payload = fixture("valid_cancel.json")
        payload["reason"] = ""
        self.assertIn(
            "/reason", paths(validate_by_name("CancelAttemptRequest", payload))
        )

    def test_error_envelope(self):
        self.assertEqual(
            validate_by_name(
                "Error", {"errorCode": "CONFLICT", "message": "lease held"}
            ),
            [],
        )
        self.assertIn(
            "/errorCode", paths(validate_by_name("Error", {"message": "x"}))
        )

    def test_provider_status_vocabulary(self):
        caps = fixture("valid_runtime_capabilities.json")
        for status in ("verified", "unsupported", "unknown", "unavailable"):
            mutated = copy.deepcopy(caps)
            mutated["providers"][0]["status"] = status
            with self.subTest(status=status):
                self.assertEqual(validate_by_name("RuntimeCapabilities", mutated), [])
        mutated = copy.deepcopy(caps)
        mutated["providers"][0]["status"] = "superuser"
        self.assertIn(
            "/providers/0/status",
            paths(validate_by_name("RuntimeCapabilities", mutated)),
        )


class IdempotencyKeyTest(unittest.TestCase):
    def test_boundaries_accepted(self):
        self.assertEqual(validate_idempotency_key("k" * 8), [])
        self.assertEqual(validate_idempotency_key("k" * 160), [])

    def test_too_short_rejected(self):
        self.assertTrue(validate_idempotency_key("k" * 7))

    def test_too_long_rejected(self):
        self.assertTrue(validate_idempotency_key("k" * 161))

    def test_non_string_rejected(self):
        self.assertTrue(validate_idempotency_key(12345678))
        self.assertTrue(validate_idempotency_key(None))


class EventEnvelopeTest(unittest.TestCase):
    def test_all_documented_event_types_accepted(self):
        base = fixture("valid_event.json")
        event_types = SCHEMAS["BridgeEvent"]["properties"]["eventType"]["$ref"]
        vocabulary = SCHEMAS[event_types.split("/")[-1]]["enum"]
        self.assertGreaterEqual(len(vocabulary), 36)
        for event_type in vocabulary:
            event = copy.deepcopy(base)
            event["eventType"] = event_type
            with self.subTest(eventType=event_type):
                self.assertEqual(validate_bridge_event(event), [])

    def test_unknown_event_type_rejected(self):
        event = fixture("valid_event.json")
        event["eventType"] = "attempt.teleported"
        self.assertIn("/eventType", paths(validate_bridge_event(event)))

    def test_schema_version_pinned(self):
        event = fixture("valid_event.json")
        event["schemaVersion"] = "0.2"
        self.assertIn("/schemaVersion", paths(validate_bridge_event(event)))

    def test_project_scoped_event_without_attempt(self):
        event = fixture("valid_event.json")
        event["eventType"] = "project.created"
        del event["taskId"]
        del event["attemptId"]
        del event["actor"]
        del event["data"]
        self.assertEqual(validate_bridge_event(event), [])

    def test_missing_identity_rejected(self):
        event = fixture("valid_event.json")
        del event["eventId"]
        self.assertIn("/eventId", paths(validate_bridge_event(event)))

    def test_fencing_epoch_minimum_one(self):
        event = fixture("valid_event.json")
        event["fencingEpoch"] = 0
        self.assertIn("/fencingEpoch", paths(validate_bridge_event(event)))

    def test_dedupe_key_rule(self):
        first = fixture("valid_event.json")
        redelivery = copy.deepcopy(first)
        self.assertEqual(dedupe_key(first), dedupe_key(redelivery))
        self.assertEqual(dedupe_key(first), ("orca-bridge", first["eventId"]))
        other = copy.deepcopy(first)
        other["eventId"] = "different-id"
        self.assertNotEqual(dedupe_key(first), dedupe_key(other))
        self.assertIsNone(dedupe_key({"source": "orca-bridge"}))
        self.assertIsNone(dedupe_key({}))


class StateMachineConsistencyTest(unittest.TestCase):
    def test_receipt_states_cover_documented_attempt_machine(self):
        # docs/05-contracts/state-machines.md attempt machine states;
        # "requested" precedes acceptance so no receipt exists for it yet.
        documented = {
            "requested",
            "accepted",
            "dispatching",
            "running",
            "finished",
            "failed",
            "cancelled",
            "unknown",
            "waiting",
        }
        frozen = set(SCHEMAS["AttemptState"]["enum"])
        self.assertEqual(documented - frozen, {"requested"})
        self.assertEqual(frozen - documented, set())


if __name__ == "__main__":
    unittest.main()
