"""Root `PlatosClient` for Python.

Theme I.6 — core client (REST + auth + retry + 401 refresh + timeout).
Theme I.7 — realtime streaming lives in `streaming.py` and surfaces as
`client.threads.send(...)` returning an `async generator` of events.
"""

from __future__ import annotations

import asyncio
import json
import random
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Mapping, TypedDict, cast

import httpx

from platos_client.errors import (
    PlatosAuthError,
    PlatosError,
    PlatosNetworkError,
    PlatosNotFoundError,
    PlatosRateLimitError,
    PlatosServerError,
    PlatosValidationError,
    is_retryable,
)


class PlatosScope(TypedDict, total=False):
    """Scope tuple required by every scope-sensitive call."""

    organizationId: str
    projectId: str
    environmentId: str
    userId: str


TokenRefreshFn = Callable[["TokenRefreshContext"], Awaitable[str | None]]


@dataclass
class TokenRefreshContext:
    current_token: str | None
    status: int


@dataclass
class RetryConfig:
    max_retries: int = 3
    base_delay_s: float = 0.25
    max_delay_s: float = 10.0
    jitter: float = 0.2


class PlatosClient:
    """Async Platos client.

    Use as an async context manager so the underlying `httpx.AsyncClient`
    is cleanly closed:

        async with PlatosClient(base_url="…", session_token="…") as c:
            ...

    Or manually, in which case call `await client.aclose()` when done.
    """

    def __init__(
        self,
        *,
        base_url: str,
        session_token: str | None = None,
        api_key: str | None = None,
        socket_namespace: str = "/agent",
        retry: RetryConfig | None = None,
        timeout_s: float = 30.0,
        on_token_refresh: TokenRefreshFn | None = None,
        httpx_client: httpx.AsyncClient | None = None,
    ) -> None:
        if not base_url:
            raise ValueError("PlatosClient: base_url is required")
        if not session_token and not api_key:
            raise ValueError(
                "PlatosClient: one of { session_token, api_key } is required"
            )
        self._base_url = base_url.rstrip("/")
        self._session_token = session_token
        self._api_key = api_key
        self._socket_namespace = socket_namespace
        self._retry = retry or RetryConfig()
        self._timeout_s = timeout_s
        self._on_token_refresh = on_token_refresh
        self._httpx = httpx_client or httpx.AsyncClient(timeout=timeout_s)
        self._owns_httpx = httpx_client is None

        # Avoid a circular import by importing the API modules here.
        from platos_client.apis.agents import AgentsApi
        from platos_client.apis.threads import ThreadsApi
        from platos_client.apis.trigger import TriggerApi

        self.agents = AgentsApi(self)
        self.threads = ThreadsApi(self)
        # Theme BGO — `bgo` is the canonical background-operations
        # namespace; `trigger` is kept as a deprecated alias pointing at
        # the same instance for one release. See docs/BGO_RENAME.md.
        self.bgo = TriggerApi(self)
        self.trigger = self.bgo

    async def __aenter__(self) -> "PlatosClient":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_httpx:
            await self._httpx.aclose()

    # ----- internal helpers (consumed by apis/*) -----

    @property
    def base_url(self) -> str:
        return self._base_url

    @property
    def socket_namespace(self) -> str:
        return self._socket_namespace

    @property
    def current_token(self) -> str | None:
        return self._session_token

    def set_session_token(self, token: str) -> None:
        self._session_token = token

    def _build_headers(self, scope: PlatosScope | None) -> dict[str, str]:
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self._session_token:
            headers["X-Platos-Session-Token"] = self._session_token
        elif self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
            if not scope:
                raise ValueError(
                    "PlatosClient: api_key mode requires an explicit scope on every call"
                )
        if scope:
            headers["X-Platos-Organization-Id"] = scope["organizationId"]
            headers["X-Platos-Project-Id"] = scope["projectId"]
            headers["X-Platos-Environment-Id"] = scope["environmentId"]
            user_id = scope.get("userId")
            if user_id:
                headers["X-Platos-User-Id"] = user_id
        return headers

    async def _request(
        self,
        method: str,
        path: str,
        *,
        scope: PlatosScope | None = None,
        body: Any = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> Any:
        return await self._request_with_refresh(
            method, path, scope=scope, body=body, extra_headers=extra_headers, refreshed=False
        )

    async def _request_with_refresh(
        self,
        method: str,
        path: str,
        *,
        scope: PlatosScope | None,
        body: Any,
        extra_headers: Mapping[str, str] | None,
        refreshed: bool,
    ) -> Any:
        try:
            return await self._request_with_retry(
                method, path, scope=scope, body=body, extra_headers=extra_headers
            )
        except PlatosAuthError as err:
            if refreshed or self._on_token_refresh is None or self._session_token is None:
                raise
            try:
                fresh = await self._on_token_refresh(
                    TokenRefreshContext(current_token=self._session_token, status=err.status)
                )
            except Exception:
                fresh = None
            if fresh and fresh != self._session_token:
                self._session_token = fresh
                return await self._request_with_refresh(
                    method, path, scope=scope, body=body, extra_headers=extra_headers, refreshed=True
                )
            raise

    async def _request_with_retry(
        self,
        method: str,
        path: str,
        *,
        scope: PlatosScope | None,
        body: Any,
        extra_headers: Mapping[str, str] | None,
    ) -> Any:
        url = f"{self._base_url}{path}"
        headers = self._build_headers(scope)
        if extra_headers:
            headers.update(extra_headers)
        payload: bytes | None = None
        if body is not None:
            payload = json.dumps(body).encode("utf-8")

        last_err: BaseException | None = None
        for attempt in range(self._retry.max_retries + 1):
            try:
                resp = await self._httpx.request(
                    method, url, headers=headers, content=payload
                )
            except (httpx.TransportError, httpx.TimeoutException) as exc:
                net_err = PlatosNetworkError(exc)
                last_err = net_err
                if attempt < self._retry.max_retries:
                    await asyncio.sleep(self._backoff(attempt))
                    continue
                raise net_err from exc

            if resp.is_success:
                if not resp.content:
                    return None
                try:
                    return resp.json()
                except json.JSONDecodeError:
                    return resp.text

            parsed = _error_from_response(resp)
            last_err = parsed
            if attempt < self._retry.max_retries and is_retryable(parsed):
                delay = (
                    parsed.retry_after_ms / 1000
                    if isinstance(parsed, PlatosRateLimitError) and parsed.retry_after_ms
                    else self._backoff(attempt)
                )
                await asyncio.sleep(delay)
                continue
            raise parsed
        assert last_err is not None
        raise last_err

    def _backoff(self, attempt: int) -> float:
        base = self._retry.base_delay_s * (2**attempt)
        capped = min(base, self._retry.max_delay_s)
        jitter_frac = self._retry.jitter
        rand = 1 + (random.random() * 2 - 1) * jitter_frac
        return max(0.0, capped * rand)


def _error_from_response(resp: httpx.Response) -> PlatosError:
    text = resp.text
    detail: dict[str, Any] | None = None
    message = resp.reason_phrase or "request failed"
    try:
        parsed = json.loads(text) if text else None
        if isinstance(parsed, dict):
            detail = cast(dict[str, Any], parsed)
            if isinstance(parsed.get("message"), str):
                message = parsed["message"]
            elif isinstance(parsed.get("error"), str):
                message = parsed["error"]
    except json.JSONDecodeError:
        if text:
            message = text if len(text) <= 200 else f"{text[:200]}…"

    status = resp.status_code
    if status in (401, 403):
        return PlatosAuthError(status, message, text, detail)
    if status == 404:
        return PlatosNotFoundError(message, text, detail)
    if status in (400, 422):
        errs_raw = detail.get("validationErrors") if detail else None
        errs = (
            [e for e in errs_raw if isinstance(e, str)]
            if isinstance(errs_raw, list)
            else []
        )
        return PlatosValidationError(status, message, errs, text, detail)
    if status == 429:
        retry_after = resp.headers.get("retry-after")
        retry_after_ms: int | None = None
        if retry_after:
            try:
                retry_after_ms = int(float(retry_after) * 1000)
            except ValueError:
                retry_after_ms = None
        return PlatosRateLimitError(message, retry_after_ms, text, detail)
    if status >= 500:
        return PlatosServerError(status, message, text, detail)
    return PlatosError(status, message, text, detail)
