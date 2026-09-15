// ONE SMTP TRANSACTION OVER ONE CONNECTION (RFC 5321), AND NOTHING ELSE.
//
// WHY THIS IS WRITTEN HERE RATHER THAN IMPORTED. A mail library would be the
// largest dependency this deployable's production graph gained in the tranche,
// with its own transports, pools, template engines and DKIM signer, to do the ten
// commands below. Every one of those features is a surface the SBOM, the advisory
// scan and the image would carry; none is used. The protocol subset a
// submission client needs is small, stable since 2008, and testable against a
// real relay — which is what
// `apps/core-api/src/composition/identity-tenancy-rest.integration.test.ts` does.
//
// THE SUBSET, IN ORDER:
//
//   greeting 220 -> EHLO -> [STARTTLS 220 -> TLS -> EHLO] -> [AUTH PLAIN 235]
//   -> MAIL FROM 250 -> RCPT TO 250/251 -> DATA 354 -> <message> CRLF.CRLF 250
//   -> QUIT
//
// A SEND IS DONE WHEN THE RELAY SAYS 250 TO THE MESSAGE, and not before. QUIT is
// sent as a courtesy and its answer is not waited on: the message is already the
// relay's responsibility, and failing a delivered message because a QUIT reply
// was slow would report as undelivered something a person is about to read.
//
// EVERY FAILURE IS A VALUE. A socket error, a TLS failure, a timeout and an
// unexpected EOF all resolve `err(NOTIFIER_EMAIL_RELAY_UNREACHABLE)` with the
// STAGE; a 4xx/5xx resolves `err(NOTIFIER_EMAIL_RELAY_REFUSED)` with the stage and
// the reply code. No reply TEXT is kept: it can echo the recipient back.
//
// THE DEADLINE STARTS BEFORE THE FIRST BYTE, NOT AFTER THE CONNECT. `timeoutMs`
// is the whole transaction's budget, and the connect and an implicit-TLS
// handshake are part of the transaction: a relay whose port is blackholed, or an
// `smtps://` listener that accepts TCP and never finishes TLS, would otherwise
// hold the sign-in request that asked for the link until the OS gave up — or, for
// the second, forever. The timer is armed first, every socket this attempt opens
// is registered with it, and when it fires they are destroyed, pending or not.
//
// TLS IS REQUIRED UNLESS THE INSTALL SAYS OTHERWISE. A sign-in link is a
// login-capable secret, and `smtp://` upgraded only "when offered" sends it in
// clear to any relay that does not offer STARTTLS — or through anybody on the path
// who strips `STARTTLS` out of the EHLO reply, which a plaintext EHLO cannot
// detect. So `requireTls` (true unless `PLATOS_CHANNELS_EMAIL_REQUIRE_TLS=false`)
// refuses the transaction with `NOTIFIER_EMAIL_INSECURE_TRANSPORT_REFUSED` BEFORE
// the envelope: no MAIL FROM, no RCPT TO, no DATA. Credentials were already
// refused over plaintext whatever the setting (`NOTIFIER_EMAIL_INSECURE_AUTH_
// REFUSED`); the setting only decides whether an UNauthenticated message may go.

import { connect as connectPlain, isIP, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";

import { err, ok, type Result } from "@platos/context-identity-access/application/ports/index.js";

import {
  insecureAuthenticationRefused,
  insecureTransportRefused,
  relayRefused,
  relayUnreachable,
} from "./errors.js";
import type { RelayEndpoint } from "./relay.js";

export interface SmtpEnvelope {
  readonly from: string;
  readonly to: string;
  /** Already rendered and admitted by `message.ts`. */
  readonly data: string;
  /** The name this client gives in EHLO. */
  readonly clientName: string;
}

export interface SmtpOptions {
  /** The whole transaction's budget, from before the connect to the final 250. */
  readonly timeoutMs: number;
  /**
   * Refuse to send anything over a connection that is not TLS — neither
   * `smtps:` nor upgraded by STARTTLS. See the banner.
   */
  readonly requireTls: boolean;
  /**
   * Extra trust for a relay's certificate — a private CA. Certificates ARE
   * verified; there is deliberately no option to turn that off.
   */
  readonly tls?: { readonly ca?: string | Buffer };
}

interface Reply {
  readonly code: number;
}

/** The NUL separator AUTH PLAIN (RFC 4616) puts between its three fields. */
const NUL = String.fromCharCode(0);

/** Reads complete SMTP replies (`ddd-...` continuation lines, `ddd ...` final). */
class ReplyReader {
  private buffer = "";
  private readonly queue: Reply[] = [];
  private waiter: { resolve: (reply: Reply) => void; reject: (error: Error) => void } | null = null;
  private failure: Error | null = null;
  /** Every complete line seen, for the one caller that reads EHLO keywords. */
  readonly lines: string[] = [];

  feed(chunk: Buffer): void {
    this.buffer += chunk.toString("latin1");
    for (;;) {
      const end = this.buffer.indexOf("\r\n");
      if (end < 0) break;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      this.lines.push(line);
      const match = /^(\d{3})([ -]|$)/u.exec(line);
      if (match === null || match[2] === "-") continue;
      this.deliver({ code: Number(match[1]) });
    }
  }

  fail(error: Error): void {
    this.failure ??= error;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.reject(error);
  }

  next(): Promise<Reply> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.failure !== null) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  private deliver(reply: Reply): void {
    const waiter = this.waiter;
    if (waiter === null) {
      this.queue.push(reply);
      return;
    }
    this.waiter = null;
    waiter.resolve(reply);
  }
}

