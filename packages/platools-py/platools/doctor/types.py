"""Public types for `platools doctor`.

Kept separate from `analyzer.py` so the CLI and check modules can
import the data shapes without pulling the full analysis engine.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Severity = Literal["error", "warning", "info"]


@dataclass(frozen=True)
class Finding:
    """A single check result."""

    severity: Severity
    code: str
    message: str
    tool: str | None = None
    param: str | None = None


@dataclass(frozen=True)
class DoctorReport:
    """Aggregate output from running every check."""

    tool_count: int
    findings: list[Finding] = field(default_factory=list)

    def errors(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "error"]

    def warnings(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "warning"]

    def infos(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "info"]

    def has_errors(self) -> bool:
        return any(f.severity == "error" for f in self.findings)
