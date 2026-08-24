"""Canonical Turn and Job request contracts."""

from __future__ import annotations

from unittest.mock import AsyncMock

from platos_client import PlatosClient


async def test_jobs_namespace_and_bounded_aliases() -> None:
    client = PlatosClient(base_url="https://platos.example.com", session_token="token")
    client._request = AsyncMock(return_value={"jobs": []})  # type: ignore[method-assign]

    assert client.bgo is client.jobs
    assert client.trigger is client.jobs
    await client.jobs.list(status="queued", limit=9)

    client._request.assert_awaited_once_with(
        "GET", "/api/v1/agent/jobs?status=queued&limit=9", scope=None
    )
    await client.aclose()


async def test_turns_namespace_encodes_query_and_ids() -> None:
    client = PlatosClient(base_url="https://platos.example.com", session_token="token")
    client._request = AsyncMock(return_value={"turns": []})  # type: ignore[method-assign]

    await client.turns.list(thread_id="thread/1")
    client._request.assert_awaited_once_with(
        "GET", "/api/v1/agent/turns?threadId=thread%2F1", scope=None
    )
    await client.aclose()
