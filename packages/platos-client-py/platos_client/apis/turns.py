"""Canonical Platos Turn API."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from urllib.parse import quote, urlencode

if TYPE_CHECKING:
    from platos_client.client import PlatosClient, PlatosScope


class TurnsApi:
    def __init__(self, client: "PlatosClient") -> None:
        self._client = client

    async def list(
        self,
        *,
        agent_id: str | None = None,
        thread_id: str | None = None,
        status: str | None = None,
        limit: int | None = None,
        scope: "PlatosScope | None" = None,
    ) -> list[dict[str, Any]]:
        query = {key: value for key, value in {
            "agentId": agent_id,
            "threadId": thread_id,
            "status": status,
            "limit": limit,
        }.items() if value is not None}
        suffix = f"?{urlencode(query)}" if query else ""
        response = await self._client._request(
            "GET", f"/api/v1/agent/turns{suffix}", scope=scope
        )
        return list((response or {}).get("turns", []))

    async def get(
        self, turn_id: str, scope: "PlatosScope | None" = None
    ) -> dict[str, Any]:
        return await self._client._request(
            "GET", f"/api/v1/agent/turns/{quote(turn_id, safe='')}", scope=scope
        )
