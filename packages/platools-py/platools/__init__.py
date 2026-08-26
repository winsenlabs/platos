"""Platools — Your AI Arsenal.

Turn any backend function into a managed, authenticated, monitored MCP
tool with a single decorator:

    from platools import Platools

    platools = Platools(url="...", secret="...")

    @platools.tool(auth="user", roles=["support", "admin"])
    def process_refund(order_id: str, reason: str) -> RefundResult:
        '''Process a refund for an order.

        Args:
            order_id: The order ID to refund.
            reason:   Reason for the refund, surfaced in the audit log.
        '''
        return refund_service.process(order_id, reason)

On startup the SDK introspects every decorated function, generates an
MCP-compliant JSON schema from type hints + docstring, and (via
`await platools.connect()`) opens an outbound WebSocket to the Platos
platform.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any, TypeVar

from platools.context import (
    PlatosCallContext,
    PlatosContext,
    current_agent_id,
    current_call_id,
    current_context,
    current_entity_id,
    current_entity_token,
    current_scope,
    current_thread_id,
    current_user_id,
    current_user_token,
)
from platools.core.decorator import make_tool_decorator
from platools.core.registry import ToolRegistry
from platools.core.schema import SchemaError
from platools.transport import PlatoolsClient
from platools.types import AuthLevel, ToolDef, ToolSchema

__version__ = "1.0.0"

__all__ = [
    "AuthLevel",
    "PlatosCallContext",
    "PlatosContext",
    "Platools",
    "PlatoolsClient",
    "SchemaError",
    "ToolDef",
    "ToolSchema",
    "__version__",
    "current_agent_id",
    "current_call_id",
    "current_context",
    "current_entity_id",
    "current_entity_token",
    "current_scope",
    "current_thread_id",
    "current_user_id",
    "current_user_token",
]

F = TypeVar("F", bound=Callable[..., Any])


class Platools:
    """Per-app registry + connection config.

    One `Platools()` instance per backend process — you import it from
    wherever you want to decorate functions:

        # yourapp/tools.py
        from platools import Platools
        platools = Platools()

        @platools.tool()
        def list_orders(...): ...

    Then in your app bootstrap:

        import asyncio
        asyncio.run(platools.connect())
    """

    def __init__(
        self,
        *,
        url: str | None = None,
        secret: str | None = None,
    ) -> None:
        self.url = url or os.environ.get("PLATOS_URL")
        self.secret = secret or os.environ.get("PLATOS_SECRET")
        self._registry = ToolRegistry()
        self.tool = make_tool_decorator(self._registry)

    @property
    def registry(self) -> ToolRegistry:
        """Public accessor for the underlying `ToolRegistry`.

        Used by `platools doctor` to walk every decorated function in
        a consumer's module without reaching for the leading-underscore
        attribute. The registry is internally mutable but external
        callers should treat it as read-only.
        """
        return self._registry

    @property
    def tools(self) -> dict[str, ToolDef]:
        """Read-only snapshot of the registered tools keyed by name."""
        return {t.name: t for t in self._registry.all()}

    def get_tool(self, name: str) -> ToolDef | None:
        return self._registry.get(name)

    def get_mcp_schemas(self) -> list[ToolSchema]:
        """Return MCP-compliant tool schemas for every registered tool."""
        return [t.to_mcp_schema() for t in self._registry.all()]

    async def connect(self) -> None:
        """Open an outbound WebSocket to the platform and run forever.

        Re-connects automatically with exponential backoff on failure.
        Exits cleanly when `stop()` is called from another task or the
        platform closes the connection after a shutdown signal. See PRD §5.2.
        """
        if self.url is None or self.secret is None:
            raise RuntimeError(
                "Platools.connect() requires url + secret — set PLATOS_URL and PLATOS_SECRET"
            )
        client = PlatoolsClient(url=self.url, secret=self.secret, registry=self._registry)
        await client.run_forever()
