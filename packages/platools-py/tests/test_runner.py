"""`platools test` runner + CLI tests — PLATOS-19."""

from __future__ import annotations

import io
import json
import textwrap
from pathlib import Path

import pytest
from platools import Platools
from platools.cli import main as cli_main
from platools.cli.test import run_test
from platools.cli.test import test_command as _test_command_entry
from platools.testing import (
    BatchResult,
    BatchTestCase,
    ToolTestRunner,
    coverage_report,
    load_batch_file,
)
from platools.testing.mock_client import MockMcpClient


@pytest.fixture()
def platools() -> Platools:
    """Fresh Platools instance with three tools — sync ok, sync raise, async ok."""
    p = Platools()

    @p.tool()
    def add(a: int, b: int) -> int:
        """Add two integers.

        Args:
            a: The first integer.
            b: The second integer.
        """
        return a + b

    @p.tool()
    def boom(x: int) -> int:
        """Always raises an error.

        Args:
            x: Anything — will be ignored.
        """
        raise RuntimeError(f"boom: {x}")

    @p.tool()
    async def fetch_async(name: str) -> str:
        """Async greeting.

        Args:
            name: The name to greet.
        """
        return f"hello {name}"

    return p


# ---- ToolTestRunner ---------------------------------------------------


def test_run_sync_tool_returns_passed(platools: Platools) -> None:
    runner = ToolTestRunner(platools.registry)
    result = runner.run("add", {"a": 2, "b": 3})
    assert result.passed
    assert result.output == 5
    assert result.duration_ms >= 0
    assert result.error is None


def test_run_async_tool_returns_passed(platools: Platools) -> None:
    runner = ToolTestRunner(platools.registry)
    result = runner.run("fetch_async", {"name": "world"})
    assert result.passed
    assert result.output == "hello world"


def test_run_sync_tool_captures_exception(platools: Platools) -> None:
    runner = ToolTestRunner(platools.registry)
    result = runner.run("boom", {"x": 1})
    assert not result.passed
    assert result.error is not None
    assert "RuntimeError" in result.error


def test_run_unknown_tool_returns_failed(platools: Platools) -> None:
    runner = ToolTestRunner(platools.registry)
    result = runner.run("ghost", {})
    assert not result.passed
    assert result.error is not None
    assert "not registered" in result.error


def test_run_rejects_extra_params(platools: Platools) -> None:
    runner = ToolTestRunner(platools.registry)
    result = runner.run("add", {"a": 1, "b": 2, "rogue": 99})
    assert not result.passed
    assert result.error is not None
    assert "schema validation" in result.error.lower()


def test_run_records_duration(platools: Platools) -> None:
    runner = ToolTestRunner(platools.registry)
    result = runner.run("add", {"a": 1, "b": 2})
    # `time.perf_counter()` resolution gives us non-negative ms even
    # for trivially fast calls; we just verify the field is populated.
    assert result.duration_ms >= 0


# ---- run_batch / BatchResult / latency stats --------------------------


async def test_run_batch_marks_expect_success_correctly(platools: Platools) -> None:
    runner = ToolTestRunner(platools.registry)
    cases = [
        BatchTestCase(tool="add", params={"a": 1, "b": 2}, expect_success=True),
        BatchTestCase(tool="boom", params={"x": 1}, expect_error=True),
    ]
    result = await runner.run_batch(cases)
    assert result.passed == 2
    assert result.failed == 0


async def test_run_batch_flags_unexpected_success_as_failed(platools: Platools) -> None:
    runner = ToolTestRunner(platools.registry)
    cases = [BatchTestCase(tool="add", params={"a": 1, "b": 2}, expect_error=True)]
    result = await runner.run_batch(cases)
    assert result.passed == 0
    assert result.failed == 1
    assert result.cases[0].error is not None
    assert "expected error" in result.cases[0].error.lower()


