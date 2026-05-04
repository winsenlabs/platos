"""`platools serve` tests — PLATOS-41.

Covers the JSON-RPC dispatcher, the stdio transport, the HTTP
transport, and the CLI front-end. The protocol shape mirrors
``apps/api/platos/gateway/mcp_server.py`` so a regression here is a
regression there too — the tests deliberately spell out the exact
field names (``inputSchema``, ``protocolVersion``, ``isError``) so a
silent camelCase → snake_case drift trips this suite immediately.
"""

from __future__ import annotations

import asyncio
import io
import json
import socket
import sys
import urllib.error
import urllib.request
from typing import Any

import pytest
from platools import Platools
from platools.cli import main as cli_main
from platools.cli.serve import run_serve, serve_command
from platools.core.registry import ToolRegistry
from platools.serve import (
    INVALID_PARAMS,
    MCP_PROTOCOL_VERSION,
    METHOD_NOT_FOUND,
    PARSE_ERROR,
    SERVER_INFO,
    JsonRpcDispatcher,
    JsonRpcRequest,
    build_tool_filter,
    run_http,
    run_stdio,
)
from platools.serve.dispatcher import ToolFilter
from platools.serve.http import HttpServerConfig
from pydantic import BaseModel

# ---- fixtures --------------------------------------------------------------


class Pong(BaseModel):
    """Module-level return type for the ``ping`` fixture tool.

    ``get_type_hints`` can't resolve a class defined inside a function
    body (forward references look it up in the function's globals, not
    its locals), so fixture return types must live at module scope.
    """

    echo: str
    length: int


def _build_registry_with_tools() -> tuple[Platools, ToolRegistry]:
    """Create a fresh ``Platools`` instance with three tools.

    Using a new ``Platools`` per test guarantees isolation — the
    global decorator pattern re-uses one registry per instance, so
    test pollution is impossible as long as we never share the same
    instance between tests.
    """
    plat = Platools()

    @plat.tool()
    def add(a: int, b: int) -> int:
        """Sum two integers.

        Args:
            a: First addend.
            b: Second addend.
        """
        return a + b

    @plat.tool()
    def ping(text: str) -> Pong:
        """Return the supplied text and its length.

        Args:
            text: The text to echo.
        """
        return Pong(echo=text, length=len(text))

    @plat.tool()
    def fail() -> str:
        """A tool that always raises — exercises the error envelope."""
        raise RuntimeError("kaboom")

    return plat, plat.registry


def _make_dispatcher(tool_filter: ToolFilter | None = None) -> JsonRpcDispatcher:
    _, registry = _build_registry_with_tools()
    return JsonRpcDispatcher(registry, tool_filter=tool_filter)


# ---- dispatcher: happy path ------------------------------------------------


@pytest.mark.asyncio
async def test_initialize_returns_server_info() -> None:
    dispatcher = _make_dispatcher()
    response = await dispatcher.handle_request(
        JsonRpcRequest(id=1, method="initialize")
    )
    assert response is not None
    assert response.error is None
    result = response.result
    assert result["protocolVersion"] == MCP_PROTOCOL_VERSION
    assert result["serverInfo"] == SERVER_INFO
    assert result["capabilities"]["tools"]["listChanged"] is False


@pytest.mark.asyncio
async def test_notifications_initialized_returns_none() -> None:
    """The client-side ``notifications/initialized`` notification is
    a no-response message. ``handle_request`` must return ``None`` so
    the transport layer knows not to write a body.
    """
    dispatcher = _make_dispatcher()
    response = await dispatcher.handle_request(
        JsonRpcRequest(method="notifications/initialized")
    )
    assert response is None


@pytest.mark.asyncio
async def test_tools_list_returns_registered_tools() -> None:
    dispatcher = _make_dispatcher()
    response = await dispatcher.handle_request(
        JsonRpcRequest(id=2, method="tools/list")
    )
    assert response is not None
    assert response.error is None
    tools = response.result["tools"]
    names = {t["name"] for t in tools}
    assert names == {"add", "ping", "fail"}
    # Shape parity with the platform gateway — camelCase "inputSchema"
    # must survive the round-trip.
    for tool in tools:
        assert set(tool.keys()) >= {"name", "description", "inputSchema"}
        assert isinstance(tool["inputSchema"], dict)


