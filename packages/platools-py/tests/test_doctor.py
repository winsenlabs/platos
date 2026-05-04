"""`platools doctor` static-analysis tests — PLATOS-18.

Each spec rule has a positive (the issue is detected) and negative
(clean tools don't trip the check) test. The CLI dispatcher and JSON
output are exercised through `run_doctor`.
"""

from __future__ import annotations

import io
import json
import sys
import textwrap
from pathlib import Path
from typing import Any

import pytest
from platools.cli import main as cli_main
from platools.cli.doctor import doctor_command, run_doctor, run_doctor_on_tools
from platools.doctor import analyze_tools, format_report
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
from platools.doctor.types import Finding
from platools.types import ToolDef


def _tool(
    name: str,
    *,
    description: str = "A tool with a long enough description for the doctor.",
    input_props: dict[str, dict[str, Any]] | None = None,
    required: list[str] | None = None,
    output_props: dict[str, dict[str, Any]] | None = None,
    annotations: dict[str, Any] | None = None,
    roles: tuple[str, ...] = (),
) -> ToolDef:
    """Build a `ToolDef` with the bare minimum the doctor cares about.

    The function pointer + auth + rate_limit fields aren't read by any
    check so they get inert defaults — the tests stay focused on the
    schema-walking parts.
    """
    input_schema: dict[str, Any] = {
        "type": "object",
        "properties": input_props or {},
        "required": required or [],
    }
    output_schema: dict[str, Any] | None = (
        None if output_props is None else {"type": "object", "properties": output_props}
    )
    return ToolDef(
        name=name,
        description=description,
        func=lambda: None,
        input_schema=input_schema,
        output_schema=output_schema,
        auth="none",
        roles=roles,
        rate_limit=None,
        timeout=None,
        annotations=annotations or {},
        is_async=False,
    )


# ---- 1. unreachable parameters ----------------------------------------


def test_unreachable_param_flagged() -> None:
    tools = [
        _tool(
            "archive_workspace",
            input_props={"admin_id": {"type": "string"}},
            required=["admin_id"],
            output_props={},
        )
    ]
    findings = check_param_sources(tools)
    codes = {f.code for f in findings}
    assert "unreachable_param" in codes


def test_unreachable_satisfied_by_user_providable() -> None:
    """A param marked `x-user-providable` is not unreachable even
    when no other tool produces it.
    """
    tools = [
        _tool(
            "ask_question",
            input_props={"question": {"type": "string", "x-user-providable": True}},
            required=["question"],
            output_props={},
        )
    ]
    findings = check_param_sources(tools)
    assert all(f.code != "unreachable_param" for f in findings)


def test_unreachable_satisfied_by_other_tool_output() -> None:
    """`get_order` outputs `order_id`, `update_order` consumes it →
    no unreachable finding.
    """
    tools = [
        _tool(
            "get_order",
            output_props={"order_id": {"type": "string"}},
        ),
        _tool(
            "update_order",
            input_props={"order_id": {"type": "string"}},
            required=["order_id"],
            output_props={},
        ),
    ]
    findings = check_param_sources(tools)
    assert all(f.code != "unreachable_param" for f in findings)


# ---- 2. type mismatches -----------------------------------------------


def test_type_mismatch_flagged() -> None:
    tools = [
        _tool("get_order", output_props={"order_id": {"type": "integer"}}),
        _tool(
            "update_order",
            input_props={"order_id": {"type": "string"}},
            required=["order_id"],
            output_props={},
        ),
    ]
    findings = check_param_sources(tools)
    codes = {f.code for f in findings}
    assert "type_mismatch" in codes


def test_no_type_mismatch_when_types_align() -> None:
    tools = [
        _tool("get_order", output_props={"order_id": {"type": "string"}}),
        _tool(
            "update_order",
            input_props={"order_id": {"type": "string"}},
            required=["order_id"],
            output_props={},
        ),
    ]
    findings = check_param_sources(tools)
    assert all(f.code != "type_mismatch" for f in findings)


# ---- 3. circular dependencies -----------------------------------------


def test_circular_dependency_two_cycle() -> None:
    """`a` outputs `x` and needs `y`; `b` outputs `y` and needs `x` →
    cycle a ↔ b.
    """
    tools = [
        _tool(
            "a",
            input_props={"y": {"type": "string"}},
            required=["y"],
            output_props={"x": {"type": "string"}},
        ),
        _tool(
            "b",
            input_props={"x": {"type": "string"}},
            required=["x"],
            output_props={"y": {"type": "string"}},
        ),
    ]
    findings = check_circular_dependencies(tools)
    assert any(f.code == "circular_dependency" for f in findings)


