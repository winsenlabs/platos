# platools

**Your AI Arsenal.** Turn any existing Python function — Flask handler, FastAPI route, internal service method, database query — into a managed, authenticated, monitored MCP tool with a single decorator.

## Why Platools

You already have a backend. It has functions like `process_refund`, `list_orders`, `search_invoices`. Wrapping each one as an MCP tool by hand means writing JSON schemas, auth checks, role-based access, timeout handling, error envelopes, registration with the platform, and websocket reconnect logic — per function.

Platools collapses all that into one decorator. You declare the tool with type hints + docstring + auth metadata; the SDK introspects, generates the MCP schema, handles transport, validates payloads, propagates scope context, retries, and speaks the wire protocol. Your function stays a normal callable — directly invokable from your existing code, *also* dispatchable by an LLM agent.

## Install

```bash
pip install platools
# or
uv add platools
```

Requires Python `>=3.10`. Works with FastAPI, Flask, Django, plain scripts — anything that can host an asyncio event loop.

## Quick start

```python
from platools import Platools

platools = Platools()  # picks up PLATOS_URL + PLATOS_SECRET from env

@platools.tool(auth="user", roles=["support", "admin"])
def process_refund(order_id: str, reason: str) -> RefundResult:
    """Process a refund for an order.

    Args:
        order_id: The order ID to refund.
        reason:   Reason for the refund, surfaced in the audit log.
    """
    return refund_service.process(order_id, reason)


# In your app bootstrap:
import asyncio
asyncio.run(platools.connect())
```

On startup the SDK introspects every decorated function, generates an MCP-compliant JSON schema from the type hints + docstring, opens an outbound WebSocket to the Platos platform, and starts executing tool calls locally.

## Complete tool declarations

Every `tool_register` frame is the complete current declaration for the Entity,
not an incremental update. The platform removes tools omitted from a later
declaration. An empty declaration removes all tools. Reconnects always replay
the registry's current complete declaration, so use `platools.registry.remove()`
or `clear()` before reconnecting when a service intentionally shrinks its
surface.

## Reading the caller's scope inside a handler

Every `tool_call` the Platos platform dispatches carries a `__platos`
envelope — the Platos V2 `(organizationId, projectId, environmentId,
entityId, userId, userToken?, agentId, threadId, callId, timestamp,
signature)` tuple that uniquely scopes the invocation. The SDK
**pops** that envelope before your handler runs (it never appears in
your `**kwargs`) and stores the fields on Python `contextvars` so you
can read them anywhere inside the handler without threading a context
argument through every function:

```python
from platools import Platools
from platools.context import (
    current_user_id,
    current_user_token,
    current_scope,
    current_thread_id,
    current_context,
)

platools = Platools()


@platools.tool(auth="user")
def list_orders(customer_id: str) -> list[Order]:
    """List open orders for a customer.

    Args:
        customer_id: The customer whose orders to return.
    """
    # Who the LLM is acting on behalf of — use this to enforce row-level
    # authorization against your database.
    acting_user = current_user_id()

    # Optional caller access token the platform forwarded (present when
    # auth="user" and the upstream request carried a user token).
    token = current_user_token()

    # The trigger.dev scope tuple — useful if you cache per-project.
    org_id, project_id, environment_id = current_scope()

    return db.list_orders(
        customer_id=customer_id,
        acting_user_id=acting_user,
        bearer=token,
    )


@platools.tool()
async def audit_log_entry(action: str) -> None:
    """Write an audit row with the full caller context."""
    ctx = current_context()  # typed `PlatosCallContext`
    if ctx is None:
        return  # called outside a Platos dispatch (e.g. unit test)
    audit.write(
        org_id=ctx.organization_id,
        user_id=ctx.user_id,
        agent_id=ctx.agent_id,
        thread_id=ctx.thread_id,
        call_id=ctx.call_id,
        action=action,
    )
```