async def test_run_batch_honors_expect_success_false(platools: Platools) -> None:
    """Regression for HIGH 2: a `expect_success=False` (without
    `expect_error=True`) is treated as a negative test — passing iff
    the tool actually errors. Previously the runner ignored
    `expect_success` entirely.
    """
    runner = ToolTestRunner(platools.registry)
    # `add` succeeds → expect_success=False means we should see "failed"
    cases = [
        BatchTestCase(
            tool="add",
            params={"a": 1, "b": 2},
            expect_success=False,
            expect_error=False,
        )
    ]
    result = await runner.run_batch(cases)
    assert result.failed == 1
    # And the inverse — `boom` errors, expect_success=False → passes
    cases = [
        BatchTestCase(
            tool="boom",
            params={"x": 1},
            expect_success=False,
            expect_error=False,
        )
    ]
    result = await runner.run_batch(cases)
    assert result.passed == 1
    assert result.failed == 0


def test_runner_run_in_event_loop_raises(platools: Platools) -> None:
    """Regression for HIGH 1: calling the sync `run()` from inside a
    running event loop raises a clear error instead of silently
    leaking a coroutine via `loop.run_until_complete`.
    """
    import asyncio

    runner = ToolTestRunner(platools.registry)

    async def call_from_inside_loop() -> None:
        runner.run("add", {"a": 1, "b": 2})

    with pytest.raises(RuntimeError, match="cannot be called from inside a running event loop"):
        asyncio.run(call_from_inside_loop())


def test_batch_result_latency_stats() -> None:
    """`BatchResult.latency_p50` / `latency_p95` are computed across cases."""
    from platools.testing.runner import TestResult

    cases = [TestResult(tool=f"t{i}", passed=True, duration_ms=float(i + 1)) for i in range(20)]
    result = BatchResult(cases=cases)
    assert result.latency_p50 == 10.5  # median of 1..20
    assert result.latency_p95 == 19.0


def test_batch_result_empty_latency_is_zero() -> None:
    result = BatchResult(cases=[])
    assert result.latency_p50 == 0.0
    assert result.latency_p95 == 0.0


# ---- YAML batch loader ------------------------------------------------


def test_load_batch_file_parses_spec_shape(tmp_path: Path) -> None:
    yaml_file = tmp_path / "platools-tests.yaml"
    yaml_file.write_text(
        textwrap.dedent(
            """
            tests:
              - tool: add
                params: {a: 1, b: 2}
                expect_success: true
              - tool: boom
                params: {x: 5}
                expect_error: true
            """
        ).strip()
    )
    cases = load_batch_file(yaml_file)
    assert len(cases) == 2
    assert cases[0].tool == "add"
    assert cases[0].params == {"a": 1, "b": 2}
    assert cases[0].expect_success is True
    assert cases[1].expect_error is True


def test_load_batch_file_rejects_invalid_top_level(tmp_path: Path) -> None:
    yaml_file = tmp_path / "bad.yaml"
    yaml_file.write_text("- not a mapping")
    with pytest.raises(ValueError, match="mapping"):
        load_batch_file(yaml_file)


def test_load_batch_file_rejects_missing_tool(tmp_path: Path) -> None:
    yaml_file = tmp_path / "bad.yaml"
    yaml_file.write_text("tests:\n  - params: {x: 1}\n")
    with pytest.raises(ValueError, match="tool"):
        load_batch_file(yaml_file)


def test_load_batch_file_rejects_contradictory_expect_flags(tmp_path: Path) -> None:
    """Regression for the LOW finding that ambiguous flags should be
    rejected at parse time so the runtime never sees them.
    """
    yaml_file = tmp_path / "bad.yaml"
    yaml_file.write_text(
        textwrap.dedent(
            """
            tests:
              - tool: add
                params: {a: 1, b: 2}
                expect_success: true
                expect_error: true
            """
        ).strip()
    )
    with pytest.raises(ValueError, match="pick one"):
        load_batch_file(yaml_file)


