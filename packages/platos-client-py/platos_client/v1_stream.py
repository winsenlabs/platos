"""The V1 event-stream reader: parse, admit, resume.

WIN-272 (M4.6), "clients resume without missing or double-applying state". Before
this module the generated ``environment_streams.read`` went through
``V1HttpTransport.send``, which runs ``json.loads`` on the body, so every valid
event stream raised, no request carried ``Last-Event-ID``, and a retried GET would
have re-read a live stream from the start.

The wire facts - the media type, the resume header, the meta event name, the
``sv`` band and the terminal frame types - come from ``generated/v1.py``, which
``scripts/sdk/v1-contract.mjs`` reads off core-api's SSE lane and the kernel.

The three rules - ``admit_frame``, ``classify_stream_end`` and ``is_resumable`` -
are ``packages/kernel/src/vo/stream-frame.ts``'s ``admitFrame``,
``classifyStreamEnd`` and ``isResumable``, PORTED because the kernel is TypeScript.
``tests/test_v1_stream.py`` drives them against the admission table in
``tests/sdk-contract/v1-stream-resume.json``, which the TypeScript suite checks
against the kernel's own functions, so the port cannot drift from the kernel
without one of the two languages failing.

The parser is the WHATWG "event stream interpretation" algorithm, and this module
is the TypeScript reader in ``packages/platos-client/src/v1-stream.ts`` in the
other language: the same fixture drives both.

STANDARD LIBRARY ONLY, like ``v1_transport``: the HTTP call is one injectable seam
(``stream_opener``), so every case runs with no socket and no package installed.
"""

from __future__ import annotations

import codecs
import json
import re
import urllib.error
import urllib.request
from collections.abc import Callable, Iterable, Iterator
from typing import Any, Optional

from platos_client.errors import PlatosError, PlatosNetworkError, PlatosRateLimitError, is_retryable
from platos_client.generated.v1 import (
    EVENT_STREAM_MEDIA_TYPE,
    LAST_EVENT_ID_HEADER,
    STREAM_META_EVENT,
    STREAM_SCHEMA_VERSION_MAX,
    STREAM_SCHEMA_VERSION_MIN,
    TERMINAL_FRAME_TYPES,
)

DEFAULT_MAX_RECONNECTS = 5
#: Three of the SSE lane's 15-second heartbeats.
DEFAULT_IDLE_TIMEOUT_S = 45.0


def admit_frame(last_applied: int, frame: dict[str, Any]) -> dict[str, Any]:
    """PORTED from the kernel's ``admitFrame``."""
    seq = frame["seq"]
    if seq <= last_applied:
        return {"kind": "duplicate"}
    expected = last_applied + 1
    if seq > expected:
        return {"kind": "gap", "missing": seq - expected}
    return {"kind": "apply"}


def classify_stream_end(last_frame: Optional[dict[str, Any]], resume_from: Optional[str]) -> dict[str, Any]:
    """PORTED from the kernel's ``classifyStreamEnd``."""
    if last_frame is None:
        return {"kind": "severed", "resumeFrom": resume_from}
    t = last_frame.get("t")
    if t == "turn.done":
        return {"kind": "completed"}
    if t == "stream.error":
        code = last_frame.get("code")
        return {"kind": "failed", "code": code if isinstance(code, str) and code != "" else None}
    if t == "stream.offline":
        cursor = last_frame.get("resumeFrom")
        if isinstance(cursor, str) and cursor != "":
            return {"kind": "interrupted", "resumeFrom": cursor}
        if resume_from is not None:
            return {"kind": "interrupted", "resumeFrom": resume_from}
        return {"kind": "severed", "resumeFrom": None}
    return {"kind": "severed", "resumeFrom": resume_from}


def is_resumable(end: dict[str, Any]) -> bool:
    """PORTED from the kernel's ``isResumable``."""
    return end["kind"] in ("interrupted", "severed")


def is_terminal_frame_type(t: str) -> bool:
    return t in TERMINAL_FRAME_TYPES


class PlatosStreamError(PlatosError):
    """A stream that broke the lane's contract. ``violation`` names how; ``code`` stays the server's."""

    def __init__(self, status: int, violation: str, message: str, reason: Any = None) -> None:
        super().__init__(status, f"{violation}: {message}")
        self.violation = violation
        self.reason = reason


