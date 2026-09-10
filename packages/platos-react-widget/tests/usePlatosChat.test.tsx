// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
  create: vi.fn(),
  send: vi.fn(),
  rate: vi.fn(),
  unrate: vi.fn(),
}));

// THE ERROR HELPERS ARE THE REAL ONES. Only `PlatosClient` is a double: a mock
// factory that replaced the whole module would also replace `readWireError` and
// `PlatosRefusal` with `undefined`, and the refusal cases below would then be
// asserting against a stub of the very thing they exist to check.
vi.mock("@platosdev/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@platosdev/client")>()),
  PlatosClient: class {
    threads = { create: clientMocks.create, send: clientMocks.send };
    messages = { rate: clientMocks.rate, unrate: clientMocks.unrate };
  },
}));

import { usePlatosChat } from "../src/usePlatosChat.js";

describe("usePlatosChat host contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientMocks.create.mockResolvedValue({ id: "thread_1" });
    clientMocks.send.mockImplementation(async function* () {
      yield { type: "token", text: "Hello " };
      yield { type: "token", text: "world" };
      yield { type: "message_persisted", messageId: "message_server_1" };
      yield { type: "done" };
    });
  });

  it("renders ordered chunks and rates only the persisted server message id", async () => {
    const { result } = renderHook(() => usePlatosChat({
      baseUrl: "https://platos.example.com",
      agentId: "agent_1",
      sessionToken: "token",
    }));

    await act(async () => result.current.send("Hi"));
    const assistant = result.current.messages.find(({ role }) => role === "assistant")!;
    expect(assistant).toMatchObject({
      content: "Hello world",
      streaming: false,
      serverId: "message_server_1",
    });

    await act(async () => {
      expect(await result.current.rate(assistant.id, "up")).toBe(true);
    });
    expect(clientMocks.rate).toHaveBeenCalledWith("message_server_1", "up");
    expect(clientMocks.rate).not.toHaveBeenCalledWith(assistant.id, expect.anything());
  });

  it("does not accept a browser-provided session context override", async () => {
    const { result } = renderHook(() => usePlatosChat({
      baseUrl: "https://platos.example.com",
      agentId: "agent_1",
      sessionToken: "token",
      perTurn: {
        dynamicBlocks: { locale: "en" },
        ...({ sessionContextOverride: { entity_ids: ["entity_1"] } } as object),
      },
    }));

    await act(async () => result.current.send("Hi"));
    expect(clientMocks.send).toHaveBeenCalledWith(
      "thread_1",
      "Hi",
      expect.not.objectContaining({ sessionContextOverride: expect.anything() }),
    );
  });
});


// ---------------------------------------------------------------------------
// WIN-270 (M4.4) — THE WIDGET IS PUBLIC SURFACE, AND ITS ONE UNAUTHENTICATED
// CALL MUST REFUSE WITH A CODE.
//
// `tokenUrl` is the only request this hook makes before it holds a credential.
// Every case here drives it to a refusal and asserts two things: the code
// reached the caller, and the hook produced NO partial answer — no client, no
// thread, no message. A widget that answered an empty transcript to a visitor it
// had been told to reject would be indistinguishable from a working widget with
// nothing to say.
// ---------------------------------------------------------------------------

import { PlatosRefusal } from "@platosdev/client";

function respond(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

describe("usePlatosChat refuses without a partial answer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  const envelope = {
    error: {
      code: "UNAUTHENTICATED",
      title: "Sign in to continue.",
      body: "This visitor holds no session.",
      errorId: "err_widget_1",
      traceRef: "trace_widget_1",
      version: "1",
    },
  };

  it("carries the V1 error code off a refused token mint", async () => {
    respond(401, envelope);
    const seen: Error[] = [];
    const { result } = renderHook(() =>
      usePlatosChat({
        baseUrl: "https://platos.example.com",
        agentId: "agent_1",
        tokenUrl: "/api/platos-session",
        onError: (error) => seen.push(error),
      }),
    );
    await act(async () => {
      await result.current.send("hello");
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBeInstanceOf(PlatosRefusal);
    expect((result.current.error as PlatosRefusal).code).toBe("UNAUTHENTICATED");
    expect((result.current.error as PlatosRefusal).refusal?.traceRef).toBe("trace_widget_1");
    expect(seen).toHaveLength(1);
    // NO PARTIAL ANSWER: no thread was opened and no assistant bubble exists.
    expect(result.current.threadId).toBeNull();
    expect(clientMocks.create).not.toHaveBeenCalled();
    expect(clientMocks.send).not.toHaveBeenCalled();
    expect(result.current.messages.filter((message) => message.role === "assistant")).toEqual([]);
  });

  it("says plainly that a non-envelope refusal carried no code", async () => {
    respond(503, "gateway is down");
    const { result } = renderHook(() =>
      usePlatosChat({
        baseUrl: "https://platos.example.com",
        agentId: "agent_1",
        tokenUrl: "/api/platos-session",
      }),
    );
    await act(async () => {
      await result.current.send("hello");
    });
    expect(result.current.status).toBe("error");
    expect((result.current.error as PlatosRefusal).code).toBeUndefined();
    expect(result.current.error?.message).toMatch(/no error code/u);
    expect(clientMocks.create).not.toHaveBeenCalled();
  });

  it("treats a 200 with no token as a refusal rather than a session", async () => {
    respond(200, { notAToken: true });
    const { result } = renderHook(() =>
      usePlatosChat({
        baseUrl: "https://platos.example.com",
        agentId: "agent_1",
        tokenUrl: "/api/platos-session",
      }),
    );
    await act(async () => {
      await result.current.send("hello");
    });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBeInstanceOf(PlatosRefusal);
    expect(result.current.error?.message).toMatch(/no \{ token \}/u);
    expect(clientMocks.create).not.toHaveBeenCalled();
  });
});
