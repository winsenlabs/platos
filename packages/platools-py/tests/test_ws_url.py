"""Regression tests for `PlatoolsClient._ws_url`.

The old implementation did `f"{base.rstrip('/')}/ws/sdk"`, which
corrupted the last query value when the URL had a query string
(`?env=prod` → `?env=prod/ws/sdk`). The server then failed env
resolution. See winsenlabs/platos#3.
"""

from __future__ import annotations

from platools import Platools
from platools.transport.client import PlatoolsClient


def _make_client(url: str) -> PlatoolsClient:
    p = Platools()
    return PlatoolsClient(url=url, secret="s", registry=p.registry)


def test_ws_url_no_query() -> None:
    client = _make_client("wss://host.example/y")
    assert client._ws_url() == "wss://host.example/y/ws/sdk"


def test_ws_url_strips_trailing_slash_from_path() -> None:
    client = _make_client("wss://host.example/y/")
    assert client._ws_url() == "wss://host.example/y/ws/sdk"


def test_ws_url_swaps_http_to_ws() -> None:
    client = _make_client("http://host:9000")
    assert client._ws_url() == "ws://host:9000/ws/sdk"


def test_ws_url_swaps_https_to_wss() -> None:
    client = _make_client("https://host.example/y")
    assert client._ws_url() == "wss://host.example/y/ws/sdk"


def test_ws_url_inserts_before_query_single_param() -> None:
    # Regression for the concat bug. Server saw `env=prod/ws/sdk`.
    client = _make_client("wss://x.example/y?z=1")
    assert client._ws_url() == "wss://x.example/y/ws/sdk?z=1"


def test_ws_url_inserts_before_query_multiple_params() -> None:
    client = _make_client(
        "wss://play.platos.dev/tools/sync?source=winsen-brain-demo-app&env=prod",
    )
    assert (
        client._ws_url()
        == "wss://play.platos.dev/tools/sync/ws/sdk?source=winsen-brain-demo-app&env=prod"
    )
