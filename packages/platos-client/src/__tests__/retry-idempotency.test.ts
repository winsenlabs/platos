/**
 * A RETRY THAT COULD DOUBLE AN EFFECT IS REFUSED, AND THE RULE IS PROVED RATHER
 * THAN THE CURRENT ACCIDENT.
 *
 * WHAT WAS WRONG. `PlatosClient._fetchWithRetry` retried ANY method — POST
 * included — on a network error, a 5xx or a 429. Nothing had gone wrong yet, and
 * the reason was not a guard: it was that no namespace on this legacy client
 * happens to reach a mint. A `mints.create()` added to `src/apis/` tomorrow would
 * have inherited the retry from the transport, minted twice, and turned nothing
 * red. ADR M0.4 §2 requires `Idempotency-Key` on those mints for exactly this
 * failure, and `v1-transport.ts` says so in its own banner while noting that
 * `_fetchWithRetry` "predates this rule".
 *
 * WHAT THESE CASES ASSERT, AND WHAT THEY DELIBERATELY DO NOT. They never ask
 * whether a mint exists. Every case drives a SYNTHETIC request through the
 * transport and counts how many times `fetch` was called, so the subject is the
 * rule — method plus header — and not the shape of today's namespace list. A
 * suite that enumerated `src/apis/` and found no mint would go green again the
 * moment somebody added one, which is the opposite of a guard.
 *
 * THE NON-VACUITY IS EXPLICIT. Retries are configured to 3 and the GET case
 * observes 4 calls, so "one call" is a refusal to repeat rather than a client
 * with retries switched off.
 */

import { describe, expect, it } from "vitest";
import { PlatosClient } from "../client.js";
import { IDEMPOTENCY_KEY_HEADER } from "../generated/v1.js";
import { PlatosNetworkError, PlatosServerError } from "../errors.js";

const MAX_RETRIES = 3;

interface Recorder {
  readonly calls: Array<{ method: string; headers: Record<string, string> }>;
  readonly fetch: typeof globalThis.fetch;
}