class SseParser:
    """The WHATWG event-stream parser, fed decoded text in arbitrary pieces."""

    def __init__(self) -> None:
        self._pending = ""
        self._started = False
        self._data = ""
        self._event = ""
        self._id = ""
        #: The last ``retry:`` field, in milliseconds, or ``None``.
        self.retry_ms: Optional[int] = None

    def push(self, text: str) -> list[dict[str, str]]:
        if not self._started:
            if text == "":
                return []
            if text.startswith("\ufeff"):
                text = text[1:]
            self._started = True
        self._pending += text
        events: list[dict[str, str]] = []
        while True:
            cr = self._pending.find("\r")
            lf = self._pending.find("\n")
            if cr == -1 and lf == -1:
                break
            if cr != -1 and (lf == -1 or cr < lf):
                # A CR at the very end may be the first half of a CRLF still in flight.
                if cr == len(self._pending) - 1:
                    break
                end = cr
                width = 2 if self._pending[cr + 1] == "\n" else 1
            else:
                end = lf
                width = 1
            line = self._pending[:end]
            self._pending = self._pending[end + width :]
            event = self._line(line)
            if event is not None:
                events.append(event)
        return events

    def finish(self) -> None:
        """The stream ended: any event without its blank line is discarded, per the spec."""
        self._pending = ""
        self._data = ""
        self._event = ""

    def _line(self, line: str) -> Optional[dict[str, str]]:
        if line == "":
            return self._dispatch()
        if line.startswith(":"):
            return None
        field, colon, value = line.partition(":")
        if colon and value.startswith(" "):
            value = value[1:]
        if field == "event":
            self._event = value
        elif field == "data":
            self._data += value + "\n"
        elif field == "id":
            if "\x00" not in value:
                self._id = value
        elif field == "retry":
            if re.fullmatch(r"[0-9]+", value):
                self.retry_ms = int(value)
        return None

    def _dispatch(self) -> Optional[dict[str, str]]:
        if self._data == "":
            self._event = ""
            return None
        data = self._data[:-1] if self._data.endswith("\n") else self._data
        event = {"event": self._event or "message", "data": data, "id": self._id}
        self._data = ""
        self._event = ""
        return event


class StreamAnswer:
    """One HTTP answer to a stream request: status and headers, then the body in pieces."""

    def __init__(
        self,
        status: int,
        headers: Optional[dict[str, str]] = None,
        chunks: Iterable[bytes] = (),
        close: Optional[Callable[[], None]] = None,
    ) -> None:
        self.status = status
        self.headers = {key.lower(): value for key, value in (headers or {}).items()}
        self.chunks = chunks
        self._close = close

    def body_text(self) -> str:
        return b"".join(self.chunks).decode("utf-8", errors="replace")

    def close(self) -> None:
        if self._close is not None:
            self._close()


#: ``(method, url, headers, idle_timeout_s) -> StreamAnswer``. The only I/O seam.
StreamOpener = Callable[[str, str, dict[str, str], float], StreamAnswer]


def _urllib_stream_opener(method: str, url: str, headers: dict[str, str], idle_timeout_s: float) -> StreamAnswer:
    request = urllib.request.Request(url, method=method)
    for name, value in headers.items():
        request.add_header(name, value)
    try:
        # The socket timeout applies per read, so it is an IDLE timeout here, not a
        # deadline on the whole stream.
        response = urllib.request.urlopen(request, timeout=idle_timeout_s)  # noqa: S310
    except urllib.error.HTTPError as error:
        return StreamAnswer(error.code, dict(error.headers.items()), [error.read()], error.close)

    def chunks() -> Iterator[bytes]:
        reader = getattr(response, "read1", None)
        while True:
            piece = reader(65536) if reader is not None else response.read(1)
            if not piece:
                return
            yield piece

    return StreamAnswer(response.status, dict(response.headers.items()), chunks(), response.close)


class _Reconnect(Exception):
    def __init__(self, cause: Any, delay_s: Optional[float]) -> None:
        super().__init__(str(cause))
        self.cause = cause
        self.delay_s = delay_s


