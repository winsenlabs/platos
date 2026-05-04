"""Public types for the Platools SDK.

These are the stable surface area that SDK consumers touch. Keep this
module free of runtime logic so typing can be imported cheaply.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

AuthLevel = Literal["none", "user", "admin"]


@dataclass(frozen=True)
class ToolSchema:
    """MCP-compliant tool schema.

    The `name`, `description`, and `input_schema` fields match the MCP
    tool spec 1:1 so `get_mcp_schemas()` can return `ToolSchema` instances
    directly. `output_schema` is captured for future-proofing (the current
    MCP spec does not expose it).
    """

    name: str
    description: str
    input_schema: dict[str, Any]
    output_schema: dict[str, Any] | None = None
    annotations: dict[str, Any] = field(default_factory=dict)


@dataclass
class ToolDef:
    """Internal representation of a registered tool.

    The SDK uses this to dispatch tool calls, enforce auth/roles, and
    serialize the registry over the WebSocket transport.

    ``ctx_param_name`` (CTX.5): name of the parameter on ``func`` that
    should receive the :class:`PlatosContext` at dispatch time, or
    ``None`` if the function signature does not take a ctx argument.
    The decorator detects a parameter named ``ctx`` annotated as
    ``PlatosContext`` (or untyped — we take the name alone as opt-in)
    and records its name here; the transport layer injects the built
    context under that kwarg.
    """

    name: str
    description: str
    func: Callable[..., Any]
    input_schema: dict[str, Any]
    output_schema: dict[str, Any] | None
    auth: AuthLevel
    roles: tuple[str, ...]
    rate_limit: str | None
    timeout: int | None
    annotations: dict[str, Any]
    is_async: bool
    ctx_param_name: str | None = None

    def to_mcp_schema(self) -> ToolSchema:
        return ToolSchema(
            name=self.name,
            description=self.description,
            input_schema=self.input_schema,
            output_schema=self.output_schema,
            annotations=self.annotations,
        )
