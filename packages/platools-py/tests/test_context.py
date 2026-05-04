"""Per-call context (Theme C) tests.

Verifies the three Theme C invariants on the Python side:

  1. `__platos` is popped from the kwargs before the handler runs —
     handlers never see the envelope in their own parameter dict.
  2. `current_user_id()` / `current_context()` etc. return the
     envelope's values while the handler is executing.
  3. The ContextVars are cleared after the handler returns so the
     next call sees a clean slate (no bleed-over between calls,
     including between concurrent tasks).
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from platools import Platools
from platools.context import (
    PlatosCallContext,
    PlatosContext,
    _reset_current_context,
    _set_current_context,
    build_platos_context,
    current_agent_id,
    current_call_id,
    current_context,
    current_entity_id,
    current_scope,
    current_thread_id,
    current_user_id,
    current_user_token,
)
from platools.transport.client import PlatoolsClient


ENVELOPE: dict[str, object] = {
    "organizationId": "org_123",
    "projectId": "proj_abc",
    "environmentId": "env_dev",
    "entityId": "ent_main",
    "userId": "user_42",
    "userToken": "tok_secret",
    "agentId": "agent_orders",
    "threadId": "thr_xyz",
    "callId": "call_001",
    "timestamp": "2026-04-17T12:00:00Z",
    "signature": "abc123",
}


# ──────────────────────────────────────────────────────────────────
# Direct ContextVar plumbing (isolated from transport)
# ──────────────────────────────────────────────────────────────────


def test_accessors_return_none_outside_call() -> None:
    assert current_user_id() is None
    assert current_user_token() is None
    assert current_thread_id() is None
    assert current_agent_id() is None
    assert current_entity_id() is None
    assert current_call_id() is None
    assert current_context() is None
    assert current_scope() == (None, None, None)


def test_set_and_reset_round_trip() -> None:
    tokens = _set_current_context(dict(ENVELOPE))
    try:
        assert current_user_id() == "user_42"
        assert current_user_token() == "tok_secret"
        assert current_thread_id() == "thr_xyz"
        assert current_agent_id() == "agent_orders"
        assert current_entity_id() == "ent_main"
        assert current_call_id() == "call_001"
        assert current_scope() == ("org_123", "proj_abc", "env_dev")

        ctx = current_context()
        assert isinstance(ctx, PlatosCallContext)
        assert ctx.organization_id == "org_123"
        assert ctx.project_id == "proj_abc"
        assert ctx.environment_id == "env_dev"
        assert ctx.entity_id == "ent_main"
        assert ctx.user_id == "user_42"
        assert ctx.user_token == "tok_secret"
        assert ctx.agent_id == "agent_orders"
        assert ctx.thread_id == "thr_xyz"
        assert ctx.call_id == "call_001"
        assert ctx.timestamp == "2026-04-17T12:00:00Z"
        assert ctx.signature == "abc123"
    finally:
        _reset_current_context(tokens)

    # After reset: back to clean slate.
    assert current_user_id() is None
    assert current_context() is None


def test_envelope_without_user_token_sets_none() -> None:
    env = {k: v for k, v in ENVELOPE.items() if k != "userToken"}
    tokens = _set_current_context(env)
    try:
        assert current_user_token() is None
        ctx = current_context()
        assert ctx is not None
        assert ctx.user_token is None
    finally:
        _reset_current_context(tokens)


def test_partial_envelope_returns_none_from_current_context() -> None:
    # Missing a required field — current_context() should refuse to
    # fabricate a partial object (invariant: "typed shape or nothing").
    partial = {"organizationId": "o", "projectId": "p"}  # missing rest
    tokens = _set_current_context(partial)
    try:
        assert current_context() is None
        # But narrower accessors still reflect what was set.
        assert current_scope()[0] == "o"
        assert current_scope()[1] == "p"
        assert current_scope()[2] is None
    finally:
        _reset_current_context(tokens)


# ──────────────────────────────────────────────────────────────────
# Transport-level dispatch behavior
# ──────────────────────────────────────────────────────────────────


class _FakeWs:
    """Minimal stand-in for `websockets.asyncio.client.ClientConnection`.

    Captures everything the client `.send()`s so the test can assert
    on the wire-level response. We don't need the full protocol — only
    `.send()` is exercised by `_dispatch_call`.
    """

    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send(self, payload: str) -> None:
        self.sent.append(payload)


def _make_client() -> PlatoolsClient:
    p = Platools(url="http://example", secret="s")
    return PlatoolsClient(url="http://example", secret="s", registry=p.registry)


async def test_dispatch_pops_envelope_and_sets_contextvars() -> None:
    p = Platools(url="http://example", secret="s")
    seen_kwargs: dict[str, Any] = {}
    seen_user: str | None = None
    seen_ctx: PlatosCallContext | None = None

    @p.tool()
    async def process(order_id: str) -> dict[str, Any]:
        """Process an order. order_id: the id to process."""
        nonlocal seen_user, seen_ctx
        seen_kwargs.update(order_id=order_id)
        seen_user = current_user_id()
        seen_ctx = current_context()
        return {"ok": True}

    client = PlatoolsClient(url="http://example", secret="s", registry=p.registry)
    ws = _FakeWs()
    # Build a ToolCallMessage mimicking what the platform would send.
    from platools.transport.protocol import ToolCallMessage

    call = ToolCallMessage(
        call_id="call_001",
        tool_name="process",
        params={"order_id": "ord_9", "__platos": dict(ENVELOPE)},
    )
    await client._dispatch_call(ws, call)  # pyright: ignore[reportPrivateUsage]

    # Handler never saw `__platos` in its kwargs.
    assert seen_kwargs == {"order_id": "ord_9"}
    # Context was populated during the call.
    assert seen_user == "user_42"
    assert seen_ctx is not None
    assert seen_ctx.organization_id == "org_123"
    assert seen_ctx.user_token == "tok_secret"
    # Exactly one tool_result on the wire; no tool_error.
    assert len(ws.sent) == 1
    payload = json.loads(ws.sent[0])
    assert payload["type"] == "tool_result"
    # Context is cleared after the handler returned.
    assert current_user_id() is None
    assert current_context() is None


async def test_dispatch_without_envelope_still_runs_handler() -> None:
    """Older servers / unit-test harnesses may not inject `__platos`.

    The handler should still run, but every context accessor returns
    None because nothing was set. PPR-30 removed the `envelope
    .setdefault("callId", call.call_id)` shim — the server
    (`tool-executor.service.ts`) now always injects `callId` into the
    envelope itself, so the SDK no longer synthesizes it from the outer
    wire-frame.
    """
    p = Platools(url="http://example", secret="s")
    observed_call_id: str | None = "sentinel"  # must get overwritten
    observed_user: str | None = "sentinel"

    @p.tool()
    def ping(v: int) -> int:
        """Ping. v: anything."""
        nonlocal observed_call_id, observed_user
        observed_call_id = current_call_id()
        observed_user = current_user_id()
        return v

    client = PlatoolsClient(url="http://example", secret="s", registry=p.registry)
    ws = _FakeWs()
    from platools.transport.protocol import ToolCallMessage

    call = ToolCallMessage(call_id="call_xyz", tool_name="ping", params={"v": 7})
    await client._dispatch_call(ws, call)  # pyright: ignore[reportPrivateUsage]

    # PPR-30: no envelope → no context seeded → every accessor is None.
    # (The outer wire-frame `call_id` is *not* synthesized back into the
    # envelope anymore — the server is responsible for shipping it.)
    assert observed_call_id is None
    assert observed_user is None
    payload = json.loads(ws.sent[0])
    assert payload["type"] == "tool_result"
    assert payload["result"] == 7


async def test_concurrent_calls_do_not_leak_context() -> None:
    """Invariant: ContextVars must be scope-local to a single task.

    Fire two `_dispatch_call`s concurrently (via asyncio.gather — each
    gets its own Task frame). Each handler should observe only its
    own envelope's values, never the other's. Any leakage here would
    be a Theme C review-gate blocker.
    """
    p = Platools(url="http://example", secret="s")
    observed: list[tuple[str, str | None, str | None]] = []

    @p.tool()
    async def slow(name: str) -> str:
        """Slow tool. name: input."""
        # Deliberately yield twice so the two coroutines are guaranteed
        # to interleave on the event loop.
        await asyncio.sleep(0)
        observed.append((name, current_user_id(), current_call_id()))
        await asyncio.sleep(0)
        observed.append((name, current_user_id(), current_call_id()))
        return f"done-{name}"

    client = PlatoolsClient(url="http://example", secret="s", registry=p.registry)
    from platools.transport.protocol import ToolCallMessage

    ws_a = _FakeWs()
    ws_b = _FakeWs()
    call_a = ToolCallMessage(
        call_id="call_A",
        tool_name="slow",
        params={
            "name": "alpha",
            "__platos": {**ENVELOPE, "userId": "user_A", "callId": "call_A"},
        },
    )
    call_b = ToolCallMessage(
        call_id="call_B",
        tool_name="slow",
        params={
            "name": "beta",
            "__platos": {**ENVELOPE, "userId": "user_B", "callId": "call_B"},
        },
    )
    await asyncio.gather(
        client._dispatch_call(ws_a, call_a),  # pyright: ignore[reportPrivateUsage]
        client._dispatch_call(ws_b, call_b),  # pyright: ignore[reportPrivateUsage]
    )

    # Every (name, user, call) triple must be internally consistent —
    # i.e. the alpha handler only ever sees user_A/call_A; beta only
    # ever sees user_B/call_B. Any mismatch is a context leak.
    for name, user, cid in observed:
        if name == "alpha":
            assert user == "user_A"
            assert cid == "call_A"
        else:
            assert name == "beta"
            assert user == "user_B"
            assert cid == "call_B"

    # And after everything, context is clean again.
    assert current_user_id() is None
    assert current_call_id() is None


async def test_dispatch_resets_context_even_on_handler_error() -> None:
    p = Platools(url="http://example", secret="s")

    @p.tool()
    async def explodes() -> None:
        """Boom."""
        assert current_user_id() == "user_42"
        raise RuntimeError("handler failed")

    client = PlatoolsClient(url="http://example", secret="s", registry=p.registry)
    ws = _FakeWs()
    from platools.transport.protocol import ToolCallMessage

    call = ToolCallMessage(
        call_id="call_X",
        tool_name="explodes",
        params={"__platos": dict(ENVELOPE)},
    )
    await client._dispatch_call(ws, call)  # pyright: ignore[reportPrivateUsage]

    # Wire response should be a tool_error.
    payload = json.loads(ws.sent[0])
    assert payload["type"] == "tool_error"
    # Critically, context is still cleaned up.
    assert current_user_id() is None
    assert current_context() is None


async def test_missing_unknown_tool_does_not_touch_context() -> None:
    """An unknown tool short-circuits before we set any vars; confirm
    the accessor still returns None (no spurious set/reset that could
    hide a bug)."""
    p = Platools(url="http://example", secret="s")
    client = PlatoolsClient(url="http://example", secret="s", registry=p.registry)
    ws = _FakeWs()
    from platools.transport.protocol import ToolCallMessage

    call = ToolCallMessage(
        call_id="c",
        tool_name="does_not_exist",
        params={"__platos": dict(ENVELOPE)},
    )
    await client._dispatch_call(ws, call)  # pyright: ignore[reportPrivateUsage]

    payload = json.loads(ws.sent[0])
    assert payload["type"] == "tool_error"
    assert current_user_id() is None


async def test_partial_envelope_is_tolerated() -> None:
    """An older server may forward an envelope missing optional fields.

    The handler should still run; the scope tuple should carry what was
    present and `None` elsewhere."""
    p = Platools(url="http://example", secret="s")
    seen_scope: tuple[str | None, str | None, str | None] = (None, None, None)

    @p.tool()
    async def peek() -> dict[str, Any]:
        """Peek."""
        nonlocal seen_scope
        seen_scope = current_scope()
        return {}

    client = PlatoolsClient(url="http://example", secret="s", registry=p.registry)
    ws = _FakeWs()
    from platools.transport.protocol import ToolCallMessage

    call = ToolCallMessage(
        call_id="c",
        tool_name="peek",
        params={"__platos": {"organizationId": "o", "projectId": "p"}},
    )
    await client._dispatch_call(ws, call)  # pyright: ignore[reportPrivateUsage]

    assert seen_scope == ("o", "p", None)
    # And after: clean.
    assert current_scope() == (None, None, None)


# ──────────────────────────────────────────────────────────────────
# CTX.5 — unpacked `_context` envelope passed as handler ctx arg
# ──────────────────────────────────────────────────────────────────


def test_build_platos_context_copies_envelope() -> None:
    ctx = build_platos_context("call_x", {"user.id": "u1", "tenant.id": "t1"})
    assert ctx.call_id == "call_x"
    assert ctx.context["user.id"] == "u1"
    assert ctx.context["tenant.id"] == "t1"


def test_build_platos_context_extracts_entity_ids_from_snake_case() -> None:
    ctx = build_platos_context(
        "c", {"user.id": "u1", "entity_ids": ["ent_a", "ent_b"]}
    )
    assert ctx.entity_ids == ("ent_a", "ent_b")


def test_build_platos_context_extracts_entity_ids_from_camel_case() -> None:
    ctx = build_platos_context("c", {"entityIds": ["ent_only"]})
    assert ctx.entity_ids == ("ent_only",)


def test_build_platos_context_entity_ids_none_when_absent() -> None:
    assert build_platos_context("c", {}).entity_ids is None
    # Non-list values must not coerce to an entity_ids tuple.
    assert build_platos_context("c", {"entity_ids": "ent_a"}).entity_ids is None
    # Non-string elements must be filtered out (empty result → None).
    assert build_platos_context("c", {"entity_ids": [1, 2, 3]}).entity_ids is None


def test_build_platos_context_tolerates_non_dict_envelope() -> None:
    ctx = build_platos_context("c", None)
    assert dict(ctx.context) == {}
    assert ctx.entity_ids is None
    assert ctx.raw is None


def test_build_platos_context_preserves_raw() -> None:
    envelope = {"user.id": "u", "nested": {"anything": True}}
    ctx = build_platos_context("c", envelope)
    assert ctx.raw is envelope


async def test_dispatch_pops_context_and_injects_ctx_kwarg() -> None:
    """Handler that declares ``ctx: PlatosContext`` receives the unpacked
    ``_context`` envelope; plain params dispatch keeps working."""
    p = Platools(url="http://example", secret="s")
    seen: dict[str, Any] = {}

    @p.tool()
    async def scheduled(day_of_week: str, ctx: PlatosContext) -> dict[str, Any]:
        """Return today's slot. day_of_week: the day."""
        seen["day"] = day_of_week
        seen["ctx"] = ctx
        return {"ok": True}

    # Declaring `ctx` should NOT have leaked the parameter into the
    # generated tool schema — the LLM must not see it as required.
    tool = p.get_tool("scheduled")
    assert tool is not None
    schema_props = tool.input_schema.get("properties", {})
    assert "ctx" not in schema_props
    assert "day_of_week" in schema_props
    assert tool.ctx_param_name == "ctx"

    client = PlatoolsClient(url="http://example", secret="s", registry=p.registry)
    ws = _FakeWs()
    from platools.transport.protocol import ToolCallMessage

    call = ToolCallMessage(
        call_id="call_ctx5",
        tool_name="scheduled",
        params={
            "day_of_week": "monday",
            "_context": {
                "user.id": "u_42",
                "tenant.id": "tnt_7",
                "entity_ids": ["ent_main", "ent_alt"],
            },
            "__platos": dict(ENVELOPE),
        },
    )
    await client._dispatch_call(ws, call)  # pyright: ignore[reportPrivateUsage]

    # Business param came through clean, ctx arrived with unpacked envelope.
    assert seen["day"] == "monday"
    ctx = seen["ctx"]
    assert isinstance(ctx, PlatosContext)
    assert ctx.call_id == "call_ctx5"
    assert ctx.context["user.id"] == "u_42"
    assert ctx.context["tenant.id"] == "tnt_7"
    assert ctx.entity_ids == ("ent_main", "ent_alt")
    # raw preserved for escape-hatch consumers.
    assert ctx.raw == {
        "user.id": "u_42",
        "tenant.id": "tnt_7",
        "entity_ids": ["ent_main", "ent_alt"],
    }

    # Wire reply is a tool_result.
    payload = json.loads(ws.sent[0])
    assert payload["type"] == "tool_result"