class V1EventStream:
    """An event-stream operation's answer: the APPLIED frames, in order, across reconnects.

    Iterate it once. ``last_event_id`` and ``last_seq`` name the last frame handed
    to the caller, which is the position a later reader resumes after.
    """

    def __init__(
        self,
        *,
        url: str,
        method: str,
        headers: dict[str, str],
        stream_opener: StreamOpener,
        sleep: Callable[[float], None],
        backoff_s: Callable[[int], float],
        refusal_from_answer: Callable[[int, str, dict[str, str]], PlatosError],
        last_event_id: Optional[str] = None,
        last_seq: Optional[int] = None,
        max_reconnects: int = DEFAULT_MAX_RECONNECTS,
        idle_timeout_s: float = DEFAULT_IDLE_TIMEOUT_S,
        on_admission: Optional[Callable[[dict[str, Any], dict[str, Any]], None]] = None,
        on_connect: Optional[Callable[[dict[str, Any]], None]] = None,
    ) -> None:
        if (last_event_id is not None) != (last_seq is not None):
            raise ValueError(
                "V1 stream: last_event_id and last_seq resume together; one without the other cannot be admitted"
            )
        if last_seq is not None and (not isinstance(last_seq, int) or isinstance(last_seq, bool) or last_seq < 1):
            raise ValueError("V1 stream: last_seq must be a whole number of at least 1")
        self._url = url
        self._method = method
        self._headers = headers
        self._open = stream_opener
        self._sleep = sleep
        self._backoff_s = backoff_s
        self._refusal_from_answer = refusal_from_answer
        self._max_reconnects = max_reconnects
        self._idle_timeout_s = idle_timeout_s
        self._on_admission = on_admission
        self._on_connect = on_connect
        self.last_event_id: Optional[str] = last_event_id
        self.last_seq: int = last_seq or 0
        self.end: Optional[dict[str, Any]] = None
        self.reconnects = 0
        self._started = False

    def __iter__(self) -> Iterator[dict[str, Any]]:
        if self._started:
            raise RuntimeError("V1 stream: a stream is read once; open another to read again")
        self._started = True
        return self._frames()

    def _frames(self) -> Iterator[dict[str, Any]]:
        resume_after = self.last_event_id
        while True:
            try:
                yield from self._connect(resume_after)
                return
            except _Reconnect as reconnect:
                if self.reconnects >= self._max_reconnects:
                    raise PlatosStreamError(
                        0,
                        "STREAM_RECONNECTS_EXHAUSTED",
                        f"the stream did not finish within {self._max_reconnects} reconnect(s)",
                        reconnect.cause,
                    ) from None
                self.reconnects += 1
                delay = reconnect.delay_s
                self._sleep(self._backoff_s(self.reconnects - 1) if delay is None else delay)
                end = self.end
                resume_after = end["resumeFrom"] if end is not None and end["kind"] == "interrupted" else self.last_event_id
                self.end = None

    def _connect(self, resume_after: Optional[str]) -> Iterator[dict[str, Any]]:
        headers = dict(self._headers)
        headers["accept"] = EVENT_STREAM_MEDIA_TYPE
        if resume_after:
            headers[LAST_EVENT_ID_HEADER] = resume_after
        try:
            answer = self._open(self._method, self._url, headers, self._idle_timeout_s)
        except Exception as cause:  # noqa: BLE001 - any transport failure is a network error
            raise _Reconnect(PlatosNetworkError(cause), None) from cause

        parser = SseParser()
        try:
            if not 200 <= answer.status < 300:
                refusal = self._refusal_from_answer(answer.status, answer.body_text(), answer.headers)
                if not is_retryable(refusal):
                    raise refusal
                delay = None
                if isinstance(refusal, PlatosRateLimitError) and refusal.retry_after_ms:
                    delay = refusal.retry_after_ms / 1000
                raise _Reconnect(refusal, delay)
            media_type = answer.headers.get("content-type", "").split(";")[0].strip().lower()
            if media_type != EVENT_STREAM_MEDIA_TYPE:
                raise PlatosStreamError(
                    answer.status,
                    "STREAM_MEDIA_TYPE",
                    f"expected {EVENT_STREAM_MEDIA_TYPE}, received {media_type or 'no content type'}",
                )
            decoder = codecs.getincrementaldecoder("utf-8")()
            meta: Optional[dict[str, Any]] = None
            last_received: Optional[dict[str, Any]] = None
            pieces = iter(answer.chunks)
            while True:
                try:
                    piece = next(pieces)
                except StopIteration:
                    parser.push(decoder.decode(b"", final=True))
                    raise self._severed(last_received, parser, None) from None
                except Exception as cause:  # noqa: BLE001 - a read that fails mid-stream severs it
                    raise self._severed(last_received, parser, cause) from cause
                for event in parser.push(decoder.decode(piece)):
                    if event["event"] == STREAM_META_EVENT:
                        meta = self._read_meta(event["data"], resume_after, answer.status)
                        if self._on_connect is not None:
                            self._on_connect({"lastEventId": resume_after, "meta": meta})
                        continue
                    if event["event"] != "message":
                        continue
                    if meta is None:
                        raise PlatosStreamError(
                            answer.status, "STREAM_META_MISSING", f"a frame arrived before {STREAM_META_EVENT}"
                        )
                    frame = _read_frame(event["data"], answer.status)
                    last_received = frame
                    admission = admit_frame(self.last_seq, frame)
                    if self._on_admission is not None:
                        self._on_admission(frame, admission)
                    if admission["kind"] == "duplicate":
                        continue
                    if admission["kind"] == "gap":
                        # Frames were lost between the producer and this reader: re-read
                        # from the last APPLIED cursor rather than render a hole.
                        raise _Reconnect(admission, 0.0)
                    self.last_seq = frame["seq"]
                    if event["id"] != "":
                        self.last_event_id = event["id"]
                    yield frame
                    if not is_terminal_frame_type(frame["t"]):
                        continue
                    end = classify_stream_end(frame, self.last_event_id)
                    self.end = end
                    if not is_resumable(end):
                        return
                    raise _Reconnect(end, None if parser.retry_ms is None else parser.retry_ms / 1000)
        finally:
            answer.close()

    def _severed(self, last_received: Optional[dict[str, Any]], parser: SseParser, cause: Any) -> _Reconnect:
        parser.finish()
        end = classify_stream_end(last_received, self.last_event_id)
        self.end = end
        return _Reconnect(cause if cause is not None else end, None if parser.retry_ms is None else parser.retry_ms / 1000)

    @staticmethod
    def _read_meta(data: str, resume_after: Optional[str], status: int) -> dict[str, Any]:
        try:
            parsed = json.loads(data)
        except ValueError as cause:
            raise PlatosStreamError(status, "STREAM_META_MALFORMED", f"{STREAM_META_EVENT} is not JSON", cause) from cause
        sv = parsed.get("sv") if isinstance(parsed, dict) else None
        replay_from = parsed.get("replayFrom") if isinstance(parsed, dict) else None
        if (
            not isinstance(sv, int)
            or isinstance(sv, bool)
            or not isinstance(parsed, dict)
            or (replay_from is not None and not isinstance(replay_from, str))
        ):
            raise PlatosStreamError(
                status,
                "STREAM_META_MALFORMED",
                f"{STREAM_META_EVENT} must carry an integer sv and a string or null replayFrom",
            )
        if sv < STREAM_SCHEMA_VERSION_MIN or sv > STREAM_SCHEMA_VERSION_MAX:
            raise PlatosStreamError(
                status,
                "STREAM_VERSION_UNSUPPORTED",
                f"this client reads sv {STREAM_SCHEMA_VERSION_MIN}..{STREAM_SCHEMA_VERSION_MAX}; the stream carries sv {sv}",
            )
        # The server echoes the position it resumed after. A different one means the
        # frames that follow are numbered from somewhere this reader did not ask for.
        if replay_from != (resume_after or None):
            raise PlatosStreamError(
                status,
                "STREAM_REPLAY_MISMATCH",
                f"asked to resume after {json.dumps(resume_after)}, the server resumed after {json.dumps(replay_from)}",
            )
        return {"sv": sv, "replayFrom": replay_from}


def _read_frame(data: str, status: int) -> dict[str, Any]:
    try:
        parsed = json.loads(data)
    except ValueError as cause:
        raise PlatosStreamError(status, "STREAM_FRAME_MALFORMED", "a frame's data is not JSON", cause) from cause
    if (
        not isinstance(parsed, dict)
        or not isinstance(parsed.get("sv"), (int, float))
        or isinstance(parsed.get("sv"), bool)
        or not isinstance(parsed.get("t"), str)
        or not isinstance(parsed.get("ts"), (int, float))
        or isinstance(parsed.get("ts"), bool)
        or not _is_whole(parsed.get("seq"))
        or parsed["seq"] < 1
    ):
        raise PlatosStreamError(
            status, "STREAM_FRAME_MALFORMED", "a frame must carry sv, t, a whole seq of at least 1, and ts"
        )
    # A JSON `3.0` is the same whole number the TypeScript reader admits.
    parsed["seq"] = int(parsed["seq"])
    return parsed


def _is_whole(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and value.is_integer()
