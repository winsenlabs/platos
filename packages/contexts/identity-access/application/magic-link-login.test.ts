import { describe, expect, it } from "vitest";

import { DEFAULT_LOGIN_POLICY, MAGIC_LINK_TTL_MS } from "../domain/index.js";
import { ENVIRONMENT, MINUTE_MS, T0, at, email } from "../domain/testing.js";
import { completeMagicLinkLogin, startMagicLinkLogin } from "./magic-link-login.js";
import { testPorts, type TestPorts } from "./testing.js";

const start = {
  email: "  Operator@Example.COM ",
  rateLimitIdentifier: "198.51.100.7",
  scope: ENVIRONMENT,
} as const;

/**
 * The token, read from the ONLY place it goes: the delivery port. D20 — the use
 * case returns no token, so a test that needs one has to read the outbox the way
 * the recipient would.
 */
async function startedToken(ports: TestPorts): Promise<string> {
  const started = await startMagicLinkLogin(ports, start);
  if (!started.ok) throw new Error("expected the link to be issued");
  const message = ports.magicLinks.delivered.at(-1);
  if (message === undefined) throw new Error("expected the link to be delivered");
  return message.token;
}

describe("issuing a magic link", () => {
  it("mints a prefixed single-use token that lives fifteen minutes, and delivers it", async () => {
    const ports = testPorts();
    const started = await startMagicLinkLogin(ports, start);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.expiresAt).toEqual(at(MAGIC_LINK_TTL_MS));
    expect(ports.magicLinks.delivered).toHaveLength(1);
    const [message] = ports.magicLinks.delivered;
    expect(message?.token.startsWith("plt_ml_")).toBe(true);
    expect(message?.email).toBe(email());
    expect(message?.expiresAt).toEqual(at(MAGIC_LINK_TTL_MS));
  });

  it("D20: RETURNS NO TOKEN — the result carries the address and the expiry and nothing else", async () => {
    const ports = testPorts();
    const started = await startMagicLinkLogin(ports, start);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(Object.keys(started.value).sort()).toEqual(["email", "expiresAt"]);
    const token = ports.magicLinks.delivered[0]?.token ?? "";
    expect(token).not.toBe("");
    expect(JSON.stringify(started.value)).not.toContain(token);
  });

  it("normalizes the address before storing it", async () => {
    const ports = testPorts();
    const started = await startMagicLinkLogin(ports, start);
    expect(started.ok && started.value.email).toBe(email());
  });

  it("stores only the verifier, never the token", async () => {
    const ports = testPorts();
    const token = await startedToken(ports);
    const stored = [...ports.repository.state.magicLinks.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).toBe(ports.hasher.hash(token));
    // No column holds the secret itself — only its verifier.
    expect(Object.values(stored[0] ?? {})).not.toContain(token);
  });

  it("SPENDS THE LOGIN BUDGET, so the mail path cannot be pointed at any inbox", async () => {
    const ports = testPorts();
    for (let index = 0; index < DEFAULT_LOGIN_POLICY.requests; index += 1) {
      expect((await startMagicLinkLogin(ports, start)).ok).toBe(true);
    }
    const limited = await startMagicLinkLogin(ports, start);
    expect(limited.ok).toBe(false);
    if (limited.ok) return;
    expect(limited.error.code).toBe("RATE_LIMITED");
    expect(ports.magicLinks.delivered).toHaveLength(DEFAULT_LOGIN_POLICY.requests);
  });

  it("refuses an address that cannot be mailed, before anything is spent", async () => {
    const ports = testPorts();
    for (const bad of ["", "no-at-sign", "a@b", "evil@example.com\r\nBcc: x@example.com"]) {
      const refused = await startMagicLinkLogin(ports, { ...start, email: bad });
      expect(refused.ok, bad).toBe(false);
      if (refused.ok) continue;
      expect(refused.error.code).toBe("INVALID_EMAIL_ADDRESS");
    }
    expect(ports.rateLimiter.buckets.size).toBe(0);
    expect(ports.repository.state.magicLinks.size).toBe(0);
    expect(ports.magicLinks.delivered).toHaveLength(0);
  });
});

