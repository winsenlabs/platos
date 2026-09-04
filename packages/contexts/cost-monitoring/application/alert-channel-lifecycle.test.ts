import { describe, expect, it } from "vitest";

import {
  asCostIdentifier,
  type AlertChannelId,
  type CredentialRef,
  type DeduplicationKey,
} from "../domain/index.js";
import {
  createAlertChannel,
  describeAlertChannel,
  listAlertChannels,
  removeAlertChannel,
  updateAlertChannel,
} from "./manage-alert-channels.js";
import { probeAlertChannel } from "./probe-alert-channel.js";
import { buildCostTestContext, otherEnvironment, testChannel } from "./testing/index.js";

function emailIntake(overrides: Record<string, unknown> = {}) {
  return {
    kind: "EMAIL",
    name: "ops mailbox",
    topics: ["BUDGET"],
    configuration: { email: "ops@example.test" },
    ...overrides,
  } as Parameters<typeof createAlertChannel>[1]["intake"];
}

describe("creating a channel", () => {
  it("mints it with the operator's subscription", async () => {
    const context = buildCostTestContext();
    const created = await createAlertChannel(context.dependencies, {
      authorization: context.tenancy.grant("secret:mutate"),
      intake: emailIntake(),
    });
    if (!created.ok) throw new Error(`unreachable: ${created.error.code}`);
    expect(created.value.topics).toEqual(["BUDGET"]);
    expect(created.value.enabled).toBe(true);
    expect(created.value.environmentId).toBe(context.scope.environmentId);
  });

  it("DEMANDS the secret-mutating grant", async () => {
    // Creating a channel mints or rotates a credential in the vault, even though
    // this context never touches the material.
    const context = buildCostTestContext();
    const denied = await createAlertChannel(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      intake: emailIntake(),
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("COST_SCOPE_MISMATCH");
  });

  it("refuses a duplicate deduplication key BEFORE it writes", async () => {
    const context = buildCostTestContext();
    context.repository.seedChannel(
      testChannel(context.scope, {
        deduplicationKey: asCostIdentifier<DeduplicationKey>("nightly-ops"),
      }),
    );
    const denied = await createAlertChannel(context.dependencies, {
      authorization: context.tenancy.grant("secret:mutate"),
      intake: emailIntake({ deduplicationKey: "nightly-ops" }),
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("COST_ALERT_CHANNEL_EXISTS");
    expect(context.unitOfWork.transactions).toEqual([]);
  });

  it("carries a webhook's credential REFERENCE and no material", async () => {
    const context = buildCostTestContext();
    const created = await createAlertChannel(context.dependencies, {
      authorization: context.tenancy.grant("secret:mutate"),
      intake: emailIntake({
        kind: "WEBHOOK",
        configuration: { url: "https://x.example.test", credential: "cred-1" },
      }),
    });
    if (!created.ok) throw new Error("unreachable");
    expect(created.value.configuration).toEqual({
      kind: "WEBHOOK",
      url: "https://x.example.test",
      credential: "cred-1",
    });
  });

  it("refuses an unsigned webhook", async () => {
    const context = buildCostTestContext();
    const denied = await createAlertChannel(context.dependencies, {
      authorization: context.tenancy.grant("secret:mutate"),
      intake: emailIntake({ kind: "WEBHOOK", configuration: { url: "https://x.example.test" } }),
    });
    expect(denied.ok).toBe(false);
  });
});

describe("reading channels", () => {
  it("lists only this environment's, and filters by kind and state", async () => {
    const context = buildCostTestContext();
    context.repository.seedChannel(testChannel(context.scope));
    context.repository.seedChannel(
      testChannel(context.scope, {
        channelId: asCostIdentifier<AlertChannelId>("channel-2"),
        enabled: false,
      }),
    );
    context.repository.seedChannel(
      testChannel(otherEnvironment(), { channelId: asCostIdentifier<AlertChannelId>("channel-3") }),
    );

    const grant = context.tenancy.grant("metadata");
    const all = await listAlertChannels(context.dependencies, { authorization: grant });
    if (!all.ok) throw new Error("unreachable");
    expect(all.value).toHaveLength(2);

    const live = await listAlertChannels(context.dependencies, { authorization: grant, enabled: true });
    if (!live.ok) throw new Error("unreachable");
    expect(live.value.map((row) => row.channelId)).toEqual(["channel-1"]);

    const webhooks = await listAlertChannels(context.dependencies, {
      authorization: grant,
      kind: "WEBHOOK",
    });
    if (!webhooks.ok) throw new Error("unreachable");
    expect(webhooks.value).toEqual([]);
  });

  it("reports a channel in another environment as not found", async () => {
    const context = buildCostTestContext();
    const elsewhere = context.repository.seedChannel(testChannel(otherEnvironment()));
    const denied = await describeAlertChannel(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      channelId: elsewhere.channelId,
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("COST_ALERT_CHANNEL_NOT_FOUND");
  });

  it("lists under the WEAKER grant, so a dashboard needs no vault access", async () => {
    const context = buildCostTestContext();
    context.repository.seedChannel(testChannel(context.scope));
    const listed = await listAlertChannels(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
    });
    expect(listed.ok).toBe(true);
  });
});

describe("updating a channel", () => {
  it("applies only what was supplied", async () => {
    const context = buildCostTestContext();
    const seeded = context.repository.seedChannel(testChannel(context.scope));
    const updated = await updateAlertChannel(context.dependencies, {
      authorization: context.tenancy.grant("secret:mutate"),
      channelId: seeded.channelId,
      patch: { enabled: false },
    });
    if (!updated.ok) throw new Error("unreachable");
    expect(updated.value.enabled).toBe(false);
    expect(updated.value.name).toBe("ops mailbox");
  });

  it("validates the configuration against the STORED kind", async () => {
    // A kind change would orphan the configuration row rather than convert it,
    // because the store keys it on [channelId, environmentId, type].
    const context = buildCostTestContext();
    const seeded = context.repository.seedChannel(
      testChannel(context.scope, {
        kind: "WEBHOOK",
        configuration: { kind: "WEBHOOK", url: "https://x.example.test", credential: asCostIdentifier<CredentialRef>("c") },
      }),
    );
    const denied = await updateAlertChannel(context.dependencies, {
      authorization: context.tenancy.grant("secret:mutate"),
      channelId: seeded.channelId,
      patch: { configuration: { email: "ops@example.test" } },
    });
    expect(denied.ok).toBe(false);
  });

  it("refuses a patch that changes nothing", async () => {
    // A no-op write is indistinguishable from a real one in an audit trail.
    const context = buildCostTestContext();
    const seeded = context.repository.seedChannel(testChannel(context.scope));
    const denied = await updateAlertChannel(context.dependencies, {
      authorization: context.tenancy.grant("secret:mutate"),
      channelId: seeded.channelId,
      patch: {},
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("COST_ALERT_CHANNEL_UNCHANGED");
  });

  it("demands the secret-mutating grant", async () => {
    const context = buildCostTestContext();
    const seeded = context.repository.seedChannel(testChannel(context.scope));
    const denied = await updateAlertChannel(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      channelId: seeded.channelId,
      patch: { enabled: false },
    });
    expect(denied.ok).toBe(false);
  });
});

describe("removing a channel", () => {
  it("retires it and releases its deduplication key", async () => {
    const context = buildCostTestContext();
    const seeded = context.repository.seedChannel(
      testChannel(context.scope, {
        deduplicationKey: asCostIdentifier<DeduplicationKey>("nightly-ops"),
        operatorSuppliedKey: true,
      }),
    );
    const removed = await removeAlertChannel(context.dependencies, {
      authorization: context.tenancy.grant("secret:mutate"),
      channelId: seeded.channelId,
    });
    if (!removed.ok) throw new Error("unreachable");
    expect(removed.value.channel.enabled).toBe(false);
    expect(removed.value.channel.deduplicationKey).toBeNull();
  });

  it("reports NO releasable credential for an email channel", async () => {
    const context = buildCostTestContext();
    const seeded = context.repository.seedChannel(testChannel(context.scope));
    const removed = await removeAlertChannel(context.dependencies, {
      authorization: context.tenancy.grant("secret:mutate"),
      channelId: seeded.channelId,
    });
    if (!removed.ok) throw new Error("unreachable");
    expect(removed.value.releasableCredential).toBeNull();
  });

  it("reports the credential as releasable when nothing else uses it", async () => {
    const context = buildCostTestContext();
    const seeded = context.repository.seedChannel(
      testChannel(context.scope, {
        kind: "WEBHOOK",
        configuration: { kind: "WEBHOOK", url: "https://x.example.test", credential: asCostIdentifier<CredentialRef>("cred-1") },
      }),
    );
    const removed = await removeAlertChannel(context.dependencies, {
      authorization: context.tenancy.grant("secret:mutate"),
      channelId: seeded.channelId,
    });
    if (!removed.ok) throw new Error("unreachable");
    expect(removed.value.releasableCredential).toBe("cred-1");
  });

  it("REFUSES to release a credential another live channel still signs with", async () => {
    // Revoking on the first delete silently breaks the second.
    const context = buildCostTestContext();
    const shared = { kind: "WEBHOOK", url: "https://x.example.test", credential: asCostIdentifier<CredentialRef>("cred-1") } as const;
    const first = context.repository.seedChannel(
      testChannel(context.scope, { kind: "WEBHOOK", configuration: shared }),
    );
    context.repository.seedChannel(
      testChannel(context.scope, {
        channelId: asCostIdentifier<AlertChannelId>("channel-2"),
        kind: "WEBHOOK",
        configuration: shared,
      }),
    );
    const removed = await removeAlertChannel(context.dependencies, {
      authorization: context.tenancy.grant("secret:mutate"),
      channelId: first.channelId,
    });
    if (!removed.ok) throw new Error("unreachable");
    expect(removed.value.releasableCredential).toBeNull();
  });
});

describe("probing a channel", () => {
  it("sends, and leaves a durable row an operator can read later", async () => {
    // The failure an operator most needs to see is the one that happened five
    // minutes ago in a tab they have since closed.
    const context = buildCostTestContext();
    const seeded = context.repository.seedChannel(testChannel(context.scope));
    const probed = await probeAlertChannel(context.dependencies, {
      authorization: context.tenancy.grant("secret:mutate"),
      channelId: seeded.channelId,
    });
    if (!probed.ok) throw new Error("unreachable");
    expect(probed.value.outcome.ok).toBe(true);
    expect(probed.value.delivery.kind).toBe("TEST");
    expect(probed.value.delivery.status).toBe("SUCCEEDED");
    expect(probed.value.delivery.retryCount).toBe(1);
    expect(context.email.probes).toHaveLength(1);
    expect(context.repository.retries).toHaveLength(1);
  });

  it("mints a FRESH key per click, so a second question actually sends", async () => {
    const context = buildCostTestContext();
    const seeded = context.repository.seedChannel(testChannel(context.scope));
    const grant = context.tenancy.grant("secret:mutate");
    await probeAlertChannel(context.dependencies, { authorization: grant, channelId: seeded.channelId });
    await probeAlertChannel(context.dependencies, { authorization: grant, channelId: seeded.channelId });
    expect(context.email.probes).toHaveLength(2);
    const keys = context.repository.allDeliveries().map((row) => row.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });

  it("records a DISABLED channel as a failed delivery rather than refusing", async () => {
    // "It is switched off" is an answer to the question the operator asked, and
    // it belongs on the ledger beside the others.
    const context = buildCostTestContext();
    const seeded = context.repository.seedChannel(testChannel(context.scope, { enabled: false }));
    const probed = await probeAlertChannel(context.dependencies, {
      authorization: context.tenancy.grant("secret:mutate"),
      channelId: seeded.channelId,
    });
    if (!probed.ok) throw new Error("unreachable");
    expect(probed.value.outcome.ok).toBe(false);
    expect(probed.value.delivery.lastErrorCode).toBe("channel_disabled");
    expect(context.email.probes).toEqual([]);
  });

  it("records a transport failure with its status code", async () => {
    const context = buildCostTestContext();
    const seeded = context.repository.seedChannel(testChannel(context.scope));
    // The delivery id is the transport's idempotency key: the first uuid this
    // context mints in the probe path.
    context.email.failFor.add("id-0001");
    const probed = await probeAlertChannel(context.dependencies, {
      authorization: context.tenancy.grant("secret:mutate"),
      channelId: seeded.channelId,
    });
    if (!probed.ok) throw new Error("unreachable");
    expect(probed.value.delivery.status).toBe("FAILED");
    expect(probed.value.delivery.lastStatusCode).toBe(502);
  });

  it("truncates the operator's message rather than sending an unbounded one", async () => {
    const context = buildCostTestContext();
    const seeded = context.repository.seedChannel(testChannel(context.scope));
    await probeAlertChannel(context.dependencies, {
      authorization: context.tenancy.grant("secret:mutate"),
      channelId: seeded.channelId,
      message: "x".repeat(5_000),
    });
    expect(context.email.probes[0]?.text).toHaveLength(500);
  });

  it("demands the secret-mutating grant and an existing channel", async () => {
    const context = buildCostTestContext();
    const seeded = context.repository.seedChannel(testChannel(context.scope));
    expect(
      (
        await probeAlertChannel(context.dependencies, {
          authorization: context.tenancy.grant("metadata"),
          channelId: seeded.channelId,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await probeAlertChannel(context.dependencies, {
          authorization: context.tenancy.grant("secret:mutate"),
          channelId: asCostIdentifier<AlertChannelId>("nope"),
        })
      ).ok,
    ).toBe(false);
  });
});
