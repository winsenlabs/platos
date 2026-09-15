"""The platools wire protocol, driven against the fixture both SDKs read.

WIN-270 (M4.4), cross-language fixtures. ``tests/sdk-contract/platools-protocol.json``
is read here AND by ``packages/platools-js/tests/protocol-fixture.test.ts``. Each
suite declares the fixture's tool in its own language, runs its own
``PlatoolsClient`` through registration and dispatch over a recording socket, and
compares the frames the client SENDS against the fixture. Nothing asserted below is
a value this file writes: the expected frames, the parameter meanings and the error
string come from the fixture, and the frame key sets come from the platform's own
protocol header in ``apps/agent/src/tool-gateway/tool-sync-ws.service.ts``.

The one thing this file does write is the handler, and the fixture's ``$comment``
states what it must return; the TypeScript suite registers the same one. What that
handler's output proves is not its own shape but what reached it: the declared
default, the call context, and no envelope in its arguments.
"""

from __future__ import annotations

import json
import pathlib
import re
from typing import Any

from platools import Platools
from platools.context import current_scope
from platools.transport.client import PlatoolsClient, _platform_adapter
from platools.transport.protocol import ToolCallMessage

REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[3]
FIXTURE: dict[str, Any] = json.loads(
    (REPOSITORY_ROOT / "tests" / "sdk-contract" / "platools-protocol.json").read_text("utf-8")
)
TOOL = FIXTURE["tool"]
FRAMES = FIXTURE["frames"]


def server_frame_keys() -> dict[str, list[str]]:
    """The frame key lists the platform documents, parsed out of its protocol header.

    Each line reads ``{ type: "<name>", key, key?, nested: [...] }``. A nested value
    is reduced to its key, and ``?`` is kept because it is the platform's statement
    that the key is optional.
    """
    source = (REPOSITORY_ROOT / FIXTURE["server"]).read_text("utf-8")
    found: dict[str, list[str]] = {}
    pattern = re.compile(r'^\s*\*\s*\{\s*type:\s*"([a-z_]+)",\s*(.*?)\s*\}\s*$', re.MULTILINE)
    for match in pattern.finditer(source):
        flattened = re.sub(r"\[[^\]]*\]", "", re.sub(r"\{[^{}]*\}", "", match.group(2)))
        keys = [key.split(":")[0].strip() for key in flattened.split(",")]
        found[match.group(1)] = ["type", *[key for key in keys if key]]
    return found


def types_of(prop: dict[str, Any]) -> list[str]:
    """A property's JSON types: ``type`` as a string or a list, plus every ``anyOf`` member's."""
    types: set[str] = set()

    def add(value: Any) -> None:
        if isinstance(value, str):
            types.add(value)
        elif isinstance(value, list):
            types.update(entry for entry in value if isinstance(entry, str))

    add(prop.get("type"))
    for member in prop.get("anyOf", []) or []:
        add(member.get("type"))
    return sorted(types)


def parameters_of(schema: dict[str, Any]) -> list[dict[str, Any]]:
    """The fixture's reading of an ``input_schema``: see its ``$comment``."""
    required = set(schema.get("required", []))
    readings: list[dict[str, Any]] = []
    for name, prop in (schema.get("properties") or {}).items():
        reading: dict[str, Any] = {
            "name": name,
            "types": types_of(prop),
            "required": name in required,
        }
        if "default" in prop and prop["default"] is not None:
            reading["default"] = prop["default"]
        readings.append(reading)
    return readings


def without_optional_nulls(frame: dict[str, Any], keys: list[str]) -> dict[str, Any]:
    """Drop the keys the platform marks optional when they are null; it treats absent and null alike."""
    optional = {key[:-1] for key in keys if key.endswith("?")}
    return {key: value for key, value in frame.items() if not (key in optional and value is None)}


def required_keys(keys: list[str]) -> list[str]:
    return sorted(key for key in keys if not key.endswith("?"))


def allowed_keys(keys: list[str]) -> list[str]:
    return sorted(key.rstrip("?") for key in keys)


