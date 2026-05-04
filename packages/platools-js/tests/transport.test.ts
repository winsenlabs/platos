/**
 * Transport tests — heartbeat cadence, reconnect flow, dispatch.
 *
 * The `PlatoolsClient` is built against abstract `WsLike` / `Sleeper`
 * interfaces so this test suite can inject deterministic fakes: no
 * real sockets, no real timers. PRD §5.2 heartbeat = 30s is asserted
 * via the cadence test below and `backoff.test.ts` covers the
 * reconnect curve.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ToolRegistry } from "../src/core/registry.js";
import { makeToolFactory } from "../src/core/decorator.js";
import {
  HEARTBEAT_INTERVAL_MS,
  PlatoolsClient,
  type ClientLogger,
  type Sleeper,
  type WsFactory,
  type WsLike,
} from "../src/transport/client.js";
import {
  decodePlatformMessage,
  type ToolCallMessage,
  type ToolRegisterMessage,
} from "../src/transport/protocol.js";

// ---- fakes ---------------------------------------------------------------

type WsEvent = "open" | "close" | "error" | "message";

// FakeWebSocket implements the `WsLike` surface with loose-typed
// listeners so tests can drive open/close/message/error synchronously.
// The implementation is typed via an untyped internal store; the
// public `on` method carries the same overload set as `WsLike` so
// assignment compatibility with `WsLike` holds.
class FakeWebSocket {
  public readonly sent: string[] = [];
  public closed = false;
  public readonly url: string;
  public readonly headers: Record<string, string>;
  private readonly listeners: {
    open: Array<() => void>;
    close: Array<(code: number, reason: Buffer) => void>;
    error: Array<(err: Error) => void>;
    message: Array<(data: unknown) => void>;
  } = {
    open: [],
    close: [],
    error: [],
    message: [],
  };

  public constructor(url: string, headers: Record<string, string>) {
    this.url = url;
    this.headers = headers;
  }

  public send(data: string): void {
    if (this.closed) {
      throw new Error("FakeWebSocket.send() after close");
    }
    this.sent.push(data);
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of [...this.listeners.close]) {
      listener(1000, Buffer.from(""));
    }
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
    for (const listener of [...this.listeners.message]) listener(payload);
  }

  public open(): void {
    for (const listener of [...this.listeners.open]) listener();
  }

  public fireError(err: Error): void {
    for (const listener of [...this.listeners.error]) listener(err);
  }

  /** Narrow the fake to the `WsLike` interface the client expects. */
  public asWs(): WsLike {
    return this as unknown as WsLike;
  }
}

class SilentLogger implements ClientLogger {
  public warn(): void {}
  public info(): void {}
  public error(): void {}
}

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const tool = makeToolFactory(registry);
  tool(
    {
      name: "echo",
      description: "Echo the input back",
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
    },
    async ({ value }) => ({ value }),
  );
  return registry;
}

// ---- tests ---------------------------------------------------------------

describe("PlatoolsClient.websocketUrl", () => {
  it("converts http:// → ws:// and appends /ws/sdk", () => {
    const client = new PlatoolsClient({
      url: "http://platform.platos.dev/",
      secret: "s",
      registry: new ToolRegistry(),
    });
    expect(client.websocketUrl()).toBe("ws://platform.platos.dev/ws/sdk");
  });

  it("converts https:// → wss:// and strips trailing slashes", () => {
    const client = new PlatoolsClient({
      url: "https://platform.platos.dev///",
      secret: "s",
      registry: new ToolRegistry(),
    });
    expect(client.websocketUrl()).toBe("wss://platform.platos.dev/ws/sdk");
  });

  it("leaves ws:// / wss:// unchanged", () => {
    const client = new PlatoolsClient({
      url: "ws://host:9000",
      secret: "s",
      registry: new ToolRegistry(),
    });
    expect(client.websocketUrl()).toBe("ws://host:9000/ws/sdk");
  });
});

