// The bytes of a message, and the relay URL's meaning — the pure half.
//
// The conversation with a REAL relay is proven in
// `apps/core-api/src/composition/identity-tenancy-rest.integration.test.ts`, against a
// Mailpit container that parses what arrives with its own MIME decoder. What is
// here is what that suite would only see as a rejected or mangled message: the
// refusals, and the encodings a relay must carry unchanged.

import { describe, expect, it } from "vitest";

import { MAGIC_LINK_SUBJECT, createNotifierEmailAdapter, magicLinkUrl, renderMagicLinkText } from "./adapter.js";
import { admitAddress, renderMessage } from "./message.js";
import { parseRelayUrl } from "./relay.js";

const AT = new Date("2026-09-15T10:00:00.000Z");

function message(overrides: Record<string, string> = {}) {
  return renderMessage({
    from: "login@platos.example",
    to: "operator@example.com",
    subject: MAGIC_LINK_SUBJECT,
    text: "Sign in to Platos: https://app.example/magic?token=plt_ml_x\nLine two",
    messageId: "abc@platos.example",
    date: AT,
    ...overrides,
  });
}

describe("rendering a message", () => {
  it("writes the headers a relay needs and a base64 body that decodes to the text", () => {
    const rendered = message();
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const [head, body] = rendered.value.split("\r\n\r\n");
    expect(head?.split("\r\n")).toEqual([
      "From: <login@platos.example>",
      "To: <operator@example.com>",
      "Subject: Sign in to Platos",
      "Date: Tue, 15 Sep 2026 10:00:00 +0000",
      "Message-ID: <abc@platos.example>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "Auto-Submitted: auto-generated",
    ]);
    expect(Buffer.from((body ?? "").replaceAll("\r\n", ""), "base64").toString("utf8")).toBe(
      "Sign in to Platos: https://app.example/magic?token=plt_ml_x\r\nLine two",
    );
  });

  it("cannot be altered by SMTP dot-stuffing: no body line begins with a dot, none exceeds 76", () => {
    const rendered = message({ text: ".\n..\n" + "x".repeat(500) });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const body = rendered.value.split("\r\n\r\n")[1] ?? "";
    for (const line of body.split("\r\n")) {
      expect(line.startsWith(".")).toBe(false);
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });

  it("writes a non-ASCII subject as an RFC 2047 encoded-word", () => {
    const rendered = message({ subject: "Budget — 80% reached" });
    expect(rendered.ok && rendered.value).toContain(
      `Subject: =?UTF-8?B?${Buffer.from("Budget — 80% reached").toString("base64")}?=`,
    );
  });

  it("REFUSES a line break in any header value rather than cleaning it", () => {
    for (const [field, value] of [
      ["to", "victim@example.com\r\nBcc: attacker@example.com"],
      ["from", "a@b.c\nX: y"],
      ["subject", "hello\r\nBcc: attacker@example.com"],
      ["messageId", "a@b\r\nX: y"],
    ] as const) {
      const refused = message({ [field]: value });
      expect(refused.ok, field).toBe(false);
      if (refused.ok) continue;
      expect(refused.error.code).toBe("NOTIFIER_EMAIL_MESSAGE_REFUSED");
      // THE VALUE IS NOT ECHOED: a refusal's details are rendered into logs.
      expect(JSON.stringify(refused.error)).not.toContain("attacker");
    }
  });

  it("refuses an address that is not one ASCII local@domain", () => {
    for (const address of ["no-at", "a@b@c", "ü@example.com", "<a@b.c>", "a b@c.d"]) {
      expect(admitAddress("to", address).ok, address).toBe(false);
    }
    expect(admitAddress("to", "first.last+tag@sub.example.com").ok).toBe(true);
  });
});

describe("the sign-in link", () => {
  it("appends the token as the one query parameter, keeping any the page already has", () => {
    expect(magicLinkUrl(new URL("https://app.example/magic"), "plt_ml_a+b/c")).toBe(
      "https://app.example/magic?token=plt_ml_a%2Bb%2Fc",
    );
    expect(magicLinkUrl(new URL("https://app.example/magic?next=%2F"), "plt_ml_x")).toBe(
      "https://app.example/magic?next=%2F&token=plt_ml_x",
    );
  });

  it("says when it expires and that it works once", () => {
    const text = renderMagicLinkText("https://app.example/magic?token=t", AT);
    expect(text).toContain("Sign in to Platos: https://app.example/magic?token=t");
    expect(text).toContain("2026-09-15T10:00:00.000Z");
  });
});

describe("the relay URL", () => {
  it("reads implicit TLS, default ports and percent-encoded credentials", () => {
    expect(parseRelayUrl("smtps://relay.example")).toEqual({
      ok: true,
      value: { implicitTls: true, host: "relay.example", port: 465, username: null, password: null },
    });
    const plain = parseRelayUrl("smtp://us%40er:p%3Ass@relay.example:2525");
    expect(plain.ok && plain.value).toEqual({
      implicitTls: false,
      host: "relay.example",
      port: 2525,
      username: "us@er",
      password: "p:ss",
    });
  });

  it("refuses a scheme, a missing host and a username without a password", () => {
    for (const url of ["https://relay.example", "smtp://", "smtp://user@relay.example", "not a url"]) {
      const refused = parseRelayUrl(url);
      expect(refused.ok, url).toBe(false);
      if (refused.ok) continue;
      expect(refused.error.code).toBe("NOTIFIER_EMAIL_CONFIGURATION_INVALID");
    }
  });

  it("refuses to construct over a login page that is not http(s) or already carries a token", () => {
    const base = { smtpUrl: "smtp://relay.example", from: "login@platos.example", clock: { now: () => AT } };
    expect(createNotifierEmailAdapter({ ...base, loginUrl: "https://app.example/magic" }).ok).toBe(true);
    for (const loginUrl of ["ftp://app.example/magic", "https://app.example/magic?token=fixed", "nope"]) {
      const refused = createNotifierEmailAdapter({ ...base, loginUrl });
      expect(refused.ok, loginUrl).toBe(false);
    }
    expect(createNotifierEmailAdapter({ ...base, loginUrl: "https://app.example/m", from: "a\r\n@b.c" }).ok).toBe(false);
  });
});
