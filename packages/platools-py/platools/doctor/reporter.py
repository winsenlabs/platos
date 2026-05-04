"""Text formatter for `platools doctor` reports — PLATOS-18.

Matches the spec's CLI output shape:

    Tools: 47 registered, 43 healthy

    ERRORS (2):
      x archive_workspace.admin_id is unreachable
      x merge_pages — circular dependency with split_page

    WARNINGS (5):
      ! get_page — description too short (3 chars)

    INFO (2):
      i cleanup_temp is not assigned to any agent

The formatter is pure-text on purpose so the CLI can pipe it into
files / CI logs without ANSI noise. A `--color` flag in the CLI can
layer Rich on top later (PLATOS-32 follow-up); the data shape stays
the same.
"""

from __future__ import annotations

from platools.doctor.types import DoctorReport, Finding


def format_report(report: DoctorReport) -> str:
    """Render a `DoctorReport` as the canonical CLI text block."""
    errors = report.errors()
    warnings = report.warnings()
    infos = report.infos()
    healthy = report.tool_count - len({f.tool for f in errors if f.tool})

    lines: list[str] = []
    lines.append(f"Tools: {report.tool_count} registered, {healthy} healthy")
    lines.append("")

    if errors:
        lines.append(f"ERRORS ({len(errors)}):")
        lines.extend(_format_section(errors, marker="x"))
        lines.append("")
    if warnings:
        lines.append(f"WARNINGS ({len(warnings)}):")
        lines.extend(_format_section(warnings, marker="!"))
        lines.append("")
    if infos:
        lines.append(f"INFO ({len(infos)}):")
        lines.extend(_format_section(infos, marker="i"))
        lines.append("")

    if not (errors or warnings or infos):
        lines.append("No issues found. 🎉")

    return "\n".join(lines).rstrip() + "\n"


def _format_section(findings: list[Finding], *, marker: str) -> list[str]:
    return [f"  {marker} {finding.message}" for finding in findings]
