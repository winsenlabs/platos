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
        page: int | None = None,
        limit: int | None = None,
        offset: int | None = None,
        search: str | None = None,
        status: str | None = None,
        scope: "PlatosScope | None" = None,
    ) -> list[dict[str, Any]]:
        query = {
            key: value
            for key, value in {
                "page": page,
                "limit": limit,
                "offset": offset,
                "search": search,
                "status": status,
            }.items()
            if value is not None
        }
        suffix = f"?{urlencode(query)}" if query else ""
        response = await self._client._request(
            "GET", f"/api/v1/agent/jobs{suffix}", scope=scope
        )
        return list((response or {}).get("jobs", []))

    async def create(
        self,
        job_id: str,
        display_name: str,
        handler: str,
        *,
        description: str | None = None,
        invocation_type: str | None = None,
        schedule_cron: str | None = None,
        schedule_timezone: str | None = None,
        allowed_agent_ids: list[str] | None = None,
        payload_schema: dict[str, Any] | None = None,
        timeout: int | None = None,
        max_retries: int | None = None,
        scope: "PlatosScope | None" = None,
    ) -> dict[str, Any]:
        body = _without_none(
            {
                "jobId": job_id,
                "displayName": display_name,
                "handler": handler,
                "description": description,
                "invocationType": invocation_type,
                "scheduleCron": schedule_cron,
                "scheduleTimezone": schedule_timezone,
                "allowedAgentIds": allowed_agent_ids,
                "payloadSchema": payload_schema,
                "timeout": timeout,
                "maxRetries": max_retries,
            }
        )
        response = await self._client._request(
            "POST", "/api/v1/agent/jobs", scope=scope, body=body
        )
        return dict(response["job"])

    async def get(
        self, job_id: str, scope: "PlatosScope | None" = None
    ) -> dict[str, Any]:
        response = await self._client._request(
            "GET", f"/api/v1/agent/jobs/{quote(job_id, safe='')}", scope=scope
        )
        return dict(response["job"])

    async def update(
        self,
        job_id: str,
        *,
        display_name: str | None = None,
        description: str | None = None,
        invocation_type: str | None = None,
        schedule_cron: str | None = None,
        schedule_timezone: str | None = None,
        allowed_agent_ids: list[str] | None = None,
        payload_schema: dict[str, Any] | None = None,
        handler: str | None = None,
        timeout: int | None = None,
        max_retries: int | None = None,
        is_active: bool | None = None,
        scope: "PlatosScope | None" = None,
    ) -> dict[str, Any]:
        body = _without_none(
            {
                "displayName": display_name,
                "description": description,
                "invocationType": invocation_type,
                "scheduleCron": schedule_cron,
                "scheduleTimezone": schedule_timezone,
                "allowedAgentIds": allowed_agent_ids,
                "payloadSchema": payload_schema,
                "handler": handler,
                "timeout": timeout,
                "maxRetries": max_retries,
                "isActive": is_active,
            }
        )
        response = await self._client._request(
            "PATCH",
            f"/api/v1/agent/jobs/{quote(job_id, safe='')}",
            scope=scope,
            body=body,
        )
        return dict(response["job"])

    async def delete(
        self, job_id: str, scope: "PlatosScope | None" = None
    ) -> dict[str, Any]:
        return await self._client._request(
            "DELETE", f"/api/v1/agent/jobs/{quote(job_id, safe='')}", scope=scope
        )

    async def dispatch(
        self,
        job_id: str,
        payload: dict[str, Any] | None = None,
        *,
        scope: "PlatosScope | None" = None,
    ) -> dict[str, Any]:
        return await self._client._request(
            "POST",
            f"/api/v1/agent/jobs/{quote(job_id, safe='')}/dispatch",
            scope=scope,
            body={"payload": payload or {}},
        )


def _without_none(values: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in values.items() if value is not None}
