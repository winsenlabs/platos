// A REAL HTTP SERVER PLAYING DISCORD'S REST API, THAT KEEPS ITS OWN RECORD.
//
// The pattern is `channel-slack/src/far-side.ts`'s, for its reason: a stubbed
// `fetch` can only be TOLD what to return, and cannot be in the one state that
// matters — "the request arrived, was processed, and the answer never came back".
// A `node:http` server is in that state by doing nothing.
//
// TWO RECORDS, NOT ONE, AND THE DIFFERENCE IS THE POINT. `received` is every
// request the server read to completion, appended BEFORE any behaviour is
// consulted. `created` is every message the server actually CREATED — appended
// only when it answers a create with success, or when it creates and then fails to
// answer (`silent`, `dropAfterRead`, `failAfterCreate`). A 429 is received and
// creates nothing; a silent create is received AND created. So a suite can ask
// the question that decides whether a retry duplicates a message: not "did the
// adapter send it" but "does the channel now hold it".
//
// THE RATE-LIMIT SHAPES ARE DISCORD'S OWN. A 429 carries the body
// `{ message, retry_after, global }` and the `Retry-After` / `X-RateLimit-*`
// headers `developers/topics/rate-limits.mdx` documents, and a success can carry
// `X-RateLimit-Remaining: 0` — the warning a well-behaved client stops on.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { DISCORD_EPOCH_MS } from "./vendor.js";

export interface ReceivedRequest {
  readonly method: string;
  /** The path below the API base, e.g. `channels/123/messages`, query included. */
  readonly path: string;
  readonly authorization: string | null;
  readonly userAgent: string | null;
  readonly contentType: string | null;
  readonly json: Readonly<Record<string, unknown>> | null;
}

export interface CreatedMessage {
  readonly id: string;
  /** The channel id, or `webhook:<application>` for an interaction followup. */
  readonly channel: string;
  readonly content: string;
}

export interface RateLimitHeaders {
  readonly bucket: string;
  readonly remaining: number;
  readonly resetAfter: number;
}

/** How the far side answers the NEXT request, and only the next one. */
export type FarSideBehaviour =
  | { readonly kind: "ok"; readonly limit?: RateLimitHeaders }
  /** Read the request, perform it, and never answer. */
  | { readonly kind: "silent" }
  /** Answer after `afterMs`. */
  | { readonly kind: "slow"; readonly afterMs: number }
  /** Read the request, perform it, and destroy the connection. */
  | { readonly kind: "dropAfterRead" }
  /** A Discord JSON error: `{ code, message }` with this status. Performs nothing. */
  | { readonly kind: "status"; readonly status: number; readonly code: number }
  /** Perform the write, then answer 500 — the state a 5xx on a write cannot rule out. */
  | { readonly kind: "failAfterCreate" }
  /** A 429 in Discord's documented shape. Performs nothing. */
  | {
      readonly kind: "rateLimited";
      readonly retryAfter: number;
      readonly retryAfterHeader?: number;
      readonly global?: boolean;
      readonly limit?: RateLimitHeaders;
    }
  /** A gateway's HTML page with a success-looking or failing status. */
  | { readonly kind: "notJson"; readonly status: number };

/** A snowflake minted at `instant`, per `developers/reference.mdx`. */
export function snowflakeAt(instant: Date, increment: number): string {
  return String(((BigInt(instant.getTime()) - DISCORD_EPOCH_MS) << 22n) + BigInt(increment));
}

export const FAR_SIDE_INSTANT = new Date("2026-04-01T12:00:00.000Z");

export class FarSide {
  readonly received: ReceivedRequest[] = [];
  readonly created: CreatedMessage[] = [];
  private readonly script: FarSideBehaviour[] = [];
  private readonly open = new Set<ServerResponse>();
  private server: Server | null = null;
  private port = 0;

  /** The `apiUrl` an adapter is pointed at. Trailing slash; see `vendor.ts`. */
  get apiUrl(): string {
    return `http://127.0.0.1:${this.port}/api/v10/`;
  }

  next(...behaviours: readonly FarSideBehaviour[]): void {
    this.script.push(...behaviours);
  }

