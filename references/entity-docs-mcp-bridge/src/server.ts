/**
 * Reference: external-MCP bridge entity backend.
 *
 * Until Platos's agent runtime can consume external MCP servers
 * directly (roadmap item: "Consume external MCP servers"), this
 * bridge stands in. It connects to an upstream MCP server as a
 * standard JSON-RPC HTTP client, mirrors every tool that server
 * exposes, and registers them with Platos through the platools SDK.
 *
 * Default upstream: `https://mcp.platos.dev/mcp` — the public,
 * unauthenticated Platos docs MCP. Result: a `search_docs` tool
 * appears under whatever entity you registered (default name in the
 * Platos dashboard: `platos-docs-mcp`), agents in scope can call it,
 * answers come back as ranked results across the 47 docs + 28
 * guides corpus.
 *
 * Mirror this pattern for any other MCP — point `MCP_UPSTREAM_URL`
 * at it, supply auth via `MCP_UPSTREAM_AUTH_HEADER` if needed, and
 * the same code mirrors whatever tools that server exposes.
 *
 * Required env:
 *   PLATOS_URL    — WebSocket endpoint of the Platos agent, e.g.
 *                   `wss://test.platos.dev/tools/sync` for staging
 *                   or `ws://localhost:3100/tools/sync` for local dev.
 *   PLATOS_SECRET — service secret for the connected entity (shown
 *                   ONCE on the `/agent-entities/new` screen).
 *
 * Optional env:
 *   MCP_UPSTREAM_URL          — defaults to `https://mcp.platos.dev/mcp`.
 *   MCP_UPSTREAM_AUTH_HEADER  — full `Authorization: Bearer …` header
 *                               for upstream MCPs that require it.
 *                               Leave unset for the public docs MCP.
 *   MCP_TOOLS_REFRESH_MS      — how often to re-fetch the upstream
 *                               tool catalog. Default 600_000 (10 min).
 */

import {
  Platools,
  PlatoolsClient,
  currentUserId,
  currentScope,
} from "@platosdev/platools-sdk";
import WebSocket from "ws";
import { z } from "zod";

const PLATOS_URL = process.env.PLATOS_URL;
const PLATOS_SECRET = process.env.PLATOS_SECRET;
// Pin the WS connection to a specific Platos environment. Without this
// hint the agent's WS handler falls back to DEVELOPMENT, which leaves the
// entity showing "disconnected" when an operator views it under any other
// env. Default `production` because that's where the docs MCP is meant to
// live for end users.
const PLATOS_ENV = process.env.PLATOS_ENV ?? "production";
const MCP_UPSTREAM_URL =
  process.env.MCP_UPSTREAM_URL ?? "https://mcp.platos.dev/mcp";
const MCP_UPSTREAM_AUTH_HEADER = process.env.MCP_UPSTREAM_AUTH_HEADER ?? "";
const MCP_TOOLS_REFRESH_MS = Number(
  process.env.MCP_TOOLS_REFRESH_MS ?? 600_000,
);

