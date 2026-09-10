"""platos-client — official Python SDK for Platos.

Theme I.6 + I.7 — mirrors the TypeScript `@platos/client` surface.

Public exports:

    from platos_client import (
        PlatosClient,
        PlatosScope,
        PlatosError,
        PlatosAuthError,
        PlatosNotFoundError,
        PlatosRateLimitError,
        PlatosServerError,
        PlatosValidationError,
        PlatosNetworkError,
    )
"""

from __future__ import annotations

from typing import Any

# The error hierarchy is imported EAGERLY and everything else is not.
#
# WIN-270 (M4.4). `platos_client.client` imports `httpx`, and `platos_client.apis.threads`
# imports `websockets`. Because this file imported both at module scope, `import
# platos_client.errors` -- which needs neither -- executed them anyway, so a
# caller that wanted nothing but `PlatosError` had to install the whole async
# HTTP and WebSocket stack, and a runtime without them could not read this SDK's
# error types at all. It also made the V1 contract suite's "standard library
# only" property false: it imports `platos_client.errors`, and that ran this
# file, and this file ran `httpx`.
#
# PEP 562 module `__getattr__` fixes it without changing the public surface:
# `from platos_client import PlatosClient` still works and still imports httpx,
# at the moment it is asked for rather than at the moment anything in the
# package is touched. `__all__` is unchanged, so `from platos_client import *`
# is unchanged.
from platos_client.errors import (
    PlatosAuthError,
    PlatosError,
    PlatosNetworkError,
    PlatosNotFoundError,
    PlatosRateLimitError,
    PlatosRefusal,
    PlatosServerError,
    PlatosValidationError,
    read_wire_error,
)

_LAZY = {
    "PlatosClient": ("platos_client.client", "PlatosClient"),
    "PlatosScope": ("platos_client.client", "PlatosScope"),
    "JobsApi": ("platos_client.apis.jobs", "JobsApi"),
    "V1Api": ("platos_client.generated.v1", "V1Api"),
    "V1_OPERATIONS": ("platos_client.generated.v1", "V1_OPERATIONS"),
    "WIRE_ERROR_CODES": ("platos_client.generated.v1", "WIRE_ERROR_CODES"),
    "IDEMPOTENCY_KEY_HEADER": ("platos_client.generated.v1", "IDEMPOTENCY_KEY_HEADER"),
    "V1HttpTransport": ("platos_client.v1_transport", "V1HttpTransport"),
    "create_v1_client": ("platos_client.v1_transport", "create_v1_client"),
}


def __getattr__(name: str) -> Any:
    target = _LAZY.get(name)
    if target is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    from importlib import import_module

    value = getattr(import_module(target[0]), target[1])
    globals()[name] = value
    return value


def __dir__() -> list:
    return sorted({*globals(), *_LAZY})


__all__ = [
    "PlatosClient",
    "PlatosScope",
    "JobsApi",
    "PlatosError",
    "PlatosAuthError",
    "PlatosNotFoundError",
    "PlatosValidationError",
    "PlatosRateLimitError",
    "PlatosServerError",
    "PlatosNetworkError",
    "PlatosRefusal",
    "read_wire_error",
    # WIN-270 (M4.4) — the V1 surface, resolved lazily through `__getattr__`.
    "V1Api",
    "V1_OPERATIONS",
    "WIRE_ERROR_CODES",
    "IDEMPOTENCY_KEY_HEADER",
    "V1HttpTransport",
    "create_v1_client",
]
