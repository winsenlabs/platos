"""Canonical Job request contracts."""

from __future__ import annotations

from unittest.mock import AsyncMock, call

from platos_client import PlatosClient


async def test_every_jobs_method_matches_runtime_contract() -> None:
    job = {"id": "job_internal", "jobId": "daily-report"}
    client = PlatosClient(base_url="https://platos.example.com", session_token="token")
    client._request = AsyncMock(  # type: ignore[method-assign]
        side_effect=[
            {"jobs": [job]},
            {"job": job},
            {"job": job},
            {"job": job},
            {"deleted": True},
            {"accepted": True, "jobId": "daily-report"},
        ]
    )

    assert await client.jobs.list(
        page=2,
        limit=9,
        offset=4,
        search="daily/report",
        status="active",
    ) == [job]
    assert await client.jobs.create(
        "daily-report", "Daily report", "return payload"
    ) == job
    assert await client.jobs.get("job/internal") == job
    assert await client.jobs.update("job/internal", is_active=False) == job
    assert await client.jobs.delete("job/internal") == {"deleted": True}
    assert await client.jobs.dispatch(
        "job/internal", {"date": "2026-08-24"}
    ) == {"accepted": True, "jobId": "daily-report"}

    assert client._request.await_args_list == [
        call(
            "GET",
            "/api/v1/agent/jobs?page=2&limit=9&offset=4&search=daily%2Freport&status=active",
            scope=None,
        ),
        call(
            "POST",
            "/api/v1/agent/jobs",
            scope=None,
            body={
                "jobId": "daily-report",
                "displayName": "Daily report",
                "handler": "return payload",
            },
        ),
        call("GET", "/api/v1/agent/jobs/job%2Finternal", scope=None),
        call(
            "PATCH",
            "/api/v1/agent/jobs/job%2Finternal",
            scope=None,
            body={"isActive": False},
        ),
        call("DELETE", "/api/v1/agent/jobs/job%2Finternal", scope=None),
        call(
            "POST",
            "/api/v1/agent/jobs/job%2Finternal/dispatch",
            scope=None,
            body={"payload": {"date": "2026-08-24"}},
        ),
    ]
    await client.aclose()


async def test_unsupported_legacy_and_turn_namespaces_are_absent() -> None:
    client = PlatosClient(base_url="https://platos.example.com", session_token="token")
    assert not hasattr(client, "bgo")
    assert not hasattr(client, "trigger")
    assert not hasattr(client, "turns")
    await client.aclose()
