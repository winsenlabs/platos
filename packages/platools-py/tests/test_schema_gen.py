"""Schema generation tests — locks the type-hint → JSON Schema contract.

Intentionally NOT using `from __future__ import annotations` here. With
PEP 563 strings, `get_type_hints()` can't resolve types defined in local
(test-function) scope, and these tests want to prove local Pydantic
models work in production SDK code that is NOT forward-annotated.
"""

from enum import StrEnum
from typing import Annotated, Literal

import pytest
from platools import Platools, SchemaError
from pydantic import BaseModel, Field


def test_basic_types_become_json_schema() -> None:
    p = Platools()

    @p.tool()
    def echo(name: str, count: int, ratio: float, enabled: bool) -> str:
        """Echo the inputs.

        Args:
            name: Who to greet.
            count: How many times.
            ratio: A float.
            enabled: Whether enabled.
        """
        return name * count

    tool = p.get_tool("echo")
    assert tool is not None
    schema = tool.input_schema
    assert schema["type"] == "object"
    assert schema["properties"]["name"]["type"] == "string"
    assert schema["properties"]["count"]["type"] == "integer"
    assert schema["properties"]["ratio"]["type"] == "number"
    assert schema["properties"]["enabled"]["type"] == "boolean"
    # Every param is required (no default).
    assert set(schema["required"]) == {"name", "count", "ratio", "enabled"}
    # Docstring descriptions propagate.
    assert schema["properties"]["name"]["description"] == "Who to greet."


def test_optional_and_default() -> None:
    p = Platools()

    @p.tool()
    def search(query: str, limit: int = 10) -> list[str]:
        """Search."""
        return []

    tool = p.get_tool("search")
    assert tool is not None
    schema = tool.input_schema
    assert schema["required"] == ["query"]
    assert schema["properties"]["limit"]["default"] == 10


class _Severity(StrEnum):
    LOW = "low"
    HIGH = "high"


def test_literal_and_enum() -> None:
    p = Platools()

    @p.tool()
    def alert(level: Literal["info", "warn", "critical"], severity: _Severity) -> None:
        """Fire an alert."""

    tool = p.get_tool("alert")
    assert tool is not None
    schema = tool.input_schema
    assert set(schema["properties"]["level"]["enum"]) == {"info", "warn", "critical"}
    # Enum is represented via $ref to the _Severity definition.
    assert (
        "$ref" in schema["properties"]["severity"]
        or schema["properties"]["severity"].get("enum") is not None
    )


class _Order(BaseModel):
    id: str
    total_cents: int


def test_pydantic_model_as_param() -> None:
    p = Platools()

    @p.tool()
    def submit(order: _Order, note: str | None = None) -> bool:
        """Submit an order."""
        return True

    tool = p.get_tool("submit")
    assert tool is not None
    schema = tool.input_schema
    # The _Order model lands in $defs.
    assert "$defs" in schema
    assert "_Order" in schema["$defs"]
    assert schema["properties"]["order"]["$ref"].endswith("/_Order")
    # Nullable param is optional.
    assert "note" not in schema["required"]


def test_annotated_field_metadata() -> None:
    p = Platools()

    @p.tool()
    def price(
        cents: Annotated[int, Field(ge=0, description="Price in cents")],
    ) -> int:
        """Compute a price."""
        return cents

    tool = p.get_tool("price")
    assert tool is not None
    schema = tool.input_schema
    assert schema["properties"]["cents"]["minimum"] == 0
    assert schema["properties"]["cents"]["description"] == "Price in cents"


def test_untyped_param_raises() -> None:
    p = Platools()

    with pytest.raises(SchemaError, match="has no type hint"):

        @p.tool()
        def broken(x) -> str:  # type: ignore[no-untyped-def]
            return "nope"


def test_varargs_kwargs_rejected() -> None:
    p = Platools()

    with pytest.raises(SchemaError, match="not supported"):

        @p.tool()
        def broken(*args: int) -> int:
            return sum(args)


def test_async_function_support() -> None:
    p = Platools()

    @p.tool()
    async def fetch(url: str) -> str:
        """Fetch a URL."""
        return url

    tool = p.get_tool("fetch")
    assert tool is not None
    assert tool.is_async is True


class _RefundResult(BaseModel):
    refund_id: str
    amount_cents: int


def test_output_schema_captured() -> None:
    p = Platools()

    @p.tool()
    def refund(order_id: str) -> _RefundResult:
        """Process a refund."""
        return _RefundResult(refund_id="r", amount_cents=0)

    tool = p.get_tool("refund")
    assert tool is not None
    assert tool.output_schema is not None
    # The output schema includes $defs pointing at _RefundResult.
    assert "$defs" in tool.output_schema
    assert "_RefundResult" in tool.output_schema["$defs"]


def test_none_return_has_no_output_schema() -> None:
    p = Platools()

    @p.tool()
    def noop(x: int) -> None:
        """Does nothing."""

    tool = p.get_tool("noop")
    assert tool is not None
    assert tool.output_schema is None