class Conversation {
  private reader = new ReplyReader();
  private socket: Socket | TLSSocket;

  constructor(socket: Socket | TLSSocket) {
    this.socket = socket;
    this.attach(socket);
  }

  get transport(): Socket | TLSSocket {
    return this.socket;
  }

  get lines(): readonly string[] {
    return this.reader.lines;
  }

  /**
   * Swap the transport after STARTTLS. Anything the relay sent before the
   * handshake is discarded, which RFC 3207 §4.2 requires: a reply injected into the
   * plaintext stream must not be read as if it arrived over TLS.
   */
  upgrade(socket: TLSSocket): void {
    this.socket.removeAllListeners("data");
    this.socket.removeAllListeners("close");
    this.reader = new ReplyReader();
    this.socket = socket;
    this.attach(socket);
  }

  /** Forget the lines read so far, so the next EHLO's keywords are its own. */
  resetLines(): void {
    this.reader.lines.length = 0;
  }

  private attach(socket: Socket | TLSSocket): void {
    const reader = this.reader;
    socket.on("data", (chunk: Buffer) => reader.feed(chunk));
    socket.on("error", (error: Error) => reader.fail(error));
    socket.on("close", () => reader.fail(new Error("connection closed")));
  }

  async read(stage: string): Promise<Result<Reply>> {
    try {
      return ok(await this.reader.next());
    } catch (error) {
      return err(relayUnreachable(stage, error instanceof Error ? error.name : "unknown"));
    }
  }

  async command(line: string, stage: string): Promise<Result<Reply>> {
    this.socket.write(`${line}\r\n`, "latin1");
    return this.read(stage);
  }
}

function accept(reply: Result<Reply>, stage: string, codes: readonly number[]): Result<Reply> {
  if (!reply.ok) return reply;
  return codes.includes(reply.value.code) ? reply : err(relayRefused(stage, reply.value.code));
}

/** EHLO, and whether the relay offered STARTTLS. No other keyword is read. */
async function hello(conversation: Conversation, clientName: string): Promise<Result<boolean>> {
  conversation.resetLines();
  const reply = accept(await conversation.command(`EHLO ${clientName}`, "ehlo"), "ehlo", [250]);
  if (!reply.ok) return reply;
  return ok(conversation.lines.some((line) => /^250[ -]STARTTLS\b/iu.test(line)));
}

/**
 * The SNI name for a relay host. RFC 6066 §3 forbids an IP literal there; the
 * certificate is still checked against the host whichever form it takes.
 */
function serverNameOf(host: string): string | undefined {
  return isIP(host) === 0 ? host : undefined;
}

/**
 * Every socket one attempt opened, so the deadline can destroy them all — the
 * plain socket still connecting, the TLS socket still handshaking, and the TLS
 * socket STARTTLS wrapped around the plain one.
 */
type Track = (socket: Socket | TLSSocket) => void;

