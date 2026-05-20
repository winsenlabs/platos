# platools (Python)

## 0.2.1 — 2026-05-20

### Fixed

- **`PlatoolsClient._ws_url` corrupted query strings** (parity with the JS SDK fix in `@platosdev/platools-sdk` 0.2.1; mirrors winsenlabs/platos#3). The old implementation did `f"{base.rstrip('/')}/ws/sdk"`, concatenating the suffix *after* any query string. A bridge configured with `PLATOS_URL=wss://play.platos.dev/tools/sync?env=prod` ended up shipping the handshake to `…?env=prod/ws/sdk`; the server then parsed `env="prod/ws/sdk"` and rejected with `could not resolve env for entity`. Fix splits the URL at `?`, appends `/ws/sdk` to the path, and re-attaches the query.
- **`WelcomeMessage` accepts the canonical `organization_id` field** the server actually emits, with `org_id` kept as a backwards-compatible read alias. The model also surfaces optional `entity_id`, `environment_id`, and `project_id` when present. Silences the `platools received malformed message` warn that older SDKs emitted on every connect.

### Tests

- New regression cases in `tests/test_ws_url.py` for the URL-construction bug.
- Welcome decoder dual-shape cases added to `tests/test_protocol.py`.

## 0.2.0 — 2026-05-06

### What changed

- Bump from `0.0.0` (pre-release) to first publishable version.
- **Confirmed correct `_context` handling** in both transport layers:
  - WebSocket dispatch (`platools.transport.client.PlatoolsClient._dispatch_call`):
    pops both `__platos` and `_context` from `params` before invoking the
    handler. Handlers without a `ctx` parameter receive a clean `**kwargs`
    splat; handlers that declare `ctx: PlatosContext` get the unpacked
    `_context` envelope as the keyword argument.
  - HTTP / `platools serve` dispatcher (`platools.serve.dispatcher.Dispatcher.dispatch_tool_call`):
    same pop semantics; merges header-derived `extra_envelope` (e.g.
    `X-Platos-Entity-Token`) into the `__platos` envelope before context
    vars are set.
- ContextVars (`platos_user_id`, `platos_org_id`, `platos_project_id`,
  `platos_env_id`, `platos_entity_id`, `platos_user_token`,
  `platos_agent_id`, `platos_thread_id`, `platos_call_id`,
  `platos_timestamp`, `platos_signature`, `platos_nonce`,
  `platos_entity_token`) are set BEFORE the handler runs and reset in a
  `finally` block — guaranteed cleanup on handler error.

### Architectural contract (entity backend authors)

Platos always injects `_context` into tool-call arguments when the
operator has enabled it on their entity (default ON for new entities).
Your handler must NOT declare `_context` as an explicit parameter — the
SDK pops it before your function runs. Read identity via:

```python
from platools.context import (
    current_user_id,
    current_scope,
    current_user_token,
    current_thread_id,
    current_agent_id,
    current_entity_id,
    current_context,
    current_entity_token,
)

@platools.tool(auth="user")
def list_orders(customer_id: str) -> list[Order]:
    user_id = current_user_id()         # MCP / agent caller identity
    org, project, env = current_scope() # trigger.dev scope tuple
    ...
```

If you need the unpacked CTX.2 envelope (entity-defined keys like
`user.id`, `tenant.id`, `entity_ids`), declare an explicit `ctx`
parameter:

```python
from platools import PlatosContext

@platools.tool()
def lookup(query: str, ctx: PlatosContext) -> dict:
    user = ctx.context["user.id"]
    return ...
```

The `ctx` parameter is stripped from the generated MCP schema — the LLM
never sees it.

### Upgrade path for existing deployments

If your live entity backend is on `platools 0.0.0` and you see
`TypeError: got an unexpected keyword argument '_context'` in your logs:

1. `pip install --upgrade platools` (or pin to `>=0.2.0`).
2. Redeploy your entity backend.
3. In the Platos dashboard, navigate to **MCPs → \<your entity\> →
   Overview** and toggle **"Inject MCP context (`_context`) into tool
   calls"** to ON.

### Tests

All 155 tests pass (`pytest tests/`), including:

- `tests/test_context.py` — 20 tests covering ContextVar plumbing,
  dispatch popping `_context` from kwargs, concurrent-call isolation,
  context reset on handler error.
- `tests/test_serve.py` — 41 tests covering the HTTP dispatcher's
  identical pop semantics + header-merge behavior.

## 0.0.0

Initial pre-release.
