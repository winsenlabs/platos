import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type {
  ChannelConnectionId,
  ChannelInstallationId,
  ChannelThreadId,
  ChannelThreadKey,
  ThreadId,
} from "./identifiers.js";
import {
  admitChannelThreadKey,
  connectionOwner,
  createThreadLink,
  installationOwner,
  linkIdentity,
  ownerKey,
  reconcileThreadLink,
} from "./thread-link.js";

const EPOCH = new Date("2026-01-01T00:00:00.000Z");
const thread = (value: string): ThreadId => asIdentifier<ThreadId>(value);
const key = (value: string): ChannelThreadKey => asIdentifier<ChannelThreadKey>(value);

function link(threadId: string, keyValue = "channel:C1:1"): ReturnType<typeof createThreadLink> {
  return createThreadLink({
    linkId: asIdentifier<ChannelThreadId>("link-1"),
    owner: connectionOwner(asIdentifier<ChannelConnectionId>("conn-1")),
    channelThreadKey: key(keyValue),
    threadId: thread(threadId),
    now: EPOCH,
  });
}

describe("admitChannelThreadKey", () => {
  it("trims a provider-supplied key", () => {
    const result = admitChannelThreadKey("  channel:C1:1  ");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("channel:C1:1");
  });

  it("does NOT lower-case, because provider ids are case-sensitive", () => {
    // Folding case would collide two distinct Slack channels onto one thread.
    const result = admitChannelThreadKey("channel:C1AbC:1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("channel:C1AbC:1");
  });

  it.each([
    ["a non-string", 42],
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["an over-long key", "x".repeat(513)],
  ])("rejects %s", (_label, value) => {
    const result = admitChannelThreadKey(value);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_THREAD_KEY_INVALID");
  });

  it("admits a key exactly at the length bound", () => {
    expect(admitChannelThreadKey("x".repeat(512)).ok).toBe(true);
  });
});

describe("ownerKey and linkIdentity", () => {
  it("distinguishes a connection owner from an installation owner", () => {
    const asConnection = ownerKey(connectionOwner(asIdentifier<ChannelConnectionId>("x")));
    const asInstallation = ownerKey(installationOwner(asIdentifier<ChannelInstallationId>("x")));
    expect(asConnection).not.toBe(asInstallation);
  });

  it("keeps the same thread key distinct across two owners", () => {
    // The uniques are per-owner: one channel key may legitimately exist under a
    // connection AND under an installation, addressing different conversations.
    const left = linkIdentity(connectionOwner(asIdentifier<ChannelConnectionId>("c1")), key("k"));
    const right = linkIdentity(installationOwner(asIdentifier<ChannelInstallationId>("c1")), key("k"));
    expect(left).not.toBe(right);
  });

  it("is stable for the same owner and key", () => {
    const owner = connectionOwner(asIdentifier<ChannelConnectionId>("c1"));
    expect(linkIdentity(owner, key("k"))).toBe(linkIdentity(owner, key("k")));
  });
});

describe("createThreadLink", () => {
  it("records the link without an agent column", () => {
    // The agent is pinned on conversations' Thread row, which this context may
    // neither read nor write; the link's EXISTENCE is the routing signal.
    const created = link("t1");
    expect(created.threadId).toBe("t1");
    expect(created.createdAt).toEqual(EPOCH);
    expect(created).not.toHaveProperty("agentId");
  });
});

describe("reconcileThreadLink", () => {
  it("is idempotent for the same thread", () => {
    const existing = link("t1");
    const result = reconcileThreadLink(existing, thread("t1"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(existing);
  });

  it("conflicts for a different thread, rather than re-pointing the conversation", () => {
    const result = reconcileThreadLink(link("t1"), thread("t2"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_THREAD_LINK_CONFLICT");
    expect(result.error.details).toMatchObject({ linkedThreadId: "t1", requestedThreadId: "t2" });
  });
});