class RecordingSocket:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send(self, payload: str) -> None:
        self.sent.append(payload)


def client_with_fixture_tool() -> PlatoolsClient:
    """The fixture's tool, declared the Python way."""
    platools = Platools()

    @platools.tool(
        name=TOOL["name"],
        description=TOOL["description"],
        auth=TOOL["auth"],
        roles=list(TOOL["roles"]),
        annotations=dict(TOOL["annotations"]),
    )
    def lookup_order(
        order_id: str, quantity: int, gift: bool = False, note: str | None = None
    ):  # noqa: ANN202 - no return annotation, so no output schema: the fixture says null
        organization_id, project_id, environment_id = current_scope()
        return {
            "received": {"order_id": order_id, "quantity": quantity, "gift": gift},
            "scope": {
                "organizationId": organization_id,
                "projectId": project_id,
                "environmentId": environment_id,
            },
        }

    return PlatoolsClient(
        url="https://platos.example.com",
        secret="service-secret",
        registry=platools.registry,
    )


async def dispatch(client: PlatoolsClient, wire: dict[str, Any]) -> dict[str, Any]:
    """Decode a platform frame the way the message loop does, dispatch it, return the reply."""
    message = _platform_adapter.validate_python(json.loads(json.dumps(wire)))
    assert isinstance(message, ToolCallMessage)
    socket = RecordingSocket()
    await client._dispatch_call(socket, message)  # type: ignore[arg-type]
    assert len(socket.sent) == 1, "the client sent no reply frame"
    frame: dict[str, Any] = json.loads(socket.sent[0])
    return frame


def test_states_exactly_the_frame_keys_the_platform_documents() -> None:
    server = server_frame_keys()
    for name in ("tool_register", "tool_call", "tool_result", "tool_error"):
        assert name in server, f"{FIXTURE['server']} no longer documents {name}"
        assert sorted(FRAMES[name]["keys"]) == sorted(server[name]), name


async def test_registers_the_tool_as_the_fixture_tool_register_frame() -> None:
    client = client_with_fixture_tool()
    socket = RecordingSocket()
    await client._send_registration(socket)  # type: ignore[arg-type]
    assert len(socket.sent) == 1
    frame = json.loads(socket.sent[0])
    spec = FRAMES["tool_register"]

    assert sorted(frame) == sorted(spec["keys"])
    assert frame["type"] == spec["expected"]["type"]
    assert len(frame["tools"]) == len(spec["expected"]["tools"])
    sent, expected = frame["tools"][0], spec["expected"]["tools"][0]
    assert sorted(sent) == sorted(spec["toolKeys"])
    for key, value in expected.items():
        assert sent[key] == value, f"tools[0].{key}"
    assert sent["input_schema"].get("type") == "object"
    assert parameters_of(sent["input_schema"]) == TOOL["parameters"]


def test_decodes_the_platform_tool_call_frame_without_losing_a_field() -> None:
    wire = FRAMES["tool_call"]["wire"]
    assert sorted(wire) == sorted(FRAMES["tool_call"]["keys"])
    decoded = _platform_adapter.validate_python(wire)
    assert isinstance(decoded, ToolCallMessage)
    assert decoded.model_dump() == wire


async def test_answers_the_tool_call_with_the_fixture_tool_result_frame() -> None:
    frame = await dispatch(client_with_fixture_tool(), FRAMES["tool_call"]["wire"])
    spec = FRAMES["tool_result"]

    assert sorted(frame) == allowed_keys(spec["keys"])
    latency = frame.pop("latency_ms")
    assert isinstance(latency, int) and not isinstance(latency, bool) and latency >= 0, latency
    assert frame == spec["expected"]


async def test_answers_an_unknown_tool_with_the_fixture_tool_error_frame() -> None:
    spec = FRAMES["tool_error"]
    frame = await dispatch(client_with_fixture_tool(), spec["call"])

    for key in required_keys(spec["keys"]):
        assert key in frame, key
    for key in frame:
        assert key in allowed_keys(spec["keys"]), key
    assert without_optional_nulls(frame, spec["keys"]) == spec["expected"]
