"""The hand-written half of the Python V1 client.

WIN-270 (M4.4). ``platos_client/generated/v1.py`` decides the method, the path,
the body and — read off core-api's own policy table — whether the operation is
bound to an ``Idempotency-Key``. It is emitted by ``pnpm generate:sdk-v1`` and
cannot drift. This module decides the three things a generator has no business
deciding, and each is here because getting it wrong has a name:

**A mint that retries without a key mints twice.** ADR M0.4 section 2 requires
``Idempotency-Key`` on the one-time-secret mints, and the reason is a retry: the
first attempt hands back a credential nobody ever sees again, the socket drops
before the response lands, and the client tries again. With a STABLE key the
server replays the first answer and the caller recovers the secret it already
created. With a fresh key per attempt — or with none — it creates a second live
credential nobody knows about. So the key is minted ONCE PER LOGICAL CALL,
before the first attempt, and every retry of that call carries the same value.

**A refusal is a code, not a sentence.** Every non-2xx answer from the V1
surface is ADR M0.4 section 2's envelope; :class:`PlatosRefusal` carries
``code``, and ``WIRE_ERROR_CODES`` — emitted from the same document — is the
closed set it is drawn from.

**An unauthenticated caller gets a refusal, not a partial answer.** ``send``
returns the decoded body or raises. No branch returns ``None``, an empty
collection or a half-populated envelope on a refusal.

SYNCHRONOUS, AND ON THE STANDARD LIBRARY. ``PlatosClient`` is async and depends
on ``httpx``; this transport is neither, because the V1 surface is what a
customer's *backend* calls to mint a token before it renders a page, and a
dependency-free synchronous call is what that code can make. The HTTP call is
one injectable seam (``opener``), so every case in
``tests/test_v1_contract.py`` drives it with no socket and no third-party
package installed.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Callable

from platos_client.errors import (
    PlatosError,
    PlatosNetworkError,
    PlatosRateLimitError,
    PlatosRefusal,
    PlatosServerError,
    is_retryable,
    read_wire_error,
)
from platos_client.generated.v1 import (
    IDEMPOTENCY_KEY_HEADER,
    V1Api,
    V1Request,
)

#: M0.4 section 2's replay marker, as the middleware spells it.
IDEMPOTENCY_REPLAYED_HEADER = "idempotency-replayed"

#: The classes an ``Idempotency-Key`` is sent for.
#:
#: ``required`` and ``accepted`` are the two M0.4 section 2 puts the header on:
#: the mints where its ABSENCE is a refusal, and every other side-effecting
#: operation, where a key is honoured when one is sent. ``exempt`` operations
#: are the ones the rule cannot bind — an OAuth token exchange, an inbound
#: webhook — and sending one a key would invent a contract the server does not
#: have. ``not-applicable`` is a read.
SENDS_IDEMPOTENCY_KEY = frozenset({"required", "accepted"})


class HttpAnswer:
    """One HTTP answer, in the shape this transport reasons about."""

    def __init__(self, status: int, body: str, headers: dict[str, str] | None = None) -> None:
        self.status = status
        self.body = body
        self.headers = {key.lower(): value for key, value in (headers or {}).items()}


#: ``(method, url, headers, body) -> HttpAnswer``. The only I/O seam.
Opener = Callable[[str, str, dict[str, str], bytes | None], HttpAnswer]


def _urllib_opener(method: str, url: str, headers: dict[str, str], body: bytes | None) -> HttpAnswer:
    request = urllib.request.Request(url, data=body, method=method)
    for name, value in headers.items():
        request.add_header(name, value)
    try:
        with urllib.request.urlopen(request) as response:  # noqa: S310 - caller-supplied base URL
            return HttpAnswer(
                response.status,
                response.read().decode("utf-8"),
                dict(response.headers.items()),
            )
    except urllib.error.HTTPError as error:
        # A 4xx/5xx is an ANSWER, not a transport failure. Letting it escape as
        # an exception here would hide the refusal envelope the caller needs.
        return HttpAnswer(error.code, error.read().decode("utf-8"), dict(error.headers.items()))


class V1HttpTransport:
    """One V1 request, retried, with the key held still."""

    def __init__(
        self,
        base_url: str,
        *,
        operator_token: str | None = None,
        opener: Opener | None = None,
        idempotency_key: Callable[[V1Request], str] | None = None,
        max_retries: int = 3,
        base_delay_s: float = 0.25,
        max_delay_s: float = 10.0,
        sleep: Callable[[float], None] | None = None,
    ) -> None:
        if not base_url:
            raise ValueError("V1HttpTransport: base_url is required")
        self.base_url = base_url.rstrip("/")
        self.operator_token = operator_token
        self._opener = opener or _urllib_opener
        self._key_factory = idempotency_key or (lambda _request: str(uuid.uuid4()))
        self.max_retries = max_retries
        self.base_delay_s = base_delay_s
        self.max_delay_s = max_delay_s
        self._sleep = sleep or time.sleep
        #: The ``Idempotency-Replayed`` verdict of the most recent completed call.
        self.last_response_was_replay = False

    def headers_for(self, request: V1Request, idempotency_key: str | None) -> dict[str, str]:
        headers = {"accept": "application/json"}
        if request["body"] is not None:
            headers["content-type"] = "application/json"
        if self.operator_token:
            # ``transports/rest/operator.ts`` accepts the session COOKIE or this
            # header, and names the header form as what a script sends.
            headers["authorization"] = f"Bearer {self.operator_token}"
        if idempotency_key is not None:
            headers[IDEMPOTENCY_KEY_HEADER] = idempotency_key
        return headers

    def url_for(self, request: V1Request) -> str:
        query = request.get("query")
        suffix = f"?{urllib.parse.urlencode(query)}" if query else ""
        return f"{self.base_url}{request['path']}{suffix}"

    def key_for(self, request: V1Request) -> str | None:
        """The key this call carries on EVERY attempt, or ``None`` for a read."""
        if request["operation"]["idempotency"] not in SENDS_IDEMPOTENCY_KEY:
            return None
        key = self._key_factory(request)
        if not isinstance(key, str) or key == "":
            raise ValueError(
                "V1: the idempotency key factory returned no key for "
                f"{request['operation']['operationId']}; a mint cannot be sent without one"
            )
        return key

    def send(self, request: V1Request) -> Any:
        # MINTED ONCE, HERE, OUTSIDE THE LOOP. Moving this line inside the loop
        # is the two-credential bug; ``test_v1_contract.py`` asserts every
        # attempt of one call carries the same value, so the move fails a case.
        idempotency_key = self.key_for(request)
        url = self.url_for(request)
        headers = self.headers_for(request, idempotency_key)
        body = None if request["body"] is None else json.dumps(request["body"]).encode("utf-8")
        method = request["operation"]["method"]

        last: PlatosError | None = None
        for attempt in range(self.max_retries + 1):
            try:
                answer = self._opener(method, url, headers, body)
            except Exception as cause:  # noqa: BLE001 - any transport failure is a network error
                last = PlatosNetworkError(cause)
                if attempt < self.max_retries:
                    self._sleep(self._backoff_s(attempt))
                    continue
                raise last from cause

            if 200 <= answer.status < 300:
                self.last_response_was_replay = (
                    answer.headers.get(IDEMPOTENCY_REPLAYED_HEADER) == "true"
                )
                if answer.status == 204 or answer.body == "":
                    return None
                return json.loads(answer.body)

            refusal = refusal_from(answer)
            last = refusal
            if attempt < self.max_retries and is_retryable(refusal):
                delay = self._backoff_s(attempt)
                if isinstance(refusal, PlatosRateLimitError) and refusal.retry_after_ms:
                    delay = refusal.retry_after_ms / 1000
                self._sleep(delay)
                continue
            raise refusal

        raise last if last is not None else PlatosServerError(0, "exhausted retries")

    def _backoff_s(self, attempt: int) -> float:
        return min(self.base_delay_s * (2**attempt), self.max_delay_s)


def refusal_from(answer: HttpAnswer) -> PlatosError:
    """Turn one non-2xx answer into a coded error. Never raises."""
    detail: dict[str, Any] | None = None
    message = f"HTTP {answer.status}"
    try:
        parsed = json.loads(answer.body)
        if isinstance(parsed, dict):
            detail = parsed
            wire = read_wire_error(parsed)
            if wire is not None:
                message = wire["code"] if wire["title"] == "" else f"{wire['code']}: {wire['title']}"
            elif isinstance(parsed.get("message"), str):
                message = parsed["message"]
    except ValueError:
        if answer.body:
            message = answer.body[:200]

    if answer.status == 429:
        retry_after = answer.headers.get("retry-after")
        retry_after_ms = int(float(retry_after) * 1000) if retry_after else None
        return PlatosRateLimitError(message, retry_after_ms, answer.body, detail)
    if answer.status >= 500:
        return PlatosServerError(answer.status, message, answer.body, detail)
    return PlatosRefusal(answer.status, message, answer.body, detail)


def create_v1_client(base_url: str, **options: Any) -> V1Api:
    """The V1 surface, wired to a transport.

    ``V1Api`` and every type it names are GENERATED; the only hand-written part
    is the transport underneath it.
    """
    api = V1Api(V1HttpTransport(base_url, **options))
    return api
