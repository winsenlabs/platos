import { asIdentifier, type RequestScope } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  connectionOwner,
  INBOUND_TURN_JOB_NAME,
  INBOUND_TURN_PAYLOAD_VERSION,
  type ChannelConnectionId,
  type ChannelEventInboxId,
  type ChannelThreadId,
  type ChannelThreadKey,
  type EndUserId,
  type InboundMessage,
} from "../domain/index.js";
import { dispatchInboundTurn, type DispatchInboundTurnCommand } from "./dispatch-inbound-turn.js";
import {
  agentId,
  buildChannelsTestContext,
  channelRule,
  createThreadLinkFor,
  prefixRule,
  testEnvironmentScope,
  threadId,
} from "./testing/index.js";

const owner = connectionOwner(asIdentifier<ChannelConnectionId>("conn-1"));

const requestScope: RequestScope = {
  requestId: asIdentifier("req-1"),
  tenant: testEnvironmentScope(),
  principalId: asIdentifier("prin-1"),
  onBehalfOf: null,
  receivedAt: new Date("2026-01-01T00:00:00.000Z"),
};

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channelThreadKey: asIdentifier<ChannelThreadKey>("channel:C1:1700.1"),
    platformChannelId: "C1",
    text: "hello",
    endUserId: asIdentifier<EndUserId>("eu-1"),
    receivedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function command(overrides: Partial<DispatchInboundTurnCommand> = {}): DispatchInboundTurnCommand {
  return {
    inboxId: asIdentifier<ChannelEventInboxId>("inbox-1"),
    owner,
    agentRouting: [],
    defaultAgentId: agentId("default-agent"),
    message: message(),
    newThreadId: threadId("thread-new"),
    requestScope,
    ...overrides,
  };
}

