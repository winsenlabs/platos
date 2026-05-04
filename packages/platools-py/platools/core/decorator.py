"""`@platools.tool()` decorator implementation.

The decorator:
  1. Inspects the wrapped function
  2. Builds input + output JSON Schemas via `platools.core.schema`
  3. Creates a `ToolDef` carrying name, description, schemas, auth, roles,
     rate_limit, timeout, annotations
  4. Registers the tool in the `Platools` instance's registry
  5. Returns the original function unchanged — decorated functions remain
     directly callable in user code

Supports both sync and async functions.
"""

from __future__ import annotations

import inspect
from collections.abc import Callable
from typing import Any, TypeVar

from platools.core.registry import ToolRegistry
from platools.core.schema import auto_description, build_input_schema, build_output_schema
from platools.types import AuthLevel, ToolDef

F = TypeVar("F", bound=Callable[..., Any])


_VALID_AUTH: frozenset[str] = frozenset(("none", "user", "admin"))

# CTX.5: parameter names the decorator recognizes as "inject the
# `PlatosContext` here". ``ctx`` is the canonical name; ``platos_ctx``
# is offered as a namespaced alternative for handlers that already use
# ``ctx`` for something else.
_CTX_PARAM_NAMES: frozenset[str] = frozenset(("ctx", "platos_ctx"))


def _detect_ctx_param(func: Callable[..., Any]) -> str | None:
    """Return the parameter name to inject the :class:`PlatosContext` into.

    CTX.5 opt-in: if the function signature has a parameter named
    ``ctx`` (or ``platos_ctx``), the transport layer injects the
    per-call context under that kwarg; the tool-call params arriving
    over the wire never carry ``ctx`` themselves. Returns ``None`` when
    the handler doesn't opt in, in which case the transport dispatches
    via kwargs only (historical behavior preserved).
    """
    import inspect as _inspect

    try:
        sig = _inspect.signature(func)
    except (TypeError, ValueError):
        return None
    for name in sig.parameters:
        if name in _CTX_PARAM_NAMES:
            return name
    return None


def make_tool_decorator(registry: ToolRegistry) -> Callable[..., Callable[[F], F]]:
    """Return a decorator factory bound to the given registry.

    `Platools.tool` is assigned from this so each `Platools()` instance
    has its own registry while sharing the same decorator logic.
    """

    def tool(
        *,
        name: str | None = None,
        description: str | None = None,
        auth: AuthLevel = "none",
        roles: list[str] | tuple[str, ...] | None = None,
        rate_limit: str | None = None,
        timeout: int | None = None,
        annotations: dict[str, Any] | None = None,
    ) -> Callable[[F], F]:
        if auth not in _VALID_AUTH:
            raise ValueError(f"auth must be one of {sorted(_VALID_AUTH)}, got {auth!r}")
        if timeout is not None and timeout <= 0:
            raise ValueError(f"timeout must be positive, got {timeout}")

        def decorator(func: F) -> F:
            tool_name = name or func.__name__
            tool_description = description or auto_description(func)
            input_schema = build_input_schema(func)
            output_schema = build_output_schema(func)
            tool_def = ToolDef(
                name=tool_name,
                description=tool_description,
                func=func,
                input_schema=input_schema,
                output_schema=output_schema,
                auth=auth,
                roles=tuple(roles or ()),
                rate_limit=rate_limit,
                timeout=timeout,
                annotations=dict(annotations or {}),
                is_async=inspect.iscoroutinefunction(func),
                ctx_param_name=_detect_ctx_param(func),
            )
            registry.register(tool_def)
            return func

        return decorator

    return tool