@pytest.mark.asyncio
async def test_tools_call_happy_path_sync() -> None:
    dispatcher = _make_dispatcher()
    response = await dispatcher.handle_request(
        JsonRpcRequest(
            id="c1",
            method="tools/call",
            params={"name": "add", "arguments": {"a": 2, "b": 3}},
        )
    )
    assert response is not None
    assert response.error is None
    body = response.result
    assert body["isError"] is False
    assert body["content"][0]["type"] == "text"
    assert json.loads(body["content"][0]["text"]) == 5


@pytest.mark.asyncio
async def test_tools_call_returns_pydantic_model_as_json() -> None:
    """Pydantic return values serialize via ``model_dump(mode='json')``
    so nested datetime/UUID/Enum fields come out as JSON-safe strings
    automatically (not as ``repr`` gunk).
    """
    dispatcher = _make_dispatcher()
    response = await dispatcher.handle_request(
        JsonRpcRequest(
            id="c2",
            method="tools/call",
            params={"name": "ping", "arguments": {"text": "hi"}},
        )
    )
    assert response is not None
    assert response.error is None
    body = response.result
    assert body["isError"] is False
    decoded = json.loads(body["content"][0]["text"])
    assert decoded == {"echo": "hi", "length": 2}


@pytest.mark.asyncio
async def test_tools_call_async_tool() -> None:
    """Async tools are awaited directly — no ``to_thread`` round-trip."""
    plat = Platools()

    @plat.tool()
    async def slow_add(a: int, b: int) -> int:
        """Add two numbers after a tiny await hop.

        Args:
            a: First operand.
            b: Second operand.
        """
        await asyncio.sleep(0)
        return a + b

    dispatcher = JsonRpcDispatcher(plat.registry)
    response = await dispatcher.handle_request(
        JsonRpcRequest(
            id="a1",
            method="tools/call",
            params={"name": "slow_add", "arguments": {"a": 7, "b": 5}},
        )
    )
    assert response is not None
    assert response.error is None
    assert json.loads(response.result["content"][0]["text"]) == 12


# ---- dispatcher: error paths ----------------------------------------------


@pytest.mark.asyncio
async def test_unknown_method_returns_method_not_found() -> None:
    dispatcher = _make_dispatcher()
    response = await dispatcher.handle_request(
        JsonRpcRequest(id=10, method="tools/delete")
    )
    assert response is not None
    assert response.error is not None
    assert response.error.code == METHOD_NOT_FOUND


@pytest.mark.asyncio
async def test_unknown_tool_returns_method_not_found() -> None:
    dispatcher = _make_dispatcher()
    response = await dispatcher.handle_request(
        JsonRpcRequest(
            id=11,
            method="tools/call",
            params={"name": "nonexistent", "arguments": {}},
        )
    )
    assert response is not None
    assert response.error is not None
    assert response.error.code == METHOD_NOT_FOUND


@pytest.mark.asyncio
async def test_tools_call_missing_name_returns_invalid_params() -> None:
    dispatcher = _make_dispatcher()
    response = await dispatcher.handle_request(
        JsonRpcRequest(id=12, method="tools/call", params={})
    )
    assert response is not None
    assert response.error is not None
    assert response.error.code == INVALID_PARAMS


@pytest.mark.asyncio
async def test_tools_call_arguments_must_be_object() -> None:
    dispatcher = _make_dispatcher()
    response = await dispatcher.handle_request(
        JsonRpcRequest(
            id=13,
            method="tools/call",
            params={"name": "add", "arguments": [1, 2]},
        )
    )
    assert response is not None
    assert response.error is not None
    assert response.error.code == INVALID_PARAMS


@pytest.mark.asyncio
async def test_tool_execution_failure_returns_call_tool_error() -> None:
    """A tool that raises gets wrapped in ``{isError: True}`` per MCP
    spec — not a JSON-RPC protocol error. The client is expected to
    read ``content[0].text`` and see the failure message.
    """
    dispatcher = _make_dispatcher()
    response = await dispatcher.handle_request(
        JsonRpcRequest(
            id=14,
            method="tools/call",
            params={"name": "fail", "arguments": {}},
        )
    )
    assert response is not None
    assert response.error is None
    body = response.result
    assert body["isError"] is True
    assert "kaboom" in body["content"][0]["text"]


