"""Replay-guard tests (PPR-71) — Python mirror of the TS suite.

Verifies three invariants:

  1. A valid ``{ts}.{nonce}.{body}`` signed request verifies.
  2. Replays of the same nonce within the skew window are rejected.
  3. Legacy ``{ts}.{body}`` requests verify and emit one log warning.
"""

from __future__ import annotations

import hmac
import logging
from datetime import datetime, timedelta, timezone
from hashlib import sha256

from platools.security.replay_guard import (
    _reset_nonce_cache_for_tests,
    verify_request,
)

SECRET = "s" * 64
ENTITY = "ent_test"


def _sign(body: str, ts: str, nonce: str | None = None) -> str:
    string = f"{ts}.{nonce}.{body}" if nonce else f"{ts}.{body}"
    return hmac.new(SECRET.encode(), string.encode(), sha256).hexdigest()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def test_accepts_new_format_request() -> None:
    _reset_nonce_cache_for_tests()
    ts = _now_iso()
    nonce = "a" * 32
    body = '{"tool":"ping"}'
    res = verify_request(
        entity_id=ENTITY,
        service_secret=SECRET,
        timestamp=ts,
        signature=_sign(body, ts, nonce),
        body=body,
        nonce=nonce,
    )
    assert res.ok
    assert not res.used_legacy_format


def test_rejects_nonce_replay() -> None:
    _reset_nonce_cache_for_tests()
    ts = _now_iso()
    nonce = "b" * 32
    body = "{}"
    sig = _sign(body, ts, nonce)
    first = verify_request(
        entity_id=ENTITY,
        service_secret=SECRET,
        timestamp=ts,
        signature=sig,
        body=body,
        nonce=nonce,
    )
    assert first.ok
    replay = verify_request(
        entity_id=ENTITY,
        service_secret=SECRET,
        timestamp=ts,
        signature=sig,
        body=body,
        nonce=nonce,
    )
    assert not replay.ok
    assert replay.reason == "nonce_replay"


def test_accepts_legacy_request_and_warns_once(
    caplog: logging.LogCaptureFixture,
) -> None:
    _reset_nonce_cache_for_tests()
    ts = _now_iso()
    body = "{}"
    sig = _sign(body, ts)
    with caplog.at_level(logging.WARNING, logger="platools.security.replay_guard"):
        first = verify_request(
            entity_id=ENTITY,
            service_secret=SECRET,
            timestamp=ts,
            signature=sig,
            body=body,
        )
        second = verify_request(
            entity_id=ENTITY,
            service_secret=SECRET,
            timestamp=ts,
            signature=sig,
            body=body,
        )
    assert first.ok and first.used_legacy_format
    assert second.ok and second.used_legacy_format
    # Only ONE warning emitted across both calls.
    warning_records = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warning_records) == 1


def test_rejects_stale_timestamp() -> None:
    _reset_nonce_cache_for_tests()
    stale = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat().replace(
        "+00:00", "Z"
    )
    nonce = "c" * 32
    res = verify_request(
        entity_id=ENTITY,
        service_secret=SECRET,
        timestamp=stale,
        signature=_sign("{}", stale, nonce),
        body="{}",
        nonce=nonce,
    )
    assert not res.ok
    assert res.reason == "timestamp_skew_exceeded"


def test_rejects_bad_signature() -> None:
    _reset_nonce_cache_for_tests()
    ts = _now_iso()
    res = verify_request(
        entity_id=ENTITY,
        service_secret=SECRET,
        timestamp=ts,
        signature="deadbeef",
        body="{}",
        nonce="d" * 32,
    )
    assert not res.ok
    assert res.reason == "signature_mismatch"
