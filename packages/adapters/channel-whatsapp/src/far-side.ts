// A REAL HTTP SERVER PLAYING META'S GRAPH API, THAT KEEPS ITS OWN RECORD.
//
// The pattern is `channel-slack/src/far-side.ts`'s and `channel-discord`'s, for
// their reason: a stubbed `fetch` can only be TOLD what to return, and cannot be
// in the one state that matters — "the request arrived, was processed, and the
// answer never came back". A `node:http` server is in that state by doing nothing.
//
// TWO RECORDS, NOT ONE, AND THE DIFFERENCE IS THE POINT. `received` is every
// request the server read to completion, appended BEFORE any behaviour is
// consulted. `sent` is every message the server actually DELIVERED — appended
// only when it answers a send with success, or when it delivers and then fails to
// answer (`silent`, `dropAfterRead`, `failAfterSend`). A rate-limit refusal is
// received and delivers nothing. So a suite can ask the question that decides
// whether a retry duplicates a message: not "did the adapter send it" but "does
// the customer's phone now hold it" — which, on a provider with no edit and no
// delete, is the only question that matters.
//
// THE ERROR SHAPES ARE META'S OWN. Graph refuses with
// `{ error: { message, type, code, error_subcode, fbtrace_id } }`, and it can
// carry that body under a **200** as well as under a 4xx, which is the case
// `okWithError` exists for.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface ReceivedRequest {
  readonly method: string;
  /** The path below the Graph base, e.g. `106540352242922/messages`, query included. */
  readonly path: string;
  readonly authorization: string | null;
  readonly contentType: string | null;
  readonly json: Readonly<Record<string, unknown>> | null;
}

export interface SentMessage {
  readonly id: string;
  /** The business phone number id the send was made on. */
  readonly phoneNumberId: string;
  readonly to: string;
  readonly text: string;
}

/** How the far side answers the NEXT request, and only the next one. */
export type FarSideBehaviour =
  | { readonly kind: "ok" }
  /** Read the request, perform it, and never answer. */
  | { readonly kind: "silent" }
  /** Answer after `afterMs`. */
  | { readonly kind: "slow"; readonly afterMs: number }
  /** Read the request, perform it, and destroy the connection. */
  | { readonly kind: "dropAfterRead" }
  /** A Graph JSON error with this status and `error.code`. Performs nothing. */
  | { readonly kind: "status"; readonly status: number; readonly code: number }
  /** A Graph JSON error carried under HTTP 200. Performs nothing. */
  | { readonly kind: "okWithError"; readonly code: number }
  /** Perform the send, then answer 500 — the state a 5xx on a write cannot rule out. */
  | { readonly kind: "failAfterSend" }
  /** A throughput refusal: a status, a Meta code, and optionally a Retry-After. */
  | {
      readonly kind: "rateLimited";
      readonly status?: number;
      readonly code: number;
      readonly retryAfterHeader?: number;
    }
  /** A gateway's HTML page with a success-looking or failing status. */
  | { readonly kind: "notJson"; readonly status: number };

export const FAR_SIDE_INSTANT = new Date("2026-05-01T09:00:00.000Z");

export class FarSide {
  readonly received: ReceivedRequest[] = [];
  readonly sent: SentMessage[] = [];
  private readonly script: FarSideBehaviour[] = [];
  private readonly open = new Set<ServerResponse>();
  private server: Server | null = null;
  private port = 0;

  /** The `graphUrl` an adapter is pointed at. Trailing slash; see `vendor.ts`. */
  get graphUrl(): string {
    return `http://127.0.0.1:${this.port}/v21.0/`;
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
      const path = (request.url ?? "").replace(/^\/v21\.0\//u, "");
      const received: ReceivedRequest = Object.freeze({
        method: request.method ?? "",
        path,
        authorization: request.headers.authorization ?? null,
        contentType: request.headers["content-type"] ?? null,
        json,
      });
      // RECORDED BEFORE THE BEHAVIOUR IS CONSULTED. Whether the far side answers
      // has nothing to do with whether it received the request.
      this.received.push(received);
      this.respond(received, response);
    });
  }

  /** Perform a request's effect: a send delivers a message, a probe names a node. */
  private perform(request: ReceivedRequest): Record<string, unknown> {
    const send = /^(\d+)\/messages$/u.exec(request.path);
    if (request.method === "POST" && send !== null) {
      const to = typeof request.json?.["to"] === "string" ? request.json["to"] : "";
      const body = request.json?.["text"];
      const text =
        typeof body === "object" && body !== null && typeof (body as { body?: unknown }).body === "string"
          ? (body as { body: string }).body
          : "";
      const id = `wamid.FARSIDE${this.sent.length + 1}`;
      this.sent.push(Object.freeze({ id, phoneNumberId: send[1]!, to, text }));
      return {
        messaging_product: "whatsapp",
        contacts: [{ input: to, wa_id: to }],
        messages: [{ id }],
      };
    }
    return { id: "106540352242922", name: "Platos System User" };
  }

  private respond(request: ReceivedRequest, response: ServerResponse): void {
    const behaviour = this.script.shift() ?? { kind: "ok" as const };
    const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(body));
    };
    const graphError = (code: number) => ({
      error: {
        message: "refused",
        type: "OAuthException",
        code,
        error_subcode: 0,
        fbtrace_id: "AbCdEfGhIjK",
      },
    });

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
        json(behaviour.status, graphError(behaviour.code));
        return;
      case "okWithError":
        json(200, graphError(behaviour.code));
        return;
      case "failAfterSend":
        this.perform(request);
        json(500, graphError(1));
        return;
      case "rateLimited":
        json(
          behaviour.status ?? 400,
          graphError(behaviour.code),
          behaviour.retryAfterHeader === undefined
            ? {}
            : { "retry-after": String(behaviour.retryAfterHeader) },
        );
        return;
      case "notJson":
        response.writeHead(behaviour.status, { "content-type": "text/html" });
        response.end("<html><body>502 Bad Gateway</body></html>");
        return;
      case "ok":
        json(200, this.perform(request));
        return;
    }
  }
}
