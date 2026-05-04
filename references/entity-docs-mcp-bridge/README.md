# entity-docs-mcp-bridge

Reference Platos entity backend that **bridges any external MCP server into Platos** as a connected entity. The agent runtime cannot yet consume external MCPs directly (roadmap item: "Consume external MCP servers"). Until it can, run this bridge alongside your Platos instance and the upstream MCP's tools appear inside Platos as entity tools.

The default upstream is the **public Platos docs MCP** at `https://mcp.platos.dev/mcp`, so out of the box this brings the `search_docs` tool into your Platos. Point `MCP_UPSTREAM_URL` at any other MCP server to bridge that one instead.

## What it does

On startup the bridge:

1. Calls `tools/list` against the upstream MCP via JSON-RPC POST.
2. Registers each tool through `@platools/sdk`, with the upstream's input schema attached as the platools tool description.
3. Connects to the Platos agent over WebSocket using your entity's service secret.
4. On every tool invocation from a Platos agent, forwards the call to the upstream MCP via `tools/call` and unwraps the standard MCP response (preferring `structuredContent` when available).
5. Re-fetches the upstream catalog every 10 minutes so new tools added upstream become available without restarting.

## Setup

1. **Register the entity in Platos.** In the dashboard, go to `Connections > New entity`. Pick an entity ID (e.g. `platos-docs-mcp` for the default upstream) and a display name. Paste `https://mcp.platos.dev/mcp` (or your upstream URL) into the optional MCP URLs field — that field is informational metadata; the actual bridging is done by this service. Save and copy the **service secret** that appears once.

2. **Copy the env template.**

   ```sh
   cp .env.example .env
   ```

   Fill in:
   - `PLATOS_URL` — `wss://test.platos.dev/tools/sync` for staging, or `ws://localhost:3100/tools/sync` for a local Platos stack.
   - `PLATOS_SECRET` — the service secret you just copied.
   - `MCP_UPSTREAM_URL` — leave at `https://mcp.platos.dev/mcp` for the docs MCP, or change to any other MCP server.
   - `MCP_UPSTREAM_AUTH_HEADER` — empty for public MCPs; for protected ones, supply a `Bearer xxx` token.

3. **Run.**

   ```sh
   npm install
   npm run dev
   ```

   Or via Docker:

   ```sh
   docker compose up --build
   ```

4. **Verify.** In the Platos dashboard, the entity flips from `disconnected` to `connected` and the tool count goes from 0 to N (1 for the docs MCP — `search_docs`). Open any agent in scope, the new tool shows up in `find_tools` and is callable from chat.

## Architecture

```
Platos agent ──(tool-call via WS)──▶ this bridge ──(JSON-RPC POST)──▶ upstream MCP
            ◀──(result via WS)─────             ◀──(JSON-RPC result)──
```

The bridge holds no state — every call is forwarded to the upstream. Authentication on the upstream side is done via the `MCP_UPSTREAM_AUTH_HEADER`. Authentication on the Platos side is done via the entity service secret + HMAC-signed WebSocket frames (handled by `@platools/sdk`).

The platools SDK runs the WebSocket transport with HMAC signing, exponential reconnect backoff, and tool re-registration on reconnect, so this file stays small and only owns the upstream-MCP plumbing.

## Bridging a different MCP

Change two env vars:

```sh
MCP_UPSTREAM_URL=https://example.com/mcp
MCP_UPSTREAM_AUTH_HEADER="Bearer eyJhbGciOi..."
```

Restart. The bridge re-discovers the upstream tools and registers them under your entity. For OAuth 2.1 with DCR, complete the handshake out-of-band first and paste the resulting access token here. Native OAuth flow is on the roadmap.

## When you can stop using this

When `Consume external MCP servers` ships on the Platos roadmap (target Q3 2026), the agent runtime will read the `mcpUrls` field on a connected entity directly, removing the need for this bridge process. To migrate, paste the upstream URL into the entity's MCP URLs field on the dashboard, restart your Platos agent, then stop this bridge. Your tools stay registered under the same entity, just sourced natively.

## Tradeoffs

- **One extra hop.** Every tool-call traverses the bridge before hitting the upstream MCP, adding ~10-30ms.
- **No upstream OAuth flow.** Protected MCPs need a manually-pasted access token.
- **Stale catalog.** New tools upstream appear within `MCP_TOOLS_REFRESH_MS` (default 10 min). Lower it if you need faster surface; the upstream rate limit is the floor.
- **Removed tools stay registered.** Until the platools SDK exposes a deregister hook, a tool removed upstream stays advertised here and fails on call. Restart the bridge to re-sync.

## Files

```
.
├── README.md            (this)
├── package.json
├── tsconfig.json
├── Dockerfile           production-style multi-stage build
├── docker-compose.yml   one-command run against staging
├── .env.example         env template
└── src/
    └── server.ts        bridge implementation
```
