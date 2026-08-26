"""Smoke test — import the package and construct a client."""

from __future__ import annotations

import pytest

from platos_client import (
    PlatosAuthError,
    PlatosClient,
    PlatosError,
    PlatosNetworkError,
    PlatosNotFoundError,
    PlatosRateLimitError,
    PlatosServerError,
    PlatosValidationError,
)


def test_exports():
    # Every public export resolves.
    assert all(
        cls is not None
        for cls in (
            PlatosClient,
            PlatosError,
            PlatosAuthError,
            PlatosNotFoundError,
            PlatosValidationError,
            PlatosRateLimitError,
            PlatosServerError,
            PlatosNetworkError,
        )
    )


def test_requires_base_url():
    with pytest.raises(ValueError, match="base_url"):
        PlatosClient(base_url="", session_token="tok")


def test_requires_auth():
    with pytest.raises(ValueError, match="session_token"):
        PlatosClient(base_url="http://localhost:3100")


def test_build_headers_session_token():
    client = PlatosClient(
        base_url="http://localhost:3100", session_token="jwt.value"
    )
    headers = client._build_headers(
        {
            "organizationId": "org_1",
            "projectId": "proj_1",
            "environmentId": "env_1",
            "userId": "user_1",
        }
    )
    assert headers["X-Platos-Session-Token"] == "jwt.value"
    assert headers["X-Platos-Organization-Id"] == "org_1"
    assert headers["X-Platos-User-Id"] == "user_1"


def test_build_headers_api_key_requires_scope():
    client = PlatosClient(base_url="http://localhost:3100", api_key="key")
    with pytest.raises(ValueError, match="scope"):
        client._build_headers(None)


def test_error_hierarchy():
    err = PlatosAuthError(401, "expired")
    assert isinstance(err, PlatosError)
    assert err.status == 401


def test_retry_backoff_bounds():
    client = PlatosClient(
        base_url="http://localhost:3100", session_token="tok"
    )
    # A zero retry count yields roughly base_delay (± jitter).
    delay = client._backoff(0)
    assert 0.0 <= delay <= 0.5
    # Max retries cap at max_delay * (1 + jitter).
    assert client._backoff(10) <= client._retry.max_delay_s * 1.5
