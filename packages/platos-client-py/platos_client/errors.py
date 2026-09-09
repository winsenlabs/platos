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


def read_wire_error(parsed: Any) -> dict[str, Any] | None:
    """Read ADR M0.4 section 2's refusal envelope, or ``None``.

    WIN-270 (M4.4). The V1 surface answers every non-2xx with
    ``{"error": {"code", "title", "body", "errorId", "traceRef", "version"}}``.
    The pre-WIN-270 readers in both SDKs looked for a ``message`` field or a
    STRING ``error`` and found neither, so the one field a caller can branch on
    was dropped and the message fell back to bare HTTP status text.

    STRICT ON ``code`` AND NOTHING ELSE: ``code`` is what the taxonomy owns and
    what a caller branches on, so a body without a non-empty string ``code`` is
    not a V1 refusal. The other members are defaulted to ``""`` when absent,
    because a server that answered a partial envelope has still refused and
    refusing to parse it would turn a coded refusal into a generic one.

    Mirrors ``readWireError`` in ``packages/platos-client/src/errors.ts``; the
    two are held together by ``tests/sdk-contract/v1-fixtures.json``, which both
    suites drive.
    """
    if not isinstance(parsed, dict):
        return None
    error = parsed.get("error")
    if not isinstance(error, dict):
        return None
    code = error.get("code")
    if not isinstance(code, str) or code == "":
        return None

    def text(key: str) -> str:
        value = error.get(key)
        return value if isinstance(value, str) else ""

    wire: dict[str, Any] = {
        "code": code,
        "title": text("title"),
        "body": text("body"),
        "errorId": text("errorId"),
        "traceRef": text("traceRef"),
        "version": text("version"),
    }
    raw_fields = error.get("fields")
    if isinstance(raw_fields, list):
        fields = [
            {
                "field": entry["field"],
                "code": entry["code"],
                "message": entry["message"] if isinstance(entry.get("message"), str) else "",
            }
            for entry in raw_fields
            if isinstance(entry, dict)
            and isinstance(entry.get("field"), str)
            and isinstance(entry.get("code"), str)
        ]
        if fields:
            wire["fields"] = fields
    if isinstance(error.get("retryAfterSec"), (int, float)):
        wire["retryAfterSec"] = error["retryAfterSec"]
    return wire


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
        wire = read_wire_error(detail)
        #: The canonical ``error.code`` when the answer was a V1 envelope, else
        #: ``None``. ``None`` and not ``"UNKNOWN"``: a code invented by the
        #: client would be indistinguishable from one the server minted.
        self.code: str | None = wire["code"] if wire is not None else None
        #: The rest of the envelope — ``errorId`` and ``traceRef`` are what a
        #: support ticket is opened with.
        self.refusal: dict[str, Any] | None = wire


class PlatosRefusal(PlatosError):
    """A CODED 4xx: the server declined, and no retry of the same request wins.

    THE BASE OF THE 4xx FAMILY, not a sibling of it. ``PlatosAuthError``,
    ``PlatosNotFoundError`` and ``PlatosValidationError`` extend this, so
    ``except PlatosRefusal`` reaches every refusal on the V1 surface — including
    the ones minted after this SDK was built, which by construction have no
    named subclass here. Code that narrows to a named class keeps working.

    429 is deliberately NOT in this family. A rate limit refuses THIS attempt
    and invites another, which is why ``is_retryable`` returns true for it.
    """


class PlatosAuthError(PlatosRefusal):
    """401 / 403 — token invalid, expired, or scope-mismatched."""


class PlatosNotFoundError(PlatosRefusal):
    """404 — resource not found in the caller's scope."""

    def __init__(
        self, message: str, body: str = "", detail: dict[str, Any] | None = None
    ) -> None:
        super().__init__(404, message, body, detail)


class PlatosValidationError(PlatosRefusal):
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
