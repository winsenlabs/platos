"""`platools test` CLI command — PLATOS-19.

Usage:

    platools test                                # batch from platools-tests.yaml
    platools test --file my-tests.yaml           # explicit batch file
    platools test process_refund                 # single tool, no params
    platools test process_refund --params '{...}'
    platools test --coverage                     # coverage checklist

Loads the consumer's tools the same way `platools doctor` does — scan
an imported module for `Platools` instances and merge their
registries. Defaults to `platools-tests.yaml` in the current directory
when neither `--file` nor a positional tool name is supplied.

Exit code:
  - 0 if every test case passed
  - 1 if any case failed
  - 2 on argument / file errors (argparse default)
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any, TextIO

from platools.core.registry import ToolRegistry
from platools.testing import (
    BatchResult,
    BatchTestCase,
    TestResult,
    ToolTestRunner,
    coverage_report,
    load_batch_file,
)

_DEFAULT_BATCH_FILE = "platools-tests.yaml"


def _load_registry(module_path: str | None) -> ToolRegistry:
    """Mirror of `cli.doctor._load_registry` — scans an imported
    module for `Platools` instances and merges their registries.
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


def _format_batch(result: BatchResult) -> str:
    lines: list[str] = []
    lines.append(f"Tests: {result.passed} passed, {result.failed} failed")
    if result.cases:
        lines.append(f"Latency: p50 {result.latency_p50:.1f}ms, p95 {result.latency_p95:.1f}ms")
    lines.append("")
    for case in result.cases:
        marker = "✓" if case.passed else "✗"
        line = f"  {marker} {case.tool} ({case.duration_ms:.1f}ms)"
        if case.error:
            line += f" — {case.error}"
        lines.append(line)
    return "\n".join(lines).rstrip() + "\n"


def _format_single(result: TestResult) -> str:
    """Render a single `TestResult` for the no-batch path."""
    marker = "✓" if result.passed else "✗"
    lines = [f"{marker} {result.tool} ({result.duration_ms:.1f}ms)"]
    if result.error:
        lines.append(f"  error: {result.error}")
    elif result.output is not None:
        lines.append(f"  output: {result.output!r}")
    return "\n".join(lines) + "\n"


def _format_coverage(report: dict[str, bool]) -> str:
    lines = [f"Coverage: {sum(report.values())}/{len(report)} tools have at least one test", ""]
    for name in sorted(report):
        marker = "✓" if report[name] else "·"
        lines.append(f"  {marker} {name}")
    return "\n".join(lines).rstrip() + "\n"


def run_test(
    *,
    module_path: str | None = None,
    tool_name: str | None = None,
    params_json: str | None = None,
    batch_file: str | None = None,
    show_coverage: bool = False,
    out: TextIO | None = None,
) -> int:
    """Programmatic entry point for `platools test`. Returns the
    process exit code (0 success, 1 failures present).
    """
    sink: TextIO = out if out is not None else sys.stdout
    registry = _load_registry(module_path)
    runner = ToolTestRunner(registry)

    # Coverage mode is independent of batch / single — it just lists
    # what's covered by the supplied YAML (or by an empty list).
    if show_coverage:
        cases: list[BatchTestCase] = []
        if batch_file:
            cases = load_batch_file(batch_file)
        elif Path(_DEFAULT_BATCH_FILE).exists():
            cases = load_batch_file(_DEFAULT_BATCH_FILE)
        sink.write(_format_coverage(coverage_report(registry, cases)))
        return 0

    # Single-tool mode.
    if tool_name:
        params: dict[str, Any] = {}
        if params_json:
            try:
                parsed = json.loads(params_json)
            except json.JSONDecodeError as exc:
                sink.write(f"Invalid --params JSON: {exc}\n")
                return 2
            if not isinstance(parsed, dict):
                sink.write("--params must decode to a JSON object\n")
                return 2
            params = parsed
        result = runner.run(tool_name, params)
        sink.write(_format_single(result))
        return 0 if result.passed else 1

    # Batch mode (default).
    resolved_batch = batch_file or (
        _DEFAULT_BATCH_FILE if Path(_DEFAULT_BATCH_FILE).exists() else None
    )
    if resolved_batch is None:
        sink.write(
            "No batch file found. Pass `--file path` or create "
            f"`{_DEFAULT_BATCH_FILE}` in the current directory.\n"
        )
        return 2
    cases = load_batch_file(resolved_batch)
    if not cases:
        sink.write(f"{resolved_batch}: no test cases defined\n")
        return 0

    batch = asyncio.run(runner.run_batch(cases))
    sink.write(_format_batch(batch))
    return 0 if batch.failed == 0 else 1


def test_command(argv: Sequence[str] | None = None) -> int:
    """`platools test` argparse front-end."""
    parser = argparse.ArgumentParser(
        prog="platools test",
        description="Run tool tests locally — PLATOS-19.",
    )
    parser.add_argument(
        "tool",
        nargs="?",
        help="Optional tool name. When given, runs that single tool with `--params`.",
    )
    parser.add_argument(
        "--module",
        default=None,
        help="Dotted module path to import before running tests "
        "(loads the @platools.tool() decorators by side-effect).",
    )
    parser.add_argument(
        "--params",
        default=None,
        help="JSON-encoded params dict for single-tool mode.",
    )
    parser.add_argument(
        "--file",
        default=None,
        help="Path to a YAML batch file (default: ./platools-tests.yaml).",
    )
    parser.add_argument(
        "--coverage",
        action="store_true",
        help="Print a coverage checklist instead of running tests.",
    )
    args = parser.parse_args(argv)
    return run_test(
        module_path=args.module,
        tool_name=args.tool,
        params_json=args.params,
        batch_file=args.file,
        show_coverage=args.coverage,
    )
