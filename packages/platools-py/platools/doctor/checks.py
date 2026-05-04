"""Individual `platools doctor` check implementations — PLATOS-18.

Every check is a pure function that takes a list of `ToolDef` (plus
optional context) and returns a list of `Finding`. No I/O, no LLM
calls — `platools doctor` is supposed to be the static, deterministic
ship gate so the SDK consumer can wire it into CI without needing
network access or an API key.

Spec rules (PRD §5.1, PLATOS-18 task description):

  1. Unreachable parameters
  2. Type mismatches
  3. Circular dependencies
  4. Orphan tools
  5. Missing descriptions
  6. No return schema
  7. Duplicate / ambiguous outputs
  8. Permission gaps
  9. Overly broad tools
 10. Missing destructive annotations

Each check function is named `check_<rule>` and registered in
`analyzer.run_all_checks` so adding a new check is one import + one
list entry.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from platools.doctor.types import Finding
from platools.types import ToolDef

# Heuristic: tool names containing one of these substrings are
# treated as destructive. The check fires when such a tool is missing
# `annotations["destructiveHint"]: True`.
_DESTRUCTIVE_NAME_TOKENS: tuple[str, ...] = (
    "delete",
    "remove",
    "archive",
    "drop",
    "purge",
    "clear",
    "wipe",
    "destroy",
    "truncate",
)

_MIN_DESCRIPTION_CHARS: int = 10
_MAX_PARAMS_BEFORE_BROAD: int = 10


def _input_properties(tool: ToolDef) -> dict[str, dict[str, Any]]:
    """Pull the `properties` map out of a JSON Schema input dict.

    Returns an empty dict if the tool has no input schema or the
    schema is malformed — the doctor's job is to flag missing data
    via dedicated checks, not crash on it.
    """
    schema = tool.input_schema or {}
    props = schema.get("properties")
    if not isinstance(props, dict):
        return {}
    return {str(k): v for k, v in props.items() if isinstance(v, dict)}


def _required_param_names(tool: ToolDef) -> set[str]:
    schema = tool.input_schema or {}
    required = schema.get("required")
    if not isinstance(required, list):
        return set()
    return {str(name) for name in required}


def _output_properties(tool: ToolDef) -> dict[str, dict[str, Any]]:
    # `tool.output_schema` is typed `dict[str, Any] | None` so the
    # `or {}` makes the rest of the body type-safe; mypy treats the
    # narrowed value as `dict[str, Any]` from here on.
    schema: dict[str, Any] = tool.output_schema or {}
    props = schema.get("properties")
    if not isinstance(props, dict):
        return {}
    return {str(k): v for k, v in props.items() if isinstance(v, dict)}


def _json_type(prop_schema: dict[str, Any]) -> str | None:
    """Pull the canonical JSON-Schema `type` out of a property dict.

    Pydantic emits the type as a string under `"type"` for primitives,
    or via `"anyOf"`/`"$ref"` for unions and refs. We only need a
    canonical name for the type-mismatch comparison so anything that
    doesn't have a plain `type` is treated as `None` (no comparison).
    """
    type_value = prop_schema.get("type")
    if isinstance(type_value, str):
        return type_value
    return None


def _is_user_providable(prop_schema: dict[str, Any]) -> bool:
    """Per-param opt-out for the unreachable check.

    A property marked `"x-user-providable": true` in its JSON Schema
    is considered satisfiable by the end user typing it in chat. Tools
    that take free-form user input should set this on every param the
    LLM can prompt for.
    """
    return bool(prop_schema.get("x-user-providable") is True)


# ---- 1. unreachable parameters / 2. type mismatches / 7. ambiguous --


def check_param_sources(
    tools: list[ToolDef],
) -> list[Finding]:
    """Combined check for rules 1, 2, and 7 — they all walk the same
    graph (every required input param ↔ every other tool's output) so
    rolling them into one pass avoids three full O(N²) scans.
    """
    findings: list[Finding] = []

    # Map output_field_name → list of producing tool names. Used by
    # the duplicate-output check (rule 7) and the source lookup.
    output_index: dict[str, list[tuple[str, str | None]]] = {}
    for tool in tools:
        for field_name, prop_schema in _output_properties(tool).items():
            output_index.setdefault(field_name, []).append((tool.name, _json_type(prop_schema)))

    # Rule 7: ambiguous outputs (multiple tools return the same field).
    for field_name, producers in output_index.items():
        if len(producers) > 1:
            names = ", ".join(sorted(p[0] for p in producers))
            findings.append(
                Finding(
                    severity="info",
                    code="ambiguous_output",
                    message=f"field {field_name!r} is returned by {len(producers)} tools: {names}",
                )
            )

    for tool in tools:
        required = _required_param_names(tool)
        properties = _input_properties(tool)
        for param_name in sorted(required):
            prop_schema = properties.get(param_name, {})
            user_providable = _is_user_providable(prop_schema)
            param_type = _json_type(prop_schema)

            sources = output_index.get(param_name, [])
            external_sources = [s for s in sources if s[0] != tool.name]

            if not external_sources and not user_providable:
                # Rule 1: unreachable.
                findings.append(
                    Finding(
                        severity="error",
                        code="unreachable_param",
                        message=f"{tool.name}.{param_name} has no source — no other tool outputs this field and the param is not marked user-providable",
                        tool=tool.name,
                        param=param_name,
                    )
                )
                continue

            if param_type is None:
                continue
            # Rule 2: type mismatches — compare against every producer.
            for producer_name, producer_type in external_sources:
                if producer_type and producer_type != param_type:
                    findings.append(
                        Finding(
                            severity="warning",
                            code="type_mismatch",
                            message=(
                                f"{tool.name}.{param_name} expects {param_type!r} but "
                                f"{producer_name} returns {producer_type!r}"
                            ),
                            tool=tool.name,
                            param=param_name,
                        )
                    )

    return findings


# ---- 3. circular dependencies ----------------------------------------


def check_circular_dependencies(tools: list[ToolDef]) -> list[Finding]:
    """DFS cycle detection on the dependency graph.

    Edges: tool A → tool B if B's output schema produces a field that
    matches one of A's required input parameter names. A cycle in
    that graph means the LLM can't pick a starting point — flagged
    as ERROR.

    The DFS is intentionally recursive — Python's default recursion
    limit (1000) caps cycle depth at 1000 tools, and a single SDK
    consumer is realistically capped at ~hundreds of tools by smart
    selection budgets long before that. The iterative rewrite is a
    PLATOS-32 follow-up if a customer ever ships a registry that
    deep, which the doctor itself would flag as `overly_broad` long
    before the recursion limit becomes a concern.
    """
    output_producers: dict[str, set[str]] = {}
    for tool in tools:
        for field_name in _output_properties(tool):
            output_producers.setdefault(field_name, set()).add(tool.name)

    deps: dict[str, set[str]] = {t.name: set() for t in tools}
    for tool in tools:
        for param_name in _required_param_names(tool):
            for producer in output_producers.get(param_name, set()):
                if producer != tool.name:
                    deps[tool.name].add(producer)

    findings: list[Finding] = []
    seen_cycles: set[tuple[str, ...]] = set()

    # Tri-color DFS — `unvisited` / `in_stack` / `done` rather than the
    # textbook WHITE/GRAY/BLACK so the linter is happy with PEP8 names.
    unvisited, in_stack, done = 0, 1, 2
    color: dict[str, int] = {name: unvisited for name in deps}
    stack: list[str] = []

    def visit(node: str) -> None:
        color[node] = in_stack
        stack.append(node)
        for neighbor in sorted(deps[node]):
            if color.get(neighbor, unvisited) == in_stack:
                # Found a back-edge → cycle. Extract the slice of the
                # stack from `neighbor` to the current node.
                idx = stack.index(neighbor)
                cycle = tuple(stack[idx:])
                # Canonicalize so a 2-cycle isn't reported twice.
                canonical = tuple(sorted(cycle))
                if canonical not in seen_cycles:
                    seen_cycles.add(canonical)
                    # Emit one finding per cycle member so the
                    # reporter's "healthy count" subtracts every tool
                    # in the cycle, not just the one we happened to
                    # walk into. PLATOS-18 reviewer caught this:
                    # without per-tool attribution, a 5-tool cycle
                    # showed as "5 healthy" because tool=None.
                    rendered = " → ".join((*cycle, neighbor))
                    for member in cycle:
                        findings.append(
                            Finding(
                                severity="error",
                                code="circular_dependency",
                                message=f"circular dependency: {rendered}",
                                tool=member,
                            )
                        )
            elif color.get(neighbor, unvisited) == unvisited:
                visit(neighbor)
        stack.pop()
        color[node] = done

    for name in sorted(deps):
        if color[name] == unvisited:
            visit(name)
    return findings


# ---- 4. orphan tools --------------------------------------------------


def check_orphan_tools(
    tools: list[ToolDef], *, agent_tool_names: set[str] | None = None
) -> list[Finding]:
    """Tools registered locally but not assigned to any agent.

    Requires an `agent_tool_names` set fetched from the platform API
    (or None to skip — local-only `platools doctor` runs don't have
    agent context). When None, the check is a no-op.
    """
    if agent_tool_names is None:
        return []
    return [
        Finding(
            severity="info",
            code="orphan_tool",
            message=f"{tool.name} is not assigned to any agent",
            tool=tool.name,
        )
        for tool in tools
        if tool.name not in agent_tool_names
    ]


# ---- 5. missing descriptions ------------------------------------------


def check_descriptions(tools: list[ToolDef]) -> list[Finding]:
    findings: list[Finding] = []
    for tool in tools:
        desc = (tool.description or "").strip()
        if len(desc) < _MIN_DESCRIPTION_CHARS:
            findings.append(
                Finding(
                    severity="warning",
                    code="short_tool_description",
                    message=f"{tool.name} description is too short ({len(desc)} chars, need ≥ {_MIN_DESCRIPTION_CHARS})",
                    tool=tool.name,
                )
            )
        for param_name, prop_schema in _input_properties(tool).items():
            param_desc = str(prop_schema.get("description") or "").strip()
            if len(param_desc) < _MIN_DESCRIPTION_CHARS:
                findings.append(
                    Finding(
                        severity="warning",
                        code="short_param_description",
                        message=f"{tool.name}.{param_name} description is too short ({len(param_desc)} chars)",
                        tool=tool.name,
                        param=param_name,
                    )
                )
    return findings


# ---- 6. no return schema ----------------------------------------------


def check_return_schema(tools: list[ToolDef]) -> list[Finding]:
    return [
        Finding(
            severity="warning",
            code="no_return_schema",
            message=f"{tool.name} has no typed return value — downstream tools can't depend on it",
            tool=tool.name,
        )
        for tool in tools
        if not tool.output_schema
    ]


# ---- 8. permission gaps -----------------------------------------------


def check_permission_gaps(
    tools: list[ToolDef], *, roles_in_use: set[str] | None = None
) -> list[Finding]:
    """Tools that require a role no agent in the org has assigned.

    Like `check_orphan_tools`, this needs context the SDK doesn't have
    locally. The CLI fetches `roles_in_use` from the platform API when
    `--platform-url` is set; local-only runs skip the check.
    """
    if roles_in_use is None:
        return []
    findings: list[Finding] = []
    for tool in tools:
        for role in tool.roles:
            if role not in roles_in_use:
                findings.append(
                    Finding(
                        severity="warning",
                        code="permission_gap",
                        message=f"{tool.name} requires role {role!r}, no agent has this role",
                        tool=tool.name,
                    )
                )
    return findings


# ---- 9. overly broad tools --------------------------------------------


def check_overly_broad(tools: list[ToolDef]) -> list[Finding]:
    findings: list[Finding] = []
    for tool in tools:
        param_count = len(_input_properties(tool))
        if param_count > _MAX_PARAMS_BEFORE_BROAD:
            findings.append(
                Finding(
                    severity="info",
                    code="overly_broad_tool",
                    message=f"{tool.name} has {param_count} parameters (consider splitting — > {_MAX_PARAMS_BEFORE_BROAD} may confuse the LLM)",
                    tool=tool.name,
                )
            )
    return findings


# ---- 10. missing destructive annotations ------------------------------


def check_destructive_annotations(tools: list[ToolDef]) -> list[Finding]:
    findings: list[Finding] = []
    for tool in tools:
        name_lower = tool.name.lower()
        looks_destructive = any(token in name_lower for token in _DESTRUCTIVE_NAME_TOKENS)
        if not looks_destructive:
            continue
        if not tool.annotations.get("destructiveHint"):
            findings.append(
                Finding(
                    severity="warning",
                    code="missing_destructive_hint",
                    message=f"{tool.name} looks destructive but is missing annotations.destructiveHint=true",
                    tool=tool.name,
                )
            )
    return findings


# ---- registration helper ---------------------------------------------


def all_checks() -> Iterable[str]:
    """Names of every check function exported by this module — used by
    the analyzer to enumerate checks for the report header.
    """
    return (
        "check_param_sources",
        "check_circular_dependencies",
        "check_orphan_tools",
        "check_descriptions",
        "check_return_schema",
        "check_permission_gaps",
        "check_overly_broad",
        "check_destructive_annotations",
    )
