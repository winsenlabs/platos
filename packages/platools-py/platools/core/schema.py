"""Type-hint → JSON Schema conversion for Platools tools.

Strategy:

  1. Introspect the function with `inspect.signature()` + `typing.get_type_hints()`
     (we pass `include_extras=True` so `Annotated[...]` metadata is preserved).
  2. Build a dynamic Pydantic model whose fields match the function params,
     carrying `Field(description=...)` pulled from the parsed docstring.
  3. Call `model.model_json_schema()` and hand back the resulting dict.

Everything Pydantic already handles — `Literal`, `Optional`, `Union`,
`list[T]`, `dict[K, V]`, enums, nested `BaseModel`, `Annotated[T, Field(...)]`,
`pydantic.StrictInt` et al. — we get for free.
"""

from __future__ import annotations

import inspect
from collections.abc import Callable
from typing import Any, get_type_hints

import docstring_parser
from pydantic import Field, create_model
from pydantic.fields import FieldInfo


class SchemaError(ValueError):
    """Raised when a decorated function can't be converted to a JSON Schema."""


def _param_descriptions(docstring: str | None) -> dict[str, str]:
    """Extract a `{param_name: description}` map from a docstring.

    Supports Google / NumPy / Sphinx styles via `docstring_parser`.
    """
    if not docstring:
        return {}
    parsed = docstring_parser.parse(docstring)
    return {p.arg_name: p.description for p in parsed.params if p.description is not None}


def _tool_description(docstring: str | None) -> str:
    if not docstring:
        return ""
    parsed = docstring_parser.parse(docstring)
    parts: list[str] = []
    if parsed.short_description:
        parts.append(parsed.short_description)
    if parsed.long_description:
        parts.append(parsed.long_description)
    return "\n\n".join(parts)


def _return_type(hints: dict[str, Any]) -> Any:
    return hints.get("return", type(None))


def _annotated_field_info(annotation: Any) -> FieldInfo | None:
    """Return the `FieldInfo` embedded in `Annotated[T, Field(...)]`, if any."""
    metadata = getattr(annotation, "__metadata__", None)
    if metadata is None:
        return None
    for item in metadata:
        if isinstance(item, FieldInfo):
            return item
    return None


def build_input_schema(func: Callable[..., Any]) -> dict[str, Any]:
    """Return the MCP `input_schema` for `func`.

    Raises `SchemaError` if any non-self/cls parameter lacks a type hint.
    """
    signature = inspect.signature(func)
    try:
        hints = get_type_hints(func, include_extras=True)
    except Exception as exc:  # noqa: BLE001
        raise SchemaError(f"could not resolve type hints for {func.__name__}: {exc}") from exc

    param_docs = _param_descriptions(func.__doc__)
    fields: dict[str, tuple[Any, Any]] = {}
    for name, param in signature.parameters.items():
        if name in ("self", "cls"):
            continue
        # CTX.5: ``ctx`` / ``platos_ctx`` is the opt-in per-call handler
        # context param — injected by the transport layer, never part
        # of the tool's wire schema. Skip it here so it doesn't appear
        # as a required argument to the LLM.
        if name in ("ctx", "platos_ctx"):
            continue
        if param.kind in (
            inspect.Parameter.VAR_POSITIONAL,
            inspect.Parameter.VAR_KEYWORD,
        ):
            raise SchemaError(
                f"{func.__name__}: *args / **kwargs are not supported in tool signatures"
            )
        if name not in hints:
            raise SchemaError(
                f"{func.__name__}.{name} has no type hint — every tool parameter must be typed"
            )

        annotation = hints[name]
        description = param_docs.get(name)
        default = param.default if param.default is not inspect.Parameter.empty else ...

        annotated_field = _annotated_field_info(annotation)
        if annotated_field is not None:
            # `Annotated[T, Field(...)]` — respect the embedded FieldInfo
            # and inject the docstring description only if the user did
            # not already supply one. Pydantic picks up the Annotated
            # Field automatically when we pass `...` as the field default.
            if description and not annotated_field.description:
                annotated_field.description = description
            fields[name] = (annotation, ...)
        elif isinstance(default, FieldInfo):
            field_info = default
            if description and not field_info.description:
                field_info.description = description
            fields[name] = (annotation, field_info)
        elif default is ...:
            # Required param — use positional Ellipsis form so mypy picks
            # the right Field overload.
            fields[name] = (annotation, Field(..., description=description))
        else:
            fields[name] = (
                annotation,
                Field(default=default, description=description),
            )

    model_name = f"{func.__name__}__input"
    model = create_model(model_name, **fields)  # type: ignore[call-overload]
    schema: dict[str, Any] = model.model_json_schema()
    # Pydantic's auto-generated $defs work fine for MCP clients, but we can
    # trim the outer title (which leaks the `__input` suffix into the UI).
    schema.pop("title", None)
    return schema


def build_output_schema(func: Callable[..., Any]) -> dict[str, Any] | None:
    """Return the output JSON Schema for `func`, or None if no return hint."""
    try:
        hints = get_type_hints(func, include_extras=True)
    except Exception:  # noqa: BLE001
        return None
    return_type = _return_type(hints)
    if return_type is type(None) or return_type is None:
        return None

    model = create_model(
        f"{func.__name__}__output",
        result=(return_type, ...),
    )
    schema: dict[str, Any] = model.model_json_schema()
    # Return the bare field schema, not the wrapping model.
    raw: Any = schema.get("properties", {}).get("result")
    if raw is None:
        return None
    result_schema: dict[str, Any] = raw
    if "$defs" in schema:
        result_schema["$defs"] = schema["$defs"]
    return result_schema


def auto_description(func: Callable[..., Any]) -> str:
    """Derive a tool description from the function's docstring."""
    return _tool_description(func.__doc__)
