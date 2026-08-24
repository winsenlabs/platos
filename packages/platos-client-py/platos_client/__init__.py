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

from platos_client.client import PlatosClient, PlatosScope
from platos_client.apis.jobs import JobsApi
from platos_client.apis.turns import TurnsApi
from platos_client.errors import (
    PlatosAuthError,
    PlatosError,
    PlatosNetworkError,
    PlatosNotFoundError,
    PlatosRateLimitError,
    PlatosServerError,
    PlatosValidationError,
)

__all__ = [
    "PlatosClient",
    "PlatosScope",
    "JobsApi",
    "TurnsApi",
    "PlatosError",
    "PlatosAuthError",
    "PlatosNotFoundError",
    "PlatosValidationError",
    "PlatosRateLimitError",
    "PlatosServerError",
    "PlatosNetworkError",
]