function open(endpoint: RelayEndpoint, options: SmtpOptions, track: Track): Promise<Result<Socket | TLSSocket>> {
  return new Promise((resolve) => {
    const socket = endpoint.implicitTls
      ? connectTls({ host: endpoint.host, port: endpoint.port, servername: serverNameOf(endpoint.host), ...(options.tls ?? {}) })
      : connectPlain({ host: endpoint.host, port: endpoint.port });
    track(socket);
    const settle = (result: Result<Socket | TLSSocket>): void => {
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      resolve(result);
    };
    const onError = (error: Error): void => {
      socket.destroy();
      settle(err(relayUnreachable("connect", error.name)));
    };
    // Destroyed by the deadline before it connected: `destroy()` without an error
    // emits `close` and no `error`, and this promise must still settle.
    const onClose = (): void => settle(err(relayUnreachable("connect", "closed")));
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.once(endpoint.implicitTls ? "secureConnect" : "connect", () => settle(ok(socket)));
  });
}

async function startTls(
  conversation: Conversation,
  endpoint: RelayEndpoint,
  options: SmtpOptions,
  track: Track,
): Promise<Result<void>> {
  const ready = accept(await conversation.command("STARTTLS", "starttls"), "starttls", [220]);
  if (!ready.ok) return ready;
  const plain = conversation.transport as Socket;
  return new Promise((resolve) => {
    const secured = connectTls({ socket: plain, host: endpoint.host, servername: serverNameOf(endpoint.host), ...(options.tls ?? {}) });
    track(secured);
    secured.once("close", () => resolve(err(relayUnreachable("tls-handshake", "closed"))));
    secured.once("error", (error: Error) => resolve(err(relayUnreachable("tls-handshake", error.name))));
    secured.once("secureConnect", () => {
      conversation.upgrade(secured);
      resolve(ok(undefined));
    });
  });
}

async function converse(
  conversation: Conversation,
  endpoint: RelayEndpoint,
  envelope: SmtpEnvelope,
  options: SmtpOptions,
  track: Track,
): Promise<Result<void>> {
  const greeting = accept(await conversation.read("greeting"), "greeting", [220]);
  if (!greeting.ok) return greeting;
  const offered = await hello(conversation, envelope.clientName);
  if (!offered.ok) return offered;
  let secure = endpoint.implicitTls;
  if (!secure && offered.value) {
    const upgraded = await startTls(conversation, endpoint, options, track);
    if (!upgraded.ok) return upgraded;
    secure = true;
    const again = await hello(conversation, envelope.clientName);
    if (!again.ok) return again;
  }
  // Before credentials AND before the envelope: with TLS required, a relay that
  // offered none — or a path that stripped the offer — learns nothing but EHLO.
  if (!secure && options.requireTls) return err(insecureTransportRefused());
  if (endpoint.username !== null && endpoint.password !== null) {
    if (!secure) return err(insecureAuthenticationRefused());
    const plain = Buffer.from(`${NUL}${endpoint.username}${NUL}${endpoint.password}`, "utf8").toString("base64");
    const authenticated = accept(await conversation.command(`AUTH PLAIN ${plain}`, "auth"), "auth", [235]);
    if (!authenticated.ok) return authenticated;
  }
  const sender = accept(await conversation.command(`MAIL FROM:<${envelope.from}>`, "mail-from"), "mail-from", [250]);
  if (!sender.ok) return sender;
  const recipient = accept(await conversation.command(`RCPT TO:<${envelope.to}>`, "rcpt-to"), "rcpt-to", [250, 251]);
  if (!recipient.ok) return recipient;
  const data = accept(await conversation.command("DATA", "data"), "data", [354]);
  if (!data.ok) return data;
  const stored = accept(await conversation.command(`${envelope.data}\r\n.`, "message"), "message", [250]);
  if (!stored.ok) return stored;
  conversation.transport.write("QUIT\r\n", "latin1");
  return ok(undefined);
}

/** Send one message. Resolves once the relay has accepted it, or with why it did not. */
export async function sendOverSmtp(
  endpoint: RelayEndpoint,
  envelope: SmtpEnvelope,
  options: SmtpOptions,
): Promise<Result<void>> {
  // ARMED FIRST. See the banner: the connect and the handshake spend this budget.
  const sockets: (Socket | TLSSocket)[] = [];
  const track: Track = (socket) => {
    sockets.push(socket);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Result<void>>((resolve) => {
    timer = setTimeout(() => resolve(err(relayUnreachable("deadline", "timeout"))), options.timeoutMs);
  });
  const attempt = async (): Promise<Result<void>> => {
    const socket = await open(endpoint, options, track);
    if (!socket.ok) return socket;
    return converse(new Conversation(socket.value), endpoint, envelope, options, track);
  };
  try {
    return await Promise.race([attempt(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
  }
}
