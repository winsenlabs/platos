"""The Python V1 event-stream reader, driven by the cross-language resume fixture.

WIN-272 (M4.6), "clients resume without missing or double-applying state".
``tests/sdk-contract/v1-stream-resume.json`` is read here and by
``packages/platos-client/tests/v1-stream.test.ts``. The TypeScript suite joins that
file to core-api's own SSE encoders and to the kernel's ``admitFrame``,
``classifyStreamEnd`` and ``encodeStreamCursor``; this suite drives the Python
reader through the GENERATED ``environment_streams.read`` against the same
connections and asserts, per connection, the Last-Event-ID it sent, the meta it
read, every admission, the frames it applied and how the connection ended. Where
each reconnect fell is pinned, not only the concatenated result.

The rule ports are checked against the fixture's ``admissionGrid`` and ``endGrid``,
which the TypeScript suite requires to be the kernel's own answers.

NO THIRD-PARTY IMPORT, like ``test_v1_contract.py``: pytest collects it, and
``python3 -S -I tests/test_v1_stream.py`` runs every case with the standard library
alone, which is how ``scripts/sdk/v1-contract.test.mjs`` runs it in CI.
"""

from __future__ import annotations

import json
import pathlib
import re
import sys
from contextlib import contextmanager

PACKAGE_ROOT = pathlib.Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = PACKAGE_ROOT.parents[1]
sys.path.insert(0, str(PACKAGE_ROOT))

from platos_client.errors import PlatosRefusal  # noqa: E402
from platos_client.generated.v1 import V1_OPERATIONS  # noqa: E402
from platos_client.v1_stream import (  # noqa: E402
    PlatosStreamError,
    SseParser,
    StreamAnswer,
    V1EventStream,
    admit_frame,
    classify_stream_end,
    is_resumable,
)
from platos_client.v1_transport import V1HttpTransport, create_v1_client  # noqa: E402

FIXTURE = json.loads(
    (REPOSITORY_ROOT / "tests" / "sdk-contract" / "v1-stream-resume.json").read_text("utf-8")
)
SCENARIOS = FIXTURE["scenarios"]
STREAM_OPERATION = next(op for op in V1_OPERATIONS if op["responseKind"] == "event-stream")
JSON_OPERATION = next(op for op in V1_OPERATIONS if op["responseKind"] == "json")


@contextmanager
def raises(expected: type[BaseException], match: str | None = None):
    """``pytest.raises``, in the standard library."""
    try:
        yield
    except expected as error:
        if match is not None and re.search(match, str(error)) is None:
            raise AssertionError(f"{error!r} does not match {match!r}") from error
        return
    raise AssertionError(f"expected {expected.__name__} and nothing was raised")


def pieces_of(connection: dict) -> list[bytes]:
    """``wire`` as UTF-8, split at the fixture's byte offsets (a split may fall inside a character)."""
    data = connection["wire"].encode("utf-8")
    cuts = [0, *connection["byteBoundaries"], len(data)]
    return [data[cuts[index] : cuts[index + 1]] for index in range(len(cuts) - 1)]


def drive(scenario: dict):  # noqa: ANN201
    """Run one scenario through the generated client and record each connection."""
    requests: list[dict] = []
    connections = [
        {"lastEventId": None, "meta": None, "admissions": [], "applied": [], "end": None}
        for _ in scenario["connections"]
    ]
    holder: dict = {}

    def current() -> dict:
        return connections[len(requests) - 1]

    def opener(method, url, headers, idle_timeout_s):  # noqa: ANN001, ANN202
        requests.append({"method": method, "url": url, "headers": dict(headers)})
        index = len(requests) - 1
        assert index < len(scenario["connections"]), f"{scenario['name']}: the reader opened an extra connection"
        connection = scenario["connections"][index]
        current()["lastEventId"] = headers.get("last-event-id")
        response = connection["response"]
        chunks = pieces_of(connection) if response["status"] == 200 else [connection["wire"].encode("utf-8")]
        return StreamAnswer(response["status"], {"Content-Type": response["contentType"]}, iter(chunks))

    def sleep(_seconds: float) -> None:
        current()["end"] = holder["stream"].end

    api = create_v1_client(
        "https://platos.example.com", operator_token="operator-token", stream_opener=opener, sleep=sleep
    )
    options: dict = {
        "on_connect": lambda connection: current().__setitem__("meta", connection["meta"]),
        "on_admission": lambda frame, admission: current()["admissions"].append({"seq": frame["seq"], **admission}),
    }
    if scenario["open"]["lastEventId"] is not None:
        options["last_event_id"] = scenario["open"]["lastEventId"]
        options["last_seq"] = scenario["open"]["lastSeq"]
    stream = api.environment_streams.read(FIXTURE["environmentId"], FIXTURE["streamId"], **options)
    holder["stream"] = stream
    assert requests == [], "nothing may be sent before iteration"
    frames = []
    for frame in stream:
        frames.append(frame)
        current()["applied"].append(frame["seq"])
    current()["end"] = stream.end
    return requests, connections, frames, stream


