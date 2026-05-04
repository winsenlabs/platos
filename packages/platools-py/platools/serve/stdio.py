"""Stdio transport for `platools serve` (PLATOS-41).

MCP stdio transport framing:

  - The client writes one JSON-RPC request per line to the server's
    stdin (``\\n``-delimited). Each line is a complete JSON object.
  - The server writes one JSON-RPC response per line to stdout,
    ``\\n``-delimited, in the same order.
  - Logs and diagnostics go to **stderr**. Stdout is reserved for
    protocol frames; any stray print() to stdout corrupts the stream.

This transport is what Claude Desktop / Cursor / Codeium use when you
point an MCP client at a local executable — the client spawns
``platools serve`` as a subprocess and the stdio file descriptors
become the protocol channel. Trust is by parent-process identity
(whoever spawned the subprocess is trusted), which is why there is no
auth in stdio mode. HTTP mode carries a bearer token instead.

We use ``asyncio.StreamReader`` so the event loop stays free while we
wait for the next line. Sync ``sys.stdin.readline()`` would block the
loop and starve concurrent tool calls. The transport dispatches each
frame into an independent ``asyncio.Task`` so a slow tool can't
stall the read loop — the next request starts processing as soon as
its line is available.

Concurrency rule: every write to stdout is protected by a single
``asyncio.Lock`` because concurrent ``asyncio.Task``s may finish in
any order. Without the lock, two tool responses could interleave mid
-line and produce corrupt JSON on the wire.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from typing import TextIO

from pydantic import ValidationError

from platools.serve.dispatcher import JsonRpcDispatcher
from platools.serve.jsonrpc import (
    INTERNAL_ERROR,
    INVALID_REQUEST,
    PARSE_ERROR,
    JsonRpcRequest,
    JsonRpcResponse,
)

log = logging.getLogger("platools.serve.stdio")


async def run_stdio(
    dispatcher: JsonRpcDispatcher,
    *,
    stdin: asyncio.StreamReader | None = None,
    stdout: TextIO | None = None,
    stop_event: asyncio.Event | None = None,
) -> None:
    """Run the stdio transport until EOF or ``stop_event`` fires.

    Parameters mirror the test harness' injection points — defaults
    target real process stdin/stdout. ``stop_event`` lets a
    host process signal shutdown cleanly (e.g. from a SIGINT handler)
    without killing the whole loop.
    """
    reader = stdin if stdin is not None else await _connect_stdin_reader()
    out = stdout if stdout is not None else sys.stdout
    write_lock = asyncio.Lock()
    stopper = stop_event or asyncio.Event()
    pending: set[asyncio.Task[None]] = set()

    try:
        while not stopper.is_set():
            line_task = asyncio.create_task(reader.readline())
            stop_task = asyncio.create_task(stopper.wait())
            done, _ = await asyncio.wait(
                {line_task, stop_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if stop_task in done and line_task not in done:
                line_task.cancel()
                break
            stop_task.cancel()

            line = line_task.result()
            if not line:
                # EOF — the parent process closed its end of the pipe.
                break
            stripped = line.strip()
            if not stripped:
                # Blank line — ignore rather than surfacing a parse
                # error. Some stdio clients write a trailing newline
                # after EOF and we don't want to spam the stderr log.
                continue

            task = asyncio.create_task(
                _handle_line(stripped, dispatcher, out, write_lock)
            )
            pending.add(task)
            task.add_done_callback(pending.discard)
    finally:
        # Give in-flight tool calls a chance to finish so we never
        # silently drop a response. If the client already disconnected
        # this is a no-op.
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)


async def _connect_stdin_reader() -> asyncio.StreamReader:
    """Wire asyncio up to real process stdin.

    ``asyncio.StreamReader`` needs to be bound to a pipe transport via
    ``loop.connect_read_pipe``. We wrap the descriptor for ``sys.stdin``
    so reads become non-blocking coroutines that play nicely with
    ``asyncio.wait`` in :func:`run_stdio`.
    """
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)
    return reader


async def _handle_line(
    line: bytes,
    dispatcher: JsonRpcDispatcher,
    out: TextIO,
    write_lock: asyncio.Lock,
) -> None:
    """Parse, dispatch, and write a single JSON-RPC frame.

    Each line is processed in its own task so a slow tool never
    blocks the reader. The write lock is held across the
    ``json.dumps`` + ``out.write`` + ``out.flush`` sequence so that
    concurrent responses never interleave mid-line.
    """
    try:
        payload = json.loads(line)
    except json.JSONDecodeError as exc:
        response = JsonRpcResponse.err(
            None,
            code=PARSE_ERROR,
            message=f"invalid JSON: {exc}",
        )
        await _write_response(out, write_lock, response)
        return

    try:
        request = JsonRpcRequest.model_validate(payload)
    except ValidationError as exc:
        # Best-effort: if the payload at least had an id, echo it back
        # so the client can correlate the failure to its original call.
        request_id = None
        if isinstance(payload, dict):
            raw_id = payload.get("id")
            if isinstance(raw_id, (str, int)):
                request_id = raw_id
        response = JsonRpcResponse.err(
            request_id,
            code=INVALID_REQUEST,
            message=f"invalid JSON-RPC request: {exc.errors()[0]['msg']}",
        )
        await _write_response(out, write_lock, response)
        return

    dispatched: JsonRpcResponse | None
    try:
        dispatched = await dispatcher.handle_request(request)
    except Exception as exc:  # noqa: BLE001
        # Defensive: the dispatcher already catches tool errors and
        # wraps them in ``CallToolResult``. Anything that reaches here
        # is a bug in the dispatcher itself — surface it as a JSON-RPC
        # internal-error instead of crashing the stdio loop.
        log.exception("platools serve dispatcher crashed")
        dispatched = JsonRpcResponse.err(
            request.id,
            code=INTERNAL_ERROR,
            message=f"internal dispatcher error: {exc}",
        )

    if dispatched is None:
        # Notification — no response body. Don't write anything.
        return
    await _write_response(out, write_lock, dispatched)


async def _write_response(
    out: TextIO,
    write_lock: asyncio.Lock,
    response: JsonRpcResponse,
) -> None:
    """Serialize and write a response under the shared stdout lock.

    ``BrokenPipeError`` / ``ValueError`` (on a closed stream) are
    swallowed: the parent process hung up mid-call, so there's no one
    left to deliver the response to. Re-raising would crash the stdio
    loop while it's still trying to drain in-flight tasks during
    shutdown — silently giving up on the write is the correct behavior
    at that point.
    """
    payload = json.dumps(response.to_wire(), separators=(",", ":"))
    async with write_lock:
        try:
            out.write(payload + "\n")
            out.flush()
        except (BrokenPipeError, ValueError) as exc:
            log.info("platools serve stdio: dropped response on closed pipe: %s", exc)
