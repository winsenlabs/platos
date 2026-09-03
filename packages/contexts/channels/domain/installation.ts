// `ChannelInstallation` — one workspace's installation of a `ChannelApp`, and
// the durable fence that makes rotating-grant refresh safe.
//
// THE PROBLEM. Slack's rotating refresh grants are SINGLE-USE: redeeming one
// invalidates it and returns a replacement. If two workers refresh the same
// installation concurrently, one of them redeems a grant whose replacement the
// other has already superseded, and committing it would overwrite a live
// credential with a dead one. There is no way to un-redeem a grant, so the loser
// must be detected BEFORE it writes, not reconciled afterwards.
//
// THE FENCE. A three-state machine plus a monotonic generation:
//
//   IDLE ──begin──▶ REFRESHING ──finalize──▶ IDLE            (generation + 1)
//                        │
//                        └────abandon─────▶ REPAIR_REQUIRED  (generation + 1)
//
// `begin` is a compare-and-swap: it succeeds only from IDLE, and only when all
// three axes the caller EXPECTED still hold — the credential row, ITS REVISION,
// and the generation. It stamps a claim id. `finalize` re-asserts state, claim
// id and the same three axes, so a claim that lost the row writes nothing.
//
// THE REVISION IS THE AXIS THAT CATCHES A REPLACEMENT IN PLACE. `secrets`
// rotating a credential's material moves neither the row's id nor this
// context's generation, so without it a claim holding an already-dead grant is
// indistinguishable from a live one. It was declared on `RefreshExpectation`
// and never read until WIN-256; `RefreshExpectation`'s own note carries the
// finding.
//
// WHY A CLAIM ID AS WELL AS A GENERATION. The generation alone cannot separate
// two claims that both began from the same generation — only one can have
// won, but both hold the same expectation. The claim id is minted per try,
// so the winner is identifiable.
//
// REPAIR_REQUIRED IS TERMINAL, AND THAT IS THE POINT. It means a grant was
// consumed and its replacement was never committed: no usable credential
// remains and no retry can produce one. Parking the row in a state that
// `begin` refuses is what stops a worker from burning the remaining grants in a
// retry loop. Only an operator re-authorizing clears it.

import { err, ok, type Result } from "@platos/kernel";

import { installationRevoked, refreshLost, refreshNotClaimable, refreshRepairRequired } from "./errors.js";
import type {
  AgentId,
  ChannelAppId,
  ChannelInstallationId,
  CredentialId,
  ExternalInstallationId,
  RefreshClaimId,
} from "./identifiers.js";
import type { ChannelRoutingRule } from "./routing.js";

/** `ChannelInstallation.status`. */
export const INSTALLATION_STATUSES = Object.freeze(["active", "revoked"] as const);
export type InstallationStatus = (typeof INSTALLATION_STATUSES)[number];

/** `ChannelInstallation.tokenRefreshState` — the durable rotating-grant fence. */
export const REFRESH_STATES = Object.freeze(["IDLE", "REFRESHING", "REPAIR_REQUIRED"] as const);
export type RefreshState = (typeof REFRESH_STATES)[number];

export interface ChannelInstallation {
  readonly installationId: ChannelInstallationId;
  readonly appId: ChannelAppId;
  readonly externalInstallationId: ExternalInstallationId;
  readonly displayName: string | null;
  readonly credentialId: CredentialId | null;
  /**
   * The revision of the credential row `credentialId` names.
   *
   * `secrets` counts a credential's `SecretRevision` up on every rotation, so
   * this is what moves when the SAME row's material is replaced. It is a
   * READ-TIME PROJECTION and not a column of this table — the repository joins
   * the credential and reads its revision, which is what the ground-truth
   * persistence layer already does — and it is carried on the value because the
   * FENCE needs it. `expectationHolds` can only compare a claim against
   * something the row actually holds.
   *
   * Zero when there is no credential. No credential has revision zero, so the
   * placeholder cannot be mistaken for a real one.
   */
  readonly credentialRevision: number;
  readonly grantedScopes: readonly string[];
  readonly defaultAgentId: AgentId | null;
  readonly agentRouting: readonly ChannelRoutingRule[];
  readonly status: InstallationStatus;
  readonly revokedAt: Date | null;
  readonly lastEventAt: Date | null;
  readonly refreshState: RefreshState;
  readonly refreshClaimId: RefreshClaimId | null;
  readonly refreshStartedAt: Date | null;
  readonly refreshRepairCode: string | null;
  /** Advances whenever a grant replaces the canonical credential. */
  readonly tokenGeneration: number;
  readonly createdAt: Date;
}

