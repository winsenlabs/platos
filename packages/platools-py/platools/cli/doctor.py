"""`platools doctor` CLI command — PLATOS-18.

Usage:

    platools doctor                       # local introspection
    platools doctor my_app.tools          # explicit module to load
    platools doctor --json                # machine-readable output

Loads tool definitions either from an explicit Python module path
(`my_app.tools` — same convention pytest uses for `--rootdir`) or
from the calling-process registry. The platform-fetch path
(`--platform-url`) is documented in the spec but lands with the
admin-tooling task; the local path is the ship gate Phase D needs.

Exit code:
  - 0 if there are no `error`-severity findings
  - 1 if any error finding is present (CI-friendly)
"""

from __future__ import annotations

import argparse
import importlib
import json
import sys
from collections.abc import Sequence
from typing import TextIO

from platools.core.registry import ToolRegistry
from platools.doctor import analyze_registry, format_report
from platools.doctor.types import DoctorReport
from platools.types import ToolDef


def _load_registry(module_path: str | None) -> ToolRegistry:
    """Build a unified `ToolRegistry` from a user-provided module path.

    SDK consumers structure their app like this:

        # my_app/tools.py
        from platools import Platools
        platools = Platools()

        @platools.tool()
        def list_orders(): ...

    `platools doctor my_app.tools` imports that module and scans its
    top-level attributes for `Platools` instances; the registries on
    each instance are merged into a fresh composite registry the
    analyzer can walk. No `Platools` instances → empty registry, which
    surfaces as "Tools: 0 registered" in the report.
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


def _report_to_json(report: DoctorReport) -> str:
    return json.dumps(
        {
            "tool_count": report.tool_count,
            "errors": [
                {
                    "code": f.code,
                    "message": f.message,
                    "tool": f.tool,
                    "param": f.param,
                }
                for f in report.errors()
            ],
            "warnings": [
                {
                    "code": f.code,
                    "message": f.message,
                    "tool": f.tool,
                    "param": f.param,
                }
                for f in report.warnings()
            ],
            "info": [
                {
                    "code": f.code,
                    "message": f.message,
                    "tool": f.tool,
                    "param": f.param,
                }
                for f in report.infos()
            ],
        },
        indent=2,
    )


def run_doctor(
    *,
    module_path: str | None = None,
    output_json: bool = False,
    out: TextIO | None = None,
) -> int:
    """Programmatic entry point — used by both the CLI and the test suite.

    Returns the process exit code (0 = no errors, 1 = errors present).
    `out` is a text-mode file-like object; defaults to `sys.stdout` so
    the CLI behaves naturally and tests can pass `io.StringIO()` to
    capture output without monkey-patching.
    """
    sink: TextIO = out if out is not None else sys.stdout
    registry = _load_registry(module_path)
    report = analyze_registry(registry)

    if output_json:
        sink.write(_report_to_json(report) + "\n")
    else:
        sink.write(format_report(report))
    return 1 if report.has_errors() else 0


def doctor_command(argv: Sequence[str] | None = None) -> int:
    """`platools doctor` argparse front-end.

    Stdlib argparse instead of click so the SDK doesn't take a third-
    party CLI dep. The flag surface is small enough that argparse is
    fine and the wheel stays light.
    """
    parser = argparse.ArgumentParser(
        prog="platools doctor",
        description="Static tool-graph analyzer for Platools (PLATOS-18).",
    )
    parser.add_argument(
        "module",
        nargs="?",
        help="Optional dotted module path to import before analysis "
        "(e.g. `my_app.tools`). Loads the @platools.tool() decorators "
        "by side-effect into the global registry.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit a machine-readable JSON report instead of the text shape.",
    )
    args = parser.parse_args(argv)
    return run_doctor(module_path=args.module, output_json=args.json)


# Direct programmatic helper used by tests that want to feed an
# explicit list of tools without touching the global registry.
def run_doctor_on_tools(tools: list[ToolDef]) -> DoctorReport:
    """Analyze a pre-loaded list of `ToolDef` and return the report."""
    from platools.doctor import analyze_tools

    return analyze_tools(tools)
