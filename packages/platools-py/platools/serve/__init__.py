"""`platools serve` — local MCP server mode (PLATOS-41).

Stands up a JSON-RPC 2.0 MCP server that exposes every
`@platools.tool()`-decorated function in the calling process, without
connecting to the Platos platform. Two transports are supported:

  - **stdio** — default. Reads JSON-RPC frames from stdin, writes
    responses to stdout. This is the shape Claude Desktop / Cursor /
    Codeium launch MCP servers as: the client spawns `platools serve`
    as a subprocess and pipes JSON-RPC over its standard streams.

  - **http** — optional, enabled with `--http`. Serves the same
    JSON-RPC envelope over HTTP POST for web-based clients. Requires
    a bearer token (via `--auth-token` or the `PLATOOLS_SERVE_TOKEN`
    env var) — stdio has trust-by-parent-process semantics; HTTP must
    authenticate per PRD §9.

The protocol implementation is deliberately kept parallel to
`apps/api/platos/gateway/mcp_server.py` so a client that can talk to
the Platos platform's MCP gateway can also talk to `platools serve`
with no changes: same JSON-RPC methods, same error codes, same
`InitializeResult` / `Tool` / `CallToolResult` shapes.

Public surface:

  - :class:`JsonRpcDispatcher` — in-process dispatcher bound to a
    :class:`platools.core.registry.ToolRegistry`. Useful for tests
    and for anyone who wants to embed `serve` mode in their own host.
  - :func:`run_stdio` — async entry point for the stdio transport.
  - :func:`run_http` — async entry point for the HTTP transport.
"""

from platools.serve.dispatcher import (
    SERVER_CAPABILITIES,
    SERVER_INFO,
    JsonRpcDispatcher,
    build_tool_filter,
)
from platools.serve.http import run_http
from platools.serve.jsonrpc import (
    INTERNAL_ERROR,
    INVALID_PARAMS,
    INVALID_REQUEST,
    MCP_PROTOCOL_VERSION,
    METHOD_NOT_FOUND,
    PARSE_ERROR,
    TOOL_EXECUTION_ERROR,
    JsonRpcErrorBody,
    JsonRpcRequest,
    JsonRpcResponse,
)
from platools.serve.stdio import run_stdio

__all__ = [
    "INTERNAL_ERROR",
    "INVALID_PARAMS",
    "INVALID_REQUEST",
    "JsonRpcDispatcher",
    "JsonRpcErrorBody",
    "JsonRpcRequest",
    "JsonRpcResponse",
    "MCP_PROTOCOL_VERSION",
    "METHOD_NOT_FOUND",
    "PARSE_ERROR",
    "SERVER_CAPABILITIES",
    "SERVER_INFO",
    "TOOL_EXECUTION_ERROR",
    "build_tool_filter",
    "run_http",
    "run_stdio",
]
