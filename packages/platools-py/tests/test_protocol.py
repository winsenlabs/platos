"""Wire protocol encoding/decoding tests."""

from __future__ import annotations

import json

from platools.transport.protocol import (
    HeartbeatAckMessage,
    HeartbeatMessage,
    PlatformToSdk,
    SdkToPlatform,
    ToolCallMessage,
    ToolErrorMessage,
    ToolHealthEntry,
    ToolRegisterMessage,
    ToolResultMessage,
    ToolSchemaPayload,
    WelcomeMessage,
)
from pydantic import TypeAdapter


def test_tool_register_roundtrip() -> None:
    payload = ToolSchemaPayload(
        name="process_refund",
        description="Process a refund",
        input_schema={"type": "object", "properties": {}},
    )
    msg = ToolRegisterMessage(tools=[payload])
    raw = msg.model_dump_json()
    data = json.loads(raw)
    assert data["type"] == "tool_register"
    assert data["tools"][0]["name"] == "process_refund"

    adapter: TypeAdapter[SdkToPlatform] = TypeAdapter(SdkToPlatform)
    decoded = adapter.validate_python(data)
    assert isinstance(decoded, ToolRegisterMessage)
    assert decoded.tools[0].name == "process_refund"


def test_tool_call_roundtrip() -> None:
    msg = ToolCallMessage(
        call_id="abc-123",
        tool_name="echo",
        params={"text": "hi"},
    )
    raw = msg.model_dump_json()
    data = json.loads(raw)
    adapter: TypeAdapter[PlatformToSdk] = TypeAdapter(PlatformToSdk)
    decoded = adapter.validate_python(data)
    assert isinstance(decoded, ToolCallMessage)
    assert decoded.call_id == "abc-123"
    assert decoded.params == {"text": "hi"}


def test_tool_result_and_error_discriminated() -> None:
    adapter: TypeAdapter[SdkToPlatform] = TypeAdapter(SdkToPlatform)
    result = adapter.validate_python(
        {"type": "tool_result", "call_id": "c1", "result": 42, "latency_ms": 12}
    )
    assert isinstance(result, ToolResultMessage)

    err = adapter.validate_python({"type": "tool_error", "call_id": "c1", "error": "boom"})
    assert isinstance(err, ToolErrorMessage)


def test_heartbeat_with_health() -> None:
    msg = HeartbeatMessage(
        tools_health={"echo": ToolHealthEntry(status="healthy", avg_latency_ms=5, error_count_1h=0)}
    )
    data = json.loads(msg.model_dump_json())
    assert data["tools_health"]["echo"]["status"] == "healthy"


def test_welcome_and_heartbeat_ack_discriminated() -> None:
    adapter: TypeAdapter[PlatformToSdk] = TypeAdapter(PlatformToSdk)
    welcome = adapter.validate_python(
        {"type": "welcome", "sdk_connection_id": "id", "org_id": "org"}
    )
    assert isinstance(welcome, WelcomeMessage)

    ack = adapter.validate_python({"type": "heartbeat_ack"})
    assert isinstance(ack, HeartbeatAckMessage)


def test_welcome_accepts_canonical_organization_id() -> None:
    # Server emits `organization_id`; older SDK only decoded `org_id`.
    # The decoder now accepts either shape and exposes both names.
    adapter: TypeAdapter[PlatformToSdk] = TypeAdapter(PlatformToSdk)
    welcome = adapter.validate_python(
        {
            "type": "welcome",
            "sdk_connection_id": "conn-1",
            "organization_id": "org-abc",
            "entity_id": "winsen-brain-demo-app",
            "environment_id": "env-prod",
            "project_id": "prj-1",
        }
    )
    assert isinstance(welcome, WelcomeMessage)
    assert welcome.organization_id == "org-abc"
    assert welcome.org_id == "org-abc"
    assert welcome.entity_id == "winsen-brain-demo-app"
    assert welcome.environment_id == "env-prod"
    assert welcome.project_id == "prj-1"


def test_welcome_back_compat_org_id_only() -> None:
    adapter: TypeAdapter[PlatformToSdk] = TypeAdapter(PlatformToSdk)
    welcome = adapter.validate_python(
        {"type": "welcome", "sdk_connection_id": "conn-2", "org_id": "org-xyz"}
    )
    assert isinstance(welcome, WelcomeMessage)
    assert welcome.organization_id == "org-xyz"
    assert welcome.org_id == "org-xyz"
    assert welcome.entity_id is None
    assert welcome.environment_id is None
    assert welcome.project_id is None
