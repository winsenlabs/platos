"""In-process MCP-style mock client — PLATOS-19.

`platools test` doesn't open a real WebSocket. Instead this module
wraps `ToolTestRunner` in an MCP-shaped surface so the CLI can
exercise the same code path the production transport uses.

Phase D scope: tools-only (no resources / prompts) since that's all
the test CLI needs. PLATOS-26 (Phase F MCP gateway) ships the real
client; this one is an explicit mock for unit-level testing.
"""

from __future__ import annotations

from typing import Any

from platools.core.registry import ToolRegistry
from platools.testing.runner import TestResult, ToolTestRunner


class MockMcpClient:
    """Minimal MCP-shaped wrapper around `ToolTestRunner`.

    The `list_tools` / `call_tool` surface mirrors the MCP spec's
    tool methods so consumer code that targets the real client can
    swap in this mock without code changes during testing.
    """

    def __init__(self, registry: ToolRegistry) -> None:
        self._registry = registry
        self._runner = ToolTestRunner(registry)

    def list_tools(self) -> list[dict[str, Any]]:
        """Return MCP-compliant tool schemas for every registered tool."""
        return [
            {
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.input_schema,
                "output_schema": tool.output_schema,
                "annotations": tool.annotations,
            }
            for tool in self._registry.all()
        ]

    async def call_tool(self, name: str, params: dict[str, Any]) -> TestResult:
        """Invoke a tool by name with the given params dict.

        Returns the same `TestResult` shape `ToolTestRunner` uses so
        callers can pull `.output` / `.error` / `.duration_ms` without
        a separate adapter.
        """
        return await self._runner.run_async(name, params)