  async listen(port = 0): Promise<void> {
    const server = createServer((request, response) => this.handle(request, response));
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  /** Stop listening, KEEPING the port and the records, so the address refuses. */
  async stop(): Promise<void> {
    for (const response of this.open) response.destroy();
    this.open.clear();
    const server = this.server;
    if (server === null) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = null;
  }

  /** Listen again on the SAME address — the reconnect half of a case. */
  async restart(): Promise<void> {
    await this.listen(this.port);
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let json: Record<string, unknown> | null = null;
      try {
        json = text === "" ? null : (JSON.parse(text) as Record<string, unknown>);
      } catch {
        json = null;
      }
      const path = (request.url ?? "").replace(/^\/api\/v10\//u, "");
      const received: ReceivedRequest = Object.freeze({
        method: request.method ?? "",
        path,
        authorization: request.headers.authorization ?? null,
        userAgent: request.headers["user-agent"] ?? null,
        contentType: request.headers["content-type"] ?? null,
        json,
      });
      // RECORDED BEFORE THE BEHAVIOUR IS CONSULTED. Whether the far side answers
      // has nothing to do with whether it received the request.
      this.received.push(received);
      this.respond(received, response);
    });
  }

  /** Perform a request's effect: a create mints a message, an edit changes one. */
  private perform(request: ReceivedRequest): Record<string, unknown> {
    const content = typeof request.json?.["content"] === "string" ? request.json["content"] : "";
    const edit = /\/messages\/([^/?]+)$/u.exec(request.path);
    if (request.method === "PATCH" && edit !== null) {
      return { id: edit[1] === "@original" ? snowflakeAt(FAR_SIDE_INSTANT, 0) : edit[1], content };
    }
    if (request.method === "POST") {
      const channel = /^channels\/(\d+)\/messages$/u.exec(request.path)?.[1]
        ?? `webhook:${/^webhooks\/(\d+)\//u.exec(request.path)?.[1] ?? "?"}`;
      const id = snowflakeAt(FAR_SIDE_INSTANT, this.created.length + 1);
      this.created.push(Object.freeze({ id, channel, content }));
      return { id, channel_id: channel, content };
    }
    return { id: "80351110224678912", username: "nelly", global_name: "Nelly" };
  }

  private respond(request: ReceivedRequest, response: ServerResponse): void {
    const behaviour = this.script.shift() ?? { kind: "ok" as const };
    const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(body));
    };
    const limitHeaders = (limit: RateLimitHeaders | undefined): Record<string, string> =>
      limit === undefined
        ? {}
        : {
            "x-ratelimit-bucket": limit.bucket,
            "x-ratelimit-remaining": String(limit.remaining),
            "x-ratelimit-reset-after": String(limit.resetAfter),
          };

    switch (behaviour.kind) {
      case "silent":
        this.perform(request);
        this.open.add(response);
        return;
      case "dropAfterRead":
        this.perform(request);
        response.socket?.destroy();
        return;
      case "slow": {
        this.open.add(response);
        const timer = setTimeout(() => {
          this.open.delete(response);
          json(200, this.perform(request));
        }, behaviour.afterMs);
        timer.unref();
        return;
      }
      case "status":
        json(behaviour.status, { message: "refused", code: behaviour.code });
        return;
      case "failAfterCreate":
        this.perform(request);
        json(500, { message: "500: Internal Server Error", code: 0 });
        return;
      case "rateLimited":
        json(
          429,
          { message: "You are being rate limited.", retry_after: behaviour.retryAfter, global: behaviour.global === true },
          {
            "retry-after": String(behaviour.retryAfterHeader ?? Math.ceil(behaviour.retryAfter)),
            ...(behaviour.global === true ? { "x-ratelimit-global": "true", "x-ratelimit-scope": "global" } : { "x-ratelimit-scope": "user" }),
            ...limitHeaders(behaviour.limit),
          },
        );
        return;
      case "notJson":
        response.writeHead(behaviour.status, { "content-type": "text/html" });
        response.end("<html><body>502 Bad Gateway</body></html>");
        return;
      case "ok":
        json(200, this.perform(request), limitHeaders(behaviour.limit));
        return;
    }
  }
}
