# Entity Connect

How external backends ("entities") register with Platos and stream their tools in. This page covers what an entity is, the `serviceSecret` lifecycle, the platools SDK in TypeScript and Python, debugging a broken connection, and the security posture of the outbound tool dispatch path.

## What is an entity?

An **entity** is any external backend that wants to expose tools to Platos agents. Think "FanDesk," "Billing API," "HR system" — a service the customer already runs, not something Platos hosts.

Entities are modeled as `PlatosConnectedEntity` in the Prisma schema (`internal-packages/database/prisma/schema.prisma`). Key properties:

- **Scope.** Every entity belongs to exactly one `(organizationId, projectId)` pair. The same entity slug can exist in two different projects without collision — they're separate rows.
- **Environment-split tool mappings.** An entity registers once per project, but each tool it exposes is mapped per `(entity, environment)` via `PlatosEntityToolMapping`. That's how the same "fandesk-main" entity can point its `get_bookings` tool at `https://staging.fandesk.app/...` for the `dev` environment and `https://api.fandesk.app/...` for `prod`.
- **Identity fields.** `entityId` (human-readable slug like `fandesk-main`), `displayName`, and optional `mcpUrls[]` (MCP endpoints Platos can sync tools from directly).
- **Connection status.** `connectionStatus` flips between `connected` and `disconnected`; `lastConnectedAt` is stamped on every successful WS upgrade.

**Relationship to organizations and projects.** The trigger.dev `Organization` and `Project` models are the outer scope. An org can have many projects; each project can register many entities. A user's session scope — `(organizationId, projectId, environmentId)` — flows into every scope-stamped row, and entities are joined on `(org, project)`.

## Registering an entity

### Via the dashboard

1. Open **Agents → Connected Entities** (the left-nav label; the route segment is `/agent-entities`).
2. Click **New**.
3. Enter:
   - **Org ID** — alphanumeric slug, e.g. `fandesk-main`. Must be unique within the current `(org, project)`.
   - **Display Name** — human-readable label shown in the UI.
   - **MCP URLs** (optional) — one per line; used only if the entity runs MCP endpoints Platos should reference.
   - **Custom Params** (optional JSON) — params Platos auto-injects into every tool call for this entity (e.g. `{ "department_id": "engineering" }`).
4. Submit. Platos POSTs to `/api/v1/agent/entities`, creates the `PlatosConnectedEntity` row, and returns the **one-time plaintext `serviceSecret`** + the WebSocket URL.

### `serviceSecret` lifecycle

- **Minted once at registration.** 32 random bytes, base64 or hex, generated server-side by `apps/agent/src/agent-orgs/` handlers.
- **Single-display.** The plaintext secret is returned in the POST response and shown on the "Organization Registered" screen. The row in Postgres stores only the encrypted form (AES-256-GCM under `PLATOS_ENCRYPTION_KEY`). If the operator navigates away without copying, the plaintext is gone.
- **Rotation.** The entity detail page (`/agent-entities/:entityId`) has a **Regenerate** button. POSTing `intent=regenerate` to the same route invalidates the old secret and mints a fresh one. Open WebSockets under the old secret are dropped on the next ping; the entity must reconnect with the new secret.
- **Revocation.** Deleting the entity (`intent=delete`) cascades: tools stop flowing, any open WS is terminated, and `PlatosEntityToolMapping` rows are removed. Agents that were calling those tools start receiving synthetic errors on the next invocation.
- **Where it's used.** Three places: (1) Mode 3 auth on WebSocket upgrade (`Authorization: Bearer <serviceSecret>` in the handshake), (2) HMAC signing key for `X-Platos-Signature` on outbound tool calls (`HMAC-SHA256(serviceSecret, "{timestamp}.{body}")`), (3) verifying inbound `__platos` envelopes on the primary transport.

<div class="warning">

