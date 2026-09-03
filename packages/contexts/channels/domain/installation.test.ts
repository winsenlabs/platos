import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type {
  ChannelAppId,
  ChannelInstallationId,
  CredentialId,
  ExternalInstallationId,
  RefreshClaimId,
} from "./identifiers.js";
import {
  abandonRefresh,
  assertActive,
  beginRefresh,
  finalizeRefresh,
  holdsRefreshClaim,
  isActive,
  reclaimStaleRefresh,
  releaseRefresh,
  revokeInstallation,
  type ChannelInstallation,
  type RefreshExpectation,
} from "./installation.js";

const EPOCH = new Date("2026-01-01T00:00:00.000Z");
const later = (ms: number): Date => new Date(EPOCH.getTime() + ms);

const claimId = (value = "claim-1"): RefreshClaimId => asIdentifier<RefreshClaimId>(value);
const credential = (value = "cred-1"): CredentialId => asIdentifier<CredentialId>(value);

function seed(overrides: Partial<ChannelInstallation> = {}): ChannelInstallation {
  return {
    installationId: asIdentifier<ChannelInstallationId>("inst-1"),
    appId: asIdentifier<ChannelAppId>("app-1"),
    externalInstallationId: asIdentifier<ExternalInstallationId>("T123"),
    displayName: "Acme",
    credentialId: credential(),
    credentialRevision: 1,
    grantedScopes: ["chat:write"],
    defaultAgentId: null,
    agentRouting: [],
    status: "active",
    revokedAt: null,
    lastEventAt: null,
    refreshState: "IDLE",
    refreshClaimId: null,
    refreshStartedAt: null,
    refreshRepairCode: null,
    tokenGeneration: 1,
    createdAt: EPOCH,
    ...overrides,
  };
}

function expectation(overrides: Partial<RefreshExpectation> = {}): RefreshExpectation {
  return { credentialId: credential(), credentialRevision: 1, tokenGeneration: 1, ...overrides };
}

function begun(installation = seed()): ChannelInstallation {
  const result = beginRefresh(installation, claimId(), expectation(), EPOCH);
  if (!result.ok) throw new Error(`expected begin to succeed, got ${result.error.code}`);
  return result.value;
}

describe("isActive / assertActive", () => {
  it("accepts an active row", () => {
    expect(isActive(seed())).toBe(true);
    expect(assertActive(seed()).ok).toBe(true);
  });

  it.each([
    ["a revoked status", { status: "revoked" as const }],
    ["a revocation timestamp", { revokedAt: EPOCH }],
  ])("refuses %s", (_label, overrides) => {
    const result = assertActive(seed(overrides));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_INSTALLATION_REVOKED");
  });
});

describe("revokeInstallation", () => {
  it("marks the row revoked and clears any in-flight refresh claim", () => {
    const revoked = revokeInstallation(begun(), later(5));
    expect(revoked.status).toBe("revoked");
    expect(revoked.revokedAt).toEqual(later(5));
    expect(revoked.refreshState).toBe("IDLE");
    expect(revoked.refreshClaimId).toBeNull();
  });

  it("keeps the credential id, so an operator can still see WHAT was revoked", () => {
    expect(revokeInstallation(seed(), later(5)).credentialId).toBe("cred-1");
  });

  it("is idempotent and preserves the ORIGINAL revocation instant", () => {
    const first = revokeInstallation(seed(), later(5));
    const second = revokeInstallation(first, later(999));
    expect(second.revokedAt).toEqual(later(5));
    expect(second).toBe(first);
  });
});

