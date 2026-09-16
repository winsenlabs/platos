// A REAL HTTP SERVER PLAYING TELEGRAM'S BOT API, THAT KEEPS ITS OWN RECORD.
//
// The pattern is `channel-slack/src/far-side.ts`'s, `channel-discord`'s and
// `channel-whatsapp`'s, for their reason: a stubbed `fetch` can only be TOLD what
// to return, and cannot be in the one state that matters — "the request arrived,
// was processed, and the answer never came back". A `node:http` server is in that
// state by doing nothing.
//
// AND HERE IT CARRIES MORE WEIGHT THAN IN THE OTHER THREE. Telegram's inbound
// half cannot be joined to anything outside this repository (see `adapter.ts`),
// so the OUTBOUND contract is where most of this directory's evidence lives: what
// method was called, under what path, with what body, and what this adapter makes
// of every documented refusal. All of that is read back from a server that was
// never told what to expect.
//
// TWO RECORDS, NOT ONE, AND THE DIFFERENCE IS THE POINT. `received` is every
// request the server read to completion, appended BEFORE any behaviour is
// consulted. `sent` is every message the chat actually now holds — appended only
// when it answers a send with success, or when it delivers and then fails to
// answer (`silent`, `dropAfterRead`, `failAfterSend`). A 429 is received and
// delivers nothing. So a suite can ask the question that decides whether a retry
// duplicates a message: not "did the adapter send it" but "does the chat hold it".
//
// THE ENVELOPES ARE TELEGRAM'S OWN: `{ ok: true, result }` on success and
// `{ ok: false, error_code, description, parameters }` on a refusal, with the HTTP
// status mirroring `error_code` unless a case deliberately makes them disagree.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface ReceivedRequest {
  readonly method: string;
  /** The Bot API method name, e.g. `sendMessage`. */
  readonly apiMethod: string;
  /** The token as it appeared in the path, with the `bot` prefix stripped. */
  readonly token: string;
  readonly contentType: string | null;
  readonly json: Readonly<Record<string, unknown>> | null;
}

export interface SentMessage {
  readonly messageId: number;
  readonly chatId: string;
  readonly threadId: number | null;
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
  /** A Bot API refusal. `status` defaults to `code`, as the API itself does. */
  | { readonly kind: "refused"; readonly code: number; readonly status?: number }
  /** A 429 with `parameters.retry_after`, and optionally a Retry-After header. */
  | {
      readonly kind: "rateLimited";
      readonly retryAfter?: number;
      readonly retryAfterHeader?: number;
      readonly status?: number;
    }
  /** Perform the send, then answer 500 — the state a 5xx on a write cannot rule out. */
  | { readonly kind: "failAfterSend" }
  /** `{ ok: true }` with no `result` object. */
  | { readonly kind: "okWithoutResult" }
  /** A gateway's HTML page with a success-looking or failing status. */
  | { readonly kind: "notJson"; readonly status: number };

/** The instant the far side stamps every message it accepts. */
export const FAR_SIDE_INSTANT = new Date("2026-06-01T08:00:00.000Z");

export class FarSide {
  readonly received: ReceivedRequest[] = [];
  readonly sent: SentMessage[] = [];
  private readonly script: FarSideBehaviour[] = [];
  private readonly open = new Set<ServerResponse>();
  private server: Server | null = null;
  private port = 0;

  /** The `apiUrl` an adapter is pointed at. Trailing slash; see `vendor.ts`. */
  get apiUrl(): string {
    return `http://127.0.0.1:${this.port}/`;
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
      const path = (request.url ?? "").replace(/^\//u, "");
      const slash = path.indexOf("/");
      const received: ReceivedRequest = Object.freeze({
        method: request.method ?? "",
        apiMethod: slash === -1 ? "" : path.slice(slash + 1),
        token: (slash === -1 ? path : path.slice(0, slash)).replace(/^bot/u, ""),
        contentType: request.headers["content-type"] ?? null,
        json,
      });
      // RECORDED BEFORE THE BEHAVIOUR IS CONSULTED. Whether the far side answers
      // has nothing to do with whether it received the request.
      this.received.push(received);
      this.respond(received, response);
    });
  }

  /** Perform a request's effect: a send delivers a message, an edit changes one. */
  private perform(request: ReceivedRequest): Record<string, unknown> {
    const chatId = String(request.json?.["chat_id"] ?? "");
    const text = typeof request.json?.["text"] === "string" ? request.json["text"] : "";
    const date = Math.floor(FAR_SIDE_INSTANT.getTime() / 1000);
    if (request.apiMethod === "editMessageText") {
      const messageId = Number(request.json?.["message_id"] ?? 0);
      return { message_id: messageId, date, chat: { id: Number(chatId), type: "supergroup" }, text };
    }
    if (request.apiMethod === "sendMessage") {
      const threadId = request.json?.["message_thread_id"];
      const messageId = 5000 + this.sent.length + 1;
      this.sent.push(
        Object.freeze({
          messageId,
          chatId,
          threadId: typeof threadId === "number" ? threadId : null,
          text,
        }),
      );
      return { message_id: messageId, date, chat: { id: Number(chatId), type: "supergroup" }, text };
    }
    if (request.apiMethod === "getChat") {
      return { id: Number(chatId), type: "private", first_name: "River", last_name: "Watcher", username: "riverwatcher" };
    }
    return { id: 7654321, is_bot: true, first_name: "Platos", username: "platos_bot" };
  }

  private respond(request: ReceivedRequest, response: ServerResponse): void {
    const behaviour = this.script.shift() ?? { kind: "ok" as const };
    const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(body));
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
          json(200, { ok: true, result: this.perform(request) });
        }, behaviour.afterMs);
        timer.unref();
        return;
      }
      case "refused":
        json(behaviour.status ?? behaviour.code, {
          ok: false,
          error_code: behaviour.code,
          description: "refused",
        });
        return;
      case "rateLimited":
        json(
          behaviour.status ?? 429,
          {
            ok: false,
            error_code: 429,
            description: "Too Many Requests: retry after",
            ...(behaviour.retryAfter === undefined ? {} : { parameters: { retry_after: behaviour.retryAfter } }),
          },
          behaviour.retryAfterHeader === undefined ? {} : { "retry-after": String(behaviour.retryAfterHeader) },
        );
        return;
      case "failAfterSend":
        this.perform(request);
        json(500, { ok: false, error_code: 500, description: "Internal Server Error" });
        return;
      case "okWithoutResult":
        json(200, { ok: true });
        return;
      case "notJson":
        response.writeHead(behaviour.status, { "content-type": "text/html" });
        response.end("<html><body>502 Bad Gateway</body></html>");
        return;
      case "ok":
        json(200, { ok: true, result: this.perform(request) });
        return;
    }
  }
}
