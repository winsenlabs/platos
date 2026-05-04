"""Wire protocol for SDK ↔ Platform WebSocket messages.

Every message is a Pydantic model with a literal `type` discriminator so
both sides can use `TypeAdapter` for safe decoding.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class ToolSchemaPayload(BaseModel):
    """A single tool schema sent during registration."""

    name: str
    description: str
    input_schema: dict[str, Any]
    output_schema: dict[str, Any] | None = None
    auth: str = "none"
    roles: list[str] = Field(default_factory=list)
    annotations: dict[str, Any] = Field(default_factory=dict)


# --- SDK → Platform --------------------------------------------------------


class ToolRegisterMessage(BaseModel):
    type: Literal["tool_register"] = "tool_register"
    tools: list[ToolSchemaPayload]


class ToolResultMessage(BaseModel):
    type: Literal["tool_result"] = "tool_result"
    call_id: str
    result: Any
    latency_ms: int


class ToolErrorMessage(BaseModel):
    type: Literal["tool_error"] = "tool_error"
    call_id: str
    error: str
    traceback: str | None = None


class ToolHealthEntry(BaseModel):
    status: Literal["healthy", "degraded", "down"]
    avg_latency_ms: int
    error_count_1h: int
    last_error: str | None = None


class HeartbeatMessage(BaseModel):
    type: Literal["heartbeat"] = "heartbeat"
    tools_health: dict[str, ToolHealthEntry] = Field(default_factory=dict)


# --- Platform → SDK --------------------------------------------------------


class ToolCallMessage(BaseModel):
    type: Literal["tool_call"] = "tool_call"
    call_id: str
    tool_name: str
    params: dict[str, Any]


class HeartbeatAckMessage(BaseModel):
    type: Literal["heartbeat_ack"] = "heartbeat_ack"


class WelcomeMessage(BaseModel):
    """Sent by the platform on successful handshake so the SDK knows the
    connection is authenticated and its tools are queued for registration.
    """

    type: Literal["welcome"] = "welcome"
    sdk_connection_id: str
    org_id: str


SdkToPlatform = ToolRegisterMessage | ToolResultMessage | ToolErrorMessage | HeartbeatMessage
PlatformToSdk = ToolCallMessage | HeartbeatAckMessage | WelcomeMessage
