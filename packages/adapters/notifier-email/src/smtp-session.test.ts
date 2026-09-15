// The relay conversation's REFUSALS, against a scripted relay on a real socket.
//
// A scripted relay is a double, and it is used here for exactly the answers a
// real sink will not give on demand: a relay that offers no TLS to a client
// holding credentials, a relay that refuses the recipient, a relay that never
// answers. The ACCEPTING path — the one a person reads — is proven against a real
// relay in `apps/core-api/src/composition/magic-link-email.integration.test.ts`.

import { createServer, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { sendOverSmtp } from "./smtp-session.js";

type Script = (line: string, socket: Socket) => void;

let server: Server | null = null;
let transcript: string[] = [];

async function relay(greeting: string | null, script: Script): Promise<number> {
  transcript = [];
  server = createServer((socket) => {
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
  it("REFUSES to send credentials when the relay offers no STARTTLS, and never sends AUTH", async () => {
    const port = await relay("220 scripted", (line, socket) => {
      if (line.startsWith("EHLO")) socket.write("250-scripted\r\n250 SIZE 1000\r\n");
      else socket.write("250 ok\r\n");
    });
    const refused = await sendOverSmtp(
      { implicitTls: false, host: "127.0.0.1", port, username: "user", password: "secret" },
      ENVELOPE,
      { timeoutMs: 5_000 },
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("NOTIFIER_EMAIL_INSECURE_AUTH_REFUSED");
    expect(transcript.some((line) => line.startsWith("AUTH"))).toBe(false);
    expect(transcript.join("\n")).not.toContain("secret");
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
      { timeoutMs: 5_000 },
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
      { timeoutMs: 300 },
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
      { timeoutMs: 2_000 },
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.details).toMatchObject({ stage: "connect" });
  });
});
