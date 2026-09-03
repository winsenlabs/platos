// The published surface, exercised end to end through `createChannelsContract`.
//
// These assertions are deliberately about the CONTRACT rather than the use
// cases: the views must not leak a credential, the two owner shapes must stay
// mutually exclusive, and the whole inbound round trip must be drivable from
// the outside with nothing but `contracts/`.

import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import { createChannelsContract } from "../application/channels-contract.js";
import {
  agentId,
  buildApp,
  buildChannelsTestContext,
  buildConnection,
  buildInstallation,
  testEnvironmentScope,
  threadId,
} from "../application/testing/index.js";
import type {
  ChannelAppId,
  ChannelConnectionId,
  ChannelEventInboxId,
  ChannelInstallationId,
  ChannelThreadKey,
  LeaseOwner,
  ProviderEventId,
  RefreshClaimId,
} from "../domain/index.js";

const scope = testEnvironmentScope();
const appId = asIdentifier<ChannelAppId>("app-1");
const connectionId = asIdentifier<ChannelConnectionId>("conn-1");

function build() {
  const context = buildChannelsTestContext();
  const contract = createChannelsContract(context.dependencies);
  return { context, contract };
}

describe("the contract's identity", () => {
  it("names itself, so a composition root can key an array of contracts", () => {
    expect(build().contract.name).toBe("channels");
  });
});

