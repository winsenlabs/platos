"""HTTP transport for `platools serve` (PLATOS-41).

Minimal HTTP/1.1 JSON-RPC server built on ``asyncio.start_server`` —
no third-party web framework, no new wheels on the SDK. The
Streamable HTTP transport in the MCP spec is "POST a JSON-RPC body,
get a JSON-RPC body back" for non-streaming methods, which is all
PLATOS-41 needs (``initialize``, ``tools/list``, ``tools/call`` are
all single request/response; streaming progress updates land with
PLATOS-28 + Phase I).

Why stdlib asyncio instead of ``aiohttp`` / ``starlette``?

  - The SDK is a laptop/install-from-PyPI product; every new runtime
    dep is one more wheel on every consumer's installer. Adding a
    full web framework for one POST endpoint is a bad trade.
  - The three HTTP features we actually need (POST with JSON body,
    Authorization header parsing, JSON body response) fit in ~150
    lines of asyncio.
  - Existing SDK deps already cover JSON + Pydantic; nothing else is
    required.

Security model (PRD §9):

  - A bearer token is **mandatory** for HTTP mode. Construction of
    :class:`HttpServerConfig` raises if ``auth_token`` is empty and
    the CLI refuses to start — no silent "zero-auth" fallback.
  - Token comparison uses ``hmac.compare_digest`` so a malicious
    client can't time-string-compare their way to the real token.
  - The server binds to ``127.0.0.1`` by default. Binding to
    ``0.0.0.0`` is allowed but forces the caller to be explicit
    about exposing the dev server on the network.
  - Requests larger than ``max_body_bytes`` (default 1 MiB) are
    rejected with a 413 before we read them into memory — protects
    against a misbehaving client trying to OOM the dev server.
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import logging
from dataclasses import dataclass

from pydantic import ValidationError

from platools.serve.dispatcher import JsonRpcDispatcher
from platools.serve.jsonrpc import (
    INTERNAL_ERROR,
    INVALID_REQUEST,
    PARSE_ERROR,
    JsonRpcRequest,
    JsonRpcResponse,
)

log = logging.getLogger("platools.serve.http")

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 3001
DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024  # 1 MiB
DEFAULT_READ_TIMEOUT_SECONDS = 30.0
# The MCP Streamable HTTP spec lands JSON-RPC bodies under a single
# POST endpoint. Any path works — the spec doesn't mandate ``/mcp`` —
# but we expose ``/mcp`` so it's obvious what the port serves.
MCP_PATH = "/mcp"


@dataclass(frozen=True)
class HttpServerConfig:
    """Validated config for the HTTP transport.

    Constructed from CLI flags / env vars in ``cli/serve.py`` and
    handed to :func:`run_http`. Keeping it immutable means the
    handler can close over it without worrying about mid-flight
    mutation; reading a misconfigured server from a test is a single
    constructor call.
    """

    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    auth_token: str = ""
    max_body_bytes: int = DEFAULT_MAX_BODY_BYTES
    read_timeout_seconds: float = DEFAULT_READ_TIMEOUT_SECONDS
    path: str = MCP_PATH

    def __post_init__(self) -> None:
        if not self.auth_token:
            raise ValueError(
                "HTTP transport requires a non-empty auth_token — "
                "pass --auth-token or set PLATOOLS_SERVE_TOKEN"
            )
        if not self.host:
            # An empty string binds to all interfaces under asyncio —
            # that would silently turn --host "" into "--host 0.0.0.0"
            # which is the opposite of the loopback-by-default posture.
            raise ValueError("host must be a non-empty string")
        if self.port <= 0 or self.port > 65535:
            raise ValueError(f"invalid port: {self.port}")
        if self.max_body_bytes <= 0:
            raise ValueError("max_body_bytes must be positive")
        if self.read_timeout_seconds <= 0:
            raise ValueError("read_timeout_seconds must be positive")
        if not self.path.startswith("/"):
            raise ValueError("path must start with '/'")


async def run_http(
    dispatcher: JsonRpcDispatcher,
    config: HttpServerConfig,
    *,
    ready_event: asyncio.Event | None = None,
    stop_event: asyncio.Event | None = None,
) -> None:
    """Run the HTTP transport until ``stop_event`` fires.

    The server binds to ``(config.host, config.port)`` and handles
    one client at a time per connection (keep-alive is disabled — the
    dev server is not a production target, and connection-per-request
    keeps the code straight). ``ready_event`` is set once the socket
    is bound so tests can wait for the port to be live before sending
    traffic.
    """

    async def _client_cb(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            await _handle_connection(reader, writer, dispatcher, config)
        except Exception:  # noqa: BLE001
            # Never let a single bad client kill the server. Log and
            # move on — the next request gets a fresh connection.
            log.exception("platools serve http: client handler crashed")
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:  # noqa: BLE001
                pass

    server = await asyncio.start_server(_client_cb, config.host, config.port)
    if ready_event is not None:
        ready_event.set()
    try:
        async with server:
            if stop_event is None:
                await server.serve_forever()
            else:
                serve_task = asyncio.create_task(server.serve_forever())
                stop_task = asyncio.create_task(stop_event.wait())
                done, _pending = await asyncio.wait(
                    {serve_task, stop_task},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if stop_task in done:
                    serve_task.cancel()
                    # Draining the cancelled task has no useful work
                    # left — suppress both the expected ``CancelledError``
                    # and any residual ``serve_forever`` exception so the
                    # shutdown path stays clean.
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await serve_task
    finally:
        server.close()
        await server.wait_closed()


# ---- HTTP/1.1 parser ------------------------------------------------------


@dataclass(frozen=True)
class _HttpRequest:
    method: str
    target: str
    headers: dict[str, str]
    body: bytes


async def _handle_connection(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    dispatcher: JsonRpcDispatcher,
    config: HttpServerConfig,
) -> None:
    """Handle a single HTTP/1.1 request on one TCP connection.

    Connection-per-request (no keep-alive) intentionally: simplicity
    for a dev server, and HTTP clients that don't reuse connections
    still work because every response sets ``Connection: close``.
    """
    try:
        req = await asyncio.wait_for(
            _read_request(reader, config),
            timeout=config.read_timeout_seconds,
        )
    except TimeoutError:
        await _write_plain(writer, 408, "Request Timeout", "request read timed out")
        return
    except _HttpError as exc:
        await _write_plain(writer, exc.status, exc.reason, exc.message)
        return

    # Method routing — only POST is meaningful for the MCP JSON-RPC
    # endpoint. Everything else gets a 405 with an ``Allow`` header so
    # the client can correct its request.
    if req.method != "POST":
        await _write_plain(
            writer,
            405,
            "Method Not Allowed",
            f"only POST is supported, got {req.method}",
            extra_headers={"Allow": "POST"},
        )
        return

    if _target_path(req.target) != config.path:
        await _write_plain(
            writer,
            404,
            "Not Found",
            f"unknown path {req.target!r}, expected {config.path}",
        )
        return

    if not _check_auth(req.headers, config.auth_token):
        # 401 with WWW-Authenticate so a compliant client at least
        # knows how it should retry. We do NOT echo the expected
        # token value in the body — helps avoid accidental log leaks.
        await _write_plain(
            writer,
            401,
            "Unauthorized",
            "missing or invalid bearer token",
            extra_headers={"WWW-Authenticate": 'Bearer realm="platools-serve"'},
        )
        return

    # Extract Platos-injected headers that don't live in the body.
    # X-Platos-Entity-Token carries the entity-issued OIDC access token
    # forwarded by the platform on behalf of authenticated MCP users.
    # It merges into the __platos envelope so current_entity_token() works.
    extra_envelope: dict[str, str] | None = None
    entity_token_header = req.headers.get("x-platos-entity-token")
    if entity_token_header:
        extra_envelope = {"entityToken": entity_token_header}

    # Parse the JSON-RPC envelope. A parse error returns a JSON-RPC
    # error body (not an HTTP 400) because the client already passed
    # auth — this is protocol-level, not transport-level.
    response = await _dispatch_body(req.body, dispatcher, extra_envelope=extra_envelope)
    if response is None:
        # Notification — HTTP 204 per the Streamable HTTP spec guidance
        # for no-body responses.
        await _write_empty(writer, 204, "No Content")
        return

    body_bytes = json.dumps(response.to_wire(), separators=(",", ":")).encode("utf-8")
    await _write_json(writer, 200, "OK", body_bytes)


async def _dispatch_body(
    body: bytes,
    dispatcher: JsonRpcDispatcher,
    *,
    extra_envelope: dict[str, str] | None = None,
) -> JsonRpcResponse | None:
    try:
        payload = json.loads(body.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        return JsonRpcResponse.err(
            None,
            code=PARSE_ERROR,
            message=f"invalid JSON: {exc}",
        )

    try:
        request = JsonRpcRequest.model_validate(payload)
    except ValidationError as exc:
        request_id = None
        if isinstance(payload, dict):
            raw_id = payload.get("id")
            if isinstance(raw_id, (str, int)):
                request_id = raw_id
        return JsonRpcResponse.err(
            request_id,
            code=INVALID_REQUEST,
            message=f"invalid JSON-RPC request: {exc.errors()[0]['msg']}",
        )

    try:
        return await dispatcher.handle_request(request, extra_envelope=extra_envelope)
    except Exception as exc:  # noqa: BLE001
        log.exception("platools serve http: dispatcher crashed")
        return JsonRpcResponse.err(
            request.id,
            code=INTERNAL_ERROR,
            message=f"internal dispatcher error: {exc}",
        )


class _HttpError(Exception):
    """Internal signal for HTTP-level failures during request parsing."""

    def __init__(self, status: int, reason: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.reason = reason
        self.message = message


async def _read_request(
    reader: asyncio.StreamReader, config: HttpServerConfig
) -> _HttpRequest:
    """Parse a single HTTP/1.1 request off the wire.

    This parser is deliberately narrow: it implements exactly the
    subset the dev server needs (POST, ``Content-Length``-framed body,
    lower-cased header lookup) and rejects anything it doesn't
    understand with an explicit ``_HttpError``. Chunked transfer
    encoding is not supported — clients that need it should use a
    real web server.
    """
    request_line = await reader.readline()
    if not request_line:
        raise _HttpError(400, "Bad Request", "empty request line")
    try:
        method, target, version = request_line.decode("ascii").strip().split(" ", 2)
    except ValueError as exc:
        raise _HttpError(400, "Bad Request", f"malformed request line: {exc}") from exc
    if not version.startswith("HTTP/1."):
        raise _HttpError(505, "HTTP Version Not Supported", version)

    headers: dict[str, str] = {}
    while True:
        line = await reader.readline()
        if not line or line in (b"\r\n", b"\n"):
            break
        try:
            name, _, value = line.decode("iso-8859-1").partition(":")
        except UnicodeDecodeError as exc:
            raise _HttpError(400, "Bad Request", f"invalid header: {exc}") from exc
        if not name or not _ or len(headers) >= 100:
            raise _HttpError(400, "Bad Request", "invalid header line")
        headers[name.strip().lower()] = value.strip()

    body = b""
    content_length_raw = headers.get("content-length")
    if content_length_raw is not None:
        try:
            content_length = int(content_length_raw)
        except ValueError as exc:
            raise _HttpError(400, "Bad Request", f"invalid Content-Length: {exc}") from exc
        if content_length < 0:
            raise _HttpError(400, "Bad Request", "negative Content-Length")
        if content_length > config.max_body_bytes:
            raise _HttpError(413, "Payload Too Large", "request body exceeds max_body_bytes")
        if content_length > 0:
            body = await reader.readexactly(content_length)
    elif "transfer-encoding" in headers:
        # Chunked is explicitly not supported — the dev server speaks
        # a narrow subset of HTTP/1.1 on purpose.
        raise _HttpError(
            411,
            "Length Required",
            "chunked transfer-encoding not supported; include Content-Length",
        )

    return _HttpRequest(method=method, target=target, headers=headers, body=body)


def _target_path(target: str) -> str:
    """Strip the query string from an HTTP request target."""
    q = target.find("?")
    return target if q < 0 else target[:q]


def _check_auth(headers: dict[str, str], expected_token: str) -> bool:
    """Constant-time bearer-token check.

    Accepts ``Authorization: Bearer <token>`` (case-insensitive scheme).
    Missing header or wrong scheme fails closed. ``hmac.compare_digest``
    stops an attacker from timing-comparing their way to the secret.
    """
    header = headers.get("authorization")
    if not header:
        return False
    parts = header.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return False
    return hmac.compare_digest(parts[1], expected_token)


# ---- HTTP response writers -----------------------------------------------

_CRLF = "\r\n"


async def _write_plain(
    writer: asyncio.StreamWriter,
    status: int,
    reason: str,
    message: str,
    *,
    extra_headers: dict[str, str] | None = None,
) -> None:
    body = (message + "\n").encode("utf-8")
    headers = {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": str(len(body)),
        "Connection": "close",
    }
    if extra_headers:
        headers.update(extra_headers)
    await _write_raw(writer, status, reason, headers, body)


async def _write_json(
    writer: asyncio.StreamWriter,
    status: int,
    reason: str,
    body: bytes,
) -> None:
    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": str(len(body)),
        "Connection": "close",
    }
    await _write_raw(writer, status, reason, headers, body)


async def _write_empty(
    writer: asyncio.StreamWriter,
    status: int,
    reason: str,
) -> None:
    await _write_raw(writer, status, reason, {"Connection": "close", "Content-Length": "0"}, b"")


async def _write_raw(
    writer: asyncio.StreamWriter,
    status: int,
    reason: str,
    headers: dict[str, str],
    body: bytes,
) -> None:
    status_line: str = f"HTTP/1.1 {status} {reason}{_CRLF}"
    out: list[str] = [status_line]
    for key, value in headers.items():
        out.append(f"{key}: {value}{_CRLF}")
    out.append(_CRLF)
    writer.write("".join(out).encode("iso-8859-1"))
    if body:
        writer.write(body)
    await writer.drain()
