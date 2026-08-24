"""Complete-declaration registration regressions."""

from __future__ import annotations

import json
from typing import Any

from platools import Platools
from platools.transport.client import PlatoolsClient


class RecordingSocket:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send(self, payload: str) -> None:
        self.sent.append(payload)


async def test_registration_shrinks_from_22_to_9_as_a_complete_declaration() -> None:
    platools = Platools()
    for index in range(22):
        def generated(value: int) -> int:
            return value

        platools.tool(name=f"tool_{index}")(generated)

    client = PlatoolsClient(
        url="https://platos.example.com",
        secret="service-secret",
        registry=platools.registry,
    )
    socket = RecordingSocket()
    await client._send_registration(socket)  # type: ignore[arg-type]
    first = json.loads(socket.sent[-1])
    assert len(first["tools"]) == 22

    for index in range(13):
        assert platools.registry.remove(f"tool_{index}") is True

    await client._send_registration(socket)  # type: ignore[arg-type]
    second: dict[str, Any] = json.loads(socket.sent[-1])
    assert len(second["tools"]) == 9
    assert [tool["name"] for tool in second["tools"]] == [
        f"tool_{index}" for index in range(13, 22)
    ]
