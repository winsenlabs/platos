"""Security helpers for inbound Platos-signed requests (PPR-71).

Exposes :func:`verify_request`, a full-fat HMAC + nonce-LRU verifier
that the SDK's HTTP fallback handler and any consumer-owned
MCP-style server can call before dispatching a tool call.
"""

from platools.security.replay_guard import (
    DEFAULT_MAX_SKEW_SECONDS,
    DEFAULT_NONCE_CACHE_SIZE,
    VerifyRequestResult,
    _reset_nonce_cache_for_tests,
    verify_request,
)

__all__ = [
    "DEFAULT_MAX_SKEW_SECONDS",
    "DEFAULT_NONCE_CACHE_SIZE",
    "VerifyRequestResult",
    "_reset_nonce_cache_for_tests",
    "verify_request",
]