describe("beginRefresh", () => {
  it("claims the fence from IDLE and stamps the claim", () => {
    const claimed = begun();
    expect(claimed.refreshState).toBe("REFRESHING");
    expect(claimed.refreshClaimId).toBe("claim-1");
    expect(claimed.refreshStartedAt).toEqual(EPOCH);
  });

  it("does NOT advance the generation — only a commit does", () => {
    expect(begun().tokenGeneration).toBe(1);
  });

  it("refuses a second concurrent claim", () => {
    const result = beginRefresh(begun(), claimId("claim-2"), expectation(), later(1));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_REFRESH_NOT_CLAIMABLE");
  });

  it("refuses a REPAIR_REQUIRED row distinctly, because it needs an operator", () => {
    const result = beginRefresh(
      seed({ refreshState: "REPAIR_REQUIRED", refreshRepairCode: "X" }),
      claimId(),
      expectation(),
      EPOCH,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_REFRESH_REPAIR_REQUIRED");
  });

  it("refuses a revoked installation", () => {
    const result = beginRefresh(seed({ status: "revoked" }), claimId(), expectation(), EPOCH);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_INSTALLATION_REVOKED");
  });

  it.each([
    ["a stale generation", expectation({ tokenGeneration: 99 })],
    ["a different credential", expectation({ credentialId: credential("other") })],
  ])("refuses %s — this claim's grant would be stale", (_label, stale) => {
    const result = beginRefresh(seed(), claimId(), stale, EPOCH);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_REFRESH_LOST");
  });

  /**
   * THE THIRD AXIS OF THE FENCE, WHICH UNTIL WIN-256 WAS PROSE ONLY.
   *
   * `secrets` rotating a credential's material in place moves its revision and
   * moves NEITHER the credential id NOR this context's `tokenGeneration`. A
   * claim built before that rotation holds a grant that is already dead, and
   * before the revision was carried on the installation the fence had nothing
   * to compare it against: `RefreshExpectation.credentialRevision` was declared,
   * never read, and deleting it left all 263 tests green.
   */
  it("refuses a claim whose credential was REPLACED IN PLACE, generation unmoved", () => {
    const replaced = seed({ credentialRevision: 2 });
    const result = beginRefresh(replaced, claimId(), expectation({ credentialRevision: 1 }), EPOCH);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_REFRESH_LOST");
  });

  it("admits that same row once the expectation names the current revision", () => {
    // The positive control. Only the revision differs between this case and the
    // one above, so a refusal that survived here would be about the row rather
    // than about the axis being tested.
    const replaced = seed({ credentialRevision: 2 });
    expect(beginRefresh(replaced, claimId(), expectation({ credentialRevision: 2 }), EPOCH).ok).toBe(true);
  });

  it("refuses a row with no credential at all", () => {
    const result = beginRefresh(seed({ credentialId: null }), claimId(), expectation(), EPOCH);
    expect(result.ok).toBe(false);
  });
});

describe("holdsRefreshClaim", () => {
  it("accepts the winning claim", () => {
    expect(holdsRefreshClaim(begun(), claimId(), expectation())).toBe(true);
  });

  it("rejects a DIFFERENT retry holding the same expectation", () => {
    // Two claims can begin from one generation; only one can have won, and
    // the claim id is the only thing that separates them.
    expect(holdsRefreshClaim(begun(), claimId("claim-2"), expectation())).toBe(false);
  });

  it("rejects an IDLE row — there is no claim to hold", () => {
    expect(holdsRefreshClaim(seed(), claimId(), expectation())).toBe(false);
  });
});

describe("finalizeRefresh", () => {
  it("commits the replacement, advances the generation and releases the fence", () => {
    const result = finalizeRefresh(begun(), claimId(), expectation(), credential("cred-2"), 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.credentialId).toBe("cred-2");
    // The pair moves together, so the value describes ONE credential row.
    expect(result.value.credentialRevision).toBe(2);
    expect(result.value.tokenGeneration).toBe(2);
    expect(result.value.refreshState).toBe("IDLE");
    expect(result.value.refreshClaimId).toBeNull();
    expect(result.value.refreshRepairCode).toBeNull();
  });

  it("makes the losing claim's expectation stale, so it cannot also commit", () => {
    const committed = finalizeRefresh(begun(), claimId(), expectation(), credential("cred-2"), 2);
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const loser = finalizeRefresh(committed.value, claimId(), expectation(), credential("cred-3"), 3);
    expect(loser.ok).toBe(false);
    if (loser.ok) return;
    expect(loser.error.code).toBe("CHANNELS_REFRESH_LOST");
  });

  it("refuses a claim this worker never held", () => {
    const result = finalizeRefresh(begun(), claimId("claim-2"), expectation(), credential("cred-2"), 2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_REFRESH_LOST");
  });

  it("refuses to commit onto an IDLE row", () => {
    expect(finalizeRefresh(seed(), claimId(), expectation(), credential("cred-2"), 2).ok).toBe(false);
  });

  /**
   * THE REVISION AXIS, AT THE COMMIT.
   *
   * `beginRefresh` proves the fence sees a replaced credential before a grant is
   * redeemed; this proves it still sees one at the moment of writing. The two
   * are different windows and a claim can lose the row in either.
   */
  it("refuses to commit onto a row whose credential was replaced underneath", () => {
    const replaced = { ...begun(), credentialRevision: 2 };
    const result = finalizeRefresh(replaced, claimId(), expectation(), credential("cred-2"), 3);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_REFRESH_LOST");
  });
});

describe("abandonRefresh", () => {
  it("parks the row terminally with its repair code", () => {
    const result = abandonRefresh(begun(), claimId(), expectation(), "GRANT_BURNED");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.refreshState).toBe("REPAIR_REQUIRED");
    expect(result.value.refreshRepairCode).toBe("GRANT_BURNED");
    expect(result.value.refreshClaimId).toBeNull();
  });

  it("advances the generation, so a concurrent holder fails closed", () => {
    const result = abandonRefresh(begun(), claimId(), expectation(), "GRANT_BURNED");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tokenGeneration).toBe(2);
  });

  it("leaves a row that beginRefresh will not reclaim", () => {
    const abandoned = abandonRefresh(begun(), claimId(), expectation(), "GRANT_BURNED");
    expect(abandoned.ok).toBe(true);
    if (!abandoned.ok) return;
    const retry = beginRefresh(abandoned.value, claimId("claim-2"), expectation({ tokenGeneration: 2 }), later(1));
    expect(retry.ok).toBe(false);
    if (retry.ok) return;
    expect(retry.error.code).toBe("CHANNELS_REFRESH_REPAIR_REQUIRED");
  });
});