interface UpstreamTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface JsonRpcSuccess<T> {
  jsonrpc: "2.0";
  id: number | string;
  result: T;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: number | string;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcError;

let nextId = 1;

/**
 * Standard MCP JSON-RPC POST. Streamable-HTTP transport.
 * Throws on transport error; returns the parsed response otherwise.
 */
async function mcpCall<T>(method: string, params?: unknown): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (MCP_UPSTREAM_AUTH_HEADER) {
    // Allow either `Bearer xxx` (just the value) or a full header
    // `Authorization: Bearer xxx`.
    if (MCP_UPSTREAM_AUTH_HEADER.toLowerCase().startsWith("authorization:")) {
      const colon = MCP_UPSTREAM_AUTH_HEADER.indexOf(":");
      headers["Authorization"] = MCP_UPSTREAM_AUTH_HEADER.slice(colon + 1).trim();
    } else {
      headers["Authorization"] = MCP_UPSTREAM_AUTH_HEADER;
    }
  }
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: nextId++,
    method,
    ...(params === undefined ? {} : { params }),
  });
  const res = await fetch(MCP_UPSTREAM_URL, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[mcp-bridge] upstream HTTP ${res.status}: ${text.slice(0, 300)}`,
    );
  }
  const json = (await res.json()) as JsonRpcResponse<T>;
  if ("error" in json) {
    throw new Error(
      `[mcp-bridge] upstream JSON-RPC error ${json.error.code}: ${json.error.message}`,
    );
  }
  return json.result;
}

/** Fetch the upstream MCP server's tool catalog. */
async function listUpstreamTools(): Promise<UpstreamTool[]> {
  const result = await mcpCall<{ tools: UpstreamTool[] }>("tools/list");
  return result.tools ?? [];
}

/**
 * Convert an upstream MCP `inputSchema` (raw JSON Schema) into a Zod
 * schema. The platools SDK accepts a Zod schema for input. We keep the
 * conversion minimal: we only need the SDK to forward the args
 * unchanged. The runtime validation cost shifts to the upstream MCP.
 *
 * Strategy: build a `z.record(z.unknown())` and rely on JSON.stringify
 * preserving structure. The agent-side caller still gets the original
 * JSON Schema as the tool's `parameters` advertisement (the platools
 * SDK extracts that from the Zod schema's `.describe()` block).
 */
function passthroughZod(schema: Record<string, unknown>): z.ZodTypeAny {
  // We attach the raw upstream schema as a description so the agent
  // sees the real shape. The platools SDK forwards .describe() into
  // the tool advertisement.
  return z
    .record(z.unknown())
    .describe(JSON.stringify(schema));
}

const platools = new Platools({
  url: PLATOS_URL,
  secret: PLATOS_SECRET,
});

const registered = new Set<string>();

/**
 * Register one upstream tool with the platools SDK. The handler
 * forwards to the upstream MCP via `tools/call` and unwraps the
 * standard MCP response shape.
 */
function registerUpstreamTool(tool: UpstreamTool): void {
  if (registered.has(tool.name)) return;
  registered.add(tool.name);

  platools.tool(
    {
      name: tool.name,
      description:
        tool.description ??
        `Tool mirrored from ${MCP_UPSTREAM_URL}. See upstream MCP for details.`,
      input: passthroughZod(tool.inputSchema),
      // The output shape is whatever the upstream returns; the platools
      // SDK does not enforce a Zod output, so we let `z.unknown()` pass
      // anything through.
      output: z.unknown(),
      auth: "none",
    },
    async (args) => {
      const userId = currentUserId() ?? "<unknown>";
      const { organizationId, projectId, environmentId } = currentScope();
      console.log(
        `[mcp-bridge] tools/call name=${tool.name} user=${userId} scope=${organizationId}/${projectId}/${environmentId}`,
      );
      const result = await mcpCall<{
        content?: Array<{ type: string; text?: string }>;
        structuredContent?: unknown;
        isError?: boolean;
      }>("tools/call", { name: tool.name, arguments: args });
      // Prefer structuredContent when the upstream provides it (the
      // Platos docs MCP does for search_docs); fall back to the
      // human-readable text content. Either way we hand the agent
      // back something it can reason about without re-parsing MCP
      // wire shapes.
      if (result.structuredContent !== undefined) {
        return result.structuredContent;
      }
      if (Array.isArray(result.content)) {
        return result.content
          .map((c) => (c.type === "text" ? c.text ?? "" : ""))
          .join("\n");
      }
      return result;
    },
  );
}

/**
 * Periodically re-fetch the upstream catalog. New tools get registered;
 * removed tools stay registered (the platools SDK does not currently
 * expose a deregister hook — a stale tool will fail at call time with
 * an upstream error, which is acceptable for a bridge).
 */
async function syncUpstreamTools(): Promise<void> {
  try {
    const tools = await listUpstreamTools();
    let added = 0;
    for (const tool of tools) {
      if (!registered.has(tool.name)) {
        registerUpstreamTool(tool);
        added++;
      }
    }
    console.log(
      `[mcp-bridge] tools/list: ${tools.length} upstream, ${added} newly registered, ${registered.size} total`,
    );
  } catch (err) {
    console.error(`[mcp-bridge] tools/list failed:`, err);
  }
}

async function main(): Promise<void> {
  // Empty PLATOS_SECRET is the documented "off" signal when this bridge
  // ships as a sidecar in docker-compose. Exit 0 (not 1) so compose
  // does not flag it as a failed service and does not spin into a
  // restart loop. Operators who want the bridge running fill in the
  // secret in .env.
  if (!PLATOS_SECRET) {
    console.log(
      "[mcp-bridge] PLATOS_SECRET is empty — sidecar is disabled. Set the entity service secret in PLATOS_DOCS_MCP_BRIDGE_SECRET to enable.",
    );
    process.exit(0);
  }
  if (!PLATOS_URL) {
    console.error(
      "[mcp-bridge] PLATOS_URL is empty — copy .env.example, set the WebSocket URL, then restart.",
    );
    process.exit(1);
  }
  console.log(
    `[mcp-bridge] upstream MCP: ${MCP_UPSTREAM_URL}` +
      (MCP_UPSTREAM_AUTH_HEADER ? " (with auth header)" : " (no auth)"),
  );
  // Pull the catalog before opening the WS so the first connect handshake
  // already advertises every tool — agents see the right surface from
  // turn one rather than missing tools that show up a beat later.
  await syncUpstreamTools();

  // Keep the catalog fresh in the background. New tools added to the
  // upstream MCP after this process started become available without a
  // restart.
  setInterval(() => {
    void syncUpstreamTools();
  }, MCP_TOOLS_REFRESH_MS);

  console.log(
    `[mcp-bridge] connecting to Platos at ${PLATOS_URL} (env=${PLATOS_ENV}) …`,
  );
  // Run the underlying client directly so we can inject a wsFactory that
  // appends `?env=${PLATOS_ENV}` to the URL the SDK already built. The
  // SDK doesn't expose env as a config option; rewriting at dial time
  // keeps the change local to this bridge.
  const client = new PlatoolsClient({
    url: PLATOS_URL,
    secret: PLATOS_SECRET,
    registry: platools.registry,
    wsFactory: (url, headers) => {
      const sep = url.includes("?") ? "&" : "?";
      const finalUrl = `${url}${sep}env=${encodeURIComponent(PLATOS_ENV)}`;
      return new WebSocket(finalUrl, { headers });
    },
  });
  // `runForever()` reconnects with exponential backoff on network drops
  // and re-syncs all registered tools on each attempt.
  await client.runForever();
}

main().catch((err) => {
  console.error("[mcp-bridge] fatal:", err);
  process.exit(1);
});
