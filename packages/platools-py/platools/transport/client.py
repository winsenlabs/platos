"""SDK-side WebSocket client that talks to the Platos platform.

Usage (from user code):

    from platools import Platools

    platools = Platools(url="https://platform.platos.dev", secret="platos_agent_...")

    @platools.tool()
    def process_refund(order_id: str, reason: str) -> RefundResult: ...

    asyncio.run(platools.connect())   # runs forever, reconnecting as needed
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
import traceback
from typing import TYPE_CHECKING, Any, cast

from pydantic import TypeAdapter, ValidationError
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed

from platools.context import (
    _reset_current_context,
    _set_current_context,
    build_platos_context,
)
from platools.transport.protocol import (
    HeartbeatMessage,
    PlatformToSdk,
    ToolCallMessage,
    ToolErrorMessage,
    ToolRegisterMessage,
    ToolResultMessage,
    ToolSchemaPayload,
)

if TYPE_CHECKING:
    from platools.core.registry import ToolRegistry

log = logging.getLogger("platools.transport")

HEARTBEAT_INTERVAL = 30.0  # seconds — PRD §5.2
BACKOFF_BASE = 1.0  # seconds
BACKOFF_MAX = 60.0  # seconds
MAX_BACKOFF_ATTEMPTS = 10

_platform_adapter: TypeAdapter[PlatformToSdk] = TypeAdapter(PlatformToSdk)


class PlatoolsClient:
    """Async WebSocket client binding a `ToolRegistry` to a remote platform."""

    def __init__(
        self,
        *,
        url: str,
        secret: str,
        registry: ToolRegistry,
    ) -> None:
        if not url:
            raise ValueError("PlatoolsClient requires a url (set PLATOS_URL)")
        if not secret:
            raise ValueError("PlatoolsClient requires a secret (set PLATOS_SECRET)")
        self._url = url
        self._secret = secret
        self._registry = registry
        self._stop = asyncio.Event()
        self._ws: ClientConnection | None = None

    async def run_forever(self) -> None:
        """Connect, register tools, process tool calls, and reconnect on drop.

        Exits cleanly when `stop()` is called from another task.
        """
        attempt = 0
        while not self._stop.is_set():
            try:
                await self._run_session()
                attempt = 0  # reset after a successful session
            except ConnectionClosed as exc:
                log.warning("platools ws closed: %s", exc)
            except Exception as exc:  # noqa: BLE001
                log.exception("platools ws error: %s", exc)

            if self._stop.is_set():
                return
            attempt += 1
            delay = min(BACKOFF_BASE * (2 ** (attempt - 1)), BACKOFF_MAX)
            log.info("platools reconnect in %.1fs (attempt %d)", delay, attempt)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=delay)

    async def stop(self) -> None:
        self._stop.set()
        if self._ws is not None:
            await self._ws.close()

    # ---- internal --------------------------------------------------------

    async def _run_session(self) -> None:
        ws_url = self._ws_url()
        headers = [("Authorization", f"Bearer {self._secret}")]
        async with connect(ws_url, additional_headers=headers) as ws:
            self._ws = ws
            await self._send_registration(ws)
            heartbeat_task = asyncio.create_task(self._heartbeat_loop(ws))
            try:
                await self._message_loop(ws)
            finally:
                heartbeat_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await heartbeat_task
                self._ws = None

    def _ws_url(self) -> str:
        base = self._url.rstrip("/")
        if base.startswith("http://"):
            base = "ws://" + base[len("http://") :]
        elif base.startswith("https://"):
            base = "wss://" + base[len("https://") :]
        return f"{base}/ws/sdk"

    async def _send_registration(self, ws: ClientConnection) -> None:
        payloads: list[ToolSchemaPayload] = []
        for tool in self._registry.all():
            payloads.append(
                ToolSchemaPayload(
                    name=tool.name,
                    description=tool.description,
                    input_schema=tool.input_schema,
                    output_schema=tool.output_schema,
                    auth=tool.auth,
                    roles=list(tool.roles),
                    annotations=tool.annotations,
                )
            )
        message = ToolRegisterMessage(tools=payloads)
        await ws.send(message.model_dump_json())

    async def _heartbeat_loop(self, ws: ClientConnection) -> None:
        while True:
            await asyncio.sleep(HEARTBEAT_INTERVAL)
            try:
                await ws.send(HeartbeatMessage().model_dump_json())
            except ConnectionClosed:
                return

    async def _message_loop(self, ws: ClientConnection) -> None:
        async for raw in ws:
            try:
                data = json.loads(raw)
                message = _platform_adapter.validate_python(data)
            except (json.JSONDecodeError, ValidationError) as exc:
                log.warning("platools received malformed message: %s", exc)
                continue
            if isinstance(message, ToolCallMessage):
                await self._dispatch_call(ws, message)
            # welcome / heartbeat_ack are informational — no action required.

    async def _dispatch_call(self, ws: ClientConnection, call: ToolCallMessage) -> None:
        tool = self._registry.get(call.tool_name)
        if tool is None:
            await ws.send(
                ToolErrorMessage(
                    call_id=call.call_id,
                    error=f"unknown tool: {call.tool_name}",
                ).model_dump_json()
            )
            return

        # ── Pop the Platos envelopes BEFORE the user handler ever sees them.
        #
        # The platform injects TWO sub-dicts into `params`:
        #   - ``__platos`` — the signed (organizationId, projectId,
        #     environmentId, entityId, userId, userToken?, agentId,
        #     threadId, callId, timestamp, signature) tuple. Handlers
        #     read it via ``from platools.context import current_user_id``.
        #   - ``_context`` — the CTX.2 per-handler envelope built from
        #     ``contextMapping.envelopeKeys`` (e.g. ``user.id``,
        #     caller-declared ``entity_ids``). CTX.5 exposes it to
        #     handlers via an optional ``ctx`` keyword argument.
        # See ``apps/agent/src/tool-gateway/tool-executor.service.ts``.
        #
        # Both are popped from the kwargs dict before we ``**splat`` it
        # into the handler so neither leaks in as a spurious kwarg.
        raw_params: dict[str, Any] = dict(call.params)
        envelope_raw = raw_params.pop("__platos", None)
        context_envelope_raw = raw_params.pop("_context", None)
        envelope: dict[str, object] = (
            envelope_raw if isinstance(envelope_raw, dict) else {}
        )
        # PPR-30: server (`apps/agent/src/tool-gateway/tool-executor.service.ts`)
        # now injects `callId` into the `__platos` envelope before dispatch, so
        # the SDK no longer papers over a missing field. If the envelope still
        # lacks required fields (degenerate case — older agent, broken middleware),
        # `current_context()` will return `None` per its strict contract.

        validated_params = raw_params

        # Set contextvars for the duration of the call, then guarantee reset
        # in `finally` so no state can leak to the next dispatch. The message
        # loop is serial (one call at a time over the WebSocket), so a
        # simple set/reset pattern is both correct and minimal. If someone
        # later parallelizes dispatch via `asyncio.create_task`, the tokens
        # are still scoped by `ContextVar`'s task-local semantics and reset
        # still cleans up whatever this coroutine set.
        tokens = _set_current_context(envelope)
        start = time.monotonic()
        try:
            # CTX.5: if the handler opts into the explicit ``ctx``
            # argument, build a :class:`PlatosContext` from the popped
            # ``_context`` envelope and inject it under the declared
            # param name. Handlers that don't declare a ``ctx`` param
            # dispatch via kwargs only — the historical contract.
            handler_kwargs: dict[str, Any] = dict(validated_params)
            if tool.ctx_param_name is not None:
                handler_kwargs[tool.ctx_param_name] = build_platos_context(
                    call.call_id, context_envelope_raw
                )
            try:
                if tool.is_async:
                    result = await tool.func(**handler_kwargs)
                else:
                    # `asyncio.to_thread` propagates the calling task's
                    # context to the worker thread (stdlib guarantee since
                    # 3.9), so the sync handler sees the same contextvars
                    # that were set above.
                    result = await asyncio.to_thread(tool.func, **handler_kwargs)
            except Exception as exc:  # noqa: BLE001
                await ws.send(
                    ToolErrorMessage(
                        call_id=call.call_id,
                        error=str(exc),
                        traceback=traceback.format_exc(),
                    ).model_dump_json()
                )
                return

            latency_ms = int((time.monotonic() - start) * 1000)
            # Pydantic models → dict for JSON serialization.
            serializable = _to_jsonable(result)
            await ws.send(
                ToolResultMessage(
                    call_id=call.call_id,
                    result=serializable,
                    latency_ms=latency_ms,
                ).model_dump_json()
            )
        finally:
            _reset_current_context(tokens)


def _to_jsonable(value: Any) -> Any:
    """Coerce a tool return value into something `model_dump_json` can handle."""
    # Pydantic v2 BaseModel
    if hasattr(value, "model_dump"):
        return cast(Any, value).model_dump(mode="json")
    return value