def test_load_batch_file_rejects_double_false(tmp_path: Path) -> None:
    yaml_file = tmp_path / "bad.yaml"
    yaml_file.write_text(
        textwrap.dedent(
            """
            tests:
              - tool: add
                params: {a: 1, b: 2}
                expect_success: false
                expect_error: false
            """
        ).strip()
    )
    with pytest.raises(ValueError, match="meaningless"):
        load_batch_file(yaml_file)


# ---- coverage report --------------------------------------------------


def test_coverage_report_marks_covered_tools(platools: Platools) -> None:
    cases = [BatchTestCase(tool="add", params={"a": 1, "b": 2})]
    report = coverage_report(platools.registry, cases)
    assert report["add"] is True
    assert report["boom"] is False
    assert report["fetch_async"] is False


# ---- MockMcpClient ----------------------------------------------------


def test_mock_client_lists_tools(platools: Platools) -> None:
    client = MockMcpClient(platools.registry)
    listing = client.list_tools()
    names = {t["name"] for t in listing}
    assert names == {"add", "boom", "fetch_async"}


async def test_mock_client_call_tool_passes(platools: Platools) -> None:
    client = MockMcpClient(platools.registry)
    result = await client.call_tool("add", {"a": 4, "b": 5})
    assert result.passed
    assert result.output == 9


# ---- run_test programmatic + CLI dispatcher ---------------------------


def test_run_test_single_tool_via_module(tmp_path: Path) -> None:
    """End-to-end: write a fake module, point `run_test` at it,
    invoke a single tool with `--params`, assert exit 0 + clean output.
    """
    pkg_dir = tmp_path / "test_pkg"
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("")
    (pkg_dir / "tools.py").write_text(
        textwrap.dedent(
            """
            from platools import Platools

            platools = Platools()

            @platools.tool()
            def echo(value: str) -> str:
                \"\"\"Echo a value.

                Args:
                    value: The value to echo.
                \"\"\"
                return value
            """
        ).strip()
    )

    import sys

    sys.path.insert(0, str(tmp_path))
    try:
        sys.modules.pop("test_pkg", None)
        sys.modules.pop("test_pkg.tools", None)
        sink = io.StringIO()
        code = run_test(
            module_path="test_pkg.tools",
            tool_name="echo",
            params_json=json.dumps({"value": "ping"}),
            out=sink,
        )
    finally:
        sys.path.remove(str(tmp_path))
        sys.modules.pop("test_pkg", None)
        sys.modules.pop("test_pkg.tools", None)

    assert code == 0
    assert "echo" in sink.getvalue()
    assert "ping" in sink.getvalue()


def test_run_test_returns_2_for_invalid_params_json() -> None:
    sink = io.StringIO()
    code = run_test(
        tool_name="add",
        params_json="not-json",
        out=sink,
    )
    assert code == 2
    assert "Invalid --params" in sink.getvalue()


def test_run_test_no_batch_file_returns_2(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """When no batch file is present and no tool is supplied, the CLI
    points the user at the missing file with exit code 2.
    """
    monkeypatch.chdir(tmp_path)
    sink = io.StringIO()
    code = run_test(out=sink)
    assert code == 2
    assert "platools-tests.yaml" in sink.getvalue()


def test_test_command_argparse_help_exit() -> None:
    with pytest.raises(SystemExit) as excinfo:
        _test_command_entry(["--help"])
    assert excinfo.value.code == 0


def test_cli_main_dispatches_test_subcommand(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`platools test` from the top-level entry hits the test command."""
    monkeypatch.chdir(tmp_path)
    code = cli_main(["test"])
    # No batch file in the empty tmp_path → exit 2 with the missing-file message.
    assert code == 2


def test_cli_main_test_serve_still_returns_1() -> None:
    """`serve` is still a placeholder."""
    assert cli_main(["serve"]) == 1
