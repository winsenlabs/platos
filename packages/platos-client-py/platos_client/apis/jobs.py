"""Canonical Platos Job API."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from urllib.parse import quote, urlencode

if TYPE_CHECKING:
    from platos_client.client import PlatosClient, PlatosScope


class JobsApi:
    def __init__(self, client: "PlatosClient") -> None:
        self._client = client

    async def list(
        self,
        *,
        job_type: str | None = None,
        status: str | None = None,
        limit: int | None = None,
        scope: "PlatosScope | None" = None,
    ) -> list[dict[str, Any]]:
        query = {key: value for key, value in {
            "type": job_type,
            "status": status,
            "limit": limit,
        }.items() if value is not None}
        suffix = f"?{urlencode(query)}" if query else ""
        response = await self._client._request(
            "GET", f"/api/v1/agent/jobs{suffix}", scope=scope
        )
        return list((response or {}).get("jobs", []))

    async def spawn(
        self,
        job_type: str,
        payload: Any,
        *,
        options: dict[str, Any] | None = None,
        scope: "PlatosScope | None" = None,
    ) -> dict[str, Any]:
        return await self._client._request(
            "POST",
            "/api/v1/agent/jobs",
            scope=scope,
            body={"type": job_type, "payload": payload, "options": options or {}},
        )

    async def get(
        self, job_id: str, scope: "PlatosScope | None" = None
    ) -> dict[str, Any]:
        return await self._client._request(
            "GET", f"/api/v1/agent/jobs/{quote(job_id, safe='')}", scope=scope
        )

    async def cancel(
        self, job_id: str, scope: "PlatosScope | None" = None
    ) -> dict[str, Any]:
        return await self._client._request(
            "POST",
            f"/api/v1/agent/jobs/{quote(job_id, safe='')}/cancel",
            scope=scope,
        )

    async def replay(
        self, job_id: str, scope: "PlatosScope | None" = None
    ) -> dict[str, Any]:
        return await self._client._request(
            "POST",
            f"/api/v1/agent/jobs/{quote(job_id, safe='')}/replay",
            scope=scope,
        )
