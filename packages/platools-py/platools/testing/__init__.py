"""`platools test` runtime test harness — PLATOS-19.

Public surface:
  - `ToolTestRunner` — invokes a single decorated tool with a params
    dict, validates input/output against the JSON schema, times the
    call, returns a `TestResult`.
  - `MockMcpClient` — in-process MCP-style wrapper used by the CLI so
    `platools test` doesn't need a live WebSocket.
  - `BatchTestCase` / `BatchResult` — YAML batch file support.
  - `coverage_report` — which tools have at least one test case.
"""

from platools.testing.runner import (
    BatchResult,
    BatchTestCase,
    TestResult,
    ToolTestRunner,
    coverage_report,
    load_batch_file,
)

__all__ = [
    "BatchResult",
    "BatchTestCase",
    "TestResult",
    "ToolTestRunner",
    "coverage_report",
    "load_batch_file",
]