describe("dispatchInboundTurn — first contact", () => {
  it("creates the link and enqueues a turn job", async () => {
    const context = buildChannelsTestContext();
    const result = await dispatchInboundTurn(context.dependencies, command());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.startedConversation).toBe(true);
    expect(result.value.link.threadId).toBe("thread-new");
    expect(context.durableRuntime.dispatched).toHaveLength(1);
  });

  it("enqueues under the Platos job name at the frozen payload version", async () => {
    const context = buildChannelsTestContext();
    await dispatchInboundTurn(context.dependencies, command());

    const [job] = context.durableRuntime.dispatched;
    expect(job?.jobName).toBe(INBOUND_TURN_JOB_NAME);
    expect(job?.payloadVersion).toBe(INBOUND_TURN_PAYLOAD_VERSION);
  });

  it("carries the routing decision on the payload", async () => {
    const context = buildChannelsTestContext();
    await dispatchInboundTurn(
      context.dependencies,
      command({ agentRouting: [channelRule("C1", "routed-agent")] }),
    );

    const [job] = context.durableRuntime.dispatched;
    expect(job?.payload).toMatchObject({ agentId: "routed-agent", threadId: "thread-new", text: "hello" });
  });

  it("resolves a prefix rule from the message text", async () => {
    const context = buildChannelsTestContext();
    await dispatchInboundTurn(
      context.dependencies,
      command({
        agentRouting: [prefixRule("ada", "ada-agent")],
        message: message({ text: "ada: hello", platformChannelId: null }),
      }),
    );

    expect(context.durableRuntime.dispatched[0]?.payload).toMatchObject({ agentId: "ada-agent" });
  });

  it("falls back to the default agent when no rule matches", async () => {
    const context = buildChannelsTestContext();
    await dispatchInboundTurn(context.dependencies, command({ agentRouting: [channelRule("C9", "other")] }));
    expect(context.durableRuntime.dispatched[0]?.payload).toMatchObject({ agentId: "default-agent" });
  });

  it("derives the channel id from the thread key when the message carries none", async () => {
    const context = buildChannelsTestContext();
    await dispatchInboundTurn(
      context.dependencies,
      command({
        agentRouting: [channelRule("C1", "routed-agent")],
        message: message({ platformChannelId: null }),
      }),
    );
    expect(context.durableRuntime.dispatched[0]?.payload).toMatchObject({ agentId: "routed-agent" });
  });

  it("refuses when nothing matches and there is no default, rather than dropping the message", async () => {
    const context = buildChannelsTestContext();
    const result = await dispatchInboundTurn(
      context.dependencies,
      command({ agentRouting: [], defaultAgentId: null }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_ROUTING_UNRESOLVED");
    expect(context.durableRuntime.dispatched).toHaveLength(0);
  });

  it("rejects a malformed channel thread key before writing anything", async () => {
    const context = buildChannelsTestContext();
    const result = await dispatchInboundTurn(
      context.dependencies,
      command({ message: message({ channelThreadKey: asIdentifier<ChannelThreadKey>("   ") }) }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_THREAD_KEY_INVALID");
    expect(context.repository.links.size).toBe(0);
  });
});

describe("dispatchInboundTurn — an existing conversation", () => {
  it("reuses the link and does NOT re-resolve routing", async () => {
    // Routing is decided once. An operator editing a rule must not hand the
    // second half of a live conversation to a different agent.
    const context = buildChannelsTestContext();
    createThreadLinkFor(context.repository, owner, "channel:C1:1700.1", "thread-existing");

    const result = await dispatchInboundTurn(
      context.dependencies,
      command({ agentRouting: [channelRule("C1", "newly-added-agent")] }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.startedConversation).toBe(false);
    expect(result.value.link.threadId).toBe("thread-existing");
    expect(result.value.agentId).toBeNull();
    expect(context.durableRuntime.dispatched[0]?.payload).toMatchObject({
      agentId: null,
      threadId: "thread-existing",
    });
  });

  it("ignores the supplied newThreadId when a link already exists", async () => {
    const context = buildChannelsTestContext();
    createThreadLinkFor(context.repository, owner, "channel:C1:1700.1", "thread-existing");

    const result = await dispatchInboundTurn(context.dependencies, command({ newThreadId: threadId("ignored") }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.link.threadId).toBe("thread-existing");
  });

  it("keeps a DIFFERENT channel thread key on its own thread", async () => {
    const context = buildChannelsTestContext();
    createThreadLinkFor(context.repository, owner, "channel:C1:1700.1", "thread-a");

    const result = await dispatchInboundTurn(
      context.dependencies,
      command({ message: message({ channelThreadKey: asIdentifier<ChannelThreadKey>("channel:C1:1700.2") }) }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.startedConversation).toBe(true);
    expect(result.value.link.threadId).toBe("thread-new");
  });
});

describe("dispatchInboundTurn — idempotency and races", () => {
  it("a redelivery produces ONE job, not a second turn", async () => {
    const context = buildChannelsTestContext();
    const first = await dispatchInboundTurn(context.dependencies, command());
    const second = await dispatchInboundTurn(context.dependencies, command());

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.jobId).toBe(first.value.jobId);
    expect(context.durableRuntime.dispatched).toHaveLength(1);
  });

  it("derives the idempotency key from the inbox row alone", async () => {
    const context = buildChannelsTestContext();
    await dispatchInboundTurn(context.dependencies, command());
    expect(context.durableRuntime.dispatched[0]?.idempotencyKey).toBe(`${INBOUND_TURN_JOB_NAME}:inbox-1`);
  });

  it("a LOST link race resolves to the winner's thread", async () => {
    const context = buildChannelsTestContext();
    // Seed the winner's link so this dispatch's insert collides on the unique.
    createThreadLinkFor(context.repository, owner, "channel:C1:1700.1", "thread-winner");

    const result = await dispatchInboundTurn(context.dependencies, command());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.link.threadId).toBe("thread-winner");
    expect(result.value.startedConversation).toBe(false);
  });

  it("writes the link inside a unit of work", async () => {
    const context = buildChannelsTestContext();
    await dispatchInboundTurn(context.dependencies, command());
    expect(context.unitOfWork.transactions.length).toBeGreaterThan(0);
  });
});
