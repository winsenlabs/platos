"""Static tool-graph analyzer — `platools doctor` (PLATOS-18)."""

from platools.doctor.analyzer import analyze_registry, analyze_tools
from platools.doctor.reporter import format_report
from platools.doctor.types import DoctorReport, Finding, Severity

__all__ = [
    "DoctorReport",
    "Finding",
    "Severity",
    "analyze_registry",
    "analyze_tools",
    "format_report",
]
