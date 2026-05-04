"""Threads API + realtime streaming for platos-client.

Theme I.7 — `send(...)` is an async-generator over agent stream events.
Connection management mirrors the TS SDK:

* Manual reconnection with exponential backoff.
* Events during a disconnect gap are buffered by the server's per-thread
  room; the client re-joins and resumes the stream.
* `asyncio.CancelledError` tears down the socket and yields a terminal
  `done` event with `stopped=True`.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any, AsyncGenerator

import websockets
from websockets.asyncio.client import ClientConnection

from platos_client.errors import PlatosError, PlatosNetworkError, PlatosNotFoundError

if TYPE_CHECKING:
    from platos_client.client import PlatosClient, PlatosScope


_DEFAULT_MAX_RECONNECT = 5
_RECONNECT_BASE_S = 0.5
_RECONNECT_MAX_S = 10.0


class ThreadsApi:
    def __init__(self, client: "PlatosClient") -> None:
        self._client = client

    # ---- CRUD ----

    async def create(
        self,
        *,
        scope: "PlatosScope | None" = None,
        agent_id: str = "default",
        title: str | None = None,
    ) -> dict[str, Any]:
        return await self._client._request(
            "POST",
            "/api/v1/agent/threads",
            scope=scope,
            body={"agentId": agent_id, "title": title},
        )

    async def list(
        self,
        *,
        scope: "PlatosScope | None" = None,
        agent_id: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        qs = []
        if agent_id:
            qs.append(f"agentId={agent_id}")
        if limit:
            qs.append(f"limit={limit}")
        suffix = ("?" + "&".join(qs)) if qs else ""
        res = await self._client._request(
            "GET", f"/api/v1/agent/threads{suffix}", scope=scope
        )
        if not res:
            return []
        return list(res.get("threads", []))

    async def get(
        self, thread_id: str, scope: "PlatosScope | None" = None
    ) -> dict[str, Any] | None:
        try:
            return await self._client._request(
                "GET", f"/api/v1/agent/threads/{thread_id}", scope=scope
            )
        except PlatosNotFoundError:
            return None

    async def messages(
        self, thread_id: str, scope: "PlatosScope | None" = None
    ) -> list[dict[str, Any]]:
        res = await self._client._request(
            "GET", f"/api/v1/agent/threads/{thread_id}/messages", scope=scope
        )
        if not res:
            return []
        return list(res.get("messages", []))

    async def artifacts(
        self, thread_id: str, scope: "PlatosScope | None" = None
    ) -> list[dict[str, Any]]:
        res = await self._client._request(
            "GET", f"/api/v1/agent/threads/{thread_id}/artifacts", scope=scope
        )
        if not res:
            return []
        return list(res.get("artifacts", []))

    async def archive(
        self, thread_id: str, scope: "PlatosScope | None" = None
    ) -> None:
        await self._client._request(
            "POST", f"/api/v1/agent/threads/{thread_id}/archive", scope=scope
        )

    async def unarchive(
        self, thread_id: str, scope: "PlatosScope | None" = None
    ) -> None:
        await self._client._request(
            "POST", f"/api/v1/agent/threads/{thread_id}/unarchive", scope=scope
        )

    async def delete(
        self, thread_id: str, scope: "PlatosScope | None" = None
    ) -> None:
        await self._client._request(
            "DELETE", f"/api/v1/agent/threads/{thread_id}", scope=scope
        )

    # ---- realtime ----

    async def send(
        self,
        thread_id: str,
        message: str,
        *,
        scope: "PlatosScope | None" = None,
        agent_id: str | None = None,
        context_type: str | None = None,
        context_id: str | None = None,
        dynamic_blocks: dict[str, str] | None = None,
        attachment_ids: list[str] | None = None,
        max_reconnect_attempts: int = _DEFAULT_MAX_RECONNECT,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Send a message on a thread and stream events back.

        The agent service speaks Socket.IO on the `/agent` namespace; we
        use the raw WebSocket transport here so we don't have to pull in
        a Socket.IO Python client. Payload framing matches Socket.IO v4
        EIO=4 packets: `40` (open namespace), `42["event", {...}]` (send).
        """
        url = self._ws_url()
        sent_initial = False
        reconnect_attempt = 0

        async def _emit_ready(ws: ClientConnection) -> None:
            # Socket.IO EIO=4 "connect" frame to the /agent namespace.
            await ws.send(f"40{self._client.socket_namespace},")

        async def _emit_message(ws: ClientConnection) -> None:
            payload: dict[str, Any] = {
                "message": message,
                "threadId": thread_id,
            }
            if agent_id:
                payload["agentId"] = agent_id
            if context_type:
                payload["contextType"] = context_type
            if context_id:
                payload["contextId"] = context_id
            if dynamic_blocks:
                payload["dynamicBlocks"] = dynamic_blocks
            if attachment_ids:
                payload["attachmentIds"] = attachment_ids
            frame = f'42{self._client.socket_namespace},["message",{json.dumps(payload)}]'
            await ws.send(frame)

        async def _emit_resume(ws: ClientConnection) -> None:
            frame = (
                f'42{self._client.socket_namespace},'
                f'["resume_stream",{json.dumps({"threadId": thread_id})}]'
            )
            await ws.send(frame)

        while True:
            try:
                async with websockets.connect(
                    url,
                    additional_headers=self._ws_auth_headers(scope),
                ) as ws:
                    yield {"type": "connected"}
                    await _emit_ready(ws)
                    if not sent_initial:
                        await _emit_message(ws)
                        sent_initial = True
                    else:
                        await _emit_resume(ws)
                    reconnect_attempt = 0
                    async for raw in ws:
                        event = _parse_socketio_frame(raw)
                        if event is None:
                            continue
                        yield event
                        if event.get("type") == "done":
                            return
            except asyncio.CancelledError:
                yield {"type": "done", "stopped": True}
                raise
            except (websockets.ConnectionClosed, websockets.InvalidHandshake) as exc:
                yield {"type": "disconnected", "reason": str(exc)}
            except OSError as exc:
                yield {"type": "disconnected", "reason": str(exc)}

            if reconnect_attempt >= max_reconnect_attempts:
                raise PlatosNetworkError(
                    RuntimeError(
                        f"platos-client: exhausted {max_reconnect_attempts} reconnection attempts"
                    )
                )
            reconnect_attempt += 1
            delay = min(_RECONNECT_MAX_S, _RECONNECT_BASE_S * (2 ** (reconnect_attempt - 1)))
            yield {"type": "reconnecting", "attempt": reconnect_attempt}
            await asyncio.sleep(delay)

    def _ws_url(self) -> str:
        base = self._client.base_url
        if base.startswith("https://"):
            return "wss://" + base[len("https://") :] + "/socket.io/?EIO=4&transport=websocket"
        if base.startswith("http://"):
            return "ws://" + base[len("http://") :] + "/socket.io/?EIO=4&transport=websocket"
        return base + "/socket.io/?EIO=4&transport=websocket"

    def _ws_auth_headers(self, scope: "PlatosScope | None") -> dict[str, str]:
        # Socket.IO auth is normally passed in the `auth` payload; the
        # agent gateway also accepts scope + token as WS headers which
        # lets us stay transport-agnostic without parsing handshake packets.
        return self._client._build_headers(scope)


def _parse_socketio_frame(raw: str | bytes) -> dict[str, Any] | None:
    """Parse a single Socket.IO v4 EIO=4 frame into the wrapped event."""
    text = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw
    if not text:
        return None
    # Protocol frames: "0" open / "2" ping / "3" pong / "40" connect ack /
    # "42" event. We only care about "42" (event) and "44" (connect-error).
    if text.startswith("42"):
        # strip namespace: "42/agent,[..]" → "[..]"
        comma = text.find(",", 2)
        if comma == -1:
            body = text[2:]
        else:
            body = text[comma + 1 :]
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            return None
        if isinstance(parsed, list) and parsed and parsed[0] == "agent_event":
            event = parsed[1] if len(parsed) > 1 else {}
            if isinstance(event, dict):
                return event
    if text.startswith("44"):
        return {"type": "error", "message": "namespace connect error"}
    return None