describe("D20 — delivery is the only way out, and its absence is refused early", () => {
  it("REFUSES WITH ITS OWN CODE when no delivery port is composed, minting nothing and spending nothing", async () => {
    const { magicLinks: _unused, ...rest } = testPorts();
    const ports = rest as Omit<TestPorts, "magicLinks">;
    const refused = await startMagicLinkLogin(ports, start);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("MAGIC_LINK_DELIVERY_UNAVAILABLE");
    expect(ports.repository.state.magicLinks.size).toBe(0);
    expect(ports.rateLimiter.buckets.size).toBe(0);
  });

  it("reports a relay that did not accept the message as a DIFFERENT code, carrying the port's code", async () => {
    const ports = testPorts();
    ports.magicLinks.refuse();
    const refused = await startMagicLinkLogin(ports, start);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("MAGIC_LINK_DELIVERY_FAILED");
    expect(refused.error.details["cause"]).toBe("MAGIC_LINK_DELIVERY_UNAVAILABLE");
    expect(ports.magicLinks.delivered).toHaveLength(0);
  });
});

describe("spending a magic link", () => {
  it("mints the account on first successful proof of the address", async () => {
    const ports = testPorts();
    const token = await startedToken(ports);
    const completed = await completeMagicLinkLogin(ports, { presentedToken: token });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(ports.repository.state.users.get(completed.value.userId)?.email).toBe(email());
    expect(completed.value.session.token.startsWith("plt_os_")).toBe(true);
  });

  it("binds a MAGIC_LINK identity keyed on the address itself", async () => {
    const ports = testPorts();
    await completeMagicLinkLogin(ports, { presentedToken: await startedToken(ports) });
    const identity = await ports.repository.operatorIdentities.findByProviderSubject(
      "MAGIC_LINK",
      email(),
    );
    expect(identity?.providerEmail).toBe(email());
  });

  it("reuses the existing account on a second login rather than minting another", async () => {
    const ports = testPorts();
    const first = await completeMagicLinkLogin(ports, { presentedToken: await startedToken(ports) });
    const second = await completeMagicLinkLogin(ports, {
      presentedToken: await startedToken(ports),
    });
    expect(first.ok && second.ok && first.value.userId).toBe(
      second.ok ? second.value.userId : undefined,
    );
    expect(ports.repository.state.users.size).toBe(1);
  });
});

describe("negative controls", () => {
  it("REFUSES A SECOND USE OF THE SAME LINK", async () => {
    const ports = testPorts();
    const token = await startedToken(ports);
    expect((await completeMagicLinkLogin(ports, { presentedToken: token })).ok).toBe(true);

    const replayed = await completeMagicLinkLogin(ports, { presentedToken: token });
    expect(replayed.ok).toBe(false);
    if (replayed.ok) return;
    expect(replayed.error.code).toBe("UNAUTHENTICATED");
    expect(ports.repository.state.sessions.size).toBe(1);
  });

  it("REFUSES AN EXPIRED LINK", async () => {
    const ports = testPorts();
    const token = await startedToken(ports);
    ports.clock.set(at(MAGIC_LINK_TTL_MS));
    const expired = await completeMagicLinkLogin(ports, { presentedToken: token });
    expect(expired.ok).toBe(false);
    expect(ports.repository.state.sessions.size).toBe(0);
  });

  it("accepts a link one millisecond before it expires", async () => {
    const ports = testPorts();
    const token = await startedToken(ports);
    ports.clock.set(at(MAGIC_LINK_TTL_MS - 1));
    expect((await completeMagicLinkLogin(ports, { presentedToken: token })).ok).toBe(true);
  });

  it("refuses a token that matches no link, and reports it the same way", async () => {
    const ports = testPorts();
    const unknown = await completeMagicLinkLogin(ports, { presentedToken: "plt_ml_invented" });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error.code).toBe("UNAUTHENTICATED");
  });

  it("refuses to log in a disabled account even with a valid link", async () => {
    const ports = testPorts();
    const token = await startedToken(ports);
    await completeMagicLinkLogin(ports, { presentedToken: await startedToken(ports) });
    for (const [id, user] of ports.repository.state.users) {
      ports.repository.state.users.set(id, { ...user, disabledAt: T0 });
    }
    ports.clock.advance(MINUTE_MS);
    const refused = await completeMagicLinkLogin(ports, { presentedToken: token });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("UNAUTHENTICATED");
  });
});