def test_the_rule_ports_give_the_kernels_admissions() -> None:
    assert len(FIXTURE["admissionGrid"]) >= 25
    for row in FIXTURE["admissionGrid"]:
        assert admit_frame(row["lastApplied"], {"seq": row["seq"]}) == row["admission"], row
    assert {row["admission"]["kind"] for row in FIXTURE["admissionGrid"]} == {"apply", "duplicate", "gap"}


def test_the_rule_ports_give_the_kernels_stream_ends() -> None:
    for row in FIXTURE["endGrid"]:
        end = classify_stream_end(row["lastFrame"], row["resumeFrom"])
        assert end == row["end"], row
        assert is_resumable(end) is row["resumable"], row
    assert {row["end"]["kind"] for row in FIXTURE["endGrid"]} == {"completed", "failed", "interrupted", "severed"}


def test_each_scenario_connection_by_connection() -> None:
    assert SCENARIOS
    template = STREAM_OPERATION["template"]
    expected_url = "https://platos.example.com" + template.replace(
        ":environmentId", FIXTURE["environmentId"]
    ).replace(":streamId", FIXTURE["streamId"])
    for scenario in SCENARIOS:
        name = scenario["name"]
        requests, connections, frames, stream = drive(scenario)
        assert len(requests) == len(scenario["connections"]), name
        for request in requests:
            assert request["method"] == "GET", name
            assert request["url"] == expected_url, name
            assert request["headers"]["accept"] == "text/event-stream", name
            assert request["headers"]["authorization"] == "Bearer operator-token", name
            assert "idempotency-key" not in request["headers"], name
        for index, connection in enumerate(scenario["connections"]):
            where = f"{name} connection {index + 1}"
            expect = connection["expect"]
            assert connections[index]["lastEventId"] == expect["lastEventId"], f"{where} Last-Event-ID"
            assert connections[index]["meta"] == expect["meta"], f"{where} meta"
            assert connections[index]["admissions"] == expect["admissions"], f"{where} admissions"
            assert connections[index]["applied"] == expect["applied"], f"{where} applied"
            assert connections[index]["end"] == expect["end"], f"{where} end"
        assert [frame["seq"] for frame in frames] == scenario["expect"]["applied"], name
        assert "".join(frame.get("text", "") for frame in frames) == scenario["expect"]["text"], name
        assert stream.last_event_id == scenario["expect"]["lastEventId"], name
        assert stream.last_seq == scenario["expect"]["lastSeq"], name
        assert stream.reconnects == scenario["expect"]["reconnects"], name
        assert stream.end == scenario["expect"]["end"], name


def test_the_reconnect_falls_in_the_middle_of_the_sequence() -> None:
    first, second = next(s for s in SCENARIOS if s["name"] == "severed-mid-frame")["connections"]
    assert first["expect"]["applied"] and second["expect"]["applied"]
    assert first["expect"]["applied"][-1] + 1 == second["expect"]["applied"][0]
    assert not first["wire"].endswith("\n\n")
    assert f'"seq":{second["expect"]["applied"][0]}' in first["truncatedAfter"]


def answering(*answers):  # noqa: ANN001, ANN201
    calls: list[dict] = []

    def opener(method, url, headers, idle_timeout_s):  # noqa: ANN001, ANN202
        calls.append(dict(headers))
        return answers[min(len(calls) - 1, len(answers) - 1)]()

    client = create_v1_client("https://platos.example.com", stream_opener=opener, sleep=lambda _s: None)
    return calls, client


def event_stream(text: str, status: int = 200):  # noqa: ANN201
    return lambda: StreamAnswer(status, {"content-type": "text/event-stream; charset=utf-8"}, iter([text.encode("utf-8")]))


def drain(stream) -> None:  # noqa: ANN001
    for _frame in stream:
        pass


def test_an_event_stream_never_goes_through_send() -> None:
    transport = V1HttpTransport("https://platos.example.com")
    with raises(ValueError, match=r"answers with an event stream; read it through stream\(\)"):
        transport.send({"operation": STREAM_OPERATION, "path": STREAM_OPERATION["template"], "body": None, "query": None})
    with raises(ValueError, match=r"answers with JSON; call it through send\(\)"):
        transport.stream({"operation": JSON_OPERATION, "path": JSON_OPERATION["template"], "body": None, "query": None})


def test_a_body_that_is_not_an_event_stream_is_refused() -> None:
    _calls, client = answering(lambda: StreamAnswer(200, {"content-type": "application/json"}, iter([b"{}"])))
    with raises(PlatosStreamError, match="STREAM_MEDIA_TYPE"):
        drain(client.environment_streams.read("e", "s"))


def test_an_sv_outside_the_band_is_refused() -> None:
    _calls, client = answering(event_stream('event: stream_meta\ndata: {"sv":2,"replayFrom":null}\n\n'))
    with raises(PlatosStreamError, match="STREAM_VERSION_UNSUPPORTED"):
        drain(client.environment_streams.read("e", "s"))