The accessors return `None` when called outside a tool dispatch (for
example from your module's top level, a unit test, or a `platools
serve` local run), so guard on that if your handler can also be
invoked out-of-band.

Because `contextvars` are task-local (asyncio) and thread-local (sync
handlers dispatched via `asyncio.to_thread`), concurrent tool calls in
the same worker never leak context into each other.

### Accepting `ctx` as a handler argument (CTX.5)

If you prefer explicit argument-passing over the ambient accessors,
add a parameter named `ctx` (or `platos_ctx`) to your handler. The SDK
unpacks the agent's `_context` envelope (built from the tool's
`contextMapping.envelopeKeys` — e.g. `user.id`, caller-declared
`entity_ids` for matrix routing) and passes it in as a
`PlatosContext`:

```python
from platools import Platools, PlatosContext

platools = Platools()


@platools.tool()
async def get_my_schedule(day_of_week: str, ctx: PlatosContext) -> list[Slot]:
    """Return today's schedule for the calling user.

    Args:
        day_of_week: The day whose schedule to return.
    """
    user_id = ctx.context.get("user.id")
    if not isinstance(user_id, str):
        raise RuntimeError("context missing user.id")
    # When routed across multiple entities that share this tool name,
    # ``ctx.entity_ids`` carries the caller-declared narrowing list.
    return await fetch_schedule(user_id, day_of_week, ctx.entity_ids)
```

`ctx` is opt-in — declare the parameter to receive the context,
omit it to keep the original kwargs-only signature. The parameter is
automatically stripped from the generated tool schema so the LLM never
sees it as a required argument.

The `PlatosContext` dataclass carries:

- `call_id: str` — platform-assigned id for this invocation
- `context: Mapping[str, Any]` — the unpacked `_context` envelope
- `entity_ids: tuple[str, ...] | None` — caller narrowing list
- `raw: Any` — the original envelope (escape hatch)

Both `__platos` and `_context` are popped from the kwargs before your
handler runs, so the decorated function's signature describes only the
business parameters (and optionally `ctx`).

## `platools serve` — local MCP server

`platools serve` spins up a local MCP (Model Context Protocol) server from the
tools you've already decorated. No platform connection needed — point any MCP
client (Claude Desktop, Cursor, Codeium) at the command and it picks up every
`@platools.tool()`-registered function in the imported module.

```bash
# stdio transport — for Claude Desktop / Cursor / any client that spawns
# MCP servers as subprocesses. Trust is by parent-process identity.
platools serve --module my_app.tools

# HTTP transport — for web-based clients. A bearer token is mandatory;
# set it via --auth-token or the PLATOOLS_SERVE_TOKEN env var.
platools serve --module my_app.tools --http --port 3001 --auth-token dev

# List the registered tools and exit — useful for a smoke check before
# wiring the command into a client config file.
platools serve --module my_app.tools --list

# Only expose a subset of tools (repeatable). Unknown names fail loudly
# at startup rather than silently at tools/list time.
platools serve --module my_app.tools --tool process_refund --tool cancel_order
```

`platools serve` runs `platools doctor` against the registry before the
transport starts — if doctor reports any errors the server refuses to start,
so a broken tool surface never reaches an MCP client.

Example Claude Desktop config (`~/.config/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "my-app": {
      "command": "platools",
      "args": ["serve", "--module", "my_app.tools"]
    }
  }
}
```

## Cross-language parity

A TypeScript / JavaScript equivalent ships as [`@platosdev/platools-sdk`](https://www.npmjs.com/package/@platosdev/platools-sdk) on npm. Both SDKs share the same wire protocol, the same envelope semantics, and the same `current_context()` / `currentContext()` strict-context rule, so you can mix Python and TypeScript tools under the same Platos entity without the platform caring which language produced a registration.

## Configuration

Two values, by env or constructor:

- `PLATOS_URL` (or `Platools(url=...)`) — the WebSocket URL the platform exposes for tool sync, e.g. `ws://platos:3100/tools/sync` (internal Docker network) or `wss://platos.your-domain.com/tools/sync` (external).
- `PLATOS_SECRET` (or `Platools(secret=...)`) — the connected entity's `serviceSecret`, minted in the dashboard when you registered the entity. It's encrypted at rest in Platos and shown plaintext exactly once at creation.

Both are required for `connect()`. The constructor + `@tool()` decorator work without them — useful for unit tests that only exercise schema generation.

## Licence

Apache 2.0 — see `LICENSE`. Same as Platos itself.

## Source + issues

- Repo: https://github.com/winsenlabs/platos
- Package directory: `packages/platools-py`
- Issues: https://github.com/winsenlabs/platos/issues
- Docs: https://platos.dev/docs/connected-entities
