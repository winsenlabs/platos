"""Tool registry — tracks every `@platools.tool()` decorated function."""

from __future__ import annotations

from platools.types import ToolDef


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, ToolDef] = {}

    def register(self, tool: ToolDef) -> None:
        if tool.name in self._tools:
            raise ValueError(
                f"tool {tool.name!r} is already registered — tool names must be unique"
            )
        self._tools[tool.name] = tool

    def get(self, name: str) -> ToolDef | None:
        return self._tools.get(name)

    def remove(self, name: str) -> bool:
        """Remove a tool from the next complete declaration."""
        return self._tools.pop(name, None) is not None

    def clear(self) -> None:
        """Remove all tools; the next declaration prunes all server mappings."""
        self._tools.clear()

    def all(self) -> list[ToolDef]:
        return list(self._tools.values())

    def names(self) -> list[str]:
        return list(self._tools.keys())

    def __len__(self) -> int:
        return len(self._tools)

    def __contains__(self, name: object) -> bool:
        return name in self._tools