def test_no_cycle_in_acyclic_graph() -> None:
    tools = [
        _tool("get_order", output_props={"order_id": {"type": "string"}}),
        _tool(
            "ship_order",
            input_props={"order_id": {"type": "string"}},
            required=["order_id"],
            output_props={"tracking_id": {"type": "string"}},
        ),
        _tool(
            "track_shipment",
            input_props={"tracking_id": {"type": "string"}},
            required=["tracking_id"],
            output_props={},
        ),
    ]
    findings = check_circular_dependencies(tools)
    assert findings == []


def test_cycle_dedupe_emits_once_per_member() -> None:
    """A 2-cycle is reported once per participating tool (so the
    reporter's healthy count is correct), but the canonical cycle
    appears in every message rather than being duplicated.
    """
    tools = [
        _tool(
            "a",
            input_props={"y": {"type": "string"}},
            required=["y"],
            output_props={"x": {"type": "string"}},
        ),
        _tool(
            "b",
            input_props={"x": {"type": "string"}},
            required=["x"],
            output_props={"y": {"type": "string"}},
        ),
    ]
    findings = check_circular_dependencies(tools)
    cycle_findings = [f for f in findings if f.code == "circular_dependency"]
    # One finding per cycle member.
    assert len(cycle_findings) == 2
    # Both findings reference the same canonical cycle string.
    messages = {f.message for f in cycle_findings}
    assert len(messages) == 1
    # Each member is attributed via the `tool` field.
    assert {f.tool for f in cycle_findings} == {"a", "b"}


# ---- 4. orphan tools --------------------------------------------------


def test_orphan_tools_flagged_when_agent_set_provided() -> None:
    tools = [_tool("used_tool"), _tool("orphan_tool")]
    findings = check_orphan_tools(tools, agent_tool_names={"used_tool"})
    assert {f.tool for f in findings} == {"orphan_tool"}


def test_orphan_check_skips_when_no_agent_context() -> None:
    """Local-only `platools doctor` runs don't have agent context — the
    check is a no-op rather than misleadingly flagging everything.
    """
    tools = [_tool("anything")]
    findings = check_orphan_tools(tools, agent_tool_names=None)
    assert findings == []


# ---- 5. missing descriptions ------------------------------------------


def test_short_tool_description_flagged() -> None:
    tools = [_tool("brief", description="hi")]
    findings = check_descriptions(tools)
    assert any(f.code == "short_tool_description" for f in findings)


def test_short_param_description_flagged() -> None:
    tools = [
        _tool(
            "ok_tool",
            input_props={"name": {"type": "string", "description": "x"}},
            required=["name"],
        )
    ]
    findings = check_descriptions(tools)
    assert any(f.code == "short_param_description" for f in findings)


def test_descriptions_clean_when_long_enough() -> None:
    tools = [
        _tool(
            "good_tool",
            input_props={
                "name": {
                    "type": "string",
                    "description": "A descriptive parameter for the tool.",
                }
            },
            required=["name"],
        )
    ]
    findings = check_descriptions(tools)
    assert findings == []


# ---- 6. no return schema ----------------------------------------------


def test_missing_return_schema_flagged() -> None:
    tools = [_tool("no_output", output_props=None)]
    findings = check_return_schema(tools)
    assert findings and findings[0].code == "no_return_schema"


def test_present_return_schema_clean() -> None:
    tools = [_tool("with_output", output_props={"x": {"type": "string"}})]
    findings = check_return_schema(tools)
    assert findings == []


# ---- 7. ambiguous outputs --------------------------------------------


def test_ambiguous_output_flagged() -> None:
    tools = [
        _tool("get_user_id", output_props={"id": {"type": "string"}}),
        _tool("get_account_id", output_props={"id": {"type": "string"}}),
    ]
    findings = check_param_sources(tools)
    assert any(f.code == "ambiguous_output" for f in findings)


# ---- 8. permission gaps -----------------------------------------------


def test_permission_gap_flagged_for_unused_role() -> None:
    tools = [_tool("export_data", roles=("exporter",))]
    findings = check_permission_gaps(tools, roles_in_use={"admin"})
    assert any(f.code == "permission_gap" for f in findings)


