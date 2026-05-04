"""Agents API for platos-client."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from platos_client.errors import PlatosNotFoundError

if TYPE_CHECKING:
    from platos_client.client import PlatosClient, PlatosScope


class AgentsApi:
    def __init__(self, client: "PlatosClient") -> None:
        self._client = client

    async def list(self, scope: "PlatosScope | None" = None) -> list[dict[str, Any]]:
        res = await self._client._request("GET", "/api/v1/agent/agents", scope=scope)
        if not res:
            return []
        return list(res.get("agents", []))

    async def get(
        self, agent_id: str, scope: "PlatosScope | None" = None
    ) -> dict[str, Any] | None:
        try:
            return await self._client._request(
                "GET", f"/api/v1/agent/agents/{agent_id}", scope=scope
            )
        except PlatosNotFoundError:
            return None

    async def list_versions(
        self, agent_id: str, scope: "PlatosScope | None" = None
    ) -> list[dict[str, Any]]:
        res = await self._client._request(
            "GET", f"/api/v1/agent/agents/{agent_id}/versions", scope=scope
        )
        if not res:
            return []
        return list(res.get("versions", []))
