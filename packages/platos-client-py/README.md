# platos-client (Python)

Official Python SDK for [Platos](https://platos.dev) — the open-source agent runtime.

Agents · threads · realtime streaming · approvals · budgets · background operations · monitoring.

## Install

```bash
pip install platos-client
# or
uv add platos-client
```

Requires Python `>=3.10`.

## Quick start

```python
import asyncio
from platos_client import PlatosClient

async def main():
    async with PlatosClient(
        base_url="https://platos.your-domain.com",
        session_token="<minted by your backend — see Auth below>",
    ) as client:
        agents = await client.agents.list()
        print(f"agents in scope: {[a['name'] for a in agents]}")

        thread = await client.threads.create(agent_id=agents[0]["id"])
        async for event in client.threads.send(thread["id"], "Summarise today's inbox."):
            if event["type"] == "token":
                print(event["text"], end="", flush=True)
            elif event["type"] == "done":
                print()
                break

asyncio.run(main())
```

## Auth — session tokens (recommended)

Platos is multi-tenant. Browsers and untrusted callers must **never** hold a raw `serviceSecret`. The pattern:

1. **Backend mints** a session token signed with your entity's `serviceSecret` (use `@platosdev/token-mint` from npm or any JWT library — the wire format is plain HS256).
2. **Client** calls `PlatosClient(session_token=...)`. The token is a short-lived JWT carrying your scope tuple `(organizationId, projectId, environmentId)`.
3. **Refresh** by re-minting on the server; pass `on_token_refresh=...` so the client retries automatically on `401`.

```python
async def refresh():
    async with httpx.AsyncClient() as http:
        r = await http.post("/api/platos-session")
        return r.json()["token"]

client = PlatosClient(
    base_url="https://platos.example.com",
    session_token=current_token,
    on_token_refresh=refresh,
)
```

## User identity passthrough (`userMeta`)

If your agent needs to know *which of your users* is speaking, sign a `userMeta: { name, email }` claim into the session token on your backend. ScopeGuard surfaces it as `{{user.name}}` / `{{user.email}}` in prompts and dynamic blocks, and the trace's identity columns get populated. See [Auth modes docs](https://platos.dev/docs/auth-modes#visitor-identity-usermeta).

## Direct-header mode (server-to-server)

For trusted server-to-server use only — never the browser:

```python
client = PlatosClient(
    base_url="http://platos:3100",
    api_key=os.environ["PLATOS_INTERNAL_TOKEN"],
    scope={
        "organizationId": "org_...",
        "projectId":      "prj_...",
        "environmentId":  "env_...",
    },
)
```

## Streaming events

`client.threads.send(...)` returns an async iterator of dict events. Common types:

| `event["type"]` | When it fires |
|---|---|
| `connected` / `disconnected` / `reconnecting` | WebSocket lifecycle |
| `token` | Streaming text chunk (`event["text"]`) |
| `thinking` | Reasoning / extended-thinking chunk |
| `tool_call` | Agent invoked a tool (`name`, `params`, `callId`) |
| `tool_result` | Tool returned (`name`, `result`, optional `display` hint) |
| `approval_needed` | HITL gate — call `client.approvals.resolve(...)` to continue |
| `artifact_start` / `artifact_delta` / `artifact_committed` | Streaming artifact build |
| `safety_flags` | PII / safety filter hits |
| `done` | Turn finished (carries `usage` cost summary) |
| `error` | Server-side error (carries `message` + extras) |

## Error handling

```python
from platos_client import (
    PlatosError,
    PlatosAuthError,
    PlatosRateLimitError,
    PlatosValidationError,
    PlatosServerError,
    PlatosNetworkError,
)

try:
    async for evt in client.threads.send(thread_id, "..."):
        ...
except PlatosAuthError:
    # 401 / 403 — refresh token
    ...
except PlatosRateLimitError as e:
    # 429 — wait e.retry_after_ms then retry
    ...
except PlatosValidationError:
    # 400 — fix payload
    ...
except PlatosServerError:
    # 5xx — likely transient
    ...
```

## API surface

| Namespace | Methods |
|---|---|
| `client.agents` | `list`, `get`, `list_versions` |
| `client.threads` | `create`, `list`, `get`, `messages`, `artifacts`, `send` (streaming) |
| `client.approvals` | `list`, `resolve` (human-in-the-loop) |
| `client.budgets` | `list`, `status` (read-only — caps managed in the dashboard) |
| `client.monitoring` | `runs`, `traces`, `cost_by_agent`, `cost_by_scope` |
| `client.bgo` | `tasks`, `runs`, `schedules`, `batches` (background-operation engine; `client.trigger` is the deprecated alias) |

## Cross-language parity

A TypeScript / JavaScript equivalent ships as [`@platosdev/client`](https://www.npmjs.com/package/@platosdev/client) on npm. The wire shape is identical; switching between them in your stack is a port, not a rewrite.

## Licence

Apache 2.0 — see `LICENSE`. Same as Platos itself.

## Source + issues

- Repo: https://github.com/winsenlabs/platos
- Package directory: `packages/platos-client-py`
- Issues: https://github.com/winsenlabs/platos/issues
- Docs: https://platos.dev/docs/sdks
