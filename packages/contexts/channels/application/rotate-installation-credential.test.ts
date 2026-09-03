import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import { DEFAULT_CHANNELS_POLICY, type ChannelInstallationId, type RefreshClaimId } from "../domain/index.js";
import {
  beginInstallationRefresh,
  reclaimStaleInstallationRefresh,
  settleInstallationRefresh,
} from "./rotate-installation-credential.js";
import {
  buildChannelsTestContext,
  buildExpectation,
  buildInstallation,
  credentialId,
} from "./testing/index.js";

const installationId = asIdentifier<ChannelInstallationId>("inst-1");

function contextWithInstallation(overrides = {}) {
  const context = buildChannelsTestContext();
  context.repository.seedInstallation(buildInstallation(overrides));
  return context;
}

describe("beginInstallationRefresh", () => {
  it("claims the fence and COMMITS it before any provider call", async () => {
    const context = contextWithInstallation();
    const result = await beginInstallationRefresh(context.dependencies, {
      installationId,
      expected: buildExpectation(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.installation.refreshState).toBe("REFRESHING");
    // Committed: the stored row, not just the returned value, is REFRESHING.
    expect(context.repository.installations.get(installationId)?.refreshState).toBe("REFRESHING");
    expect(context.unitOfWork.transactions).toHaveLength(1);
  });

  it("mints a distinct claim id per retry", async () => {
    const context = contextWithInstallation();
    const first = await beginInstallationRefresh(context.dependencies, {
      installationId,
      expected: buildExpectation(),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.claimId).toBeTruthy();
  });

  it("refuses a SECOND concurrent claim — only one worker may redeem", async () => {
    const context = contextWithInstallation();
    await beginInstallationRefresh(context.dependencies, { installationId, expected: buildExpectation() });

    const second = await beginInstallationRefresh(context.dependencies, {
      installationId,
      expected: buildExpectation(),
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("CHANNELS_REFRESH_NOT_CLAIMABLE");
  });

  it("refuses a stale expectation", async () => {
    const context = contextWithInstallation();
    const result = await beginInstallationRefresh(context.dependencies, {
      installationId,
      expected: buildExpectation({ tokenGeneration: 99 }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_REFRESH_LOST");
  });

  it("fails for an installation that does not exist", async () => {
    const context = buildChannelsTestContext();
    const result = await beginInstallationRefresh(context.dependencies, {
      installationId,
      expected: buildExpectation(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_INSTALLATION_NOT_FOUND");
  });
});

describe("settleInstallationRefresh", () => {
  async function claimed() {
    const context = contextWithInstallation();
    const begun = await beginInstallationRefresh(context.dependencies, {
      installationId,
      expected: buildExpectation(),
    });
    if (!begun.ok) throw new Error("expected begin to succeed");
    return { context, claimId: begun.value.claimId };
  }

  it("commits a success, advancing the generation and releasing the fence", async () => {
    const { context, claimId } = await claimed();
    const result = await settleInstallationRefresh(context.dependencies, {
      installationId,
      claimId,
      expected: buildExpectation(),
      outcome: { kind: "succeeded", credentialId: credentialId("cred-2"), credentialRevision: 2 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.credentialId).toBe("cred-2");
    expect(result.value.tokenGeneration).toBe(2);
    // The revision travels with the id through the use case, not just the rule.
    expect(result.value.credentialRevision).toBe(2);
    expect(result.value.refreshState).toBe("IDLE");
  });

  it("releases an UNUSED failure without advancing the generation", async () => {
    const { context, claimId } = await claimed();
    const result = await settleInstallationRefresh(context.dependencies, {
      installationId,
      claimId,
      expected: buildExpectation(),
      outcome: { kind: "failed-unused" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.refreshState).toBe("IDLE");
    expect(result.value.tokenGeneration).toBe(1);

    // Immediately re-claimable on the SAME expectation: nothing was consumed.
    const retry = await beginInstallationRefresh(context.dependencies, {
      installationId,
      expected: buildExpectation(),
    });
    expect(retry.ok).toBe(true);
  });

  it("parks a CONSUMED failure in REPAIR_REQUIRED, which no retry can clear", async () => {
    const { context, claimId } = await claimed();
    const result = await settleInstallationRefresh(context.dependencies, {
      installationId,
      claimId,
      expected: buildExpectation(),
      outcome: { kind: "failed-consumed", repairCode: "GRANT_BURNED" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.refreshState).toBe("REPAIR_REQUIRED");
    expect(result.value.tokenGeneration).toBe(2);

    const retry = await beginInstallationRefresh(context.dependencies, {
      installationId,
      expected: buildExpectation({ tokenGeneration: 2 }),
    });
    expect(retry.ok).toBe(false);
    if (retry.ok) return;
    expect(retry.error.code).toBe("CHANNELS_REFRESH_REPAIR_REQUIRED");
  });

  it("refuses a settle from a claim this worker never held", async () => {
    const { context } = await claimed();
    const result = await settleInstallationRefresh(context.dependencies, {
      installationId,
      claimId: asIdentifier<RefreshClaimId>("someone-else"),
      expected: buildExpectation(),
      outcome: { kind: "succeeded", credentialId: credentialId("cred-2"), credentialRevision: 2 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_REFRESH_LOST");
  });

  it("stops the LOSER of a concurrent refresh from overwriting the winner", async () => {
    // The property the whole fence exists for: a stale grant must never
    // replace a live credential.
    const { context, claimId } = await claimed();
    await settleInstallationRefresh(context.dependencies, {
      installationId,
      claimId,
      expected: buildExpectation(),
      outcome: { kind: "succeeded", credentialId: credentialId("winner"), credentialRevision: 2 },
    });

    const loser = await settleInstallationRefresh(context.dependencies, {
      installationId,
      claimId,
      expected: buildExpectation(),
      outcome: { kind: "succeeded", credentialId: credentialId("stale"), credentialRevision: 3 },
    });

    expect(loser.ok).toBe(false);
    expect(context.repository.installations.get(installationId)?.credentialId).toBe("winner");
  });

  it("refuses to settle an installation that is not refreshing", async () => {
    const context = contextWithInstallation();
    const result = await settleInstallationRefresh(context.dependencies, {
      installationId,
      claimId: asIdentifier<RefreshClaimId>("claim-1"),
      expected: buildExpectation(),
      outcome: { kind: "failed-unused" },
    });
    expect(result.ok).toBe(false);
  });
});

describe("reclaimStaleInstallationRefresh", () => {
  it("reclaims a long-stalled claim into REPAIR_REQUIRED", async () => {
    const context = contextWithInstallation();
    await beginInstallationRefresh(context.dependencies, { installationId, expected: buildExpectation() });

    context.clock.advanceSeconds(DEFAULT_CHANNELS_POLICY.refresh.staleClaimMilliseconds / 1000);
    const result = await reclaimStaleInstallationRefresh(context.dependencies, installationId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.refreshState).toBe("REPAIR_REQUIRED");
    expect(result.value.refreshRepairCode).toBe(DEFAULT_CHANNELS_POLICY.refresh.repairCode);
  });

  it("refuses to reclaim a claim that is merely slow", async () => {
    const context = contextWithInstallation();
    await beginInstallationRefresh(context.dependencies, { installationId, expected: buildExpectation() });

    context.clock.advanceSeconds(1);
    const result = await reclaimStaleInstallationRefresh(context.dependencies, installationId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_REFRESH_NOT_CLAIMABLE");
  });

  it("refuses to reclaim an IDLE installation", async () => {
    const context = contextWithInstallation();
    const result = await reclaimStaleInstallationRefresh(context.dependencies, installationId);
    expect(result.ok).toBe(false);
  });
});
