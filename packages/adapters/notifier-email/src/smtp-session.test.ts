// The relay conversation's REFUSALS, against a scripted relay on a real socket.
//
// A scripted relay is a double, and it is used here for exactly the answers a
// real sink will not give on demand: a relay that offers no TLS to a client
// holding credentials or a sign-in link, a relay that refuses the recipient, a
// relay that never answers — and a listener that accepts TCP and never finishes
// a TLS handshake, which is the case the deadline used not to cover. The ACCEPTING path — the one a person reads — is proven against a real
// relay in `apps/core-api/src/composition/identity-tenancy-rest.integration.test.ts`.

import { createServer, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { sendOverSmtp } from "./smtp-session.js";

type Script = (line: string, socket: Socket) => void;

let server: Server | null = null;
let transcript: string[] = [];

async function relay(greeting: string | null, script: Script): Promise<number> {
  transcript = [];
  server = createServer((socket) => {
    // THE CLIENT HANGS UP WITHOUT WAITING, BY DESIGN: `sendOverSmtp` writes QUIT
    // and destroys its socket at once (see its banner). When this relay's answer
    // to QUIT is already in the client's receive buffer, that close is a TCP RST,
    // and without a listener the relay's `read ECONNRESET` is an UNCAUGHT
    // exception that fails the run after every case has passed — measured at 5 of
    // 12 runs of this file. The relay's own socket errors are not what any case
    // here asserts, so they are observed and dropped.
    socket.on("error", () => undefined);
    if (greeting !== null) socket.write(`${greeting}\r\n`);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      for (;;) {
        const end = buffer.indexOf("\r\n");
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        transcript.push(line);
        script(line, socket);
      }
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server === null ? resolve() : server.close(() => resolve())));
  server = null;
});

const ENVELOPE = { from: "login@platos.example", to: "operator@example.com", data: "Subject: x\r\n\r\nYQ==", clientName: "platos.example" };