@pytest.mark.asyncio
async def test_tools_call_bad_arguments_caught_as_error() -> None:
    """Passing arguments a Python function can't accept surfaces as a
    tool-level error, not a Python traceback to the client.
    """
    dispatcher = _make_dispatcher()
    response = await dispatcher.handle_request(
        JsonRpcRequest(
            id=15,
            method="tools/call",
            params={"name": "add", "arguments": {"a": 1}},  # missing b
        )
    )
    assert response is not None
    assert response.error is None
    assert response.result["isError"] is True


@pytest.mark.asyncio
async def test_tools_call_traceback_included_by_default() -> None:
    """Stdio-style dispatcher exposes tracebacks for local debugging."""
    _, registry = _build_registry_with_tools()
    dispatcher = JsonRpcDispatcher(registry, include_traceback=True)
    response = await dispatcher.handle_request(
        JsonRpcRequest(
            id=16,
            method="tools/call",
            params={"name": "fail", "arguments": {}},
        )
    )
    assert response is not None
    assert response.error is None
    body = response.result
    assert body["isError"] is True
    # Two content blocks: stringified error + traceback.
    assert len(body["content"]) == 2
    assert "Traceback" in body["content"][1]["text"]


@pytest.mark.asyncio
async def test_tools_call_traceback_suppressed_for_http_mode() -> None:
    """HTTP-style dispatcher scrubs the traceback so a remote (even
    authenticated) client never sees absolute filesystem paths or
    local-variable fragments from a Python stack frame.
    """
    _, registry = _build_registry_with_tools()
    dispatcher = JsonRpcDispatcher(registry, include_traceback=False)
    response = await dispatcher.handle_request(
        JsonRpcRequest(
            id=17,
            method="tools/call",
            params={"name": "fail", "arguments": {}},
        )
    )
    assert response is not None
    assert response.error is None
    body = response.result
    assert body["isError"] is True
    assert len(body["content"]) == 1
    assert "Traceback" not in body["content"][0]["text"]
    # The user-facing error text still identifies the failure class
    # and message so the client can react to it.
    assert "kaboom" in body["content"][0]["text"]


# ---- dispatcher: tool filter ----------------------------------------------


def test_build_tool_filter_raises_on_unknown_name() -> None:
    _, registry = _build_registry_with_tools()
    with pytest.raises(ValueError, match="unknown tool name"):
        build_tool_filter(registry, allowed=["add", "does_not_exist"])


def test_build_tool_filter_allow_all_when_none() -> None:
    _, registry = _build_registry_with_tools()
    tool_filter = build_tool_filter(registry, allowed=None)
    assert tool_filter.allow_all is True
    assert tool_filter.includes("add")


def test_build_tool_filter_explicit_names() -> None:
    _, registry = _build_registry_with_tools()
    tool_filter = build_tool_filter(registry, allowed=["add"])
    assert tool_filter.allow_all is False
    assert tool_filter.includes("add")
    assert not tool_filter.includes("ping")


@pytest.mark.asyncio
async def test_tools_list_respects_filter() -> None:
    _, registry = _build_registry_with_tools()
    dispatcher = JsonRpcDispatcher(
        registry,
        tool_filter=build_tool_filter(registry, allowed=["add"]),
    )
    response = await dispatcher.handle_request(
        JsonRpcRequest(id=1, method="tools/list")
    )
    assert response is not None
    names = {t["name"] for t in response.result["tools"]}
    assert names == {"add"}


@pytest.mark.asyncio
async def test_tools_call_filtered_tool_is_invisible() -> None:
    """A tool that's registered but filtered out must appear exactly
    like a tool that doesn't exist at all — don't leak the registry.
    """
    _, registry = _build_registry_with_tools()
    dispatcher = JsonRpcDispatcher(
        registry,
        tool_filter=build_tool_filter(registry, allowed=["add"]),
    )
    response = await dispatcher.handle_request(
        JsonRpcRequest(
            id=1,
            method="tools/call",
            params={"name": "ping", "arguments": {"text": "hi"}},
        )
    )
    assert response is not None
    assert response.error is not None
    assert response.error.code == METHOD_NOT_FOUND


# ---- stdio transport -------------------------------------------------------