/**
 * What a refresh claim believes about the row it is about to change.
 *
 * ALL THREE AXES ARE CARRIED AND ALL THREE ARE COMPARED. The credential id
 * catches an installation re-imported onto a different `Credential` row. The
 * revision catches the SAME row's material being replaced underneath: `secrets`
 * rotating a credential in place moves neither the id nor this context's
 * `tokenGeneration`, so a claim holding the superseded grant would otherwise
 * still look current. The generation catches this context's own commits.
 *
 * THE PARAGRAPH ABOVE USED TO BE PROSE ONLY. `ChannelInstallation` carried no
 * revision at all, so `expectationHolds` could not read one and did not try;
 * deleting `credentialRevision` from this interface left all 263 tests green.
 * A comment describing a fence the code cannot build is worse than no comment,
 * because a reader stops looking. The field the comparison needs is now on the
 * installation and the comparison is made.
 */
export interface RefreshExpectation {
  readonly credentialId: CredentialId;
  readonly credentialRevision: number;
  readonly tokenGeneration: number;
}

export function isActive(installation: ChannelInstallation): boolean {
  return installation.status === "active" && installation.revokedAt === null;
}

/**
 * The gate every operation on an installation passes through: `beginRefresh`
 * below, and `application/channels-contract.ts::routingFor` on the inbound path.
 *
 * The inbound call site was MISSING until WIN-256 — the sentence was true of
 * refresh and false of dispatch, so a workspace that had uninstalled the app
 * kept routing turns.
 */
export function assertActive(installation: ChannelInstallation): Result<ChannelInstallation> {
  if (!isActive(installation)) {
    return err(installationRevoked(installation.installationId, installation.revokedAt?.toISOString() ?? null));
  }
  return ok(installation);
}

/**
 * Revocation is idempotent and never clears the credential id.
 *
 * The row is kept so an operator can see WHAT was revoked and when, and so a
 * later re-install reuses the same installation rather than orphaning its
 * threads. Re-revoking preserves the ORIGINAL `revokedAt`: the first revocation
 * is the one that happened, and letting a repeat overwrite it would destroy the
 * only timestamp anyone audits.
 */
export function revokeInstallation(installation: ChannelInstallation, now: Date): ChannelInstallation {
  if (installation.status === "revoked") return installation;
  return Object.freeze({
    ...installation,
    status: "revoked" as const,
    revokedAt: installation.revokedAt ?? now,
    refreshState: "IDLE" as const,
    refreshClaimId: null,
    refreshStartedAt: null,
  });
}

function expectationHolds(installation: ChannelInstallation, expected: RefreshExpectation): boolean {
  return (
    installation.credentialId !== null &&
    installation.credentialId === expected.credentialId &&
    installation.credentialRevision === expected.credentialRevision &&
    installation.tokenGeneration === expected.tokenGeneration
  );
}

/**
 * Claim the exclusive right to redeem this installation's rotating grant.
 *
 * Succeeds only from `IDLE`, on an active row, when the caller's expectation
 * still holds. `REPAIR_REQUIRED` is reported distinctly from `REFRESHING`
 * because they need opposite responses: one is an operator's problem, the other
 * resolves itself when the holder finishes.
 */
export function beginRefresh(
  installation: ChannelInstallation,
  claimId: RefreshClaimId,
  expected: RefreshExpectation,
  now: Date,
): Result<ChannelInstallation> {
  const active = assertActive(installation);
  if (!active.ok) return err(active.error);

  if (installation.refreshState === "REPAIR_REQUIRED") {
    return err(refreshRepairRequired(installation.installationId, installation.refreshRepairCode));
  }
  if (installation.refreshState !== "IDLE") {
    return err(refreshNotClaimable(installation.installationId, installation.refreshState));
  }
  if (!expectationHolds(installation, expected)) return err(refreshLost(installation.installationId));

  return ok(
    Object.freeze({
      ...installation,
      refreshState: "REFRESHING" as const,
      refreshClaimId: claimId,
      refreshStartedAt: now,
      refreshRepairCode: null,
    }),
  );
}

