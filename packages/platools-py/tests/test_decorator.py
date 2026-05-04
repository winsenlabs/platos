"""Decorator + registry behavior tests."""

from __future__ import annotations

import pytest
from platools import Platools, ToolSchema


def test_decorator_returns_callable_unchanged() -> None:
    p = Platools()

    @p.tool()
    def greet(name: str) -> str:
        """Greet someone."""
        return f"hi {name}"

    assert greet("world") == "hi world"  # still directly callable


def test_tools_dict_is_populated() -> None:
    p = Platools()

    @p.tool()
    def a(x: int) -> int:
        """First."""
        return x

    @p.tool(name="renamed")
    def b(y: int) -> int:
        """Second."""
        return y

    assert set(p.tools) == {"a", "renamed"}
    assert p.tools["a"].name == "a"
    assert p.tools["renamed"].name == "renamed"


def test_decorator_params() -> None:
    p = Platools()

    @p.tool(
        description="Explicit description",
        auth="admin",
        roles=["support"],
        rate_limit="100/min",
        timeout=30,
        annotations={"readOnlyHint": True},
    )
    def restricted(query: str) -> str:
        """Docstring description (should be overridden)."""
        return query

    tool = p.get_tool("restricted")
    assert tool is not None
    assert tool.description == "Explicit description"
    assert tool.auth == "admin"
    assert tool.roles == ("support",)
    assert tool.rate_limit == "100/min"
    assert tool.timeout == 30
    assert tool.annotations == {"readOnlyHint": True}


def test_invalid_auth_rejected() -> None:
    p = Platools()

    with pytest.raises(ValueError, match="auth must be one of"):

        @p.tool(auth="root")  # runtime value — intentionally violates AuthLevel
        def forbidden(x: int) -> int:
            return x


def test_invalid_timeout_rejected() -> None:
    p = Platools()

    with pytest.raises(ValueError, match="timeout must be positive"):

        @p.tool(timeout=0)
        def bad(x: int) -> int:
            return x


def test_duplicate_tool_name_rejected() -> None:
    p = Platools()

    @p.tool()
    def foo(x: int) -> int:
        """First."""
        return x

    with pytest.raises(ValueError, match="already registered"):

        @p.tool(name="foo")
        def other(x: int) -> int:
            return x


def test_get_mcp_schemas_returns_list() -> None:
    p = Platools()

    @p.tool()
    def a(x: int) -> int:
        """First."""
        return x

    @p.tool()
    def b(y: str) -> str:
        """Second."""
        return y

    schemas = p.get_mcp_schemas()
    assert len(schemas) == 2
    assert all(isinstance(s, ToolSchema) for s in schemas)
    assert {s.name for s in schemas} == {"a", "b"}


def test_env_var_fallback() -> None:
    import os

    os.environ["PLATOS_URL"] = "http://env-url"
    os.environ["PLATOS_SECRET"] = "env-secret"
    try:
        p = Platools()
        assert p.url == "http://env-url"
        assert p.secret == "env-secret"
    finally:
        del os.environ["PLATOS_URL"]
        del os.environ["PLATOS_SECRET"]


def test_explicit_config_overrides_env() -> None:
    import os

    os.environ["PLATOS_URL"] = "http://env-url"
    try:
        p = Platools(url="http://explicit")
        assert p.url == "http://explicit"
    finally:
        del os.environ["PLATOS_URL"]


def test_independent_registries() -> None:
    a = Platools()
    b = Platools()

    @a.tool()
    def only_in_a(x: int) -> int:
        """A only."""
        return x

    @b.tool()
    def only_in_b(x: int) -> int:
        """B only."""
        return x

    assert set(a.tools) == {"only_in_a"}
    assert set(b.tools) == {"only_in_b"}