describe("PlatoolsClient session dispatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends registration on open, dispatches a tool call, and returns a result", async () => {
    const registry = buildRegistry();
    let createdSocket: FakeWebSocket | null = null;
    const wsFactory: WsFactory = (url, headers) => {
      createdSocket = new FakeWebSocket(url, headers);
      return createdSocket.asWs();
    };
    const client = new PlatoolsClient({
      url: "http://platform.test",
      secret: "tok",
      registry,
      wsFactory,
      logger: new SilentLogger(),
    });

    const sessionPromise = client.runSession();

    // Drive the open event synchronously.
    expect(createdSocket).not.toBeNull();
    const socket = createdSocket as unknown as FakeWebSocket;
    socket.open();

    // Registration message should be first on the wire.
    expect(socket.sent.length).toBe(1);
    const register = JSON.parse(socket.sent[0]!) as ToolRegisterMessage;
    expect(register.type).toBe("tool_register");
    expect(register.tools).toHaveLength(1);
    expect(register.tools[0]!.name).toBe("echo");

    // Platform auth header present.
    expect(socket.headers["Authorization"]).toBe("Bearer tok");

    // Deliver a tool_call; the client should reply with a tool_result.
    const call: ToolCallMessage = {
      type: "tool_call",
      call_id: "abc",
      tool_name: "echo",
      params: { value: "hi" },
    };
    socket.deliverMessage(JSON.stringify(call));

    // Let microtasks flush.
    await vi.advanceTimersByTimeAsync(0);

    expect(socket.sent.length).toBeGreaterThanOrEqual(2);
    const result = JSON.parse(socket.sent[socket.sent.length - 1]!) as {
      type: string;
      call_id: string;
      result: { value: string };
    };
    expect(result.type).toBe("tool_result");
    expect(result.call_id).toBe("abc");
    expect(result.result).toEqual({ value: "hi" });

    // Close the socket and wait for session to resolve.
    socket.close();
    await sessionPromise;
  });

  it("sends a heartbeat every HEARTBEAT_INTERVAL_MS", async () => {
    const registry = buildRegistry();
    let createdSocket: FakeWebSocket | null = null;
    const wsFactory: WsFactory = (url, headers) => {
      createdSocket = new FakeWebSocket(url, headers);
      return createdSocket.asWs();
    };
    const client = new PlatoolsClient({
      url: "http://platform.test",
      secret: "tok",
      registry,
      wsFactory,
      logger: new SilentLogger(),
    });

    const sessionPromise = client.runSession();
    expect(createdSocket).not.toBeNull();
    const socket = createdSocket as unknown as FakeWebSocket;
    socket.open();

    // After the open, only registration has been sent so far.
    const postRegisterCount = socket.sent.length;
    expect(postRegisterCount).toBe(1);

    // Advance the clock by one heartbeat interval — expect exactly
    // one heartbeat frame on the wire.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(socket.sent.length).toBe(postRegisterCount + 1);
    const hb1 = JSON.parse(socket.sent[socket.sent.length - 1]!) as {
      type: string;
    };
    expect(hb1.type).toBe("heartbeat");

    // Another interval → another heartbeat.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(socket.sent.length).toBe(postRegisterCount + 2);
    const hb2 = JSON.parse(socket.sent[socket.sent.length - 1]!) as {
      type: string;
    };
    expect(hb2.type).toBe("heartbeat");

    // Cleanup.
    socket.close();
    await sessionPromise;
  });

  it("returns a tool_error for unknown tool names", async () => {
    const registry = buildRegistry();
    let createdSocket: FakeWebSocket | null = null;
    const wsFactory: WsFactory = (url, headers) => {
      createdSocket = new FakeWebSocket(url, headers);
      return createdSocket.asWs();
    };
    const client = new PlatoolsClient({
      url: "http://platform.test",
      secret: "tok",
      registry,
      wsFactory,
      logger: new SilentLogger(),
    });

    const sessionPromise = client.runSession();
    const socket = createdSocket as unknown as FakeWebSocket;
    socket.open();

    socket.deliverMessage(
      JSON.stringify({
        type: "tool_call",
        call_id: "missing",
        tool_name: "no_such_tool",
        params: {},
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    const err = JSON.parse(socket.sent[socket.sent.length - 1]!) as {
      type: string;
      error: string;
    };
    expect(err.type).toBe("tool_error");
    expect(err.error).toMatch(/unknown tool/);

    socket.close();
    await sessionPromise;
  });

  it("returns a tool_error when the Zod input fails validation", async () => {
    const registry = buildRegistry();
    let createdSocket: FakeWebSocket | null = null;
    const wsFactory: WsFactory = (url, headers) => {
      createdSocket = new FakeWebSocket(url, headers);
      return createdSocket.asWs();
    };
    const client = new PlatoolsClient({
      url: "http://platform.test",
      secret: "tok",
      registry,
      wsFactory,
      logger: new SilentLogger(),
    });

    const sessionPromise = client.runSession();
    const socket = createdSocket as unknown as FakeWebSocket;
    socket.open();

    socket.deliverMessage(
      JSON.stringify({
        type: "tool_call",
        call_id: "bad",
        tool_name: "echo",
        params: { value: 123 }, // should be string
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    const err = JSON.parse(socket.sent[socket.sent.length - 1]!) as {
      type: string;
    };
    expect(err.type).toBe("tool_error");

    socket.close();
    await sessionPromise;
  });
});

describe("PlatoolsClient reconnect flow", () => {
  it("runs multiple sessions in runForever() with exponential backoff", async () => {
    const registry = buildRegistry();
    const sockets: FakeWebSocket[] = [];
    const wsFactory: WsFactory = (url, headers) => {
      const s = new FakeWebSocket(url, headers);
      sockets.push(s);
      // Defer the open/close until the caller has wired listeners.
      // The session awaits ws events; this scheduler drives them.
      queueMicrotask(() => {
        s.open();
        // Immediately close so the reconnect loop kicks in.
        s.close();
      });
      return s.asWs();
    };

    const sleepDelays: number[] = [];
    const sleeper: Sleeper = async (ms, signal) => {
      sleepDelays.push(ms);
      // Stop the loop after two reconnects so the test finishes.
      if (sleepDelays.length >= 2) {
        const client = clientRef;
        if (client !== null) await client.stop();
      }
      if (signal?.aborted === true) return;
      return;
    };

    let clientRef: PlatoolsClient | null = null;
    const client = new PlatoolsClient({
      url: "http://platform.test",
      secret: "tok",
      registry,
      wsFactory,
      sleeper,
      backoffBaseMs: 50,
      backoffMaxMs: 400,
      logger: new SilentLogger(),
    });
    clientRef = client;

    await client.runForever();

    // At least 2 sockets created: first session, then one+ reconnects
    // before `stop()` breaks the loop.
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    // A clean close counts as a successful session and resets the
    // attempt counter back to 0 — matching the Python SDK's behavior
    // in `PlatoolsClient.run_forever()`. Every reconnect after a
    // clean close therefore uses the base delay (attempt 1).
    expect(sleepDelays[0]).toBe(50);
    expect(sleepDelays[1]).toBe(50);
  });

  it("grows the backoff delay when sessions fail before opening", async () => {
    // Unlike the clean-close case above, a factory that throws
    // synchronously never enters `runSession` so the reconnect loop
    // treats each attempt as a failure and lets the curve climb.
    const sockets: FakeWebSocket[] = [];
    const wsFactory: WsFactory = (url, headers) => {
      const s = new FakeWebSocket(url, headers);
      sockets.push(s);
      // Fire an error asynchronously *before* opening — the client
      // treats this as a session that never succeeded, so `attempt`
      // is not reset between retries.
      queueMicrotask(() => {
        s.fireError(new Error("connection refused"));
      });
      return s.asWs();
    };

    const sleepDelays: number[] = [];
    let clientRef: PlatoolsClient | null = null;
    const sleeper: Sleeper = async (ms) => {
      sleepDelays.push(ms);
      if (sleepDelays.length >= 3 && clientRef !== null) {
        await clientRef.stop();
      }
    };

    const client = new PlatoolsClient({
      url: "http://platform.test",
      secret: "tok",
      registry: new ToolRegistry(),
      wsFactory,
      sleeper,
      backoffBaseMs: 10,
      backoffMaxMs: 1_000,
      logger: new SilentLogger(),
    });
    clientRef = client;

    await client.runForever();

    expect(sleepDelays.length).toBeGreaterThanOrEqual(3);
    expect(sleepDelays[0]).toBe(10); // attempt 1
    expect(sleepDelays[1]).toBe(20); // attempt 2
    expect(sleepDelays[2]).toBe(40); // attempt 3
  });

  it("stop() aborts the reconnect loop cleanly", async () => {
    const registry = new ToolRegistry();
    const wsFactory: WsFactory = (url, headers) => {
      const s = new FakeWebSocket(url, headers);
      queueMicrotask(() => {
        s.open();
        s.close();
      });
      return s.asWs();
    };

    const sleeper: Sleeper = () => new Promise<void>(() => undefined);
    const client = new PlatoolsClient({
      url: "http://platform.test",
      secret: "tok",
      registry,
      wsFactory,
      sleeper,
      logger: new SilentLogger(),
    });

    const runPromise = client.runForever();
    // Let the first session roll.
    await Promise.resolve();
    await client.stop();
    await runPromise;
  });
});

describe("protocol decoder", () => {
  it("returns null for malformed JSON", () => {
    expect(decodePlatformMessage("not json")).toBeNull();
  });
  it("returns null for unknown discriminator", () => {
    expect(decodePlatformMessage(JSON.stringify({ type: "??" }))).toBeNull();
  });
  it("decodes a tool_call", () => {
    const msg = decodePlatformMessage(
      JSON.stringify({
        type: "tool_call",
        call_id: "c1",
        tool_name: "echo",
        params: { v: 1 },
      }),
    );
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("tool_call");
  });
});
