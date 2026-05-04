"""Per-call context for platools tool handlers.

The Platos platform injects a `__platos` envelope into every `tool_call`
message's `params` dict before it reaches this SDK. The transport layer
pops the envelope (so user handlers never see it in their kwargs) and
publishes its fields onto `contextvars.ContextVar` slots so handler code
can read them via the accessors exposed here:

    from platools.context import (
        current_user_id,
        current_scope,
        current_user_token,
        current_thread_id,
        current_agent_id,
        current_entity_id,
        current_context,
    )

    @platools.tool(auth="user")
    def list_orders(customer_id: str) -> list[Order]:
        uid = current_user_id()                # who the LLM is acting on behalf of
        token = current_user_token()           # optional caller access token
        org, project, env = current_scope()    # trigger.dev scope tuple
        return db.list_orders(customer_id=customer_id, user_id=uid)

Because `ContextVar` is task-local (asyncio) and thread-local (sync
threads spawned via `asyncio.to_thread`), concurrent tool calls in the
same worker never leak context into each other — each call dispatches
inside its own `contextvars.Context.copy()` in the transport layer.

Fields match the `__platos` envelope shape written by the server in
`apps/agent/src/tool-gateway/tool-executor.service.ts` (see §10 of the
master spec for the invariant):

    organizationId, projectId, environmentId, entityId, userId,
    userToken?, agentId, threadId, callId, timestamp, signature

`PlatosCallContext` is the typed mirror of that dict.
"""

from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any


@dataclass(frozen=True)
class PlatosContext:
    """Per-call handler context (CTX.5).

    Passed as the optional `ctx` argument to every registered tool
    handler. Gives handlers direct access to the Platos `_context`
    envelope the agent builds from `contextMapping.envelopeKeys` —
    e.g. ``user.id``, custom per-entity identity fields, and the
    caller-declared ``entity_ids`` used for tool-matrix routing.

    Mirrors the TypeScript SDK's ``PlatosContext`` shape bit-for-bit.

    Fields:
        call_id: Platform-assigned id for this single tool invocation.
        context: The unpacked ``_context`` envelope — arbitrary
            key/value pairs built by the platform from the tool's
            ``contextMapping``. Keys can be dotted (``user.id``) and
            values are whatever the agent resolved at dispatch time.
            Empty ``{}`` when the platform did not attach a ``_context``
            envelope (older agent, local test run). Exposed as an
            immutable mapping so handlers can't accidentally mutate
            the per-call snapshot.
        entity_ids: Caller-declared entity narrowing list for matrix
            routing. Heuristically extracted from the envelope's
            ``entity_ids`` or ``entityIds`` key when present; ``None``
            otherwise. Consumers needing a specific key should read
            directly off ``context``.
        raw: Escape hatch — the original, untouched ``_context``
            envelope value the platform sent.
    """

    call_id: str
    context: Any = field(default_factory=lambda: MappingProxyType({}))
    entity_ids: tuple[str, ...] | None = None
    raw: Any = None


def build_platos_context(call_id: str, raw_context_envelope: Any) -> PlatosContext:
    """Build a :class:`PlatosContext` from a popped ``_context`` envelope.

    Tolerant: a missing or non-dict envelope produces a context with an
    empty ``context`` map and ``entity_ids=None`` so handlers branching
    on ``if ctx.entity_ids`` behave predictably.
    """
    if isinstance(raw_context_envelope, dict):
        safe: dict[str, Any] = dict(raw_context_envelope)
    else:
        safe = {}
    entity_ids = _extract_entity_ids(safe)
    return PlatosContext(
        call_id=call_id,
        context=MappingProxyType(safe),
        entity_ids=entity_ids,
        raw=raw_context_envelope,
    )


def _extract_entity_ids(envelope: dict[str, Any]) -> tuple[str, ...] | None:
    # Server default key is ``entity_ids`` (see
    # apps/agent/src/tool-gateway/tool-executor.service.ts:267). Some
    # entities configure ``entityIds`` or a fully-custom path — callers
    # that need a custom key should read ``context`` directly.
    raw = envelope.get("entity_ids", envelope.get("entityIds"))
    if not isinstance(raw, (list, tuple)):
        return None
    out = tuple(v for v in raw if isinstance(v, str))
    return out or None


