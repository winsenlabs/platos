"""Error hierarchy for the Python SDK. Mirrors the TS `errors.ts`.

Consumer code narrows via `isinstance` — typical pattern:

    try:
        await client.agents.list()
    except PlatosAuthError:
        await refresh_token()
    except PlatosRateLimitError as err:
        await asyncio.sleep((err.retry_after_ms or 1000) / 1000)
"""

from __future__ import annotations

from typing import Any


class PlatosError(Exception):
    """Root class — every error raised by the SDK extends this."""

    def __init__(
        self,
        status: int,
        message: str,
        body: str = "",
        detail: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(f"Platos {status}: {message}")
        self.status = status
        self.body = body
        self.detail: dict[str, Any] = detail or {}


class PlatosAuthError(PlatosError):
    """401 / 403 — token invalid, expired, or scope-mismatched."""


class PlatosNotFoundError(PlatosError):
    """404 — resource not found in the caller's scope."""

    def __init__(
        self, message: str, body: str = "", detail: dict[str, Any] | None = None
    ) -> None:
        super().__init__(404, message, body, detail)


class PlatosValidationError(PlatosError):
    """400 / 422 — request body failed server-side validation."""

    def __init__(
        self,
        status: int,
        message: str,
        validation_errors: list[str] | None = None,
        body: str = "",
        detail: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(status, message, body, detail)
        self.validation_errors: list[str] = validation_errors or []


class PlatosRateLimitError(PlatosError):
    """429 — caller should back off."""

    def __init__(
        self,
        message: str,
        retry_after_ms: int | None,
        body: str = "",
        detail: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(429, message, body, detail)
        self.retry_after_ms = retry_after_ms


class PlatosServerError(PlatosError):
    """5xx — transient. Retry policy in client.py handles these."""


class PlatosNetworkError(PlatosError):
    """Network-layer failure (httpx/websockets raised)."""

    def __init__(self, cause: BaseException) -> None:
        msg = str(cause) or type(cause).__name__
        super().__init__(0, f"network error: {msg}")
        self.cause = cause


def is_retryable(err: BaseException) -> bool:
    """True iff the error is worth retrying."""
    return isinstance(err, (PlatosNetworkError, PlatosServerError, PlatosRateLimitError))