After regeneration the old secret becomes invalid immediately. Update your backend's `PLATOS_SERVICE_SECRET` env var **before** clicking Regenerate in production, or schedule a short maintenance window.

</div>

## platools SDK walkthrough

The **platools** SDK handles the WebSocket handshake, reconnect backoff, tool-schema marshaling, and HMAC verification on inbound tool calls. TypeScript (`@platools/sdk`) and Python (`platools`) packages ship side-by-side.

Both read the platform URL and the entity's `serviceSecret` from two env vars:

- `PLATOS_URL` — base URL of your Platos deployment (e.g. `https://platos.example.com`). The SDK derives the `/tools/sync` WebSocket path internally.
- `PLATOS_SECRET` — the entity's `serviceSecret` (from the dashboard's "Organization Registered" screen or the Regenerate flow).

### TypeScript

```ts
import { z } from "zod";
import { Platools } from "@platools/sdk";

const platools = new Platools({
  url: process.env.PLATOS_URL,
  secret: process.env.PLATOS_SECRET,
});

export const listBookings = platools.tool(
  {
    name: "fandesk.list_bookings",
    description: "List bookings for a given date.",
    input: z.object({ date: z.string() }),
    output: z.object({ bookings: z.array(z.any()) }),
    auth: "user",
    roles: ["support", "admin"],
  },
  async ({ date }) => {
    const res = await fetch(`https://api.fandesk.app/bookings?date=${date}`);
    return { bookings: await res.json() };
  },
);

// Bootstrap:
await platools.connect();
```

The SDK:
- Opens `wss://<PLATOS_URL>/tools/sync` with a JWT derived from `PLATOS_SECRET`.
- Publishes the `PlatosToolDefinition` schemas for every `@platools.tool()`-decorated function on connect; re-publishes on every reconnect.
- Reconnects with exponential backoff on drop.
- For each inbound tool call, verifies the `__platos` envelope signature against `secret` before dispatching to the handler. Rejects payloads with a bad signature or a timestamp outside `PLATOS_TOOL_HMAC_MAX_SKEW_SECONDS` (default 300s).

### Python

```python
import os
import requests
from pydantic import BaseModel
from platools import Platools

platools = Platools(url=os.environ["PLATOS_URL"], secret=os.environ["PLATOS_SECRET"])


class Bookings(BaseModel):
    bookings: list[dict]


@platools.tool(auth="user", roles=["support", "admin"])
def list_bookings(date: str) -> Bookings:
    """List bookings for a given date.

    Args:
        date: ISO date (YYYY-MM-DD).
    """
    r = requests.get(f"https://api.fandesk.app/bookings?date={date}")
    r.raise_for_status()
    return Bookings(bookings=r.json())


if __name__ == "__main__":
    import asyncio

    asyncio.run(platools.connect())
```

Equivalent behavior. The Python SDK introspects type hints + docstring to generate the MCP-compliant JSON schema, matching what the TypeScript SDK does via Zod.

One process can expose dozens of tools; Platos doesn't care.

## Debugging a broken connection

| Symptom | Likely cause | Fix |
|---|---|---|
| Dashboard shows "disconnected" immediately after registration | Backend never called `connectTools()` | Start the entity backend with `serviceSecret` + `wsUrl` wired. |
| 401 on WS upgrade | Wrong or stale `serviceSecret` | Copy the secret from the dashboard again, or regenerate if lost. Paste into the entity backend's env. |
| 401 on tool calls (HMAC mismatch) | Clock skew between Platos host and entity host | Check NTP. Default skew tolerance is 300s (`PLATOS_TOOL_HMAC_MAX_SKEW_SECONDS`). |
| Tools registered but not showing up | Environment mismatch — tools are mapped per `(entity, environment)` | Make sure the scope sending the WS handshake matches the environment you're looking at in the UI. |
| Connection loops / pings missed | Backend NAT drops long-lived sockets | Ensure your egress NAT has a TCP idle timeout > 30s, or proxy the WS through a stable reverse proxy (Caddy, NGINX, CloudFront). |
| Agent sees `TOOL_DOWN` errors | `PlatosToolHealth.lastStatus = "failed"` for 3 consecutive calls | Check the entity backend logs. The handler is raising. Platos surfaces the 4xx body to the LLM verbatim. |