@dataclass(frozen=True)
class PlatosCallContext:
    """Typed snapshot of the `__platos` envelope for the current tool call.

    Returned by :func:`current_context` when a call is in-flight. All
    fields are strings except `user_token`, which is `None` when the
    platform did not forward a caller access token (e.g. when
    `auth="none"`).

    The `timestamp` and `signature` fields carry the HMAC replay-prevention
    tuple the server attached when it dispatched the call. Handlers rarely
    need them — they're exposed for audit logging and forwarding to
    downstream MCP-style services.
    """

    organization_id: str
    project_id: str
    environment_id: str
    entity_id: str
    user_id: str
    agent_id: str
    thread_id: str
    call_id: str
    timestamp: str
    signature: str
    user_token: str | None = None
    # PPR-71: per-request nonce. Absent on legacy (pre-PPR-71) callers.
    nonce: str | None = None
    # PIFSP-22: entity-issued access token forwarded when the MCP user
    # authenticated via entity-delegated OIDC. Pass to your own auth system
    # to verify the real user identity independently of Platos' claims.
    # None when the user connected via bearer PAT or anonymous mode.
    entity_token: str | None = None


# ──────────────────────────────────────────────────────────────────
# ContextVar slots — one per field on the envelope.
#
# These are module-private (leading underscore) because the public API
# below is the stable surface. `set_current_context` and
# `reset_current_context` are the only two mutators and live in the
# transport layer (see `_dispatch_call` in `transport/client.py`).
# ──────────────────────────────────────────────────────────────────


_org_id_var: ContextVar[str | None] = ContextVar("platos_org_id", default=None)
_project_id_var: ContextVar[str | None] = ContextVar("platos_project_id", default=None)
_env_id_var: ContextVar[str | None] = ContextVar("platos_env_id", default=None)
_entity_id_var: ContextVar[str | None] = ContextVar("platos_entity_id", default=None)
_user_id_var: ContextVar[str | None] = ContextVar("platos_user_id", default=None)
_user_token_var: ContextVar[str | None] = ContextVar("platos_user_token", default=None)
_agent_id_var: ContextVar[str | None] = ContextVar("platos_agent_id", default=None)
_thread_id_var: ContextVar[str | None] = ContextVar("platos_thread_id", default=None)
_call_id_var: ContextVar[str | None] = ContextVar("platos_call_id", default=None)
_timestamp_var: ContextVar[str | None] = ContextVar("platos_timestamp", default=None)
_nonce_var: ContextVar[str | None] = ContextVar("platos_nonce", default=None)
_signature_var: ContextVar[str | None] = ContextVar("platos_signature", default=None)
# PIFSP-22: entity-issued access token from entity-delegated OIDC flow.
_entity_token_var: ContextVar[str | None] = ContextVar("platos_entity_token", default=None)


# Ordered tuple so `set_current_context` / `reset_current_context` can
# iterate and `reset_current_context` can undo exactly what was set. We
# carry the paired (var, token) list so reset is symmetrical.
_ALL_VARS: tuple[ContextVar[str | None], ...] = (
    _org_id_var,
    _project_id_var,
    _env_id_var,
    _entity_id_var,
    _user_id_var,
    _user_token_var,
    _agent_id_var,
    _thread_id_var,
    _call_id_var,
    _timestamp_var,
    _nonce_var,
    _signature_var,
    _entity_token_var,
)


# ──────────────────────────────────────────────────────────────────
# Public read-side API — what user handler code imports.
# ──────────────────────────────────────────────────────────────────


def current_user_id() -> str | None:
    """Return the calling end-user's id for this tool invocation.

    Returns `None` when called outside a tool-handler dispatch (e.g.
    from module top-level, a unit test with no envelope, or a
    `platools serve` local run).
    """
    return _user_id_var.get()


def current_user_token() -> str | None:
    """Return the calling end-user's access token, if the platform forwarded one.

    Only present when the tool was registered with `auth="user"` and
    the upstream agent call carried a user token. `None` otherwise.
    """
    return _user_token_var.get()


def current_thread_id() -> str | None:
    """Return the conversation/thread id this tool call belongs to."""
    return _thread_id_var.get()


def current_agent_id() -> str | None:
    """Return the id of the agent that dispatched this tool call."""
    return _agent_id_var.get()


def current_entity_id() -> str | None:
    """Return the id of the registered entity whose SDK is handling this call."""
    return _entity_id_var.get()


def current_call_id() -> str | None:
    """Return the platform-assigned id for this single tool invocation."""
    return _call_id_var.get()


def current_scope() -> tuple[str | None, str | None, str | None]:
    """Return the `(organization_id, project_id, environment_id)` tuple.

    Mirrors the trigger.dev 3-axis scope every Platos object is bound to
    (see spec §3). Any or all components may be `None` outside a
    dispatched tool call.
    """
    return (_org_id_var.get(), _project_id_var.get(), _env_id_var.get())


