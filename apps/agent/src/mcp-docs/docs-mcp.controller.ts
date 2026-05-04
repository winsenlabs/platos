/**
 * Phase 3 — Docs MCP controller.
 *
 * Exposes a minimal MCP JSON-RPC surface at `/mcp/docs` (POST) +
 * `/mcp/docs/sse` (legacy MCP SSE transport, ping-only loop).
 *
 * Methods supported:
 *   - initialize          — handshake. Reports server name + capabilities.
 *   - notifications/ping  — keepalive ack.
 *   - tools/list          — single tool: `search_docs`.
 *   - tools/call          — dispatch `search_docs(query, kind?, limit?)`.
 *   - resources/list      — every doc + guide as a `docs://` / `guides://` URI.
 *   - resources/read      — return rendered HTML for a URI.
 *
 * Auth: NONE. Per-IP rate limit (60 req/min) is enforced inside this
 * controller. ScopeGuard bypass added in `auth/scope.guard.ts` for
 * `/mcp/docs*`.
 */

import { Body, Controller, Get, Headers, HttpException, HttpStatus, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { DocsMcpService } from "./docs-mcp.service";

interface JsonRpcReq {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcRes {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const RPC = {
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  RATE_LIMITED: -32099,
} as const;

const SEARCH_DOCS_TOOL = {
  name: "search_docs",
  description:
    "Search the Platos documentation. Use this when answering a user's product question. Match against question keywords first; falls back to full-text. Returns up to 10 ranked results.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What to search for. Plain English question or keywords both work.",
      },
      kind: {
        type: "string",
        enum: ["docs", "guides", "all"],
        description: "Restrict to docs (reference), guides (how-tos), or all (default).",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 25,
        description: "Max results to return (default 10, max 25).",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

/**
 * Two paths, one controller. `mcp/docs` is the canonical internal path
 * (every controller test, every internal caller, the host-aware middleware's
 * allow list — they all key off `/mcp/docs`). `mcp` is the user-facing
 * install URL we publish — `claude mcp add platos https://mcp.platos.dev/mcp`
 * — so the bare path needs to serve the same content without forcing users
 * to remember a `/docs` suffix.
 *
 * NestJS @Controller accepts an array of base paths and binds every method
 * decorator (@Post, @Get, @Get('sse'), @Post('messages')) to BOTH prefixes.
 * Net effect: `/mcp`, `/mcp/sse`, `/mcp/messages` work identically to
 * `/mcp/docs`, `/mcp/docs/sse`, `/mcp/docs/messages` — same handler, same
 * rate limit bucket, same scope guard bypass.
 *
 * On `play.platos.dev` / `test.platos.dev` both prefixes are reachable;
 * the host-aware middleware (`HostRouterMiddleware`) blocks every other
 * path on `mcp.platos.dev` so the public surface stays read-only docs.
 */
@Controller(["mcp/docs", "mcp"])
export class DocsMcpController {
  constructor(private readonly docsService: DocsMcpService) {}

  /**
   * `POST /mcp/docs` — JSON-RPC streamable HTTP transport.
   * Caller hits this with `{ jsonrpc, id, method, params }`. We respond
   * inline on the POST body.
   */
  @Post()
  async jsonRpc(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: JsonRpcReq,
  ): Promise<void> {
    const ip = clientIp(req);
    const rl = await this.docsService.checkRateLimit(ip);
    if (!rl.ok) {
      this.applyCors(res);
      res.setHeader("Retry-After", String(Math.max(1, rl.retryAfter)));
      res.status(429).json(
        rpcError(body?.id ?? null, RPC.RATE_LIMITED, "Too many requests. Try again shortly.", {
          retryAfterSeconds: Math.max(1, rl.retryAfter),
        }),
      );
      return;
    }

    if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      this.applyCors(res);
      res.status(400).json(rpcError(body?.id ?? null, RPC.INVALID_REQUEST, "JSON-RPC 2.0 request expected"));
      return;
    }

    this.applyCors(res);
    res.status(200).json(await this.dispatch(body));
  }

  /**
   * `OPTIONS /mcp/docs` — CORS preflight. Browsers running `fetch` from a
   * different origin send this before the actual JSON-RPC POST.
   */
  @Get()
  async getInfo(@Req() req: Request, @Res() res: Response): Promise<void> {
    // Convenience: GET returns a one-shot capabilities probe so curl users
    // can sanity-check the endpoint without crafting a JSON-RPC envelope.
    this.applyCors(res);
    res.status(200).json({
      service: "platos-docs-mcp",
      version: "0.1.0",
      transport: ["http+jsonrpc", "sse"],
      auth: "none",
      rateLimit: { requestsPerMinute: 60, scope: "ip" },
      methods: ["initialize", "notifications/ping", "tools/list", "tools/call", "resources/list", "resources/read"],
      tools: [SEARCH_DOCS_TOOL.name],
    });
  }

  /**
   * `GET /mcp/docs/sse` — legacy MCP SSE transport.
   * Keeps a long-lived connection open; client posts to `/mcp/docs/messages`
   * with `?sessionId=…`. Minimal session map — no persistence; on agent
   * restart the client reconnects.
   */
  @Get("sse")
  async sse(@Req() req: Request, @Res() res: Response, @Headers() _headers: Record<string, string>): Promise<void> {
    const ip = clientIp(req);
    const rl = await this.docsService.checkRateLimit(ip);
    if (!rl.ok) {
      this.applyCors(res);
      res.status(429).setHeader("Retry-After", String(Math.max(1, rl.retryAfter))).end();
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.flushHeaders();

    const sessionId = randomHex(16);
    const endpoint = `/mcp/docs/messages?sessionId=${sessionId}`;
    res.write(`event: endpoint\ndata: ${endpoint}\n\n`);
    sessions.set(sessionId, { res, lastSeen: Date.now() });

    const ping = setInterval(() => {
      try {
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/ping" })}\n\n`);
      } catch {
        /* socket closed */
      }
    }, 30_000);

    const cleanup = (): void => {
      clearInterval(ping);
      sessions.delete(sessionId);
      try {
        res.end();
      } catch {
        /* already closed */
      }
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  }

  /**
   * `POST /mcp/docs/messages?sessionId=…` — SSE control. Caller POSTs the
   * JSON-RPC request; we 202-ack immediately + push the response back on
   * the SSE stream owned by `sessionId`.
   */
  @Post("messages")
  async messages(@Req() req: Request, @Res() res: Response, @Body() body: JsonRpcReq): Promise<void> {
    const ip = clientIp(req);
    const rl = await this.docsService.checkRateLimit(ip);
    if (!rl.ok) {
      this.applyCors(res);
      res.status(429).setHeader("Retry-After", String(Math.max(1, rl.retryAfter))).end();
      return;
    }

    const sessionId = String(req.query?.sessionId ?? "");
    if (!sessionId) {
      this.applyCors(res);
      res.status(400).send("missing sessionId query param");
      return;
    }
    const session = sessions.get(sessionId);
    if (!session) {
      this.applyCors(res);
      res.status(404).send("unknown or expired sessionId");
      return;
    }
    if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      this.applyCors(res);
      res.status(400).send("body must be a JSON-RPC 2.0 request with `method`");
      return;
    }
    res.status(202).send();

    try {
      const response = await this.dispatch(body);
      session.res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
    } catch (err) {
      session.res.write(
        `event: message\ndata: ${JSON.stringify(
          rpcError(body.id ?? null, RPC.INTERNAL_ERROR, err instanceof Error ? err.message : "internal error"),
        )}\n\n`,
      );
    }
  }

  private applyCors(res: Response): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
    res.setHeader("Access-Control-Max-Age", "86400");
  }

  /** Dispatch a single JSON-RPC method. */
  private async dispatch(req: JsonRpcReq): Promise<JsonRpcRes> {
    const id = req.id ?? null;
    try {
      switch (req.method) {
        case "initialize":
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {
                tools: {},
                resources: { listChanged: false },
                logging: {},
              },
              serverInfo: { name: "platos-docs-mcp", version: "0.1.0" },
            },
          };
        case "notifications/ping":
        case "ping":
          return { jsonrpc: "2.0", id, result: {} };
        case "tools/list":
          return { jsonrpc: "2.0", id, result: { tools: [SEARCH_DOCS_TOOL] } };
        case "tools/call": {
          const params = req.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
          if (params?.name !== "search_docs") {
            return rpcError(id, RPC.METHOD_NOT_FOUND, `tool '${params?.name ?? "(unknown)"}' not found`);
          }
          const args = (params?.arguments ?? {}) as { query?: unknown; kind?: unknown; limit?: unknown };
          if (typeof args.query !== "string" || !args.query.trim()) {
            return rpcError(id, RPC.INVALID_PARAMS, "search_docs.query must be a non-empty string");
          }
          let kind: "docs" | "guides" | "all" = "all";
          if (args.kind === "docs" || args.kind === "guides" || args.kind === "all") kind = args.kind;
          let limit: number | undefined;
          if (typeof args.limit === "number" && Number.isFinite(args.limit)) limit = args.limit;
          const results = await this.docsService.searchDocs({ query: args.query, kind, limit });
          // MCP `tools/call` shape: `content[]` of `{type:"text", text:…}`
          // PLUS `structuredContent` for clients that want JSON. The text
          // form is human-readable for LLM context windows.
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text:
                    results.length === 0
                      ? `No matches for "${args.query}".`
                      : results
                          .map(
                            (r, i) =>
                              `${i + 1}. ${r.title} (${r.kind}/${r.slug}, score=${r.score})\n${r.matchedQuestion ? `   Q: ${r.matchedQuestion}\n` : ""}${r.snippet ? `   ${r.snippet}` : ""}`,
                          )
                          .join("\n\n"),
                },
              ],
              structuredContent: { results },
            },
          };
        }
        case "resources/list": {
          const resources = await this.docsService.listResources();
          return { jsonrpc: "2.0", id, result: { resources } };
        }
        case "resources/read": {
          const params = req.params as { uri?: string } | undefined;
          if (!params?.uri || typeof params.uri !== "string") {
            return rpcError(id, RPC.INVALID_PARAMS, "resources/read.uri is required");
          }
          const content = await this.docsService.readResource(params.uri);
          if (!content) return rpcError(id, RPC.METHOD_NOT_FOUND, `resource '${params.uri}' not found`);
          return { jsonrpc: "2.0", id, result: { contents: [content] } };
        }
        default:
          return rpcError(id, RPC.METHOD_NOT_FOUND, `method '${req.method}' not found`);
      }
    } catch (err) {
      return rpcError(id, RPC.INTERNAL_ERROR, err instanceof Error ? err.message : "internal error");
    }
  }
}

// ─── module-private state for the SSE transport ─────────────────────

interface SseSession {
  res: Response;
  lastSeen: number;
}
const sessions = new Map<string, SseSession>();

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcRes {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) return fwd.split(",")[0]!.trim();
  if (Array.isArray(fwd) && fwd[0]) return String(fwd[0]).split(",")[0]!.trim();
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.trim()) return real.trim();
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

function randomHex(bytes: number): string {
  // node:crypto would pull in another import; the SSE session id only
  // needs collision resistance not unguessability (the endpoint is public).
  let out = "";
  for (let i = 0; i < bytes * 2; i += 1) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

/** Exported for the test surface — unit tests poke `dispatch` directly. */
export const __TEST_INTERNALS = { rpcError, parseResourceUri: undefined };
