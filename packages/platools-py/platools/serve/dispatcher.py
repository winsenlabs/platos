"""JSON-RPC dispatcher for `platools serve` (PLATOS-41).

Wraps a :class:`platools.core.registry.ToolRegistry` and answers the
three MCP methods the platform gateway handles plus the
``notifications/initialized`` notification:

  - ``initialize``               → ``{protocolVersion, capabilities, serverInfo}``
  - ``notifications/initialized``→ notification (no response)
  - ``tools/list``               → ``{tools: [{name, description, inputSchema}]}``
  - ``tools/call``               → ``{content: [{type:"text", text:...}], isError}``

The dispatcher is transport-agnostic. Stdio and HTTP transports call
:meth:`JsonRpcDispatcher.handle_request` with a parsed ``JsonRpcRequest``
and serialize the response however they like. That split is important
for testability — the test suite exercises the dispatcher directly
without spinning up sockets or pipes.

Shape parity with the platform gateway is intentional: a client that
can talk to ``apps/api/platos/gateway/mcp_server.py`` can talk to
``platools serve`` byte-for-byte. If either side drifts, both sides
break, so any shape change here should land simultaneously in the
gateway (with task coordination).
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import traceback
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any, cast

from platools import __version__
from platools.context import (
    _reset_current_context,
    _set_current_context,
    build_platos_context,
)
from platools.core.registry import ToolRegistry
from platools.serve.jsonrpc import (
    INVALID_PARAMS,
    MCP_PROTOCOL_VERSION,
    METHOD_NOT_FOUND,
    JsonRpcRequest,
    JsonRpcResponse,
)
from platools.types import ToolDef

log = logging.getLogger("platools.serve")


SERVER_INFO: dict[str, Any] = {"name": "platools-serve", "version": __version__}
"""``serverInfo`` block returned from the ``initialize`` handshake.

