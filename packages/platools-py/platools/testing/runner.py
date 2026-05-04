"""Tool test runner — PLATOS-19.

Invokes a single `@platools.tool()`-decorated function with a params
dict, validates the input against the tool's JSON schema, dispatches
the call (sync or async), times it, and returns a `TestResult`. The
runner is the building block both `platools test <name>` and the
batch YAML mode use under the hood.

The schema validation uses Pydantic's standard JSON Schema → model
round-trip — we don't pull in a separate `jsonschema` dep when the
SDK already requires Pydantic.

Latency stats are exposed as `BatchResult.latency_p50` /
`latency_p95` so the CLI can render the spec's "p50/p95" line
without callers needing to do their own statistics.
"""

from __future__ import annotations

import asyncio
import statistics
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml
from pydantic import ValidationError, create_model

from platools.core.registry import ToolRegistry
from platools.types import ToolDef


@dataclass(frozen=True)
class TestResult:
    """Outcome of a single tool invocation."""

    tool: str
    passed: bool
    duration_ms: float
    error: str | None = None
    output: Any = None


@dataclass(frozen=True)
class BatchTestCase:
    """One row in a YAML batch file.

    `expect_success` and `expect_error` are mutually exclusive: at
    most one may be set to a non-default value, and they may never
    both be `True` (or both be `False` after a manual `expect_success=False`
    + `expect_error=False` payload). `load_batch_file` rejects the
    contradictory combinations at parse time so the runtime path
    never sees an ambiguous case.
    """

    tool: str
    params: dict[str, Any]
    expect_success: bool = True
    expect_error: bool = False

    def expects_failure(self) -> bool:
        """True iff this case is configured as a negative test."""
        return self.expect_error or not self.expect_success


@dataclass(frozen=True)
class BatchResult:
    """Aggregate result from running a batch of test cases."""

    cases: list[TestResult] = field(default_factory=list)

    @property
    def passed(self) -> int:
        return sum(1 for c in self.cases if c.passed)

    @property
    def failed(self) -> int:
        return sum(1 for c in self.cases if not c.passed)

    @property
    def latency_p50(self) -> float:
        if not self.cases:
            return 0.0
        return statistics.median(c.duration_ms for c in self.cases)

    @property
    def latency_p95(self) -> float:
        if not self.cases:
            return 0.0
        # Manual p95 (statistics.quantiles needs n>=2 with method="exclusive").
        sorted_durations = sorted(c.duration_ms for c in self.cases)
        idx = max(0, int(round(len(sorted_durations) * 0.95)) - 1)
        return sorted_durations[idx]


class ToolTestRunner:
    """Single-tool invocation harness.

    Build with a `ToolRegistry`; call `run(tool_name, params)` to
    invoke one tool. The runner is reusable across many calls so
    batch mode just loops over `run`.
    """

    def __init__(self, registry: ToolRegistry) -> None:
        self._registry = registry

    def has_tool(self, name: str) -> bool:
        return name in self._registry

    def list_tool_names(self) -> list[str]:
        return self._registry.names()

    async def run_async(self, tool_name: str, params: dict[str, Any]) -> TestResult:
        """Async-friendly entry point. Used by the batch runner so a
        mixed registry of sync + async tools can run in one pass.
        """
        tool = self._registry.get(tool_name)
        if tool is None:
            return TestResult(
                tool=tool_name,
                passed=False,
                duration_ms=0.0,
                error=f"tool {tool_name!r} is not registered",
            )

        # Schema validation: build a one-off Pydantic model whose
        # fields mirror the JSON schema, then call `model_validate`
        # on the params dict. Validation errors round-trip as
        # `TestResult.error`.
        try:
            _validate_params_against_schema(tool, params)
        except ValidationError as exc:
            return TestResult(
                tool=tool_name,
                passed=False,
                duration_ms=0.0,
                error=f"input schema validation failed: {exc}",
            )

        start = time.perf_counter()
        try:
            if tool.is_async:
                output = await tool.func(**params)
            else:
                output = tool.func(**params)
        except Exception as exc:  # noqa: BLE001 — we surface every error
            duration_ms = (time.perf_counter() - start) * 1000.0
            return TestResult(
                tool=tool_name,
                passed=False,
                duration_ms=duration_ms,
                error=f"{type(exc).__name__}: {exc}",
            )

        duration_ms = (time.perf_counter() - start) * 1000.0
        return TestResult(
            tool=tool_name,
            passed=True,
            duration_ms=duration_ms,
            output=output,
        )

    def run(self, tool_name: str, params: dict[str, Any]) -> TestResult:
        """Sync wrapper around `run_async`. The CLI uses this; tests
        running inside an `async def` should call `run_async` directly.

        Raises `RuntimeError` if called from inside a running event
        loop — `loop.run_until_complete` on the active loop crashes
        with "This event loop is already running" and leaks an
        un-awaited coroutine, so refusing the call is the only safe
        thing to do.
        """
        if _running_in_event_loop():
            raise RuntimeError(
                "ToolTestRunner.run() cannot be called from inside a running "
                "event loop — use `await runner.run_async(...)` instead."
            )
        return asyncio.run(self.run_async(tool_name, params))

    async def run_batch(self, cases: Iterable[BatchTestCase]) -> BatchResult:
        """Run every case in `cases` and aggregate the results.

        Negative cases (`expect_error=True` OR `expect_success=False`)
        flip the pass/fail condition: passing iff the tool errored,
        failing if it unexpectedly succeeded. Both flags are honored
        via `BatchTestCase.expects_failure` so a YAML file using
        either spelling produces the same behavior.
        """
        results: list[TestResult] = []
        for case in cases:
            raw = await self.run_async(case.tool, case.params)
            if case.expects_failure():
                # Negative test: pass iff the tool errored.
                passed = raw.error is not None
                error = None if passed else "expected error but tool succeeded"
                results.append(
                    TestResult(
                        tool=case.tool,
                        passed=passed,
                        duration_ms=raw.duration_ms,
                        error=error,
                        output=raw.output,
                    )
                )
            else:
                # Positive test: pass iff the tool ran without error.
                results.append(raw)
        return BatchResult(cases=results)


