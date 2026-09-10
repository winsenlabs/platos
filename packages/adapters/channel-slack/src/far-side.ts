// A REAL HTTP SERVER THAT KEEPS ITS OWN RECORD OF WHAT IT RECEIVED.
//
// WHY THIS EXISTS RATHER THAN A STUBBED `fetch`. WIN-271's whole subject is the
// far side misbehaving, and a stub cannot misbehave — it can only be TOLD to
// return a value, which makes every assertion downstream a statement about the
// instruction rather than about the adapter. Worse, a stub cannot express the
// one state that matters here at all: "the request arrived, was processed, and
// the answer never came back". A stub either answers or it does not.
//
// A REAL `node:http` SERVER CAN BE IN THAT STATE, BY DOING NOTHING. `/silent`
// reads the request to completion, records it, and then simply never writes a
// response. Nothing is simulated: the socket is open, the request is delivered,
// the far side has it, and the caller's deadline elapses. That is the real
// production failure, reproduced rather than described.
//
// AND THE ASSERTIONS ARE AGAINST `received`, WHICH THIS FILE DOES NOT CONTROL.
// Every request the server parses is appended to that array by the server's own
// handler. A suite asking "did the message actually land?" reads the FAR SIDE's
// record, not the adapter's report — which is the only way to catch an adapter
// that says `UNAVAILABLE` (retry me) about a message that was in fact posted.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

export interface ReceivedRequest {
  readonly method: string;
  /** The Slack API method, taken from the last path segment. */
  readonly slackMethod: string;
  readonly authorization: string | null;
  /** The form-encoded body, decoded. */
  readonly form: Readonly<Record<string, string>>;
}

/**
 * How the far side behaves for the NEXT request, and only the next one.
 *
 * A queue rather than a mode, so a case can script "fail, then succeed" — which
 * is what a reconnect looks like — without any per-test server plumbing. When
 * the queue empties the server answers normally, so the ordinary path is the
 * default and a case that forgets to script anything gets a working provider.
 */
export type FarSideBehaviour =
  | { readonly kind: "ok" }
  /** Read the request, record it, and never answer. */
  | { readonly kind: "silent" }
  /** Answer after `afterMs`, which may still beat the caller's deadline. */
  | { readonly kind: "slow"; readonly afterMs: number }
  /** Slack's own refusal shape: HTTP 200 with `{ ok: false, error }`. */
  | { readonly kind: "refuse"; readonly error: string }
  /** An HTTP status with a JSON body, the way Slack answers a 429 or a 5xx. */
  | { readonly kind: "status"; readonly status: number; readonly error: string }
  /** A gateway's plain-text error page — not JSON, and not Slack's shape. */
  | { readonly kind: "notJson"; readonly status: number };

export class FarSide {
  readonly received: ReceivedRequest[] = [];
  private readonly script: FarSideBehaviour[] = [];
  private readonly open = new Set<ServerResponse>();
  private server: Server | null = null;
  private port = 0;

  /** The `apiUrl` an adapter is pointed at. Trailing slash; see `send.ts`. */
  get apiUrl(): string {
    return `http://127.0.0.1:${this.port}/api/`;
  }

  /** A port nothing is listening on — the connection-refused case. */
  get deadApiUrl(): string {
    return `http://127.0.0.1:${this.port}/api/`;
  }

  next(...behaviours: readonly FarSideBehaviour[]): void {
    this.script.push(...behaviours);
  }

  async listen(port = 0): Promise<void> {
    const server = createServer((request, response) => {
      this.handle(request, response);
    });
    await new Promise<void>((resolve) => {
      server.listen(port, "127.0.0.1", resolve);
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  /**
   * Stop listening WITHOUT losing the port or the record.
   *
   * The port is remembered so a caller can keep pointing at it and get
   * `ECONNREFUSED` from the operating system — a genuine refused connection, not
   * a simulated one — and `listen(this.port)` brings the same address back for
   * the reconnect half of the case.
   */
  async stop(): Promise<void> {
    for (const response of this.open) response.destroy();
    this.open.clear();
    const server = this.server;
    if (server === null) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    this.server = null;
  }

  async restart(): Promise<void> {
    await this.listen(this.port);
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const form: Record<string, string> = {};
      for (const [key, value] of new URLSearchParams(body)) form[key] = value;
      // RECORDED BEFORE THE BEHAVIOUR IS CONSULTED. Whether the far side answers
      // has nothing to do with whether it received the request, and conflating
      // the two here would destroy the very distinction these suites exist to
      // measure.
      this.received.push({
        method: request.method ?? "",
        slackMethod: (request.url ?? "").split("/").pop() ?? "",
        authorization: request.headers.authorization ?? null,
        form: Object.freeze(form),
      });
      this.respond(response);
    });
  }

  private respond(response: ServerResponse): void {
    const behaviour = this.script.shift() ?? { kind: "ok" as const };
    const posted = JSON.stringify({
      ok: true,
      ts: `171200000${this.received.length}.000100`,
      channel: "C0LAN2Q65",
    });

    if (behaviour.kind === "silent") {
      // Held open, answered never. Destroyed in `stop()` so the process can end.
      this.open.add(response);
      return;
    }
    if (behaviour.kind === "slow") {
      const timer = setTimeout(() => {
        this.open.delete(response);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(posted);
      }, behaviour.afterMs);
      timer.unref?.();
      this.open.add(response);
      return;
    }
    if (behaviour.kind === "refuse") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: behaviour.error }));
      return;
    }
    if (behaviour.kind === "status") {
      response.writeHead(behaviour.status, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: behaviour.error }));
      return;
    }
    if (behaviour.kind === "notJson") {
      response.writeHead(behaviour.status, { "content-type": "text/html" });
      response.end("<html><body>502 Bad Gateway</body></html>");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(posted);
  }
}
