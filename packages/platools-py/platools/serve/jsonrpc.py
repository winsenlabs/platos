"""JSON-RPC 2.0 envelope for `platools serve` (PLATOS-41).

Deliberately mirrors ``apps/api/platos/gateway/mcp_transport.py`` so a
client that handshakes with the Platos platform can also handshake
with a local ``platools serve`` process without any protocol drift.

We do NOT depend on the ``mcp`` Python SDK here — the envelope is
small enough to hand-roll in Pydantic and keeping the SDK wheel lean
matters (PLATOS-41 is a developer-laptop CLI, not a server product).
If the MCP SDK ever becomes a dependency for other reasons, this
module can re-export its envelope types without touching callers.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

MCP_PROTOCOL_VERSION = "2024-11-05"
"""MCP protocol revision advertised in the ``initialize`` response.

Kept byte-identical to the value used by
``apps/api/platos/gateway/mcp_transport.py`` so the platform and the
local SDK never disagree about which revision they speak. Bumping this
string is a single-line diff in two places.
"""

JSON_RPC_VERSION: Literal["2.0"] = "2.0"


# ---- JSON-RPC 2.0 error codes --------------------------------------------
# Spec ranges:
#   -32700 parse error
#   -32600 invalid request
#   -32601 method not found
#   -32602 invalid params
#   -32603 internal error
#   -32000..-32099 server-defined application errors
#
# PLATOS-41 uses all five canonical codes plus the same application code
# (``-32000``) the gateway uses for "tool execution error" so clients
# can distinguish protocol-level problems from tool-level failures.

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
TOOL_EXECUTION_ERROR = -32000


class JsonRpcRequest(BaseModel):
    """Inbound JSON-RPC 2.0 request envelope.

    ``id`` is optional — JSON-RPC 2.0 notifications omit it, and we
    still accept the method. The handler returns ``None`` for
    notifications so the transport layer doesn't serialize a response.

    ``model_config = extra='allow'`` matches the platform gateway's
    tolerance: unknown top-level fields are preserved (not silently
    rejected) so a newer MCP client doesn't get a parse error just for
    adding an optional extension field.
    """

    model_config = ConfigDict(extra="allow")

    jsonrpc: Literal["2.0"] = JSON_RPC_VERSION
    id: str | int | None = None
    method: str
    params: dict[str, Any] = Field(default_factory=dict)


class JsonRpcErrorBody(BaseModel):
    code: int
    message: str
    data: Any | None = None


class JsonRpcResponse(BaseModel):
    """Outbound JSON-RPC 2.0 response envelope.

    Exactly one of ``result`` / ``error`` is set on the wire. Pydantic
    can't enforce that directly, so :meth:`ok` and :meth:`err` are the
    only supported construction paths and :meth:`to_wire` strips the
    unused side before serialization.
    """

    jsonrpc: Literal["2.0"] = JSON_RPC_VERSION
    id: str | int | None = None
    result: Any | None = None
    error: JsonRpcErrorBody | None = None

    @classmethod
    def ok(cls, request_id: str | int | None, result: Any) -> JsonRpcResponse:
        return cls(id=request_id, result=result, error=None)

    @classmethod
    def err(
        cls,
        request_id: str | int | None,
        *,
        code: int,
        message: str,
        data: Any | None = None,
    ) -> JsonRpcResponse:
        return cls(
            id=request_id,
            result=None,
            error=JsonRpcErrorBody(code=code, message=message, data=data),
        )

    def to_wire(self) -> dict[str, Any]:
        """Serialize to a dict matching the JSON-RPC 2.0 wire shape.

        The spec says exactly one of ``result`` / ``error`` appears on
        a response — not both, and the unused field is **absent**, not
        ``null``. The gateway uses the same trick (see
        ``gateway/mcp_transport.py::JsonRpcResponse.to_wire``).
        """
        data: dict[str, Any] = {"jsonrpc": self.jsonrpc, "id": self.id}
        if self.error is not None:
            data["error"] = self.error.model_dump(exclude_none=True)
        else:
            # Result of ``None`` is a valid JSON-RPC response body for
            # methods like ``notifications/initialized`` that carry no
            # payload. Preserve it rather than dropping the key.
            data["result"] = self.result
        return data