/** Answers every call with the same failure, and records what it was asked. */
function alwaysFails(kind: "status" | "network"): Recorder {
  const calls: Array<{ method: string; headers: Record<string, string> }> = [];
  const impl = (async (_url: string, init: RequestInit) => {
    calls.push({
      method: String(init.method ?? "GET"),
      headers: { ...(init.headers as Record<string, string>) },
    });
    if (kind === "network") throw new TypeError("socket hung up");
    return new Response("upstream is unwell", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch: impl };
}

/** Fails once, then succeeds — the shape a legitimate retry recovers from. */
function failsOnceThenSucceeds(): Recorder {
  const calls: Array<{ method: string; headers: Record<string, string> }> = [];
  const impl = (async (_url: string, init: RequestInit) => {
    calls.push({
      method: String(init.method ?? "GET"),
      headers: { ...(init.headers as Record<string, string>) },
    });
    if (calls.length === 1) {
      return new Response("try again", { status: 503, headers: { "Content-Type": "text/plain" } });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch: impl };
}

function clientOver(recorder: Recorder): PlatosClient {
  return new PlatosClient({
    baseUrl: "https://platos.test",
    sessionToken: "session-token",
    // baseDelayMs 0 keeps the suite fast; maxRetries stays at 3 because the
    // whole point is that a repeatable call really does repeat.
    retry: { maxRetries: MAX_RETRIES, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    fetch: recorder.fetch,
  });
}

/** The transport is `@internal`; these cases drive it the way the APIs do. */
function send(client: PlatosClient, path: string, init: RequestInit): Promise<unknown> {
  return (client as unknown as { _fetch: (p: string, i: RequestInit) => Promise<unknown> })._fetch(
    path,
    init,
  );
}

describe("the legacy transport's retry guard", () => {
  it("NON-VACUITY: an idempotent GET really is retried to the configured limit", async () => {
    const recorder = alwaysFails("status");
    await expect(send(clientOver(recorder), "/api/v1/agent/agents", {})).rejects.toBeInstanceOf(
      PlatosServerError,
    );
    // 1 first try + 3 retries. Without this every "exactly one call" below would
    // be satisfied by a client that had simply stopped retrying.
    expect(recorder.calls).toHaveLength(MAX_RETRIES + 1);
  });

  it("a POST with NO idempotency key is sent exactly once, on a 503", async () => {
    const recorder = alwaysFails("status");
    await expect(
      send(clientOver(recorder), "/api/v1/agent/anything", {
        method: "POST",
        body: JSON.stringify({ some: "effect" }),
      }),
    ).rejects.toBeInstanceOf(PlatosServerError);
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]!.method).toBe("POST");
  });

  it("a POST with NO idempotency key is sent exactly once on a NETWORK error, which is the dangerous one", async () => {
    // The request may have been delivered and only the response lost, so this is
    // the case where a retry actually doubles the effect rather than merely
    // risking it.
    const recorder = alwaysFails("network");
    await expect(
      send(clientOver(recorder), "/api/v1/agent/anything", {
        method: "POST",
        body: JSON.stringify({ some: "effect" }),
      }),
    ).rejects.toBeInstanceOf(PlatosNetworkError);
    expect(recorder.calls).toHaveLength(1);
  });

  it("PATCH is refused a retry too — RFC 9110 §9.2.2 excludes it as well as POST", async () => {
    const recorder = alwaysFails("status");
    await expect(
      send(clientOver(recorder), "/api/v1/agent/anything", { method: "PATCH", body: "{}" }),
    ).rejects.toBeInstanceOf(PlatosServerError);
    expect(recorder.calls).toHaveLength(1);
  });

  it("a POST that CARRIES an idempotency key is retried — the guard is the key, not the verb", async () => {
    // If the rule were "POST never retries" this case would fail, and the SDK
    // would have no way to recover a mint whose response was lost. The header is
    // what makes the server replay its first answer instead of acting again.
    const recorder = failsOnceThenSucceeds();
    await expect(
      send(clientOver(recorder), "/api/v1/agent/anything", {
        method: "POST",
        body: JSON.stringify({ some: "effect" }),
        headers: { [IDEMPOTENCY_KEY_HEADER]: "01JD-stable-key" },
      }),
    ).resolves.toEqual({ ok: true });
    expect(recorder.calls).toHaveLength(2);
    // AND THE SECOND TRY CARRIES THE SAME KEY. A retry that minted a fresh key
    // would be the double-charge with extra steps.
    expect(recorder.calls[0]!.headers[IDEMPOTENCY_KEY_HEADER]).toBe("01JD-stable-key");
    expect(recorder.calls[1]!.headers[IDEMPOTENCY_KEY_HEADER]).toBe("01JD-stable-key");
  });

  it("the key is honoured whatever the caller's capitalisation, because HTTP field names are case-insensitive", async () => {
    const recorder = failsOnceThenSucceeds();
    await expect(
      send(clientOver(recorder), "/api/v1/agent/anything", {
        method: "POST",
        body: "{}",
        headers: { "Idempotency-Key": "01JD-stable-key" },
      }),
    ).resolves.toEqual({ ok: true });
    expect(recorder.calls).toHaveLength(2);
  });

  it("an EMPTY key is not a key", async () => {
    // A caller that sends the header with nothing in it has no replay handle on
    // the server, so treating its presence as permission would be worse than
    // having no rule: it would look guarded and behave unguarded.
    const recorder = alwaysFails("status");
    await expect(
      send(clientOver(recorder), "/api/v1/agent/anything", {
        method: "POST",
        body: "{}",
        headers: { [IDEMPOTENCY_KEY_HEADER]: "   " },
      }),
    ).rejects.toBeInstanceOf(PlatosServerError);
    expect(recorder.calls).toHaveLength(1);
  });

  it("DELETE and PUT keep their retries — the standard calls them idempotent", async () => {
    for (const method of ["DELETE", "PUT"]) {
      const recorder = alwaysFails("status");
      await expect(
        send(clientOver(recorder), "/api/v1/agent/anything", { method }),
      ).rejects.toBeInstanceOf(PlatosServerError);
      expect(recorder.calls, `${method} must still be retried`).toHaveLength(MAX_RETRIES + 1);
    }
  });

  it("EVERY mutating call the shipped namespaces make is either idempotent or unretried", async () => {
    // THE JOIN TO THE REST OF THE PACKAGE. The cases above prove the rule on
    // synthetic requests; this one drives the real namespaces and asserts that
    // none of them gets a second attempt it has not earned. It is not the guard —
    // it is the check that no namespace bypasses `_fetch` and reintroduces the
    // defect underneath it.
    const cases: Array<{ label: string; run: (client: PlatosClient) => Promise<unknown> }> = [
      { label: "threads.create", run: (c) => c.threads.create({ agentId: "a" }) },
      { label: "threads.delete", run: (c) => c.threads.delete("t") },
      { label: "messages.rate", run: (c) => c.messages.rate("m", 1) },
      { label: "messages.unrate", run: (c) => c.messages.unrate("m") },
      { label: "jobs.create", run: (c) => c.jobs.create({ name: "j", handler: "h" } as never) },
      { label: "jobs.dispatch", run: (c) => c.jobs.dispatch("j", {}) },
      { label: "tools.setEnabled", run: (c) => c.tools.setEnabled("e", "t", true) },
    ];
    for (const { label, run } of cases) {
      const recorder = alwaysFails("status");
      const client = clientOver(recorder);
      await run(client).catch(() => undefined);
      expect(recorder.calls.length, `${label} was asked more than once`).toBeGreaterThan(0);
      const method = recorder.calls[0]!.method.toUpperCase();
      const key = recorder.calls[0]!.headers[IDEMPOTENCY_KEY_HEADER];
      const repeatable = ["GET", "HEAD", "PUT", "DELETE", "OPTIONS"].includes(method) || Boolean(key);
      expect(
        recorder.calls.length,
        `${label} (${method}) was retried ${recorder.calls.length} times with no idempotency key`,
      ).toBe(repeatable ? MAX_RETRIES + 1 : 1);
    }
  });
});