The name is intentionally different from the platform gateway's
``platos-mcp-gateway`` so a client inspecting the two servers can tell
them apart (useful when one developer has both running locally).
"""

SERVER_CAPABILITIES: dict[str, Any] = {
    # ``listChanged=false`` — the SDK registry is snapshotted at process
    # start, so ``notifications/tools/list_changed`` is never emitted.
    # Hot-reloading the registry mid-session would require re-importing
    # the user's tool module, which is out of scope for PLATOS-41.
    "tools": {"listChanged": False},
}


@dataclass(frozen=True)
class ToolFilter:
    """In-memory allowlist for ``--tool`` CLI flag.

    A ``ToolFilter`` with ``allow_all=True`` passes every tool through;
    otherwise only names in ``names`` are exposed. Invalid / unknown
    names are caught at build time (in
    :func:`build_tool_filter`) so the server refuses to start with a
    typo rather than silently dropping the offender at runtime.
    """

    allow_all: bool
    names: frozenset[str]

    def includes(self, name: str) -> bool:
        return self.allow_all or name in self.names


def build_tool_filter(
    registry: ToolRegistry,
    *,
    allowed: Iterable[str] | None,
) -> ToolFilter:
    """Resolve the ``--tool`` allowlist against the registry.

    Raising on unknown names is deliberate — a typo in ``--tool
    proces_refund`` should surface loudly at startup rather than
    silently exposing zero tools over MCP and confusing the developer.
    """
    if allowed is None:
        return ToolFilter(allow_all=True, names=frozenset())
    wanted: set[str] = {n for n in allowed if n}
    registered: set[str] = set(registry.names())
    missing = wanted - registered
    if missing:
        raise ValueError(
            "unknown tool name(s) passed to --tool: " + ", ".join(sorted(missing))
        )
    return ToolFilter(allow_all=False, names=frozenset(wanted))


class JsonRpcDispatcher:
    """In-process JSON-RPC dispatcher bound to a ``ToolRegistry``.

    The dispatcher does not know about stdio or HTTP — transports hand
    it parsed :class:`JsonRpcRequest` instances and serialize whatever
    :class:`JsonRpcResponse` comes back. ``handle_request`` returns
    ``None`` for notifications (methods whose names start with
    ``notifications/``) so transports can skip writing a response body.
    """

    def __init__(
        self,
        registry: ToolRegistry,
        *,
        tool_filter: ToolFilter | None = None,
        include_traceback: bool = True,
    ) -> None:
        self._registry = registry
        self._filter = tool_filter or ToolFilter(allow_all=True, names=frozenset())
        # Stdio runs under parent-process trust so local tracebacks are
        # fine — they help developers debug. HTTP transport flips this
        # to ``False`` so an authenticated-but-remote client can't scrape
        # absolute filesystem paths out of an error response.
        self._include_traceback = include_traceback

    @property
    def registry(self) -> ToolRegistry:
        return self._registry

    @property
    def tool_filter(self) -> ToolFilter:
        return self._filter

    @property
    def include_traceback(self) -> bool:
        return self._include_traceback

    def visible_tools(self) -> list[ToolDef]:
        """Return the tools that pass the allowlist, in registration order."""
        return [t for t in self._registry.all() if self._filter.includes(t.name)]

    async def handle_request(
        self,
        request: JsonRpcRequest,
        *,
        extra_envelope: dict[str, Any] | None = None,
    ) -> JsonRpcResponse | None:
        """Dispatch one JSON-RPC request.

        ``extra_envelope`` lets the HTTP transport inject fields that
        arrive as HTTP headers rather than body params (e.g.
        ``X-Platos-Entity-Token`` → ``entityToken`` in the ``__platos``
        envelope). These are merged into any ``__platos`` dict found
        inside the ``tools/call`` arguments before context vars are set.

        Returns ``None`` for JSON-RPC notifications (client-initiated
        one-shot messages with no response body). Returns a populated
        :class:`JsonRpcResponse` for everything else, including error
        paths — protocol errors stay inside the JSON-RPC envelope.
        """
        method = request.method
        params = request.params or {}

        if method == "initialize":
            return self._handle_initialize(request)
        if method == "notifications/initialized":
            # Spec: posted by the client after processing the initialize
            # response. No response body; transports treat ``None`` as
            # "don't write anything" (stdio: skip line, http: 204).
            return None
        if method == "tools/list":
            return self._handle_tools_list(request)
        if method == "tools/call":
            return await self._handle_tools_call(
                request, params=params, extra_envelope=extra_envelope
            )

        return JsonRpcResponse.err(
            request.id,
            code=METHOD_NOT_FOUND,
            message=f"method {method!r} is not implemented by platools serve",
        )

    # ---- method handlers ------------------------------------------------

    def _handle_initialize(self, request: JsonRpcRequest) -> JsonRpcResponse:
        return JsonRpcResponse.ok(
            request.id,
            {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": SERVER_CAPABILITIES,
                "serverInfo": SERVER_INFO,
            },
        )

    def _handle_tools_list(self, request: JsonRpcRequest) -> JsonRpcResponse:
        tools = [_tool_to_mcp(t) for t in self.visible_tools()]
        return JsonRpcResponse.ok(request.id, {"tools": tools})

    async def _handle_tools_call(
        self,
        request: JsonRpcRequest,
        *,
        params: dict[str, Any],
        extra_envelope: dict[str, Any] | None = None,
    ) -> JsonRpcResponse:
        tool_name = params.get("name")
        if not isinstance(tool_name, str) or not tool_name:
            return JsonRpcResponse.err(
                request.id,
                code=INVALID_PARAMS,
                message="tools/call requires a non-empty `name` parameter",
            )

        # ``arguments`` is optional per the MCP spec — absent or explicit
        # ``null`` both become an empty dict. An explicit non-object is a
        # client bug and should fail with ``-32602`` rather than be
        # silently coerced. This matches the platform gateway (PLATOS-26).
        raw_arguments = params.get("arguments")
        if raw_arguments is None:
            arguments: dict[str, Any] = {}
        elif isinstance(raw_arguments, dict):
            arguments = dict(raw_arguments)
        else:
            return JsonRpcResponse.err(
                request.id,
                code=INVALID_PARAMS,
                message="tools/call `arguments` must be an object",
            )

        # Pop the Platos envelopes before invoking the handler — mirrors
        # the WS transport path in ``transport/client.py`` so context
        # accessors (current_user_id, current_entity_token, …) work
        # identically in both ``platools serve`` and WS-connected modes.
        #
        # ``extra_envelope`` carries fields that arrived as HTTP headers
        # (e.g. ``X-Platos-Entity-Token`` → ``entityToken``). Merge
        # those in AFTER popping so HTTP-header values win over body ones.
        envelope_raw = arguments.pop("__platos", None)
        context_envelope_raw = arguments.pop("_context", None)
        envelope: dict[str, Any] = (
            dict(envelope_raw) if isinstance(envelope_raw, dict) else {}
        )
        if extra_envelope:
            envelope.update(extra_envelope)

        # Allowlist check runs before the registry lookup so a filtered
        # tool looks indistinguishable from a nonexistent one from the
        # client's perspective — don't leak the shape of the registry.
        if not self._filter.includes(tool_name):
            return JsonRpcResponse.err(
                request.id,
                code=METHOD_NOT_FOUND,
                message=f"tool {tool_name!r} is not exposed by this server",
            )

        tool = self._registry.get(tool_name)
        if tool is None:
            return JsonRpcResponse.err(
                request.id,
                code=METHOD_NOT_FOUND,
                message=f"tool {tool_name!r} is not registered",
            )

        # Set context vars for the duration of this call — same pattern
        # as ``transport/client.py`` so sync + async handlers see the
        # same context regardless of transport.
        tokens = _set_current_context(envelope)
        try:
            handler_kwargs: dict[str, Any] = dict(arguments)
            if tool.ctx_param_name is not None:
                handler_kwargs[tool.ctx_param_name] = build_platos_context(
                    envelope.get("callId", request.id or ""),
                    context_envelope_raw,
                )
            try:
                result = await _invoke_tool(tool, handler_kwargs)
            except TypeError as exc:
                # Argument-shape mismatch — pydantic would surface this at
                # the registration layer, but a client can still pass
                # garbage arguments at call time. Report it as a tool
                # execution error so the client sees a structured failure
                # rather than a Python traceback.
                log.info("platools serve tools/call bad args: %s", exc)
                return JsonRpcResponse.ok(
                    request.id, _call_tool_result(str(exc), is_error=True)
                )
            except Exception as exc:  # noqa: BLE001
                # Every other tool failure becomes ``isError=True`` per the
                # MCP spec: "If an error occurs during tool execution,
                # servers SHOULD return the error in the CallToolResult."
                log.info(
                    "platools serve tools/call failed",
                    extra={"tool": tool_name, "err": str(exc)},
                )
                tb_text = traceback.format_exc() if self._include_traceback else None
                body = _call_tool_result(
                    f"{type(exc).__name__}: {exc}",
                    is_error=True,
                    traceback_text=tb_text,
                )
                return JsonRpcResponse.ok(request.id, body)
        finally:
            _reset_current_context(tokens)

        return JsonRpcResponse.ok(
            request.id, _call_tool_result(result, is_error=False)
        )


async def _invoke_tool(tool: ToolDef, arguments: dict[str, Any]) -> Any:
    """Execute a tool with the MCP ``arguments`` dict.

    Async tools are awaited directly. Sync tools run on a worker
    thread via ``asyncio.to_thread`` so a slow blocking tool can't
    wedge the event loop (stdio transport in particular needs the
    loop free to keep draining stdin). This mirrors the
    platform-side client in ``transport/client.py``.
    """
    if tool.is_async or inspect.iscoroutinefunction(tool.func):
        return await tool.func(**arguments)
    return await asyncio.to_thread(tool.func, **arguments)


# ---- MCP shape helpers ---------------------------------------------------


def _tool_to_mcp(tool: ToolDef) -> dict[str, Any]:
    """Coerce a :class:`ToolDef` into the MCP ``Tool`` wire shape.

    MCP uses camelCase (``inputSchema``); the SDK's internal field is
    ``input_schema``. ``description`` is always a string in the MCP
    schema — coalesce ``None`` / empty to an empty string so strict
    validators on the client don't reject the list.
    """
    return {
        "name": tool.name,
        "description": tool.description or "",
        "inputSchema": tool.input_schema or {"type": "object", "properties": {}},
    }


def _call_tool_result(
    result: Any,
    *,
    is_error: bool,
    traceback_text: str | None = None,
) -> dict[str, Any]:
    """Wrap an arbitrary Python result in an MCP ``CallToolResult``.

    MCP ``content`` is a list of ``{type, text}`` blocks (or other
    content types). We stringify via ``json.dumps`` so structured
    results round-trip safely; already-a-string results pass through
    verbatim so the client doesn't see escaped quotes on a trivial tool.

    Pydantic models are serialized via ``model_dump(mode='json')`` so
    nested ``datetime`` / ``UUID`` / ``Enum`` fields are emitted as
    JSON-safe strings without the caller having to opt in.

    A non-None ``traceback_text`` is attached as a second ``text``
    block on error results. Regular (non-error) results never include
    a traceback.
    """
    text = _stringify(result)
    content: list[dict[str, Any]] = [{"type": "text", "text": text}]
    if is_error and traceback_text:
        content.append({"type": "text", "text": traceback_text})
    return {"content": content, "isError": is_error}


def _stringify(result: Any) -> str:
    """JSON-serialize a tool result, preserving Pydantic model shapes.

    Three cases:
      - Plain strings pass through verbatim.
      - Pydantic v2 ``BaseModel`` → ``model_dump(mode='json')`` for
        datetime/UUID/Enum coercion, then ``json.dumps``.
      - Everything else → ``json.dumps(default=str)`` so unknown
        objects degrade to their ``repr``-ish form instead of raising.
    """
    if isinstance(result, str):
        return result
    if hasattr(result, "model_dump"):
        try:
            dumped = cast(Any, result).model_dump(mode="json")
        except Exception:  # noqa: BLE001
            dumped = cast(Any, result).model_dump()
        return json.dumps(dumped, default=str)
    try:
        return json.dumps(result, default=str)
    except (TypeError, ValueError):
        return repr(result)
