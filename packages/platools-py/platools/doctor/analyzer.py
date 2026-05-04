"""Tool graph analyzer entry point — `platools doctor` (PLATOS-18).

Loads a list of `ToolDef` from one of two sources:

  - **Local introspection** (default): walks `platools.core.registry`
    to grab every `@platools.tool()`-decorated function in the calling
    process. Used by `platools doctor` invoked inside the SDK
    consumer's project — same model as `pytest` discovering tests.
  - **Platform fetch** (PLATOS-32 follow-up): pulls the registered
    tool definitions from the platform API via `--platform-url`. The
    fetcher hook lives in `cli/doctor.py`; this module just accepts a
    pre-loaded list so it can be tested in isolation without network.

Then runs every check in `checks.py` and aggregates the findings into
a `DoctorReport`. The CLI passes that report to `reporter.format_report`
for the final text output, and exits 1 if `report.has_errors()`.
"""

from __future__ import annotations

from platools.core.registry import ToolRegistry
from platools.doctor.checks import (
    check_circular_dependencies,
    check_descriptions,
    check_destructive_annotations,
    check_orphan_tools,
    check_overly_broad,
    check_param_sources,
    check_permission_gaps,
    check_return_schema,
)
from platools.doctor.types import DoctorReport, Finding
from platools.types import ToolDef


def analyze_tools(
    tools: list[ToolDef],
    *,
    agent_tool_names: set[str] | None = None,
    roles_in_use: set[str] | None = None,
) -> DoctorReport:
    """Run every doctor check against `tools` and return a report.

    `agent_tool_names` and `roles_in_use` are optional — when None,
    the orphan and permission-gap checks are skipped. Pass them when
    the CLI is invoked with `--platform-url` and the analyzer can
    enrich the local view with platform context.
    """
    findings: list[Finding] = []
    findings.extend(check_param_sources(tools))
    findings.extend(check_circular_dependencies(tools))
    findings.extend(check_orphan_tools(tools, agent_tool_names=agent_tool_names))
    findings.extend(check_descriptions(tools))
    findings.extend(check_return_schema(tools))
    findings.extend(check_permission_gaps(tools, roles_in_use=roles_in_use))
    findings.extend(check_overly_broad(tools))
    findings.extend(check_destructive_annotations(tools))
    return DoctorReport(tool_count=len(tools), findings=findings)


def analyze_registry(
    registry: ToolRegistry,
    *,
    agent_tool_names: set[str] | None = None,
    roles_in_use: set[str] | None = None,
) -> DoctorReport:
    """Convenience wrapper that pulls tools out of a `ToolRegistry`."""
    return analyze_tools(
        registry.all(),
        agent_tool_names=agent_tool_names,
        roles_in_use=roles_in_use,
    )