describe("describeConnection", () => {
  it("publishes routing unredacted but never the credential id", () => {
    // agentRouting is configuration and is returned as written; the credential
    // is a pointer into secrets and nothing outside needs it.
    const { context, contract } = build();
    context.repository.seedConnection(buildConnection());

    return contract.describeConnection({ scope, connectionId }).then((result) => {
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.connected).toBe(true);
      expect(result.value).not.toHaveProperty("credentialId");
      expect(result.value.agentRouting).toEqual([]);
    });
  });

  it("reports a connection with no credential as not connected", async () => {
    const { context, contract } = build();
    context.repository.seedConnection(buildConnection({ credentialId: null }));

    const result = await contract.describeConnection({ scope, connectionId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.connected).toBe(false);
  });

  it("is invisible across environments", async () => {
    const { context, contract } = build();
    context.repository.seedConnection(buildConnection({ scope: testEnvironmentScope("other") }));

    const result = await contract.describeConnection({ scope, connectionId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_CONNECTION_NOT_FOUND");
  });
});

describe("describeApp and describeInstallation", () => {
  it("publishes an app view", async () => {
    const { context, contract } = build();
    context.repository.seedApp(buildApp());

    const result = await contract.describeApp({ scope, appId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.clientId).toBe("client-1");
    expect(result.value).not.toHaveProperty("credentialId");
  });

  it("publishes the refresh STATE but never the claim token", async () => {
    const { context, contract } = build();
    context.repository.seedInstallation(
      buildInstallation({
        refreshState: "REPAIR_REQUIRED",
        refreshRepairCode: "X",
        refreshClaimId: asIdentifier<RefreshClaimId>("secret"),
      }),
    );

    const result = await contract.describeInstallation(asIdentifier<ChannelInstallationId>("inst-1"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.refreshState).toBe("REPAIR_REQUIRED");
    expect(result.value.refreshRepairCode).toBe("X");
    expect(result.value).not.toHaveProperty("refreshClaimId");
  });
});

describe("the inbound round trip, driven entirely through the contract", () => {
  it("admits, dispatches, claims and completes one provider event", async () => {
    const { context, contract } = build();
    context.repository.seedConnection(buildConnection({ defaultAgentId: agentId("a1") }));

    const admitted = await contract.admitEvent({
      appId,
      eventId: asIdentifier<ProviderEventId>("Ev1"),
      body: '{"text":"hi"}',
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.value.admitted).toBe(true);

    const dispatched = await contract.dispatchInboundTurn({
      inboxId: asIdentifier(admitted.value.event.inboxId),
      connectionId,
      channelThreadKey: asIdentifier<ChannelThreadKey>("channel:C1:1"),
      platformChannelId: "C1",
      text: "hi",
      endUserId: "eu-1",
      newThreadId: threadId("t-1"),
    });
    expect(dispatched.ok).toBe(true);
    if (!dispatched.ok) return;
    expect(dispatched.value.startedConversation).toBe(true);
    expect(dispatched.value.agentId).toBe("a1");

    const claimed = await contract.claimNextEvent({ appId, leaseOwner: asIdentifier<LeaseOwner>("w1") });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok || claimed.value === null) return;

    const completed = await contract.completeEvent({
      inboxId: asIdentifier(claimed.value.event.inboxId),
      hold: claimed.value.hold,
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.status).toBe("COMPLETED");
  });

  it("never publishes the sealed payload on an event view", async () => {
    const { contract } = build();
    const admitted = await contract.admitEvent({
      appId,
      eventId: asIdentifier<ProviderEventId>("Ev1"),
      body: "secret",
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.value.event).not.toHaveProperty("payload");
    expect(JSON.stringify(admitted.value.event)).not.toContain("secret");
  });

  it("resolves the routing table from the installation, then the app", async () => {
    const { context, contract } = build();
    context.repository.seedApp(buildApp({ defaultAgentId: agentId("app-default") }));
    context.repository.seedInstallation(buildInstallation({ defaultAgentId: null }));

    const result = await contract.dispatchInboundTurn({
      inboxId: asIdentifier("inbox-1"),
      installationId: asIdentifier<ChannelInstallationId>("inst-1"),
      channelThreadKey: asIdentifier<ChannelThreadKey>("channel:C1:1"),
      platformChannelId: "C1",
      text: "hi",
      endUserId: null,
      newThreadId: threadId("t-1"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The installation has no default, so the app's is inherited.
    expect(result.value.agentId).toBe("app-default");
  });

  it("prefers the installation's own default over the app's", async () => {
    const { context, contract } = build();
    context.repository.seedApp(buildApp({ defaultAgentId: agentId("app-default") }));
    context.repository.seedInstallation(buildInstallation({ defaultAgentId: agentId("install-default") }));

    const result = await contract.dispatchInboundTurn({
      inboxId: asIdentifier("inbox-1"),
      installationId: asIdentifier<ChannelInstallationId>("inst-1"),
      channelThreadKey: asIdentifier<ChannelThreadKey>("channel:C1:1"),
      platformChannelId: "C1",
      text: "hi",
      endUserId: null,
      newThreadId: threadId("t-1"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.agentId).toBe("install-default");
  });

  it("refuses the inbound turn on a DISABLED connection, and spends nothing", async () => {
    // THE OPERATOR KILL SWITCH, PROVEN ON THE PATH IT GUARDS. `enabled` is the
    // switch an operator throws to stop a channel costing money. Before this
    // case, `assertEnabled` had ZERO CALLERS in the repository: the whole
    // function could be deleted with all 258 cases still green, so a disabled
    // connection kept accepting events and kept enqueuing turn jobs while the
    // console showed it switched off.
    //
    // The refusal is asserted on THREE axes, because "returns an error" alone
    // would still pass if the turn had already been dispatched:
    //   1. the published call fails, with the domain's own code — not a generic
    //      routing error — so an operator can tell "I turned this off" apart
    //      from "this is misconfigured";
    //   2. NO job reached `DurableRuntime`. This is the money assertion: the
    //      dispatch record is what a turn costs;
    //   3. NO unit of work was opened, so no `ChannelThreadLink` row was
    //      inserted and the conversation was never started.
    const { context, contract } = build();
    context.repository.seedConnection(buildConnection({ enabled: false, defaultAgentId: agentId("a1") }));

    const result = await contract.dispatchInboundTurn({
      inboxId: asIdentifier("inbox-1"),
      connectionId,
      channelThreadKey: asIdentifier<ChannelThreadKey>("channel:C1:1"),
      platformChannelId: "C1",
      text: "hi",
      endUserId: null,
      newThreadId: threadId("t-1"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_CONNECTION_DISABLED");
    expect(context.durableRuntime.dispatched).toHaveLength(0);
    expect(context.unitOfWork.transactions).toHaveLength(0);
  });

  it("dispatches the SAME turn once the connection is enabled — the control", async () => {
    // The positive half of the pair. Byte-for-byte the request above, differing
    // only in `enabled`, so the refusal cannot be blamed on a malformed request,
    // an unseeded row or unresolvable routing. If this case and its neighbour
    // ever agree, the kill switch has stopped discriminating.
    const { context, contract } = build();
    context.repository.seedConnection(buildConnection({ enabled: true, defaultAgentId: agentId("a1") }));

    const result = await contract.dispatchInboundTurn({
      inboxId: asIdentifier("inbox-1"),
      connectionId,
      channelThreadKey: asIdentifier<ChannelThreadKey>("channel:C1:1"),
      platformChannelId: "C1",
      text: "hi",
      endUserId: null,
      newThreadId: threadId("t-1"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.agentId).toBe("a1");
    expect(context.durableRuntime.dispatched).toHaveLength(1);
  });

  it("refuses the inbound turn on a REVOKED installation, and spends nothing", async () => {
    // The installation half of the same gate, and the same defect: `assertActive`
    // is documented as "the gate every operation on an installation passes
    // through", and on the inbound path it was not called at all — only
    // `beginRefresh` used it. A workspace that uninstalled the app therefore
    // kept routing turns.
    const { context, contract } = build();
    context.repository.seedApp(buildApp({ defaultAgentId: agentId("app-default") }));
    context.repository.seedInstallation(
      buildInstallation({ status: "revoked", revokedAt: new Date("2026-02-02T00:00:00.000Z") }),
    );

    const result = await contract.dispatchInboundTurn({
      inboxId: asIdentifier("inbox-1"),
      installationId: asIdentifier<ChannelInstallationId>("inst-1"),
      channelThreadKey: asIdentifier<ChannelThreadKey>("channel:C1:1"),
      platformChannelId: "C1",
      text: "hi",
      endUserId: null,
      newThreadId: threadId("t-1"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_INSTALLATION_REVOKED");
    expect(context.durableRuntime.dispatched).toHaveLength(0);
    expect(context.unitOfWork.transactions).toHaveLength(0);
  });

  it.each([
    ["neither owner", {}],
    ["both owners", { connectionId, installationId: asIdentifier<ChannelInstallationId>("inst-1") }],
  ])("refuses a dispatch naming %s", async (_label, owners) => {
    // The two are different tables with different uniques; silently preferring
    // one would put the link where the caller did not intend.
    const { contract } = build();
    const result = await contract.dispatchInboundTurn({
      inboxId: asIdentifier("inbox-1"),
      channelThreadKey: asIdentifier<ChannelThreadKey>("channel:C1:1"),
      platformChannelId: "C1",
      text: "hi",
      endUserId: null,
      newThreadId: threadId("t-1"),
      ...owners,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_ROUTING_INVALID");
  });
});

describe("configureRouting", () => {
  it("stores a validated table on a connection", async () => {
    const { context, contract } = build();
    context.repository.seedConnection(buildConnection());
    context.agents.register("env-1", "a1");

    const result = await contract.configureRouting({
      scope,
      connectionId,
      agentRouting: [{ match: { type: "channel", id: "C1" }, agentId: "a1" }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.agentRouting).toHaveLength(1);
  });

  it("refuses an out-of-scope agent through the published surface too", async () => {
    const { context, contract } = build();
    context.repository.seedConnection(buildConnection());

    const result = await contract.configureRouting({
      scope,
      connectionId,
      agentRouting: [{ match: { type: "channel", id: "C1" }, agentId: "intruder" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_ROUTING_AGENT_UNKNOWN");
  });
});

describe("erasureTarget", () => {
  it("is exposed and names this context", () => {
    expect(build().contract.erasureTarget().targetName).toBe("channels");
  });
});