def test_permission_check_skips_without_context() -> None:
    tools = [_tool("export_data", roles=("exporter",))]
    findings = check_permission_gaps(tools, roles_in_use=None)
    assert findings == []


# ---- 9. overly broad tools --------------------------------------------


def test_overly_broad_tool_flagged() -> None:
    big_props = {f"p{i}": {"type": "string"} for i in range(12)}
    tools = [_tool("send_email", input_props=big_props)]
    findings = check_overly_broad(tools)
    assert any(f.code == "overly_broad_tool" for f in findings)


def test_normal_param_count_clean() -> None:
    tools = [_tool("send_email", input_props={"to": {"type": "string"}})]
    findings = check_overly_broad(tools)
    assert findings == []


# ---- 10. destructive annotations --------------------------------------


def test_destructive_name_without_annotation_flagged() -> None:
    tools = [_tool("delete_user", annotations={})]
    findings = check_destructive_annotations(tools)
    assert any(f.code == "missing_destructive_hint" for f in findings)


def test_destructive_name_with_annotation_clean() -> None:
    tools = [_tool("delete_user", annotations={"destructiveHint": True})]
    findings = check_destructive_annotations(tools)
    assert findings == []


def test_non_destructive_name_clean() -> None:
    tools = [_tool("get_user", annotations={})]
    findings = check_destructive_annotations(tools)
    assert findings == []


# ---- analyze_tools end-to-end -----------------------------------------


def test_analyze_tools_aggregates_every_check() -> None:
    tools = [
        _tool(
            "get_user",
            output_props={"id": {"type": "string"}},
        ),
        _tool(
            "get_order",
            output_props={"id": {"type": "string"}},  # ambiguous output
        ),
        _tool(
            "delete_user",  # missing destructive hint
            input_props={"id": {"type": "string"}},
            required=["id"],
            output_props={},
        ),
        _tool(
            "broken_tool",  # unreachable param + no output schema
            input_props={"missing_field": {"type": "string"}},
            required=["missing_field"],
        ),
    ]
    report = analyze_tools(tools)
    codes = {f.code for f in report.findings}
    assert "ambiguous_output" in codes
    assert "missing_destructive_hint" in codes
    assert "unreachable_param" in codes
    assert "no_return_schema" in codes
    assert report.has_errors() is True


def test_analyze_tools_clean_input_has_no_errors() -> None:
    tools = [
        _tool(
            "get_user",
            input_props={
                "user_id": {
                    "type": "string",
                    "description": "User identifier to fetch.",
                    "x-user-providable": True,
                }
            },
            required=["user_id"],
            output_props={"name": {"type": "string"}},
        ),
    ]
    report = analyze_tools(tools)
    assert report.has_errors() is False


# ---- reporter ---------------------------------------------------------


def test_reporter_renders_section_headers() -> None:
    tools = [
        _tool(
            "broken",
            input_props={"missing": {"type": "string"}},
            required=["missing"],
            output_props={},
        ),
    ]
    report = analyze_tools(tools)
    text = format_report(report)
    assert "Tools: 1 registered" in text
    assert "ERRORS" in text
    assert "broken.missing" in text


def test_reporter_clean_run_renders_celebration() -> None:
    tools = [
        _tool(
            "always_ok",
            input_props={
                "x": {
                    "type": "string",
                    "description": "An input parameter.",
                    "x-user-providable": True,
                }
            },
            required=["x"],
            output_props={"y": {"type": "string"}},
        ),
    ]
    report = analyze_tools(tools)
    text = format_report(report)
    assert "No issues" in text


# ---- CLI / run_doctor / json output ----------------------------------


def test_run_doctor_on_tools_returns_report() -> None:
    tools = [
        _tool(
            "broken",
            input_props={"missing": {"type": "string"}},
            required=["missing"],
            output_props={},
        ),
    ]
    report = run_doctor_on_tools(tools)
    assert report.has_errors() is True


def test_run_doctor_text_output() -> None:
    """`run_doctor` with no module path uses an empty composite registry
    and returns exit 0 + clean text.
    """
    sink = io.StringIO()
    code = run_doctor(out=sink)
    assert code == 0
    assert "Tools: 0 registered" in sink.getvalue()


def test_run_doctor_json_output_shape() -> None:
    sink = io.StringIO()
    code = run_doctor(out=sink, output_json=True)
    assert code == 0
    payload = json.loads(sink.getvalue())
    assert payload["tool_count"] == 0
    assert payload["errors"] == []
    assert payload["warnings"] == []
    assert payload["info"] == []


