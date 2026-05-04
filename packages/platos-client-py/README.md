# platos-client (Python)

Official Python SDK for [Platos](https://platos.dev) — the open-source agent
runtime. Apache 2.0.

```bash
pip install platos-client
```

## Quickstart

```python
import asyncio
from platos_client import PlatosClient

async def main():
    async with PlatosClient(
        base_url="https://agent.platos.dev",
        session_token="<session token minted by your backend>",
    ) as client:
        agents = await client.agents.list()
        print(f"agents in scope: {[a['name'] for a in agents]}")

        thread = await client.threads.create(agent_id=agents[0]["id"])
        async for event in client.threads.send(thread["id"], "hello!"):
            if event["type"] == "token":
                print(event["text"], end="", flush=True)
            elif event["type"] == "done":
                print()
                break

asyncio.run(main())
```

## Auth modes

Mirrors the TypeScript SDK:

- **`session_token`** — JWT minted by the customer's backend with the entity's
  service secret. This is the mode for consumer apps.
- **`api_key`** — direct-header mode. Only valid for trusted internal calls.
  Every call must pass `scope=`.

## Features

- Typed responses (`TypedDict`-friendly result shapes)
- Automatic retry with exponential backoff on 5xx / 429 / network errors
- Token-refresh hook (`on_token_refresh=...`) for 401 recovery
- Realtime streaming via `websockets` with buffer-during-disconnect + reconnect
- Unified trigger.dev ops under `client.trigger.tasks / runs / schedules / batches`

See the mirrored TypeScript package `@platos/client` for the full surface.