def _validate_params_against_schema(tool: ToolDef, params: dict[str, Any]) -> None:
    """Build a throw-away Pydantic model from the tool's JSON schema
    and validate `params` against it.

    Pydantic doesn't expose a "JSON schema → model" API directly, so
    we walk the `properties` map and create matching fields. Only the
    field name + required-ness is enforced — the JSON Schema `type`
    field is ignored because Pydantic emits its own discriminators
    that don't always round-trip cleanly. The runner intentionally
    keeps validation lightweight; tighter checks live in
    `platools doctor`.
    """
    schema = tool.input_schema or {}
    properties = schema.get("properties", {})
    required = set(schema.get("required", []) or [])

    fields: dict[str, Any] = {}
    for name in properties:
        if name in required:
            fields[name] = (Any, ...)
        else:
            fields[name] = (Any, None)

    # Reject params that aren't in the schema (typo guard) — same
    # `extra="forbid"` semantics the rest of the dashboard uses.
    extras = set(params.keys()) - set(properties.keys())
    if extras:
        raise ValidationError.from_exception_data(
            "ToolParams",
            [
                {
                    "type": "extra_forbidden",
                    "loc": (next(iter(extras)),),
                    "input": None,
                }
            ],
        )

    if not fields:
        # Tool with no declared params — treat any caller-supplied
        # params as a hard error caught above; nothing more to do.
        return

    params_model = create_model("ToolParams", **fields)
    params_model.model_validate(params)


def _running_in_event_loop() -> bool:
    try:
        asyncio.get_running_loop()
        return True
    except RuntimeError:
        return False


# ---- YAML batch file loader -------------------------------------------


def load_batch_file(path: str | Path) -> list[BatchTestCase]:
    """Parse a `platools-tests.yaml` file into `BatchTestCase`s.

    Schema (matches the spec):

        tests:
          - tool: process_refund
            params: { order_id: 'abc123', reason: 'damaged' }
            expect_success: true
          - tool: process_refund
            params: { order_id: '' }
            expect_error: true
    """
    raw = Path(path).read_text(encoding="utf-8")
    parsed = yaml.safe_load(raw) or {}
    if not isinstance(parsed, dict):
        raise ValueError(f"{path}: expected a YAML mapping at the top level")
    tests = parsed.get("tests")
    if not isinstance(tests, list):
        raise ValueError(f"{path}: expected `tests:` to be a list")
    cases: list[BatchTestCase] = []
    for entry in tests:
        if not isinstance(entry, dict):
            raise ValueError(f"{path}: every test entry must be a mapping")
        tool = str(entry.get("tool") or "")
        if not tool:
            raise ValueError(f"{path}: test entry missing `tool` field")
        params = entry.get("params") or {}
        if not isinstance(params, dict):
            raise ValueError(f"{path}: `params` must be a mapping")
        # Track which keys were explicitly set so we can detect the
        # contradictory `expect_success: true + expect_error: true`
        # combo without false-flagging the default-only case.
        expect_success_set = "expect_success" in entry
        expect_error_set = "expect_error" in entry
        expect_success = bool(entry.get("expect_success", True))
        expect_error = bool(entry.get("expect_error", False))
        if expect_success_set and expect_error_set and expect_success and expect_error:
            raise ValueError(
                f"{path}: test entry for {tool!r} sets both "
                "`expect_success: true` and `expect_error: true` — pick one"
            )
        if expect_success_set and not expect_success and expect_error_set and not expect_error:
            raise ValueError(
                f"{path}: test entry for {tool!r} sets both "
                "`expect_success: false` and `expect_error: false` — "
                "this asserts neither outcome, which is meaningless"
            )
        cases.append(
            BatchTestCase(
                tool=tool,
                params={str(k): v for k, v in params.items()},
                expect_success=expect_success,
                expect_error=expect_error,
            )
        )
    return cases


# ---- coverage report --------------------------------------------------


def coverage_report(registry: ToolRegistry, cases: Iterable[BatchTestCase]) -> dict[str, bool]:
    """Return a `{tool_name: has_test}` map for every registered tool.

    The CLI's `--coverage` flag renders this as a checklist so the
    SDK consumer can see which tools they haven't tested yet.
    """
    covered = {case.tool for case in cases}
    return {name: name in covered for name in registry.names()}