/** True when `claimId` is the claim currently holding the refresh fence. */
export function holdsRefreshClaim(
  installation: ChannelInstallation,
  claimId: RefreshClaimId,
  expected: RefreshExpectation,
): boolean {
  return (
    installation.refreshState === "REFRESHING" &&
    installation.refreshClaimId === claimId &&
    expectationHolds(installation, expected)
  );
}

/**
 * Commit the replacement grant and release the fence.
 *
 * The generation advances HERE and nowhere else, which is what makes it a
 * reliable expectation for the next claim. `credentialId` moves too: an import
 * may land the new grant on a different credential row.
 *
 * THE REVISION MOVES WITH THE ID, and it is one parameter rather than none
 * because the two describe ONE credential row. A value carrying the new grant's
 * id beside the old grant's revision would be a lie, and it is the lie the next
 * claim's expectation gets built from.
 */
export function finalizeRefresh(
  installation: ChannelInstallation,
  claimId: RefreshClaimId,
  expected: RefreshExpectation,
  credentialId: CredentialId,
  credentialRevision: number,
): Result<ChannelInstallation> {
  if (!holdsRefreshClaim(installation, claimId, expected)) return err(refreshLost(installation.installationId));
  return ok(
    Object.freeze({
      ...installation,
      credentialId,
      credentialRevision,
      tokenGeneration: installation.tokenGeneration + 1,
      refreshState: "IDLE" as const,
      refreshClaimId: null,
      refreshStartedAt: null,
      refreshRepairCode: null,
    }),
  );
}

/**
 * Abandon a refresh whose grant was consumed but whose replacement never
 * committed. Advances the generation as well, so any other claim still
 * holding the old expectation fails closed rather than resuming into a row
 * whose credential is known to be dead.
 */
export function abandonRefresh(
  installation: ChannelInstallation,
  claimId: RefreshClaimId,
  expected: RefreshExpectation,
  repairCode: string,
): Result<ChannelInstallation> {
  if (!holdsRefreshClaim(installation, claimId, expected)) return err(refreshLost(installation.installationId));
  return ok(
    Object.freeze({
      ...installation,
      tokenGeneration: installation.tokenGeneration + 1,
      refreshState: "REPAIR_REQUIRED" as const,
      refreshClaimId: null,
      refreshStartedAt: null,
      refreshRepairCode: repairCode,
    }),
  );
}

/**
 * Release a refresh that failed BEFORE the grant was redeemed.
 *
 * Distinct from {@link abandonRefresh} and the distinction is the whole point:
 * nothing was consumed, so the credential is still live and the row must return
 * to `IDLE` with its generation UNCHANGED. Advancing it here would invalidate a
 * concurrent holder's expectation for no reason, and sending it to
 * `REPAIR_REQUIRED` would demand an operator fix a working installation.
 */
export function releaseRefresh(
  installation: ChannelInstallation,
  claimId: RefreshClaimId,
  expected: RefreshExpectation,
): Result<ChannelInstallation> {
  if (!holdsRefreshClaim(installation, claimId, expected)) return err(refreshLost(installation.installationId));
  return ok(
    Object.freeze({
      ...installation,
      refreshState: "IDLE" as const,
      refreshClaimId: null,
      refreshStartedAt: null,
    }),
  );
}

/**
 * Reclaim a refresh whose holder died. A claim older than `staleAfterMs` is
 * assumed abandoned — but it goes to `REPAIR_REQUIRED`, not `IDLE`, because a
 * crash between redeeming and committing is indistinguishable from one before
 * redeeming, and assuming the safe-looking case would burn a live grant.
 */
export function reclaimStaleRefresh(
  installation: ChannelInstallation,
  staleAfterMilliseconds: number,
  repairCode: string,
  now: Date,
): Result<ChannelInstallation> {
  if (installation.refreshState !== "REFRESHING" || installation.refreshStartedAt === null) {
    return err(refreshNotClaimable(installation.installationId, installation.refreshState));
  }
  if (now.getTime() - installation.refreshStartedAt.getTime() < staleAfterMilliseconds) {
    return err(refreshNotClaimable(installation.installationId, installation.refreshState));
  }
  return ok(
    Object.freeze({
      ...installation,
      tokenGeneration: installation.tokenGeneration + 1,
      refreshState: "REPAIR_REQUIRED" as const,
      refreshClaimId: null,
      refreshStartedAt: null,
      refreshRepairCode: repairCode,
    }),
  );
}