async def test_dispatch_strips_context_from_kwargs_for_legacy_handler() -> None:
    """A handler without a ``ctx`` parameter must still run when the
    wire carries ``_context`` — it must be popped so the ``**kwargs``
    splat doesn't fail with TypeError.
    """
    p = Platools(url="http://example", secret="s")
    observed: dict[str, Any] = {}

    @p.tool()
    async def legacy(value: int) -> dict[str, Any]:
        """Legacy handler. value: the input."""
        observed["value"] = value
        return {"ok": True}

    assert p.get_tool("legacy").ctx_param_name is None  # type: ignore[union-attr]

    client = PlatoolsClient(url="http://example", secret="s", registry=p.registry)
    ws = _FakeWs()
    from platools.transport.protocol import ToolCallMessage

    call = ToolCallMessage(
        call_id="call_legacy",
        tool_name="legacy",
        params={"value": 7, "_context": {"user.id": "u"}},
    )
    await client._dispatch_call(ws, call)  # pyright: ignore[reportPrivateUsage]

    assert observed["value"] == 7
    payload = json.loads(ws.sent[0])
    assert payload["type"] == "tool_result"


async def test_dispatch_ctx_arg_works_without_envelope() -> None:
    """A handler that declares ``ctx`` must still run when the wire has
    no ``_context`` — ctx gets an empty context map, entity_ids=None."""
    p = Platools(url="http://example", secret="s")
    seen_ctx: PlatosContext | None = None

    @p.tool()
    async def probe(name: str, ctx: PlatosContext) -> str:
        """Probe. name: anything."""
        nonlocal seen_ctx
        seen_ctx = ctx
        return name

    client = PlatoolsClient(url="http://example", secret="s", registry=p.registry)
    ws = _FakeWs()
    from platools.transport.protocol import ToolCallMessage

    call = ToolCallMessage(
        call_id="call_plain",
        tool_name="probe",
        params={"name": "x"},
    )
    await client._dispatch_call(ws, call)  # pyright: ignore[reportPrivateUsage]

    assert seen_ctx is not None
    assert seen_ctx.call_id == "call_plain"
    assert dict(seen_ctx.context) == {}
    assert seen_ctx.entity_ids is None


# pytest-asyncio auto-mode is enabled in pyproject.toml, so `async def`
# tests are collected and awaited without decorators. This sentinel
# guards against a future configuration regression.
def test_pytest_asyncio_auto_mode_is_enabled() -> None:
    import tomllib
    from pathlib import Path

    pyproject = Path(__file__).parent.parent / "pyproject.toml"
    data = tomllib.loads(pyproject.read_text())
    mode = data["tool"]["pytest"]["ini_options"]["asyncio_mode"]
    assert mode == "auto"


# Silence unused-import warnings from the pytest module level.
_ = pytest