async def _feed_stdio(
    dispatcher: JsonRpcDispatcher, lines: list[bytes]
) -> list[dict[str, Any]]:
    """Pump synthetic input through :func:`run_stdio` and parse
    every response line back into a list of JSON dicts.

    The test builds an ``asyncio.StreamReader``, feeds it the bytes
    verbatim, and closes it (``feed_eof``) so ``run_stdio`` exits
    cleanly on the next read. Stdout is a ``StringIO`` so the test
    can assert on framed response bytes.
    """
    reader = asyncio.StreamReader()
    for line in lines:
        reader.feed_data(line)
    reader.feed_eof()
    out = io.StringIO()
    await run_stdio(dispatcher, stdin=reader, stdout=out)
    responses: list[dict[str, Any]] = []
    for raw in out.getvalue().splitlines():
        if raw.strip():
            responses.append(json.loads(raw))
    return responses


@pytest.mark.asyncio
async def test_stdio_initialize_roundtrip() -> None:
    dispatcher = _make_dispatcher()
    responses = await _feed_stdio(
        dispatcher,
        [json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize"}).encode() + b"\n"],
    )
    assert len(responses) == 1
    assert responses[0]["id"] == 1
    assert responses[0]["result"]["protocolVersion"] == MCP_PROTOCOL_VERSION


@pytest.mark.asyncio
async def test_stdio_parse_error_on_malformed_json() -> None:
    dispatcher = _make_dispatcher()
    responses = await _feed_stdio(dispatcher, [b"not-json\n"])
    assert len(responses) == 1
    assert responses[0]["error"]["code"] == PARSE_ERROR
    assert responses[0]["id"] is None


@pytest.mark.asyncio
async def test_stdio_invalid_request_echoes_id_when_possible() -> None:
    dispatcher = _make_dispatcher()
    # Missing required ``method`` field — envelope validation error.
    bad = {"jsonrpc": "2.0", "id": 42}
    responses = await _feed_stdio(dispatcher, [json.dumps(bad).encode() + b"\n"])
    assert len(responses) == 1
    assert responses[0]["id"] == 42  # best-effort correlation
    assert responses[0]["error"] is not None


@pytest.mark.asyncio
async def test_stdio_notification_has_no_response() -> None:
    dispatcher = _make_dispatcher()
    responses = await _feed_stdio(
        dispatcher,
        [
            json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}).encode()
            + b"\n"
        ],
    )
    assert responses == []


@pytest.mark.asyncio
async def test_stdio_multiple_calls_are_all_answered() -> None:
    dispatcher = _make_dispatcher()
    calls = [
        json.dumps({"jsonrpc": "2.0", "id": i, "method": "initialize"}).encode() + b"\n"
        for i in range(3)
    ]
    responses = await _feed_stdio(dispatcher, calls)
    assert {r["id"] for r in responses} == {0, 1, 2}


@pytest.mark.asyncio
async def test_stdio_concurrent_tool_calls_do_not_interleave() -> None:
    """Two async tool calls are dispatched back-to-back; both must
    produce complete, independently-parseable JSON lines. The write
    lock in ``stdio.py`` is what guarantees this.
    """
    plat = Platools()

    @plat.tool()
    async def slow(marker: str) -> str:
        """Return the marker after a tiny yield.

        Args:
            marker: Identifier echoed in the response.
        """
        await asyncio.sleep(0.01)
        return marker

    dispatcher = JsonRpcDispatcher(plat.registry)
    calls = [
        json.dumps(
            {
                "jsonrpc": "2.0",
                "id": i,
                "method": "tools/call",
                "params": {"name": "slow", "arguments": {"marker": f"m{i}"}},
            }
        ).encode()
        + b"\n"
        for i in range(5)
    ]
    responses = await _feed_stdio(dispatcher, calls)
    assert len(responses) == 5
    by_id = {r["id"]: r for r in responses}
    for i in range(5):
        text = by_id[i]["result"]["content"][0]["text"]
        assert text == f"m{i}"


# ---- HTTP transport --------------------------------------------------------


