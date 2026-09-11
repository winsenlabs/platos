"""The generated Python V1 client, driven against the contract it came from.

WIN-270 (M4.4). This suite and
``packages/platos-client/tests/v1-contract.test.ts`` read the SAME file —
``tests/sdk-contract/v1-fixtures.json``, emitted by ``pnpm generate:sdk-v1``
from the V1 OpenAPI document, the operation manifest and core-api's idempotency
policy. Each drives its own generated client and asserts the request it
produces. Two clients that disagree about a path, a header or an idempotency
class cannot both match one fixture, which is what "cross-language fixtures" has
to mean to be worth anything. Nothing here is asserted against a value written
in this file.

NO THIRD-PARTY IMPORT, DELIBERATELY. ``pytest`` collects and runs this module
the usual way, and ``python3 tests/test_v1_contract.py`` runs every case with
nothing but the standard library. That is what lets
``scripts/sdk/v1-contract.test.mjs`` — and therefore CI — execute the Python
half on a runner that has an interpreter and no packages installed. A
cross-language fixture only one language ever runs is not a cross-language
fixture.
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

from platos_client.errors import (  # noqa: E402
    PlatosNetworkError,
    PlatosRefusal,
    read_wire_error,
)
from platos_client.generated.v1 import (  # noqa: E402
    IDEMPOTENCY_KEY_HEADER,
    V1_OPERATIONS,
    WIRE_ERROR_CODES,
    V1Api,
)
from platos_client.v1_transport import (  # noqa: E402
    HttpAnswer,
    V1HttpTransport,
    create_v1_client,
    refusal_from,
)

FIXTURE = json.loads(
    (REPOSITORY_ROOT / "tests" / "sdk-contract" / "v1-fixtures.json").read_text("utf-8")
)
OPENAPI = json.loads(
    (
        REPOSITORY_ROOT / "apps" / "agent" / "src" / "openapi" / "openapi.generated.json"
    ).read_text("utf-8")
)
TAXONOMY = json.loads((REPOSITORY_ROOT / "docs" / "error-taxonomy.json").read_text("utf-8"))

OPERATIONS = FIXTURE["operations"]
MINTS = [entry for entry in OPERATIONS if entry["idempotency"] == "required"]

UNAUTHENTICATED_ENVELOPE = {
    "error": {
        "code": "UNAUTHENTICATED",
        "title": "Sign in to continue.",
        "body": "This request carried no live operator session.",
        "errorId": "err_01J",
        "traceRef": "trace_01J",
        "version": "1",
    }
}


@contextmanager
def raises(expected: type[BaseException], match: str | None = None):
    """``pytest.raises``, in six lines of standard library.

    Written out rather than imported so this module has no third-party
    dependency; see the module docstring for why that matters.
    """
    try:
        yield
    except expected as error:
        if match is not None and re.search(match, str(error)) is None:
            raise AssertionError(f"{error!r} does not match {match!r}") from error
        return
    raise AssertionError(f"expected {expected.__name__} and nothing was raised")


class Recorder:
    """A transport that records the request instead of performing it."""

    def __init__(self) -> None:
        self.sent: list[dict] = []

    def send(self, request):  # noqa: ANN001, ANN201 - matches the generated Protocol
        self.sent.append(request)
        return None


def drive(api: V1Api, entry: dict):  # noqa: ANN201
    """Invoke one generated method by the names the fixture states."""
    namespace = getattr(api, entry["python"]["namespace"], None)
    assert namespace is not None, f"no generated namespace {entry['python']['namespace']}"
    method = getattr(namespace, entry["python"]["method"], None)
    assert callable(method), f"no generated method {entry['python']['method']}"
    args = list(entry["arguments"]["pathParameters"].values())
    if entry["arguments"]["body"] is not None:
        args.append(entry["arguments"]["body"])
    # M4 finish - the DERIVED query, under Python's own spelling. Three operations
    # publish typed query parameters and one of them is required, so a driver that
    # stopped at path and body would raise for them.
    query = entry["arguments"]["pythonQuery"]
    if query is not None:
        return method(*args, **query)
    return method(*args)


def openers(answers):  # noqa: ANN001, ANN201
    """An opener that records every call and replays ``answers`` in order."""
    calls: list[tuple] = []

    def opener(method, url, headers, body):  # noqa: ANN001
        calls.append((method, url, dict(headers), body))
        answer = answers[min(len(calls) - 1, len(answers) - 1)]
        return answer() if callable(answer) else answer

    return calls, opener


def test_emits_exactly_the_operations_the_document_derives_schemas_for() -> None:
    derived = sorted(
        f"{method.upper()} {path}"
        for path, item in OPENAPI["paths"].items()
        for method, operation in item.items()
        if operation.get("x-platos-schema-source") == "typescript-dto"
    )
    emitted = sorted(
        "{} {}".format(
            operation["method"],
            re.sub(r":([A-Za-z0-9_]+)", lambda m: "{" + m.group(1) + "}", operation["template"]),
        )
        for operation in V1_OPERATIONS
    )
    assert emitted == derived
    assert emitted


def test_every_wire_error_code_is_canonical() -> None:
    canonical = set(TAXONOMY["codes"])
    assert canonical
    assert [code for code in WIRE_ERROR_CODES if code not in canonical] == []


def test_idempotency_header_matches_the_fixture() -> None:
    assert IDEMPOTENCY_KEY_HEADER == FIXTURE["idempotencyKeyHeader"]


def test_generated_methods_produce_the_fixture_requests() -> None:
    assert OPERATIONS
    for entry in OPERATIONS:
        where = entry["operationId"]
        recorder = Recorder()
        drive(V1Api(recorder), entry)
        assert len(recorder.sent) == 1, where
        request = recorder.sent[0]
        assert request["operation"]["operationId"] == entry["operationId"], where
        assert request["operation"]["method"] == entry["expected"]["method"], where
        assert request["operation"]["idempotency"] == entry["idempotency"], where
        assert request["operation"]["successStatus"] == entry["successStatus"], where
        assert request["path"] == entry["expected"]["path"], where
        assert request["body"] == entry["arguments"]["body"], where


def test_the_transport_sends_the_fixture_headers() -> None:
    for entry in OPERATIONS:
        where = entry["operationId"]
        calls, opener = openers([HttpAnswer(204, "")])
        api = create_v1_client(
            "https://platos.example.com",
            operator_token="operator-token",
            opener=opener,
        )
        drive(api, entry)
        assert len(calls) == 1, where
        method, url, headers, _body = calls[0]
        expected_url = (
            "https://platos.example.com"
            + entry["expected"]["path"]
            + entry["expected"]["queryString"]
        )
        assert url == expected_url, where
        assert method == entry["expected"]["method"], where
        assert headers["authorization"] == "Bearer operator-token", where
        assert headers.get("content-type") == entry["expected"]["contentType"], where
        assert (IDEMPOTENCY_KEY_HEADER in headers) is entry["expected"]["sendsIdempotencyKey"], where


def test_there_are_mints_to_test() -> None:
    assert MINTS


def test_a_mint_reuses_one_key_across_every_retry() -> None:
    for entry in MINTS:
        where = entry["operationId"]
        state = {"calls": 0}

        def answer() -> HttpAnswer:
            state["calls"] += 1
            # Two transport failures, then the answer. Exactly the shape that
            # mints twice when the key moves inside the retry loop.
            if state["calls"] < 3:
                return HttpAnswer(503, "{}")
            return HttpAnswer(201, json.dumps({"data": {}, "meta": {}}))

        calls, opener = openers([answer])
        api = create_v1_client("https://platos.example.com", opener=opener, sleep=lambda _s: None)
        drive(api, entry)
        keys = [headers[IDEMPOTENCY_KEY_HEADER] for _m, _u, headers, _b in calls]
        assert len(keys) == 3, where
        assert len(set(keys)) == 1, where
        assert re.fullmatch(r"[A-Za-z0-9_.:-]{1,255}", keys[0]), where


def test_a_second_logical_call_mints_a_different_key() -> None:
    for entry in MINTS:
        where = entry["operationId"]
        calls, opener = openers([HttpAnswer(201, json.dumps({"data": {}, "meta": {}}))])
        api = create_v1_client("https://platos.example.com", opener=opener)
        drive(api, entry)
        drive(api, entry)
        keys = [headers[IDEMPOTENCY_KEY_HEADER] for _m, _u, headers, _b in calls]
        assert len(keys) == 2, where
        assert len(set(keys)) == 2, where


def test_a_mint_is_refused_when_the_key_factory_returns_nothing() -> None:
    transport = V1HttpTransport("https://platos.example.com", idempotency_key=lambda _r: "")
    mint = next(op for op in V1_OPERATIONS if op["idempotency"] == "required")
    with raises(ValueError, match="a mint cannot be sent without one"):
        transport.key_for({"operation": mint, "path": mint["template"], "body": {}, "query": None})


def test_the_servers_replay_verdict_is_surfaced() -> None:
    _calls, opener = openers(
        [
            HttpAnswer(
                201,
                json.dumps({"data": {}, "meta": {}}),
                {"Idempotency-Replayed": "true"},
            )
        ]
    )
    transport = V1HttpTransport("https://platos.example.com", opener=opener)
    V1Api(transport).mcp_platform_tokens.mint(
        {
            "environmentId": "env",
            "name": "n",
            "permissions": [],
            "tier": "admin",
            "ttlSeconds": None,
        }
    )
    assert transport.last_response_was_replay is True


def test_an_unauthenticated_caller_gets_a_coded_refusal() -> None:
    for entry in OPERATIONS:
        where = entry["operationId"]
        _calls, opener = openers([HttpAnswer(401, json.dumps(UNAUTHENTICATED_ENVELOPE))])
        api = create_v1_client("https://platos.example.com", opener=opener)
        try:
            drive(api, entry)
        except PlatosRefusal as refusal:
            assert refusal.status == 401, where
            assert refusal.code == "UNAUTHENTICATED", where
            assert refusal.code in WIRE_ERROR_CODES, where
            assert refusal.refusal is not None, where
            assert refusal.refusal["errorId"] == "err_01J", where
            assert refusal.refusal["traceRef"] == "trace_01J", where
        else:  # pragma: no cover - the failure this whole case exists for
            raise AssertionError(f"{where} returned a value to an unauthenticated caller")


def test_the_code_is_read_off_the_envelope_not_off_a_message_field() -> None:
    error = refusal_from(HttpAnswer(403, json.dumps(UNAUTHENTICATED_ENVELOPE)))
    assert error.code == "UNAUTHENTICATED"
    assert "UNAUTHENTICATED" in str(error)


def test_no_code_is_invented_for_a_body_that_is_not_the_envelope() -> None:
    assert read_wire_error({"error": "plain string"}) is None
    assert read_wire_error({"error": {"title": "no code here"}}) is None
    assert refusal_from(HttpAnswer(400, "not json at all")).code is None


def test_fields_are_carried_off_a_validation_refusal() -> None:
    error = refusal_from(
        HttpAnswer(
            400,
            json.dumps(
                {
                    "error": {
                        "code": "TRANSPORT_REQUEST_INVALID",
                        "title": "That request could not be read.",
                        "body": "One or more fields were rejected.",
                        "errorId": "err_2",
                        "traceRef": "trace_2",
                        "version": "1",
                        "fields": [
                            {"field": "slug", "code": "required", "message": "slug is required"}
                        ],
                    }
                }
            ),
        )
    )
    assert error.refusal is not None
    assert error.refusal["fields"] == [
        {"field": "slug", "code": "required", "message": "slug is required"}
    ]


def test_a_refusal_is_not_retried() -> None:
    calls, opener = openers([HttpAnswer(401, json.dumps(UNAUTHENTICATED_ENVELOPE))])
    api = create_v1_client("https://platos.example.com", opener=opener, sleep=lambda _s: None)
    with raises(PlatosRefusal):
        api.organizations.list()
    assert len(calls) == 1


def test_a_transport_failure_is_a_network_error_not_an_empty_answer() -> None:
    def opener(_method, _url, _headers, _body):  # noqa: ANN001
        raise OSError("socket hang up")

    api = create_v1_client(
        "https://platos.example.com", opener=opener, max_retries=1, sleep=lambda _s: None
    )
    with raises(PlatosNetworkError):
        api.projects.list()


def test_an_empty_path_parameter_is_refused() -> None:
    api = V1Api(Recorder())
    with raises(ValueError, match="path parameter entityId is required"):
        api.mcp_entity_tokens.mint(
            "",
            {
                "environmentId": "env",
                "label": "l",
                "scopes": [],
                "mcpUserId": None,
                "ttlSeconds": None,
            },
        )


def main() -> int:
    """Run every case with the standard library alone."""
    cases = sorted(
        (name, value)
        for name, value in globals().items()
        if name.startswith("test_") and callable(value)
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
            print(f"FAIL {name}: {error}", file=sys.stderr)
    print(f"{len(cases) - failures}/{len(cases)} python V1 contract cases passed", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
