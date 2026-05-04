/**
 * Per-call context (Theme C) tests — TypeScript side.
 *
 * Verifies the three Theme C invariants on the TS SDK:
 *
 *   1. `__platos` is stripped from the Zod-parsed params before the
 *      handler runs — handlers never see the envelope in their input.
 *   2. `currentContext()` / `currentUserId()` etc. return the
 *      envelope's values while the handler is executing.
 *   3. `AsyncLocalStorage` is scope-local to a single call so two
 *      concurrent `runWithContext` frames do not leak into each
 *      other, and after the handler settles the context is cleared.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  buildPlatosContext,
  currentAgentId,
  currentCallId,
  currentContext,
  currentEntityId,
  currentScope,
  currentThreadId,
  currentUserId,
  currentUserToken,
  envelopeToContext,
  runWithContext,
  type PlatosCallContext,
  type PlatosContext,
} from "../src/context.js";
import { makeToolFactory } from "../src/core/decorator.js";
import { ToolRegistry } from "../src/core/registry.js";
import { PlatoolsClient, type WsFactory, type WsLike } from "../src/transport/client.js";

const ENVELOPE: PlatosCallContext = {
  organizationId: "org_123",
  projectId: "proj_abc",
  environmentId: "env_dev",
  entityId: "ent_main",
  userId: "user_42",
  userToken: "tok_secret",
  agentId: "agent_orders",
  threadId: "thr_xyz",
  callId: "call_001",
  timestamp: "2026-04-17T12:00:00Z",
  signature: "abc123",
};

// ───────────────────────────────────────────────────────────
// Direct AsyncLocalStorage plumbing
// ───────────────────────────────────────────────────────────

describe("currentContext() accessors", () => {
  it("returns undefined / empty outside any call", () => {
    expect(currentContext()).toBeUndefined();
    expect(currentUserId()).toBeUndefined();
    expect(currentUserToken()).toBeUndefined();
    expect(currentThreadId()).toBeUndefined();
    expect(currentAgentId()).toBeUndefined();
    expect(currentEntityId()).toBeUndefined();
    expect(currentCallId()).toBeUndefined();
    expect(currentScope()).toEqual({});
  });

  it("exposes the full envelope while runWithContext is active", async () => {
    const observed = await runWithContext(ENVELOPE, async () => {
      return {
        ctx: currentContext(),
        userId: currentUserId(),
        userToken: currentUserToken(),
        threadId: currentThreadId(),
        agentId: currentAgentId(),
        entityId: currentEntityId(),
        callId: currentCallId(),
        scope: currentScope(),
      };
    });
    expect(observed.ctx).toEqual(ENVELOPE);
    expect(observed.userId).toBe("user_42");
    expect(observed.userToken).toBe("tok_secret");
    expect(observed.threadId).toBe("thr_xyz");
    expect(observed.agentId).toBe("agent_orders");
    expect(observed.entityId).toBe("ent_main");
    expect(observed.callId).toBe("call_001");
    expect(observed.scope).toEqual({
      organizationId: "org_123",
      projectId: "proj_abc",
      environmentId: "env_dev",
    });
  });

  it("clears context after runWithContext settles", async () => {
    await runWithContext(ENVELOPE, async () => {
      expect(currentUserId()).toBe("user_42");
    });
    expect(currentUserId()).toBeUndefined();
    expect(currentContext()).toBeUndefined();
  });

  it("clears context after runWithContext throws", async () => {
    await expect(
      runWithContext(ENVELOPE, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(currentUserId()).toBeUndefined();
  });

  it("concurrent runWithContext frames do not leak into each other", async () => {
    const alpha: PlatosCallContext = { ...ENVELOPE, userId: "user_A", callId: "call_A" };
    const beta: PlatosCallContext = { ...ENVELOPE, userId: "user_B", callId: "call_B" };
    const observations: Array<{ tag: "alpha" | "beta"; user?: string; call?: string }> = [];
    const run = async (tag: "alpha" | "beta", env: PlatosCallContext): Promise<void> => {
      await runWithContext(env, async () => {
        // Two yields so the event loop definitely interleaves the
        // two coroutines.
        await Promise.resolve();
        observations.push({ tag, user: currentUserId(), call: currentCallId() });
        await Promise.resolve();
        observations.push({ tag, user: currentUserId(), call: currentCallId() });
      });
    };
    await Promise.all([run("alpha", alpha), run("beta", beta)]);

    // Every observation must be internally consistent.
    for (const o of observations) {
      if (o.tag === "alpha") {
        expect(o.user).toBe("user_A");
        expect(o.call).toBe("call_A");
      } else {
        expect(o.user).toBe("user_B");
        expect(o.call).toBe("call_B");
      }
    }
    expect(currentUserId()).toBeUndefined();
  });
});

describe("envelopeToContext", () => {
  it("coerces a well-formed envelope into the typed shape", () => {
    const ctx = envelopeToContext({ ...ENVELOPE });
    expect(ctx).not.toBeNull();
    expect(ctx).toEqual(ENVELOPE);
  });

  it("returns null when a required field is missing (strict — PPR-29)", () => {
    // Python's current_context() already behaved this way. TS now matches:
    // any missing required field → null, no empty-string coercion, no
    // callId fallback. Consumers get the typed shape or nothing.
    const { callId: _omitCall, ...noCall } = ENVELOPE;
    void _omitCall;
    expect(envelopeToContext(noCall)).toBeNull();

    const { organizationId: _omitOrg, ...noOrg } = ENVELOPE;
    void _omitOrg;
    expect(envelopeToContext(noOrg)).toBeNull();

    const { signature: _omitSig, ...noSig } = ENVELOPE;
    void _omitSig;
    expect(envelopeToContext(noSig)).toBeNull();
  });

  it("returns null when a required field is non-string", () => {
    expect(envelopeToContext({ ...ENVELOPE, callId: 123 })).toBeNull();
    expect(envelopeToContext({ ...ENVELOPE, userId: null })).toBeNull();
  });

  it("omits userToken when the envelope has none (userToken is optional)", () => {
    const { userToken: _omit, ...rest } = ENVELOPE;
    void _omit;
    const ctx = envelopeToContext(rest);
    expect(ctx).not.toBeNull();
    expect(ctx!.userToken).toBeUndefined();
  });

  it("returns null for a non-object envelope", () => {
    expect(envelopeToContext(undefined)).toBeNull();
    expect(envelopeToContext(null)).toBeNull();
    expect(envelopeToContext("a string")).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
// Transport-level dispatch (pops envelope + sets context)
// ───────────────────────────────────────────────────────────

type WsEvent = "open" | "close" | "error" | "message";

class FakeWebSocket {
  public readonly sent: string[] = [];
  public closed = false;
  private readonly listeners: {
    open: Array<() => void>;
    close: Array<(code: number, reason: Buffer) => void>;
    error: Array<(err: Error) => void>;
    message: Array<(data: unknown) => void>;
  } = { open: [], close: [], error: [], message: [] };

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const l of [...this.listeners.close]) l(1000, Buffer.from(""));
  }

  public on(event: "message", listener: (data: unknown) => void): void;
  public on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  public on(event: "error", listener: (err: Error) => void): void;
  public on(event: "open", listener: () => void): void;
  public on(event: WsEvent, listener: unknown): void {
    switch (event) {
      case "open":
        this.listeners.open.push(listener as () => void);
        return;
      case "close":
        this.listeners.close.push(listener as (code: number, reason: Buffer) => void);
        return;
      case "error":
        this.listeners.error.push(listener as (err: Error) => void);
        return;
      case "message":
        this.listeners.message.push(listener as (data: unknown) => void);
        return;
    }
  }

  public deliverMessage(payload: string): void {
    for (const l of [...this.listeners.message]) l(payload);
  }

  public open(): void {
    for (const l of [...this.listeners.open]) l();
  }

  public asWs(): WsLike {
    return this as unknown as WsLike;
  }
}

function buildRegistryWith<Input extends z.ZodTypeAny>(
  options: { name: string; input: Input },
  handler: (params: z.infer<Input>) => unknown | Promise<unknown>,
): ToolRegistry {
  const registry = new ToolRegistry();
  const tool = makeToolFactory(registry);
  tool({ name: options.name, description: "-", input: options.input }, async (params) => handler(params));
  return registry;
}

describe("transport pops __platos before the handler", () => {
  it("handler receives only the non-envelope params and reads context", async () => {
    const seen = { params: undefined as unknown, user: undefined as string | undefined };
    const registry = buildRegistryWith(
      { name: "process", input: z.object({ orderId: z.string() }) },
      async (params) => {
        seen.params = params;
        seen.user = currentUserId();
        return { ok: true, user: currentUserId() };
      },
    );

    let createdSocket: FakeWebSocket | null = null;
    const wsFactory: WsFactory = (url, headers) => {
      createdSocket = new FakeWebSocket();
      void url;
      void headers;
      return createdSocket.asWs();
    };

    const client = new PlatoolsClient({
      url: "http://test",
      secret: "s",
      registry,
      wsFactory,
      logger: { warn(): void {}, info(): void {}, error(): void {} },
    });
    const sessionPromise = client.runSession();

    // Socket was created synchronously by the factory.
    expect(createdSocket).not.toBeNull();
    const socket = createdSocket as unknown as FakeWebSocket;
    socket.open();

    socket.deliverMessage(
      JSON.stringify({
        type: "tool_call",
        call_id: "call_001",
        tool_name: "process",
        params: { orderId: "ord_9", __platos: ENVELOPE },
      }),
    );
    // Flush microtasks.
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    // Handler saw only `orderId` — no `__platos` leaked in.
    expect(seen.params).toEqual({ orderId: "ord_9" });
    expect(seen.user).toBe("user_42");

    // Wire reply is a tool_result whose body carries what the handler returned.
    expect(socket.sent.length).toBeGreaterThanOrEqual(2);
    const wireResult = JSON.parse(socket.sent[socket.sent.length - 1]!) as {
      type: string;
      result: { ok: boolean; user: string };
    };
    expect(wireResult.type).toBe("tool_result");
    expect(wireResult.result.user).toBe("user_42");

    // Context is cleared after the handler returned.
    expect(currentUserId()).toBeUndefined();

    socket.close();
    await sessionPromise;
  });

  it("handler without an envelope still runs; every context accessor returns undefined (PPR-29/30)", async () => {
    let observed: { call?: string; user?: string } = {};
    const registry = buildRegistryWith(
      { name: "ping", input: z.object({ v: z.number() }) },
      async () => {
        observed = { call: currentCallId(), user: currentUserId() };
        return { ok: true };
      },
    );

    let createdSocket: FakeWebSocket | null = null;
    const wsFactory: WsFactory = () => {
      createdSocket = new FakeWebSocket();
      return createdSocket.asWs();
    };
    const client = new PlatoolsClient({
      url: "http://test",
      secret: "s",
      registry,
      wsFactory,
      logger: { warn(): void {}, info(): void {}, error(): void {} },
    });
    const sessionPromise = client.runSession();
    const socket = createdSocket as unknown as FakeWebSocket;
    socket.open();
    socket.deliverMessage(
      JSON.stringify({
        type: "tool_call",
        call_id: "outer_call",
        tool_name: "ping",
        params: { v: 1 },
      }),
    );
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    // When the envelope is missing we don't open an ALS frame, so
    // every accessor returns undefined — including callId. This
    // matches the documented "outside a tool dispatch" behavior.
    expect(observed.call).toBeUndefined();
    expect(observed.user).toBeUndefined();
    const last = JSON.parse(socket.sent[socket.sent.length - 1]!) as { type: string };
    expect(last.type).toBe("tool_result");

    socket.close();
    await sessionPromise;
  });

  it("does not leak context across two dispatches on the same socket", async () => {
    const observations: Array<{ user?: string; call?: string }> = [];
    const registry = buildRegistryWith(
      { name: "peek", input: z.object({ n: z.number() }) },
      async () => {
        observations.push({ user: currentUserId(), call: currentCallId() });
        return {};
      },
    );

    let createdSocket: FakeWebSocket | null = null;
    const wsFactory: WsFactory = () => {
      createdSocket = new FakeWebSocket();
      return createdSocket.asWs();
    };
    const client = new PlatoolsClient({
      url: "http://test",
      secret: "s",
      registry,
      wsFactory,
      logger: { warn(): void {}, info(): void {}, error(): void {} },
    });
    const sessionPromise = client.runSession();
    const socket = createdSocket as unknown as FakeWebSocket;
    socket.open();

    socket.deliverMessage(
      JSON.stringify({
        type: "tool_call",
        call_id: "a",
        tool_name: "peek",
        params: { n: 1, __platos: { ...ENVELOPE, userId: "user_A", callId: "a" } },
      }),
    );
    socket.deliverMessage(
      JSON.stringify({
        type: "tool_call",
        call_id: "b",
        tool_name: "peek",
        params: { n: 2, __platos: { ...ENVELOPE, userId: "user_B", callId: "b" } },
      }),
    );
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    // Two dispatches, two distinct observations.
    expect(observations).toHaveLength(2);
    const byUser = Object.fromEntries(observations.map((o) => [o.user ?? "?", o.call ?? "?"]));
    expect(byUser["user_A"]).toBe("a");
    expect(byUser["user_B"]).toBe("b");
    // After everything: clean slate.
    expect(currentUserId()).toBeUndefined();

    socket.close();
    await sessionPromise;
  });
});

// ───────────────────────────────────────────────────────────
// CTX.5 — unpacked `_context` envelope passed as handler ctx arg
// ───────────────────────────────────────────────────────────

describe("buildPlatosContext", () => {
  it("copies the envelope into a frozen `context` map", () => {
    const ctx = buildPlatosContext("call_x", { "user.id": "u1", "tenant.id": "t1" });
    expect(ctx.callId).toBe("call_x");
    expect(ctx.context["user.id"]).toBe("u1");
    expect(ctx.context["tenant.id"]).toBe("t1");
    expect(Object.isFrozen(ctx.context)).toBe(true);
  });

  it("extracts entityIds from `entity_ids` (server default)", () => {
    const ctx = buildPlatosContext("c", { "user.id": "u1", entity_ids: ["ent_a", "ent_b"] });
    expect(ctx.entityIds).toEqual(["ent_a", "ent_b"]);
  });

  it("extracts entityIds from the camelCase `entityIds` alias", () => {
    const ctx = buildPlatosContext("c", { entityIds: ["ent_only"] });
    expect(ctx.entityIds).toEqual(["ent_only"]);
  });

  it("leaves entityIds undefined when absent / non-array / non-string", () => {
    expect(buildPlatosContext("c", {}).entityIds).toBeUndefined();
    expect(buildPlatosContext("c", { entity_ids: "ent_a" }).entityIds).toBeUndefined();
    expect(buildPlatosContext("c", { entity_ids: [1, 2, 3] }).entityIds).toBeUndefined();
  });

  it("tolerates a non-object envelope (empty context, raw preserved)", () => {
    const ctx = buildPlatosContext("c", undefined);
    expect(ctx.context).toEqual({});
    expect(ctx.entityIds).toBeUndefined();
    expect(ctx.raw).toBeUndefined();
  });

  it("preserves the original envelope under `raw` (escape hatch)", () => {
    const envelope = { "user.id": "u", nested: { anything: true } };
    const ctx = buildPlatosContext("c", envelope);
    expect(ctx.raw).toBe(envelope);
  });
});

describe("transport pops _context and passes ctx to handler (CTX.5)", () => {
  it("handler receives clean params + a PlatosContext as second arg", async () => {
    const seen: { params?: unknown; ctx?: PlatosContext } = {};
    const registry = buildRegistryWith(
      { name: "scheduled", input: z.object({ dayOfWeek: z.string() }) },
      async () => {
        // handler body populates seen from the outer closure below
        return { ok: true };
      },
    );
    // Re-register with a two-arg handler that captures ctx.
    const twoArgRegistry = new ToolRegistry();
    const tool = (await import("../src/core/decorator.js")).makeToolFactory(twoArgRegistry);
    tool(
      {
        name: "scheduled",
        description: "-",
        input: z.object({ dayOfWeek: z.string() }),
      },
      async (params, ctx) => {
        seen.params = params;
        seen.ctx = ctx;
        return { ok: true };
      },
    );
    void registry;

    let createdSocket: FakeWebSocket | null = null;
    const wsFactory: WsFactory = () => {
      createdSocket = new FakeWebSocket();
      return createdSocket.asWs();
    };
    const client = new PlatoolsClient({
      url: "http://test",
      secret: "s",
      registry: twoArgRegistry,
      wsFactory,
      logger: { warn(): void {}, info(): void {}, error(): void {} },
    });
    const sessionPromise = client.runSession();
    const socket = createdSocket as unknown as FakeWebSocket;
    socket.open();

    socket.deliverMessage(
      JSON.stringify({
        type: "tool_call",
        call_id: "call_ctx_5",
        tool_name: "scheduled",
        params: {
          dayOfWeek: "monday",
          _context: {
            "user.id": "u_42",
            "tenant.id": "tnt_7",
            entity_ids: ["ent_main", "ent_alt"],
          },
          __platos: ENVELOPE,
        },
      }),
    );
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    // Handler saw ONLY `dayOfWeek` — `_context` AND `__platos` were stripped.
    expect(seen.params).toEqual({ dayOfWeek: "monday" });

    // ctx.context carries the unpacked `_context` envelope.
    expect(seen.ctx).toBeDefined();
    expect(seen.ctx!.callId).toBe("call_ctx_5");
    expect(seen.ctx!.context["user.id"]).toBe("u_42");
    expect(seen.ctx!.context["tenant.id"]).toBe("tnt_7");
    // entityIds heuristically extracted from `entity_ids`.
    expect(seen.ctx!.entityIds).toEqual(["ent_main", "ent_alt"]);
    // raw preserved for escape-hatch consumers.
    expect(seen.ctx!.raw).toEqual({
      "user.id": "u_42",
      "tenant.id": "tnt_7",
      entity_ids: ["ent_main", "ent_alt"],
    });

    socket.close();
    await sessionPromise;
  });

  it("handler that only accepts (params) keeps working (backwards compat)", async () => {
    const observed: { params?: unknown } = {};
    const registry = new ToolRegistry();
    const tool = (await import("../src/core/decorator.js")).makeToolFactory(registry);
    // Single-arg handler — existing consumer code shape.
    tool(
      {
        name: "legacy",
        description: "-",
        input: z.object({ value: z.number() }),
      },
      async (params) => {
        observed.params = params;
        return { ok: true };
      },
    );

    let createdSocket: FakeWebSocket | null = null;
    const wsFactory: WsFactory = () => {
      createdSocket = new FakeWebSocket();
      return createdSocket.asWs();
    };
    const client = new PlatoolsClient({
      url: "http://test",
      secret: "s",
      registry,
      wsFactory,
      logger: { warn(): void {}, info(): void {}, error(): void {} },
    });
    const sessionPromise = client.runSession();
    const socket = createdSocket as unknown as FakeWebSocket;
    socket.open();

    socket.deliverMessage(
      JSON.stringify({
        type: "tool_call",
        call_id: "call_legacy",
        tool_name: "legacy",
        params: { value: 7, _context: { "user.id": "u" } },
      }),
    );
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    // Handler ran, saw clean params (no `_context` leak), and the
    // wire reply is a tool_result.
    expect(observed.params).toEqual({ value: 7 });
    const last = JSON.parse(socket.sent[socket.sent.length - 1]!) as { type: string };
    expect(last.type).toBe("tool_result");

    socket.close();
    await sessionPromise;
  });
});
