"""Background-operations (BGO) surface for platos-client.

Theme I.6 parity with TS I.2; renamed under Theme BGO. Exposed on
``PlatosClient`` as both ``client.bgo`` (canonical) and ``client.trigger``
(deprecated alias, removed in the next major). Both point at the same
``TriggerApi`` instance. See ``docs/BGO_RENAME.md``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from platos_client.client import PlatosClient, PlatosScope


class TriggerApi:
    def __init__(self, client: "PlatosClient") -> None:
        self.tasks = TriggerTasksApi(client)
        self.runs = TriggerRunsApi(client)
        self.schedules = TriggerSchedulesApi(client)
        self.batches = TriggerBatchesApi(client)
        self._client = client

    async def raw(
        self,
        path: str,
        *,
        method: str = "GET",
        body: Any = None,
        scope: "PlatosScope | None" = None,
    ) -> Any:
        return await self._client._request(method, path, scope=scope, body=body)


class TriggerTasksApi:
    def __init__(self, client: "PlatosClient") -> None:
        self._client = client

    async def list(self, scope: "PlatosScope | None" = None) -> list[dict[str, Any]]:
        res = await self._client._request(
            "GET", "/api/v1/agent/trigger/tasks", scope=scope
        )
        return list((res or {}).get("tasks", []))

    async def trigger(
        self,
        task_id: str,
        payload: Any,
        *,
        options: dict[str, Any] | None = None,
        scope: "PlatosScope | None" = None,
    ) -> dict[str, Any]:
        return await self._client._request(
            "POST",
            f"/api/v1/agent/trigger/tasks/{task_id}/trigger",
            scope=scope,
            body={"payload": payload, "options": options or {}},
        )


class TriggerRunsApi:
    def __init__(self, client: "PlatosClient") -> None:
        self._client = client

    async def list(
        self,
        *,
        task_id: str | None = None,
        status: str | None = None,
        limit: int | None = None,
        scope: "PlatosScope | None" = None,
    ) -> list[dict[str, Any]]:
        qs = []
        if task_id:
            qs.append(f"taskId={task_id}")
        if status:
            qs.append(f"status={status}")
        if limit:
            qs.append(f"limit={limit}")
        suffix = ("?" + "&".join(qs)) if qs else ""
        res = await self._client._request(
            "GET", f"/api/v1/agent/trigger/runs{suffix}", scope=scope
        )
        return list((res or {}).get("runs", []))

    async def get(
        self, run_id: str, scope: "PlatosScope | None" = None
    ) -> dict[str, Any]:
        return await self._client._request(
            "GET", f"/api/v1/agent/trigger/runs/{run_id}", scope=scope
        )

    async def cancel(
        self, run_id: str, scope: "PlatosScope | None" = None
    ) -> dict[str, Any]:
        return await self._client._request(
            "POST", f"/api/v1/agent/trigger/runs/{run_id}/cancel", scope=scope
        )

    async def replay(
        self, run_id: str, scope: "PlatosScope | None" = None
    ) -> dict[str, Any]:
        return await self._client._request(
            "POST", f"/api/v1/agent/trigger/runs/{run_id}/replay", scope=scope
        )


class TriggerSchedulesApi:
    def __init__(self, client: "PlatosClient") -> None:
        self._client = client

    async def list(self, scope: "PlatosScope | None" = None) -> list[dict[str, Any]]:
        res = await self._client._request(
            "GET", "/api/v1/agent/trigger/schedules", scope=scope
        )
        return list((res or {}).get("schedules", []))

    async def create(
        self,
        *,
        task_id: str,
        cron: str,
        timezone: str | None = None,
        payload: Any = None,
        scope: "PlatosScope | None" = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"taskId": task_id, "cron": cron}
        if timezone:
            body["timezone"] = timezone
        if payload is not None:
            body["payload"] = payload
        return await self._client._request(
            "POST", "/api/v1/agent/trigger/schedules", scope=scope, body=body
        )

    async def activate(
        self, schedule_id: str, scope: "PlatosScope | None" = None
    ) -> dict[str, Any]:
        return await self._client._request(
            "POST",
            f"/api/v1/agent/trigger/schedules/{schedule_id}/activate",
            scope=scope,
        )

    async def deactivate(
        self, schedule_id: str, scope: "PlatosScope | None" = None
    ) -> dict[str, Any]:
        return await self._client._request(
            "POST",
            f"/api/v1/agent/trigger/schedules/{schedule_id}/deactivate",
            scope=scope,
        )

    async def delete(
        self, schedule_id: str, scope: "PlatosScope | None" = None
    ) -> None:
        await self._client._request(
            "DELETE", f"/api/v1/agent/trigger/schedules/{schedule_id}", scope=scope
        )


class TriggerBatchesApi:
    def __init__(self, client: "PlatosClient") -> None:
        self._client = client

    async def trigger(
        self,
        task_id: str,
        payloads: list[Any],
        *,
        options: dict[str, Any] | None = None,
        scope: "PlatosScope | None" = None,
    ) -> dict[str, Any]:
        return await self._client._request(
            "POST",
            f"/api/v1/agent/trigger/batches/{task_id}",
            scope=scope,
            body={"payloads": payloads, "options": options or {}},
        )

    async def get(
        self, batch_id: str, scope: "PlatosScope | None" = None
    ) -> dict[str, Any]:
        return await self._client._request(
            "GET", f"/api/v1/agent/trigger/batches/{batch_id}", scope=scope
        )
