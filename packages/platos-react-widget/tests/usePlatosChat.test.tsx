// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
  create: vi.fn(),
  send: vi.fn(),
  rate: vi.fn(),
  unrate: vi.fn(),
}));

vi.mock("@platosdev/client", () => ({
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

  it("forwards every per-Turn context option", async () => {
    const override = { entity_ids: ["entity_1"] };
    const { result } = renderHook(() => usePlatosChat({
      baseUrl: "https://platos.example.com",
      agentId: "agent_1",
      sessionToken: "token",
      perTurn: { sessionContextOverride: override },
    }));

    await act(async () => result.current.send("Hi"));
    expect(clientMocks.send).toHaveBeenCalledWith(
      "thread_1",
      "Hi",
      expect.objectContaining({ sessionContextOverride: override }),
    );
  });
});