def test_doctor_command_argparse_help_exit() -> None:
    """`platools doctor --help` exits cleanly via argparse."""
    with pytest.raises(SystemExit) as excinfo:
        doctor_command(["--help"])
    assert excinfo.value.code == 0


def test_load_registry_imports_real_module(tmp_path: Path) -> None:
    """End-to-end: write a fake `my_app/tools.py` to disk, point
    `_load_registry` at it via `sys.path`, and confirm the doctor
    surfaces the decorated tool from the imported module.
    """
    pkg_dir = tmp_path / "doctor_e2e_pkg"
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("")
    # The tool returns a typed value AND its `name` param is patched
    # post-decoration with `x-user-providable=True` so the doctor
    # doesn't flag it as unreachable. This is the same shape an SDK
    # consumer's real tool would have once we ship a `user_providable`
    # decorator argument (PLATOS-19).
    (pkg_dir / "tools.py").write_text(
        textwrap.dedent(
            """
            from pydantic import BaseModel
            from platools import Platools

            platools = Platools()


            class Greeting(BaseModel):
                message: str


            @platools.tool()
            def hello(name: str) -> Greeting:
                \"\"\"Say hello to a user.

                Args:
                    name: The name to greet, supplied by the end user.
                \"\"\"
                return Greeting(message=f"hi {name}")


            # Mark the param as user-providable so the doctor's
            # unreachable check is satisfied. The decorator API for
            # this lands in PLATOS-19; for now we patch the schema
            # directly so the e2e test can pass.
            hello_tool = platools.registry.get("hello")
            assert hello_tool is not None
            hello_tool.input_schema["properties"]["name"]["x-user-providable"] = True
            """
        ).strip()
        + "\n"
    )

    sys.path.insert(0, str(tmp_path))
    try:
        # Force a fresh import in case a prior test loaded the same name.
        sys.modules.pop("doctor_e2e_pkg", None)
        sys.modules.pop("doctor_e2e_pkg.tools", None)
        sink = io.StringIO()
        code = run_doctor(module_path="doctor_e2e_pkg.tools", out=sink)
        output = sink.getvalue()
    finally:
        sys.path.remove(str(tmp_path))
        sys.modules.pop("doctor_e2e_pkg", None)
        sys.modules.pop("doctor_e2e_pkg.tools", None)

    # The decorated `hello` tool should appear in the report.
    assert "Tools: 1 registered" in output
    # And the run is clean (no errors) so the exit code is 0.
    assert code == 0


def test_cycle_findings_count_each_member_unhealthy() -> None:
    """A 2-tool cycle must subtract BOTH tools from the healthy count
    in the reporter header — not just the one we walked into.
    """
    from platools.doctor.reporter import format_report

    tools = [
        _tool(
            "a",
            input_props={"y": {"type": "string"}},
            required=["y"],
            output_props={"x": {"type": "string"}},
        ),
        _tool(
            "b",
            input_props={"x": {"type": "string"}},
            required=["x"],
            output_props={"y": {"type": "string"}},
        ),
    ]
    report = analyze_tools(tools)
    text = format_report(report)
    # Both tools are unhealthy → "0 healthy" in the header.
    assert "Tools: 2 registered, 0 healthy" in text


def test_cli_main_dispatches_doctor() -> None:
    """`platools doctor` from the top-level entry hits the doctor command."""
    code = cli_main(["doctor"])
    assert code == 0


def test_cli_main_unknown_subcommand_returns_2() -> None:
    code = cli_main(["nope"])
    assert code == 2


def test_cli_main_help_returns_0() -> None:
    assert cli_main(["help"]) == 0
    assert cli_main(["--help"]) == 0


def test_finding_dataclass_filters() -> None:
    """`DoctorReport.errors` / `warnings` / `infos` partition correctly."""
    findings = [
        Finding(severity="error", code="x", message="e1"),
        Finding(severity="warning", code="y", message="w1"),
        Finding(severity="info", code="z", message="i1"),
    ]
    report = analyze_tools([])
    # Replace the empty report's findings with our hand-built ones for
    # the partition assertion.
    object.__setattr__(report, "findings", findings)
    assert len(report.errors()) == 1
    assert len(report.warnings()) == 1
    assert len(report.infos()) == 1