Useful checks:

```bash
# Is Platos seeing my WS?
docker compose logs agent | grep tool-sync-ws

# What's the live connection status?
curl -H "X-Platos-Organization-Id: <org>" \
     -H "X-Platos-Project-Id: <project>" \
     -H "X-Platos-Environment-Id: <env>" \
     https://platos.example.com/api/v1/agent/entities/<entityId>
```

The `connectionStatus` field in the JSON response is the source of truth.

## Security posture

Platos dispatches tool calls *outbound* to entity-supplied `callbackUrl`s. That's an SSRF-adjacent surface and deserves its own threat model.

### What Platos ships today

- **TLS-only in production.** The agent rejects `callbackUrl`s without `https://` when `NODE_ENV=production`. Plaintext `http://` is allowed only in dev + compose.
- **Timestamp + skew check.** `X-Platos-Timestamp` must be within `PLATOS_TOOL_HMAC_MAX_SKEW_SECONDS`. The server clock-checks before HMAC verification.
- **HMAC-SHA256 per-entity.** Every request signed with `serviceSecret`, rotatable. A compromised entity key doesn't compromise any other entity's calls.
- **No credential passthrough.** Platos does NOT forward user cookies, bearer tokens, or any cross-site credentials to entity backends. The only principal-bearing header is `X-Platos-User-Token`, an opaque string the entity chose to have forwarded (set by the session token claim).
- **Egress URL is entity-controlled.** The entity registers the `callbackUrl` when it calls `connectTools()`. Platos stores it verbatim on `PlatosEntityToolMapping.callbackUrl`. Operators who want to restrict what URLs an entity can register should add ingress controls on registration — that's out of scope for the default config.
- **Retry with bounded fanout.** 3 retries with exponential backoff. A misbehaving entity can't amplify a single call into unbounded fanout.

### SSRF considerations

Because the entity chooses its own `callbackUrl`, a malicious or compromised entity could point it at:

- A metadata service (`http://169.254.169.254/…` on AWS/GCP).
- A private-network-only service you never intended to expose.
- A service that returns reflection attacks in the response body (which gets handed to the LLM).

**Recommended mitigations for multi-tenant deployments:**

1. **Run the agent container in a network namespace** that blocks RFC1918 ranges + link-local addresses (`169.254.0.0/16`) via iptables or egress firewall rules. Compose isolates services on `platos_default`, but doesn't block external egress by default.
2. **Enforce an allowlist** of permitted `callbackUrl` hostnames at entity-registration time. Add a Zod `.refine()` on the `mcpUrls` + `callbackUrl` input in `apps/agent/src/agent-orgs/` handlers. Reject private IP ranges.
3. **Treat tool response bodies as untrusted input.** The LLM sees whatever the entity returns. Tool responses should be schema-validated before re-entering the prompt; this is already the case for `output`-typed returns, but freeform text passes through.

### Per-tool approval gates

For write-destructive tools, set `requiresApproval: true` on the agent's `perToolPerms` map. Every invocation fires `request_approval` first; the user must click Approve in the UI before the HTTP POST goes out. See [tool-gateway.md](./tool-gateway.md#per-agent-tool-permissions).

## Further reading

- [tool-gateway.md](./tool-gateway.md) — full tool-matrix data model + three execution modes.
- [env-vars.md](./env-vars.md) — every env var Platos reads, including `PLATOS_TOOL_HMAC_MAX_SKEW_SECONDS` and `PLATOS_CORS_ORIGIN`.
- [production-hardening.md](./production-hardening.md) — secrets rotation, TLS, and backups before going live.
