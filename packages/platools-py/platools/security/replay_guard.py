"""Replay guard for inbound HMAC-signed tool-call requests (PPR-71).

Mirrors :file:`packages/platools-js/src/security/replay-guard.ts`
so the TypeScript and Python SDKs behave identically on the wire.

The Platos agent signs every tool call with
``HMAC-SHA256(serviceSecret, f"{ts}.{nonce}.{body}")`` and forwards the
triple ``(X-Platos-Timestamp, X-Platos-Nonce, X-Platos-Signature)`` —
either via HTTP headers on the fallback path or embedded in the
``__platos`` envelope on the primary WS transport.

This module exposes a small in-memory LRU of seen nonces, keyed per
entity, plus :func:`verify_request` which atomically tests-then-stores
a nonce. A captured request inside the skew window is rejected the
second time it shows up.

Why an LRU (not Redis / a shared store)?

  - The SDK runs inside the entity's backend; it already scales
    horizontally. A shared nonce store would be another piece of infra
    the entity has to run, for a marginal protection (each replay would
    simply get hashed to another replica and still hit the LRU there
    within the skew window).
  - 100k entries × ~50 bytes/nonce ≈ 5MB per process — fits everywhere.
  - FIFO eviction is O(1) with an :class:`collections.OrderedDict`.

Legacy compat (PPR-71 one-release back-compat):

  - If ``nonce`` is absent, the caller falls back to the legacy
    ``"{ts}.{body}"`` signing string. We emit a single one-time warning
    per process (debounced via the module-level :data:`_warned_legacy`)
    and accept the request. Remove the fallback after the next release.
"""

from __future__ import annotations

import hmac
import logging
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from typing import Literal

log = logging.getLogger("platools.security.replay_guard")

DEFAULT_NONCE_CACHE_SIZE = 100_000
DEFAULT_MAX_SKEW_SECONDS = 300


class _NonceLru:
    """Insertion-ordered FIFO-bounded seen-nonce tracker.

    :class:`~collections.OrderedDict` preserves insertion order so
    ``popitem(last=False)`` drops the oldest entry in O(1) when we
    overflow. No TTL logic — entries live as long as the LRU allows,
    which is fine because the timestamp skew-window check already
    rejects anything older than ``max_skew_seconds``.
    """

    def __init__(self, capacity: int = DEFAULT_NONCE_CACHE_SIZE) -> None:
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self._capacity = capacity
        self._seen: OrderedDict[str, int] = OrderedDict()

    def try_insert(self, nonce: str, ts_ms: int) -> bool:
        """Test-and-insert.

        Returns ``True`` if the nonce was freshly inserted (not a
        replay). Returns ``False`` if the nonce was already cached.
        """
        if nonce in self._seen:
            return False
        self._seen[nonce] = ts_ms
        if len(self._seen) > self._capacity:
            self._seen.popitem(last=False)
        return True

    @property
    def size(self) -> int:  # pragma: no cover - for tests
        return len(self._seen)


# Per-entity LRU. Keyed by ``entity_id`` so multi-tenant SDK
# instances don't collide.
_caches: dict[str, _NonceLru] = {}
_warned_legacy = False


def _get_cache_for(entity_id: str, capacity: int) -> _NonceLru:
    cache = _caches.get(entity_id)
    if cache is None:
        cache = _NonceLru(capacity)
        _caches[entity_id] = cache
    return cache


def _emit_legacy_warning() -> None:
    global _warned_legacy
    if _warned_legacy:
        return
    _warned_legacy = True
    log.warning(
        "[platools] legacy HMAC request received (no X-Platos-Nonce). "
        "Replay protection is DEGRADED for this call. Upgrade the Platos "
        "agent to the version that signs with {ts}.{nonce}.{body} — "
        "see docs/tool-gateway.md.",
    )


@dataclass(frozen=True)
class VerifyRequestResult:
    """Outcome of :func:`verify_request`.

    ``ok=True`` means the request is authentic and not a replay. Check
    ``used_legacy_format`` to decide whether to route or log extra.

    ``ok=False`` carries a machine-readable ``reason`` so the caller
    can emit a 401 with a narrow diagnostic.
    """

    ok: bool
    used_legacy_format: bool = False
    reason: Literal[
        "timestamp_invalid",
        "timestamp_skew_exceeded",
        "signature_mismatch",
        "nonce_replay",
    ] | None = None


def _parse_iso_timestamp(ts: str) -> int | None:
    """Parse an ISO-8601 timestamp into epoch milliseconds.

    Accepts both the ``Z`` suffix and ``+00:00`` offsets. Returns
    ``None`` if the value is unparseable.
    """
    try:
        normalized = ts.replace("Z", "+00:00") if ts.endswith("Z") else ts
        dt = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def verify_request(
    *,
    entity_id: str,
    service_secret: str,
    timestamp: str,
    signature: str,
    body: str,
    nonce: str | None = None,
    now: datetime | None = None,
    max_skew_seconds: int = DEFAULT_MAX_SKEW_SECONDS,
    cache_capacity: int = DEFAULT_NONCE_CACHE_SIZE,
) -> VerifyRequestResult:
    """Verify a Platos-signed tool-call request end-to-end.

    Steps:

    1. Reject if ``timestamp`` is unparseable or outside the skew window.
    2. Recompute the HMAC signature and ``hmac.compare_digest`` it
       against the claimed signature.
    3. If ``nonce`` is present (PPR-71 format), atomically test-and-
       insert into the per-entity LRU. A replay returns ``ok=False``.
       If ``nonce`` is absent (legacy format), the function emits a
       one-time warning and accepts the request. Replay protection is
       degraded for that single call — callers concerned about replay
       within the 5-minute skew window should reject legacy requests
       explicitly.
    """
    ts_ms = _parse_iso_timestamp(timestamp)
    if ts_ms is None:
        return VerifyRequestResult(ok=False, reason="timestamp_invalid")

    now_ms = int((now or datetime.now(timezone.utc)).timestamp() * 1000)
    if abs(now_ms - ts_ms) > max_skew_seconds * 1000:
        return VerifyRequestResult(ok=False, reason="timestamp_skew_exceeded")

    used_legacy_format = not nonce
    signing_string = (
        f"{timestamp}.{body}"
        if used_legacy_format
        else f"{timestamp}.{nonce}.{body}"
    )
    expected = hmac.new(
        service_secret.encode("utf-8"),
        signing_string.encode("utf-8"),
        sha256,
    ).hexdigest()

    if not hmac.compare_digest(expected, signature):
        return VerifyRequestResult(ok=False, reason="signature_mismatch")

    if used_legacy_format:
        _emit_legacy_warning()
        return VerifyRequestResult(ok=True, used_legacy_format=True)

    cache = _get_cache_for(entity_id, cache_capacity)
    # `nonce` is guaranteed non-None here by the `used_legacy_format`
    # branch above. The cast silences mypy in strict mode.
    if not cache.try_insert(nonce or "", ts_ms):
        return VerifyRequestResult(ok=False, reason="nonce_replay")
    return VerifyRequestResult(ok=True, used_legacy_format=False)


def _reset_nonce_cache_for_tests() -> None:
    """Test-only: clear the per-entity cache and legacy-warning flag."""
    global _warned_legacy
    _caches.clear()
    _warned_legacy = False


__all__ = [
    "DEFAULT_MAX_SKEW_SECONDS",
    "DEFAULT_NONCE_CACHE_SIZE",
    "VerifyRequestResult",
    "_reset_nonce_cache_for_tests",
    "verify_request",
]