def _free_port() -> int:
    """Grab an OS-assigned free port so parallel tests don't clash."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


async def _http_client_post(
    url: str, body: bytes, headers: dict[str, str]
) -> tuple[int, dict[str, str], bytes]:
    """Blocking ``urllib`` POST wrapped in ``to_thread``.

    ``urllib`` is stdlib (no new test deps) and the tiny amount of
    blocking is fine because it runs in a worker thread while the
    event loop services the server under test.
    """

    def _sync() -> tuple[int, dict[str, str], bytes]:
        req = urllib.request.Request(url, data=body, method="POST", headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=5.0) as resp:
                return (
                    resp.getcode(),
                    {k.lower(): v for k, v in resp.getheaders()},
                    resp.read(),
                )
        except urllib.error.HTTPError as exc:
            return (
                exc.code,
                {k.lower(): v for k, v in exc.headers.items()},
                exc.read(),
            )

    return await asyncio.to_thread(_sync)


@pytest.mark.asyncio
async def test_http_initialize_with_auth() -> None:
    dispatcher = _make_dispatcher()
    port = _free_port()
    config = HttpServerConfig(host="127.0.0.1", port=port, auth_token="shh")
    ready = asyncio.Event()
    stop = asyncio.Event()
    server_task = asyncio.create_task(
        run_http(dispatcher, config, ready_event=ready, stop_event=stop)
    )
    try:
        await asyncio.wait_for(ready.wait(), timeout=5.0)
        status, headers, body = await _http_client_post(
            f"http://127.0.0.1:{port}/mcp",
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize"}).encode(),
            {
                "Content-Type": "application/json",
                "Authorization": "Bearer shh",
            },
        )
        assert status == 200
        assert headers["content-type"].startswith("application/json")
        payload = json.loads(body)
        assert payload["id"] == 1
        assert payload["result"]["protocolVersion"] == MCP_PROTOCOL_VERSION
    finally:
        stop.set()
        await asyncio.wait_for(server_task, timeout=5.0)


@pytest.mark.asyncio
async def test_http_rejects_missing_token() -> None:
    dispatcher = _make_dispatcher()
    port = _free_port()
    config = HttpServerConfig(host="127.0.0.1", port=port, auth_token="shh")
    ready = asyncio.Event()
    stop = asyncio.Event()
    server_task = asyncio.create_task(
        run_http(dispatcher, config, ready_event=ready, stop_event=stop)
    )
    try:
        await asyncio.wait_for(ready.wait(), timeout=5.0)
        status, headers, _body = await _http_client_post(
            f"http://127.0.0.1:{port}/mcp",
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize"}).encode(),
            {"Content-Type": "application/json"},
        )
        assert status == 401
        assert "bearer" in headers.get("www-authenticate", "").lower()
    finally:
        stop.set()
        await asyncio.wait_for(server_task, timeout=5.0)


@pytest.mark.asyncio
async def test_http_rejects_wrong_token() -> None:
    dispatcher = _make_dispatcher()
    port = _free_port()
    config = HttpServerConfig(host="127.0.0.1", port=port, auth_token="shh")
    ready = asyncio.Event()
    stop = asyncio.Event()
    server_task = asyncio.create_task(
        run_http(dispatcher, config, ready_event=ready, stop_event=stop)
    )
    try:
        await asyncio.wait_for(ready.wait(), timeout=5.0)
        status, _headers, _body = await _http_client_post(
            f"http://127.0.0.1:{port}/mcp",
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize"}).encode(),
            {"Content-Type": "application/json", "Authorization": "Bearer wrong"},
        )
        assert status == 401
    finally:
        stop.set()
        await asyncio.wait_for(server_task, timeout=5.0)


@pytest.mark.asyncio
async def test_http_rejects_wrong_path() -> None:
    dispatcher = _make_dispatcher()
    port = _free_port()
    config = HttpServerConfig(host="127.0.0.1", port=port, auth_token="shh")
    ready = asyncio.Event()
    stop = asyncio.Event()
    server_task = asyncio.create_task(
        run_http(dispatcher, config, ready_event=ready, stop_event=stop)
    )
    try:
        await asyncio.wait_for(ready.wait(), timeout=5.0)
        status, _headers, _body = await _http_client_post(
            f"http://127.0.0.1:{port}/wrong",
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize"}).encode(),
            {"Content-Type": "application/json", "Authorization": "Bearer shh"},
        )
        assert status == 404
    finally:
        stop.set()
        await asyncio.wait_for(server_task, timeout=5.0)


@pytest.mark.asyncio
async def test_http_rejects_get_method() -> None:
    dispatcher = _make_dispatcher()
    port = _free_port()
    config = HttpServerConfig(host="127.0.0.1", port=port, auth_token="shh")
    ready = asyncio.Event()
    stop = asyncio.Event()
    server_task = asyncio.create_task(
        run_http(dispatcher, config, ready_event=ready, stop_event=stop)
    )
    try:
        await asyncio.wait_for(ready.wait(), timeout=5.0)

        def _do_get() -> int:
            with socket.create_connection(("127.0.0.1", port), timeout=5.0) as sock:
                sock.sendall(b"GET /mcp HTTP/1.1\r\nHost: x\r\n\r\n")
                data = sock.recv(4096)
            # First line is "HTTP/1.1 NNN reason"
            return int(data.split(b" ", 2)[1])

        status = await asyncio.to_thread(_do_get)
        assert status == 405
    finally:
        stop.set()
        await asyncio.wait_for(server_task, timeout=5.0)


@pytest.mark.asyncio
async def test_http_rejects_payload_too_large() -> None:
    dispatcher = _make_dispatcher()
    port = _free_port()
    # Tight cap so the test doesn't have to ship a megabyte of bytes.
    config = HttpServerConfig(
        host="127.0.0.1",
        port=port,
        auth_token="shh",
        max_body_bytes=64,
    )
    ready = asyncio.Event()
    stop = asyncio.Event()
    server_task = asyncio.create_task(
        run_http(dispatcher, config, ready_event=ready, stop_event=stop)
    )
    try:
        await asyncio.wait_for(ready.wait(), timeout=5.0)
        body = b"x" * 1024
        status, _headers, _body = await _http_client_post(
            f"http://127.0.0.1:{port}/mcp",
            body,
            {"Content-Type": "application/json", "Authorization": "Bearer shh"},
        )
        assert status == 413
    finally:
        stop.set()
        await asyncio.wait_for(server_task, timeout=5.0)


@pytest.mark.asyncio
async def test_http_tools_call_roundtrip() -> None:
    dispatcher = _make_dispatcher()
    port = _free_port()
    config = HttpServerConfig(host="127.0.0.1", port=port, auth_token="shh")
    ready = asyncio.Event()
    stop = asyncio.Event()
    server_task = asyncio.create_task(
        run_http(dispatcher, config, ready_event=ready, stop_event=stop)
    )
    try:
        await asyncio.wait_for(ready.wait(), timeout=5.0)
        status, _headers, body = await _http_client_post(
            f"http://127.0.0.1:{port}/mcp",
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {"name": "add", "arguments": {"a": 4, "b": 5}},
                }
            ).encode(),
            {"Content-Type": "application/json", "Authorization": "Bearer shh"},
        )
        assert status == 200
        payload = json.loads(body)
        assert payload["id"] == 1
        assert payload["result"]["isError"] is False
        assert json.loads(payload["result"]["content"][0]["text"]) == 9
    finally:
        stop.set()
        await asyncio.wait_for(server_task, timeout=5.0)


def test_http_server_config_rejects_empty_token() -> None:
    with pytest.raises(ValueError, match="auth_token"):
        HttpServerConfig(host="127.0.0.1", port=3001, auth_token="")


def test_http_server_config_rejects_bad_port() -> None:
    with pytest.raises(ValueError, match="port"):
        HttpServerConfig(host="127.0.0.1", port=0, auth_token="ok")


# ---- CLI -------------------------------------------------------------------


def test_cli_run_serve_list_only(tmp_path: Any) -> None:
    """``platools serve --list --module <mod>`` prints the registered
    tools and exits 0 without starting a transport.
    """
    mod_path = tmp_path / "my_tools.py"
    mod_path.write_text(
        'from platools import Platools\n'
        'platools = Platools()\n'
        '\n'
        '@platools.tool()\n'
        'def add(a: int, b: int) -> int:\n'
        '    """Sum two integers.\n'
        '\n'
        '    Args:\n'
        '        a: First.\n'
        '        b: Second.\n'
        '    """\n'
        '    return a + b\n'
    )
    sys.path.insert(0, str(tmp_path))
    try:
        out = io.StringIO()
        err = io.StringIO()
        code = run_serve(
            module_path="my_tools",
            list_only=True,
            out=out,
            err=err,
        )
        assert code == 0
        assert "add" in out.getvalue()
    finally:
        sys.path.remove(str(tmp_path))
        sys.modules.pop("my_tools", None)