def current_entity_token() -> str | None:
    """Return the entity-issued access token for the current OIDC-authenticated call.

    Only present when the MCP user authenticated via entity-delegated OIDC
    (identityMode includes "oidc"). Pass this token to your own auth system
    (Google, Auth0, etc.) to verify the real user identity independently of
    Platos' claims — your auth system issued this token, so you fully trust it.

    Returns ``None`` for bearer PAT or anonymous identity modes.

    Example::

        from platools.context import current_entity_token

        @platools.tool(auth="user")
        def list_my_orders() -> list[Order]:
            token = current_entity_token()
            if token:
                user = google.verify_token(token)   # verify with your auth
            else:
                user = current_user_id()             # fallback: trust Platos claim
            return db.orders(user_id=user.sub)
    """
    return _entity_token_var.get()


def current_context() -> PlatosCallContext | None:
    """Return the full typed context for this call, or `None` if not in a call.

    Required fields must all be present to construct a
    `PlatosCallContext` — if any are missing we're outside a dispatched
    call and return `None`. Handlers that only need a subset should
    prefer the narrower accessors above.
    """
    org = _org_id_var.get()
    project = _project_id_var.get()
    env = _env_id_var.get()
    entity = _entity_id_var.get()
    user = _user_id_var.get()
    agent = _agent_id_var.get()
    thread = _thread_id_var.get()
    call = _call_id_var.get()
    ts = _timestamp_var.get()
    sig = _signature_var.get()
    nonce = _nonce_var.get()
    if (
        org is None
        or project is None
        or env is None
        or entity is None
        or user is None
        or agent is None
        or thread is None
        or call is None
        or ts is None
        or sig is None
    ):
        return None
    return PlatosCallContext(
        organization_id=org,
        project_id=project,
        environment_id=env,
        entity_id=entity,
        user_id=user,
        user_token=_user_token_var.get(),
        agent_id=agent,
        thread_id=thread,
        call_id=call,
        timestamp=ts,
        signature=sig,
        nonce=nonce,
        entity_token=_entity_token_var.get(),
    )


# ──────────────────────────────────────────────────────────────────
# Internal mutators — called only by the transport layer.
#
# These are part of the package's private API (underscore prefix and
# not re-exported from `platools`) so consumers don't manufacture
# contexts by hand. Tests import them directly via `platools.context`.
# ──────────────────────────────────────────────────────────────────


def _set_current_context(envelope: dict[str, object]) -> list[object]:
    """Set every ContextVar from the popped `__platos` envelope.

    Returns the opaque token list `reset_current_context` needs to undo
    the set. Missing keys default to `None` so a partial envelope (from
    an older server) doesn't crash — handlers see `None` for absent
    fields.
    """
    tokens: list[object] = []

    def set_one(var: ContextVar[str | None], key: str) -> None:
        raw = envelope.get(key)
        value: str | None
        if raw is None:
            value = None
        elif isinstance(raw, str):
            value = raw
        else:
            value = str(raw)
        tokens.append(var.set(value))

    set_one(_org_id_var, "organizationId")
    set_one(_project_id_var, "projectId")
    set_one(_env_id_var, "environmentId")
    set_one(_entity_id_var, "entityId")
    set_one(_user_id_var, "userId")
    set_one(_user_token_var, "userToken")
    set_one(_agent_id_var, "agentId")
    set_one(_thread_id_var, "threadId")
    set_one(_call_id_var, "callId")
    set_one(_timestamp_var, "timestamp")
    set_one(_nonce_var, "nonce")
    set_one(_signature_var, "signature")
    set_one(_entity_token_var, "entityToken")
    return tokens


def _reset_current_context(tokens: list[object]) -> None:
    """Restore every ContextVar to its prior value using tokens from _set."""
    # Reset in reverse so nested sets unwind in LIFO order. Each token
    # corresponds to the var at the matching index in `_ALL_VARS`.
    for var, token in zip(reversed(_ALL_VARS), reversed(tokens), strict=True):
        var.reset(token)  # type: ignore[arg-type]


__all__ = [
    "PlatosCallContext",
    "PlatosContext",
    "build_platos_context",
    "current_agent_id",
    "current_call_id",
    "current_context",
    "current_entity_id",
    "current_entity_token",
    "current_scope",
    "current_thread_id",
    "current_user_id",
    "current_user_token",
]