describe("a relay that should not be trusted with a secret", () => {
  it("REFUSES to send credentials when the relay offers no STARTTLS, and never sends AUTH — even with TLS not required", async () => {
    const port = await relay("220 scripted", (line, socket) => {
      if (line.startsWith("EHLO")) socket.write("250-scripted\r\n250 SIZE 1000\r\n");
      else socket.write("250 ok\r\n");
    });
    const refused = await sendOverSmtp(
      { implicitTls: false, host: "127.0.0.1", port, username: "user", password: "secret" },
      ENVELOPE,
      { timeoutMs: 5_000, requireTls: false },
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("NOTIFIER_EMAIL_INSECURE_AUTH_REFUSED");
    expect(transcript.some((line) => line.startsWith("AUTH"))).toBe(false);
    expect(transcript.join("\n")).not.toContain("secret");
  });

  // With TLS required — the default an install gets — a relay that offers
  // no STARTTLS, or a path that stripped the offer out of the plaintext EHLO reply
  // (the client cannot tell the two apart, which is why both are refused), gets
  // EHLO and nothing else: the sign-in link never reaches a connection without TLS.
  it("REFUSES the whole message, before the envelope, when TLS is required and the relay offers none", async () => {
    const port = await relay("220 scripted", (line, socket) => {
      if (line.startsWith("EHLO")) socket.write("250-scripted\r\n250 SIZE 1000\r\n");
      else socket.write("250 ok\r\n");
    });
    const refused = await sendOverSmtp(
      { implicitTls: false, host: "127.0.0.1", port, username: null, password: null },
      { ...ENVELOPE, data: "Subject: x\r\n\r\nSign in: https://app.example/magic?token=plt_ml_secret" },
      { timeoutMs: 5_000, requireTls: true },
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("NOTIFIER_EMAIL_INSECURE_TRANSPORT_REFUSED");
    expect(transcript.every((line) => line.startsWith("EHLO"))).toBe(true);
    expect(transcript.join("\n")).not.toContain("plt_ml_secret");
  });

  it("sends an unauthenticated message in clear ONLY when the install turned TLS off", async () => {
    let inData = false;
    const port = await relay("220 scripted", (line, socket) => {
      if (inData) {
        if (line === ".") {
          inData = false;
          socket.write("250 queued\r\n");
        }
        return;
      }
      if (line.startsWith("EHLO")) socket.write("250 scripted\r\n");
      else if (line === "DATA") {
        inData = true;
        socket.write("354 go\r\n");
      } else socket.write("250 ok\r\n");
    });
    const sent = await sendOverSmtp(
      { implicitTls: false, host: "127.0.0.1", port, username: null, password: null },
      ENVELOPE,
      { timeoutMs: 5_000, requireTls: false },
    );
    expect(sent.ok).toBe(true);
    expect(transcript).toContain("DATA");
  });
});

describe("a relay that answers no", () => {
  it("reports the STAGE and the reply code, and not the reply text", async () => {
    const port = await relay("220 scripted", (line, socket) => {
      if (line.startsWith("EHLO")) socket.write("250 scripted\r\n");
      else if (line.startsWith("RCPT")) socket.write("550 5.1.1 operator@example.com unknown\r\n");
      else socket.write("250 ok\r\n");
    });
    const refused = await sendOverSmtp(
      { implicitTls: false, host: "127.0.0.1", port, username: null, password: null },
      ENVELOPE,
      { timeoutMs: 5_000, requireTls: false },
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("NOTIFIER_EMAIL_RELAY_REFUSED");
    expect(refused.error.details).toEqual({ stage: "rcpt-to", replyCode: 550 });
    expect(JSON.stringify(refused.error)).not.toContain("operator@example.com");
    expect(transcript.some((line) => line === "DATA")).toBe(false);
  });

  it("gives up at the deadline on a relay that never greets, as UNREACHABLE", async () => {
    const port = await relay(null, () => undefined);
    const refused = await sendOverSmtp(
      { implicitTls: false, host: "127.0.0.1", port, username: null, password: null },
      ENVELOPE,
      { timeoutMs: 300, requireTls: true },
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("NOTIFIER_EMAIL_RELAY_UNREACHABLE");
    expect(refused.error.details).toMatchObject({ stage: "deadline" });
  });

  it("reports a closed port as UNREACHABLE at connect", async () => {
    const port = await relay("220 x", () => undefined);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    const refused = await sendOverSmtp(
      { implicitTls: false, host: "127.0.0.1", port, username: null, password: null },
      ENVELOPE,
      { timeoutMs: 2_000, requireTls: true },
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.details).toMatchObject({ stage: "connect" });
  });
});

describe("the deadline covers the connect and the TLS handshake, and destroys what it abandons", () => {
  /**
   * A listener that ACCEPTS TCP and then says nothing, ever — to a TLS
   * ClientHello or to anything else. Resolves `closed` when the client end goes
   * away, which is how the case proves the abandoned socket was destroyed rather
   * than left to the OS.
   */
  async function silent(): Promise<{ port: number; closed: Promise<number> }> {
    let markClosed: (at: number) => void = () => undefined;
    const closed = new Promise<number>((resolve) => {
      markClosed = resolve;
    });
    server = createServer((socket) => {
      socket.on("data", () => undefined);
      socket.on("error", () => undefined);
      socket.on("close", () => markClosed(Date.now()));
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    return { port: address.port, closed };
  }

  it("gives up at the deadline on an smtps:// listener that never finishes TLS, and closes the socket", async () => {
    const { port, closed } = await silent();
    const began = Date.now();
    const refused = await sendOverSmtp(
      { implicitTls: true, host: "127.0.0.1", port, username: null, password: null },
      ENVELOPE,
      { timeoutMs: 300, requireTls: true },
    );
    const elapsed = Date.now() - began;
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("NOTIFIER_EMAIL_RELAY_UNREACHABLE");
    expect(refused.error.details).toMatchObject({ stage: "deadline" });
    expect(elapsed).toBeLessThan(1_500);
    const closedAt = await Promise.race([closed, new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000))]);
    expect(closedAt, "the abandoned handshake's socket must be destroyed, not left open").not.toBeNull();
  }, 4_000);

  it("gives up at the deadline on a relay that answers STARTTLS 220 and never finishes the handshake", async () => {
    const port = await relay("220 scripted", (line, socket) => {
      if (line.startsWith("EHLO")) socket.write("250-scripted\r\n250 STARTTLS\r\n");
      else if (line === "STARTTLS") socket.write("220 go ahead\r\n");
      // and then silence: the ClientHello is read and never answered.
    });
    const began = Date.now();
    const refused = await sendOverSmtp(
      { implicitTls: false, host: "127.0.0.1", port, username: null, password: null },
      ENVELOPE,
      { timeoutMs: 300, requireTls: true },
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.details).toMatchObject({ stage: "deadline" });
    expect(Date.now() - began).toBeLessThan(1_500);
    expect(transcript.some((line) => line.startsWith("MAIL"))).toBe(false);
  }, 4_000);
});