def test_cli_run_serve_empty_registry_refuses_to_start(tmp_path: Any) -> None:
    """With no module and no registered tools, ``serve`` must refuse
    rather than silently stand up a zero-tool MCP surface.
    """
    out = io.StringIO()
    err = io.StringIO()
    code = run_serve(out=out, err=err)
    assert code == 1
    assert "no tools" in err.getvalue().lower()


def test_cli_run_serve_doctor_errors_refuse_to_start(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    """When doctor emits an error-severity finding the server must
    abort. Patch the analyzer rather than crafting a real broken
    tool — the gate logic is what we're testing, not doctor itself.
    """
    mod_path = tmp_path / "clean_tools.py"
    mod_path.write_text(
        'from platools import Platools\n'
        'platools = Platools()\n'
        '\n'
        '@platools.tool()\n'
        'def echo(text: str) -> str:\n'
        '    """Echo the input.\n'
        '\n'
        '    Args:\n'
        '        text: The text to echo.\n'
        '    """\n'
        '    return text\n'
    )
    sys.path.insert(0, str(tmp_path))
    try:
        from platools.doctor.types import DoctorReport, Finding

        def _broken(_reg: Any) -> DoctorReport:
            return DoctorReport(
                tool_count=1,
                findings=[
                    Finding(
                        severity="error",
                        code="synthetic",
                        message="broken for test",
                    )
                ],
            )

        import platools.cli.serve as serve_mod

        monkeypatch.setattr(serve_mod, "analyze_registry", _broken)

        out = io.StringIO()
        err = io.StringIO()
        code = run_serve(
            module_path="clean_tools", out=out, err=err
        )
        assert code == 1
        assert "doctor" in err.getvalue().lower()
    finally:
        sys.path.remove(str(tmp_path))
        sys.modules.pop("clean_tools", None)


def test_cli_unknown_tool_allowlist_returns_exit_2(tmp_path: Any) -> None:
    mod_path = tmp_path / "one_tool.py"
    mod_path.write_text(
        'from platools import Platools\n'
        'platools = Platools()\n'
        '\n'
        '@platools.tool()\n'
        'def echo(text: str) -> str:\n'
        '    """Echo.\n'
        '\n'
        '    Args:\n'
        '        text: The text.\n'
        '    """\n'
        '    return text\n'
    )
    sys.path.insert(0, str(tmp_path))
    try:
        out = io.StringIO()
        err = io.StringIO()
        code = run_serve(
            module_path="one_tool",
            allowed_tools=["echo", "does_not_exist"],
            out=out,
            err=err,
        )
        assert code == 2
        assert "does_not_exist" in err.getvalue()
    finally:
        sys.path.remove(str(tmp_path))
        sys.modules.pop("one_tool", None)


def test_cli_http_mode_requires_token(tmp_path: Any) -> None:
    mod_path = tmp_path / "http_tools.py"
    mod_path.write_text(
        'from platools import Platools\n'
        'platools = Platools()\n'
        '\n'
        '@platools.tool()\n'
        'def ping() -> str:\n'
        '    """Return pong."""\n'
        '    return "pong"\n'
    )
    sys.path.insert(0, str(tmp_path))
    try:
        out = io.StringIO()
        err = io.StringIO()
        code = run_serve(
            module_path="http_tools",
            transport="http",
            out=out,
            err=err,
        )
        assert code == 1
        assert "token" in err.getvalue().lower()
    finally:
        sys.path.remove(str(tmp_path))
        sys.modules.pop("http_tools", None)


def test_cli_main_wires_serve_subcommand(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """``platools serve --help`` via the top-level CLI dispatcher must
    reach the serve subcommand rather than the legacy placeholder.
    """
    with pytest.raises(SystemExit) as exc:
        cli_main(["serve", "--help"])
    assert exc.value.code == 0
    captured = capsys.readouterr()
    assert "platools serve" in captured.out


def test_cli_serve_command_argparse_defaults(tmp_path: Any) -> None:
    """Invoking ``serve_command`` with a populated module should
    proceed far enough to enter the stdio path. We don't actually
    want to hand it a real stdin, so we check the ``--list`` path
    end-to-end instead.
    """
    mod_path = tmp_path / "listable.py"
    mod_path.write_text(
        'from platools import Platools\n'
        'platools = Platools()\n'
        '\n'
        '@platools.tool()\n'
        'def hello() -> str:\n'
        '    """Say hi."""\n'
        '    return "hi"\n'
    )
    sys.path.insert(0, str(tmp_path))
    try:
        # Redirect stdout via monkeypatched sys.stdout — serve_command
        # uses run_serve which defaults to sys.stdout.
        captured = io.StringIO()
        old = sys.stdout
        sys.stdout = captured
        try:
            code = serve_command(["--module", "listable", "--list"])
        finally:
            sys.stdout = old
        assert code == 0
        assert "hello" in captured.getvalue()
    finally:
        sys.path.remove(str(tmp_path))
        sys.modules.pop("listable", None)
