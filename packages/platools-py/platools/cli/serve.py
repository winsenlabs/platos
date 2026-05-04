"""`platools serve` CLI command — PLATOS-41.

Spins up a local MCP server from the user's tool registry:

    platools serve                                   # stdio transport
    platools serve --module my_app.tools             # explicit module
    platools serve --http --port 3001 \
                   --auth-token my-secret            # HTTP transport
    platools serve --list                            # print tools, exit 0
    platools serve --tool process_refund \
                   --tool cancel_order               # allowlist

Behavior rules drawn from `CLAUDE.md` + PRD §5.1:

  - Tool discovery mirrors ``platools doctor`` / ``platools test``:
    scan an imported module for ``Platools`` instances, merge their
    registries into a composite. Zero tools → refuse to start (a
    stdio server with no tools is almost always a typo in the
    ``--module`` flag).
  - ``platools doctor`` is run against the composite registry before
    the transport starts. Any error-severity finding aborts the
    start with exit code 1 — a broken tool surface should never be
    silently exposed over MCP.
  - HTTP transport requires a bearer token (``--auth-token`` or
    ``PLATOOLS_SERVE_TOKEN``). Stdio transport is trusted-by-parent-
    process and carries no token (see ``serve/http.py`` docstring).
  - ``--list`` and ``--tool`` validate names against the live
    registry — a typo fails loudly at startup, not silently at
    ``tools/list`` time.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import os
import sys
from collections.abc import Sequence
from typing import Literal, TextIO

from platools.core.registry import ToolRegistry
from platools.doctor import analyze_registry, format_report
from platools.serve.dispatcher import JsonRpcDispatcher, build_tool_filter
from platools.serve.http import DEFAULT_HOST, DEFAULT_PORT, HttpServerConfig, run_http
from platools.serve.stdio import run_stdio

Transport = Literal["stdio", "http"]
"""Supported ``--transport`` values. Keeping this a closed ``Literal``
lets callers / tests catch typos at the type-checker instead of at
runtime where the only feedback is an exit-2 error line."""

_AUTH_TOKEN_ENV = "PLATOOLS_SERVE_TOKEN"


def _load_registry(module_path: str | None) -> ToolRegistry:
    """Mirror of ``cli.doctor._load_registry`` — scan a module for
    ``Platools`` instances and merge their registries.

    Kept as its own helper (rather than imported from the doctor
    module) so ``cli.serve`` has no runtime dependency on the doctor
    CLI layer, only on the pure-library ``platools.doctor`` analyzer.
    """
    from platools import Platools

    composite = ToolRegistry()
    if not module_path:
        return composite
    module = importlib.import_module(module_path)
    for attr_name in dir(module):
        attr = getattr(module, attr_name, None)
        if isinstance(attr, Platools):
            for tool in attr.registry.all():
                if tool.name not in composite:
                    composite.register(tool)
    return composite


def _format_list(registry: ToolRegistry, *, visible_names: set[str] | None) -> str:
    """Render a human-readable tool listing for ``--list`` mode.

    ``visible_names=None`` means "no allowlist — everything is
    visible"; otherwise tools not in the set are annotated as
    ``(filtered)`` so the developer can see what their ``--tool``
    flags excluded without re-running the command.
    """
    tools = registry.all()
    if not tools:
        return "No tools registered.\n"
    lines = [f"Tools: {len(tools)} registered"]
    for tool in sorted(tools, key=lambda t: t.name):
        marker = ""
        if visible_names is not None and tool.name not in visible_names:
            marker = "  (filtered)"
        desc_first_line = (tool.description or "").strip().splitlines()
        first = desc_first_line[0] if desc_first_line else ""
        lines.append(f"  - {tool.name}{marker}  {first}".rstrip())
    return "\n".join(lines) + "\n"


def _run_doctor_gate(registry: ToolRegistry, err: TextIO) -> bool:
    """Run the doctor analyzer and refuse to start on any error.

    Returns True when doctor is clean enough to proceed, False when
    the caller should abort. Warnings and infos are shown to stderr
    but do not block startup — matching the CLI's existing policy.
    """
    report = analyze_registry(registry)
    if report.has_errors():
        err.write("platools serve: refusing to start — doctor reported errors:\n")
        err.write(format_report(report))
        return False
    # Surface non-blocking findings so the operator knows about them
    # but doesn't have to opt in. Silent success on a registry with
    # warnings is a trap.
    if report.warnings() or report.infos():
        err.write(format_report(report))
    return True


def run_serve(
    *,
    module_path: str | None = None,
    transport: Transport = "stdio",
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    auth_token: str | None = None,
    allowed_tools: Sequence[str] | None = None,
    list_only: bool = False,
    out: TextIO | None = None,
    err: TextIO | None = None,
    stop_event: asyncio.Event | None = None,
    http_ready_event: asyncio.Event | None = None,
) -> int:
    """Programmatic entry point for ``platools serve``.

    Split from the argparse front-end so tests can drive it without
    spawning a subprocess. Returns the process exit code: ``0`` on a
    clean shutdown, ``1`` on a startup refusal (empty registry, doctor
    errors, bad config), ``2`` on argument errors (matching
    ``argparse``).
    """
    sink: TextIO = out if out is not None else sys.stdout
    errsink: TextIO = err if err is not None else sys.stderr

    registry = _load_registry(module_path)

    # Build the filter BEFORE --list rendering so --list can show
    # which tools are filtered under the current flags.
    try:
        tool_filter = build_tool_filter(registry, allowed=allowed_tools)
    except ValueError as exc:
        errsink.write(f"platools serve: {exc}\n")
        return 2

    visible_names: set[str] | None = (
        None if tool_filter.allow_all else set(tool_filter.names)
    )

    if list_only:
        sink.write(_format_list(registry, visible_names=visible_names))
        return 0

    if len(registry) == 0:
        errsink.write(
            "platools serve: no tools registered. "
            "Pass --module to import your tool module, "
            "e.g. `platools serve --module my_app.tools`.\n"
        )
        return 1

    if not _run_doctor_gate(registry, errsink):
        return 1

    # Stdio is parent-process-trust: expose tracebacks to speed up
    # local debugging. HTTP mode is remote-capable even with a bearer
    # token, so the dispatcher scrubs tracebacks there to avoid
    # leaking filesystem paths or local-variable fragments.
    dispatcher = JsonRpcDispatcher(
        registry,
        tool_filter=tool_filter,
        include_traceback=(transport == "stdio"),
    )

    if transport == "stdio":
        asyncio.run(run_stdio(dispatcher, stop_event=stop_event))
        return 0

    # HTTP mode MUST have a token. The dataclass' __post_init__
    # raises if it's empty, but we format the error before it
    # reaches the user so they see a clean CLI-style message
    # instead of a pydantic-flavored stack trace.
    resolved_token = auth_token or os.environ.get(_AUTH_TOKEN_ENV, "")
    if not resolved_token:
        errsink.write(
            "platools serve: --http mode requires a bearer token. "
            "Pass --auth-token or set $PLATOOLS_SERVE_TOKEN.\n"
        )
        return 1
    try:
        config = HttpServerConfig(
            host=host,
            port=port,
            auth_token=resolved_token,
        )
    except ValueError as exc:
        errsink.write(f"platools serve: invalid http config — {exc}\n")
        return 1
    errsink.write(
        f"platools serve: listening on http://{config.host}:{config.port}{config.path} "
        f"({len(dispatcher.visible_tools())} tools)\n"
    )
    asyncio.run(
        run_http(
            dispatcher,
            config,
            ready_event=http_ready_event,
            stop_event=stop_event,
        )
    )
    return 0


def serve_command(argv: Sequence[str] | None = None) -> int:
    """``platools serve`` argparse front-end.

    Stdlib argparse (no click / typer) so the SDK wheel stays
    dependency-free at the CLI layer — same policy as ``platools
    doctor`` / ``platools test``.
    """
    parser = argparse.ArgumentParser(
        prog="platools serve",
        description="Run a local MCP server from the decorated tool "
        "registry (PLATOS-41).",
    )
    parser.add_argument(
        "--module",
        default=None,
        help="Dotted module path to import before serving (e.g. "
        "`my_app.tools`). Loads the @platools.tool() decorators by "
        "side-effect into the global registry.",
    )
    transport_group = parser.add_mutually_exclusive_group()
    transport_group.add_argument(
        "--stdio",
        dest="transport",
        action="store_const",
        const="stdio",
        help="Use stdio transport (default). For Claude Desktop, Cursor, "
        "and other MCP clients that launch servers as subprocesses.",
    )
    transport_group.add_argument(
        "--http",
        dest="transport",
        action="store_const",
        const="http",
        help="Use HTTP transport. Requires --auth-token or $PLATOOLS_SERVE_TOKEN.",
    )
    parser.set_defaults(transport="stdio")
    parser.add_argument(
        "--host",
        default=DEFAULT_HOST,
        help=f"HTTP bind host (default: {DEFAULT_HOST}).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help=f"HTTP bind port (default: {DEFAULT_PORT}).",
    )
    parser.add_argument(
        "--auth-token",
        default=None,
        help="Bearer token for HTTP mode. Falls back to $PLATOOLS_SERVE_TOKEN.",
    )
    parser.add_argument(
        "--tool",
        dest="tools",
        action="append",
        default=None,
        help="Only expose the named tool (repeatable). Default: expose all.",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="Print the registered tools and exit without starting a server.",
    )
    args = parser.parse_args(argv)
    # argparse gives us a plain ``str``; narrow it to the Literal so
    # ``run_serve`` stays strictly typed and a future mistyped default
    # fails at the call site instead of in a generic exit-2 branch.
    raw_transport = args.transport
    if raw_transport not in ("stdio", "http"):
        sys.stderr.write(
            f"platools serve: unknown transport {raw_transport!r}\n"
        )
        return 2
    transport: Transport = raw_transport
    return run_serve(
        module_path=args.module,
        transport=transport,
        host=args.host,
        port=args.port,
        auth_token=args.auth_token,
        allowed_tools=args.tools,
        list_only=args.list,
    )