def test_a_server_resuming_from_elsewhere_is_refused() -> None:
    cursor = FIXTURE["cursors"]["2"]
    _calls, client = answering(event_stream(f'event: stream_meta\ndata: {{"sv":1,"replayFrom":"{cursor}"}}\n\n'))
    with raises(PlatosStreamError, match="STREAM_REPLAY_MISMATCH"):
        drain(client.environment_streams.read("e", "s"))


def test_a_frame_before_stream_meta_is_refused() -> None:
    wire = SCENARIOS[0]["connections"][0]["wire"]
    _calls, client = answering(event_stream(wire[wire.index("id: ") :]))
    with raises(PlatosStreamError, match="STREAM_META_MISSING"):
        drain(client.environment_streams.read("e", "s"))


def test_a_non_retryable_refusal_is_raised_without_reconnecting() -> None:
    envelope = {
        "error": {"code": "STREAM_CURSOR_EXPIRED", "title": "t", "body": "b", "errorId": "e", "traceRef": "r", "version": "1"}
    }
    calls, client = answering(lambda: StreamAnswer(409, {"content-type": "application/json"}, iter([json.dumps(envelope).encode()])))
    with raises(PlatosRefusal):
        drain(client.environment_streams.read("e", "s"))
    assert len(calls) == 1


def test_the_reconnect_budget_ends_the_stream_and_every_retry_carries_the_cursor() -> None:
    cursor = FIXTURE["cursors"]["1"]
    severed = event_stream(
        'event: stream_meta\ndata: {"sv":1,"replayFrom":null}\n\n'
        f'id: {cursor}\ndata: {{"sv":1,"t":"assistant.delta","seq":1,"ts":1}}\n\n'
    )
    resumed_nothing = event_stream(f'event: stream_meta\ndata: {{"sv":1,"replayFrom":"{cursor}"}}\n\n')
    calls, client = answering(severed, resumed_nothing)
    stream = client.environment_streams.read("e", "s", max_reconnects=2)
    try:
        drain(stream)
    except PlatosStreamError as error:
        assert error.violation == "STREAM_RECONNECTS_EXHAUSTED"
    else:  # pragma: no cover - the failure this case exists for
        raise AssertionError("an endless severed stream was not bounded")
    assert [headers.get("last-event-id") for headers in calls] == [None, cursor, cursor]
    assert stream.reconnects == 2


def test_a_cursor_without_its_sequence_is_refused() -> None:
    _calls, client = answering(event_stream(""))
    with raises(ValueError, match="resume together"):
        client.environment_streams.read("e", "s", last_event_id=FIXTURE["cursors"]["2"])


def test_a_stream_is_read_once() -> None:
    wire = next(s for s in SCENARIOS if s["name"] == "failed-is-final")["connections"][0]["wire"]
    _calls, client = answering(event_stream(wire))
    stream = client.environment_streams.read("e", "s")
    drain(stream)
    assert isinstance(stream, V1EventStream)
    with raises(RuntimeError, match="read once"):
        drain(stream)


def test_the_parser_ends_lines_on_crlf_cr_and_lf() -> None:
    parser = SseParser()
    events = parser.push("data: a\r") + parser.push("\n\r\ndata: b\rdata: c\n\n")
    assert events == [
        {"event": "message", "data": "a", "id": ""},
        {"event": "message", "data": "b\nc", "id": ""},
    ]


def test_the_parser_strips_a_bom_ignores_comments_and_joins_data() -> None:
    parser = SseParser()
    bom = chr(0xFEFF)
    assert parser.push(f"{bom}: hello\nevent: x\ndata:one\ndata: two\n\n") == [{"event": "x", "data": "one\ntwo", "id": ""}]


def test_the_parser_keeps_the_id_buffer_and_ignores_an_id_holding_null() -> None:
    parser = SseParser()
    nul = chr(0)
    assert parser.push(f"id: 7\ndata: a\n\nid: 8{nul}\ndata: b\n\nevent: only\n\ndata: c\n\n") == [
        {"event": "message", "data": "a", "id": "7"},
        {"event": "message", "data": "b", "id": "7"},
        {"event": "message", "data": "c", "id": "7"},
    ]


def test_the_parser_reads_retry_and_discards_a_torn_event() -> None:
    parser = SseParser()
    parser.push("retry: 1500\nretry: soon\ndata: torn")
    assert parser.retry_ms == 1500
    parser.finish()
    assert parser.push("\n\n") == []


def main() -> int:
    """Run every case with the standard library alone."""
    cases = sorted(
        (name, value) for name, value in globals().items() if name.startswith("test_") and callable(value)
    )
    if not cases:
        print("no cases were collected; the runner is wrong", file=sys.stderr)
        return 1
    failures = 0
    for name, case in cases:
        try:
            case()
        except Exception as error:  # noqa: BLE001 - a runner reports, it does not filter
            failures += 1
            print(f"FAIL {name}: {error!r}", file=sys.stderr)
    print(f"{len(cases) - failures}/{len(cases)} python V1 stream cases passed", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