describe("releaseRefresh", () => {
  it("returns to IDLE with the generation UNCHANGED, because nothing was consumed", () => {
    const result = releaseRefresh(begun(), claimId(), expectation());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.refreshState).toBe("IDLE");
    expect(result.value.tokenGeneration).toBe(1);
    expect(result.value.refreshRepairCode).toBeNull();
  });

  it("leaves the row immediately re-claimable on the SAME expectation", () => {
    // The distinction from abandon: a release must not demand an operator fix
    // an installation whose credential is still live.
    const released = releaseRefresh(begun(), claimId(), expectation());
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(beginRefresh(released.value, claimId("claim-2"), expectation(), later(1)).ok).toBe(true);
  });

  it("refuses a claim this worker never held", () => {
    expect(releaseRefresh(begun(), claimId("claim-2"), expectation()).ok).toBe(false);
  });

  it("refuses a release whose credential was replaced underneath", () => {
    // Release is the path that leaves the generation UNCHANGED, so it is the one
    // path where a stale claim would otherwise be indistinguishable from a live
    // one on the generation axis alone.
    const replaced = { ...begun(), credentialRevision: 2 };
    expect(releaseRefresh(replaced, claimId(), expectation()).ok).toBe(false);
  });
});

describe("reclaimStaleRefresh", () => {
  const STALE_MS = 600_000;

  it("sends a long-stalled claim to REPAIR_REQUIRED, never to IDLE", () => {
    // A crash between redeeming and committing is indistinguishable from one
    // before redeeming, and the optimistic reading burns a live grant.
    const result = reclaimStaleRefresh(begun(), STALE_MS, "ABANDONED", later(STALE_MS));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.refreshState).toBe("REPAIR_REQUIRED");
    expect(result.value.refreshRepairCode).toBe("ABANDONED");
    expect(result.value.tokenGeneration).toBe(2);
  });

  it("refuses a claim that is not yet stale", () => {
    const result = reclaimStaleRefresh(begun(), STALE_MS, "ABANDONED", later(STALE_MS - 1));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_REFRESH_NOT_CLAIMABLE");
  });

  it("refuses a row that is not refreshing at all", () => {
    expect(reclaimStaleRefresh(seed(), STALE_MS, "ABANDONED", later(999_999)).ok).toBe(false);
  });
});
