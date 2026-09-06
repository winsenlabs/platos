// Use cases: the rotating-grant refresh protocol, from the application side.
//
// The state machine and its fence are in `domain/installation.ts`. What lives
// here is the ORDER OF OPERATIONS, which is the half that is easy to get wrong
// and impossible to see from the domain alone:
//
//   begin   ── claim the fence, in its own transaction, and COMMIT it.
//   redeem  ── talk to the provider. OUTSIDE any transaction.
//   finalize── commit the replacement, re-asserting the fence.
//
// WHY THE CLAIM COMMITS BEFORE THE PROVIDER CALL. If the claim were held open
// across the network call, a crash would roll it back and leave the row IDLE
// while a grant was in flight — the exact double-redeem the fence exists to
// prevent. Committing first means a crash leaves the row REFRESHING, which
// `beginRefresh` refuses and the stale-claim sweep later resolves.
//
// WHY A PROVIDER CALL IS NEVER INSIDE A TRANSACTION. It is unbounded in time. A
// database transaction held across it pins a connection and holds row locks for
// as long as the provider takes to answer, which is how one slow workspace
// stalls every other tenant's writes.
//
// THE THREE OUTCOMES OF A REDEEM, AND WHY THEY DIFFER:
//
//   succeeded         -> finalize.  Generation advances; the fence releases.
//   failed, unused    -> release.   Nothing was consumed; generation UNCHANGED.
//   failed, consumed  -> abandon.   A grant is gone; REPAIR_REQUIRED.
//
// The caller must tell the difference, so `RedeemOutcome` makes it a required
// discriminator rather than something inferred from an error code. Guessing
// wrong in either direction is expensive: guessing "unused" burns the
// installation silently, and guessing "consumed" demands an operator fix an
// installation that was merely briefly unreachable.

import { err, ok, runResult, type Result } from "@platos/kernel";

import {
  abandonRefresh,
  beginRefresh,
  finalizeRefresh,
  installationNotFound,
  reclaimStaleRefresh,
  releaseRefresh,
  type ChannelInstallation,
  type ChannelInstallationId,
  type CredentialId,
  type RefreshClaimId,
  type RefreshExpectation,
} from "../domain/index.js";
import type { ChannelsDependencies } from "./dependencies.js";

type Dependencies = Pick<ChannelsDependencies, "repository" | "clock" | "ids" | "unitOfWork" | "policy">;

export interface BeginRefreshCommand {
  readonly installationId: ChannelInstallationId;
  readonly expected: RefreshExpectation;
}

export interface ClaimedRefresh {
  readonly installation: ChannelInstallation;
  readonly claimId: RefreshClaimId;
}

async function current(
  dependencies: Dependencies,
  installationId: ChannelInstallationId,
): Promise<Result<ChannelInstallation>> {
  const found = await dependencies.repository.findInstallation(installationId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(installationNotFound(installationId));
  return ok(found.value);
}

/** Claim the fence and COMMIT it before anything talks to the provider. */
export async function beginInstallationRefresh(
  dependencies: Dependencies,
  command: BeginRefreshCommand,
): Promise<Result<ClaimedRefresh>> {
  const claimId = dependencies.ids.uuid() as unknown as RefreshClaimId;
  return runResult(dependencies.unitOfWork, async (transaction) => {
    const installation = await current(dependencies, command.installationId);
    if (!installation.ok) return err<ClaimedRefresh>(installation.error);

    const claimed = beginRefresh(installation.value, claimId, command.expected, dependencies.clock.now());
    if (!claimed.ok) return err<ClaimedRefresh>(claimed.error);

    const saved = await dependencies.repository.saveInstallation(claimed.value, transaction);
    if (!saved.ok) return err<ClaimedRefresh>(saved.error);
    return ok({ installation: saved.value, claimId });
  });
}

/** What happened when the caller redeemed the grant. See the header. */
export type RedeemOutcome =
  | {
      readonly kind: "succeeded";
      readonly credentialId: CredentialId;
      /** The new credential's revision. It travels with the id; see `finalizeRefresh`. */
      readonly credentialRevision: number;
    }
  /** The grant was NOT consumed — the credential is still live. */
  | { readonly kind: "failed-unused" }
  /** The grant WAS consumed and its replacement is unrecoverable. */
  | { readonly kind: "failed-consumed"; readonly repairCode: string };

export interface SettleRefreshCommand {
  readonly installationId: ChannelInstallationId;
  readonly claimId: RefreshClaimId;
  readonly expected: RefreshExpectation;
  readonly outcome: RedeemOutcome;
}

/**
 * Commit whichever ending the redeem produced, re-asserting the fence.
 *
 * One entry point for all three so a caller cannot commit a success down the
 * release path, and so the fence check is written once.
 */
export async function settleInstallationRefresh(
  dependencies: Dependencies,
  command: SettleRefreshCommand,
): Promise<Result<ChannelInstallation>> {
  return runResult(dependencies.unitOfWork, async (transaction) => {
    const installation = await current(dependencies, command.installationId);
    if (!installation.ok) return installation;

    const settled = settle(installation.value, command);
    if (!settled.ok) return err<ChannelInstallation>(settled.error);
    return dependencies.repository.saveInstallation(settled.value, transaction);
  });
}

function settle(installation: ChannelInstallation, command: SettleRefreshCommand): Result<ChannelInstallation> {
  if (command.outcome.kind === "succeeded") {
    return finalizeRefresh(
      installation,
      command.claimId,
      command.expected,
      command.outcome.credentialId,
      command.outcome.credentialRevision,
    );
  }
  if (command.outcome.kind === "failed-unused") {
    return releaseRefresh(installation, command.claimId, command.expected);
  }
  return abandonRefresh(installation, command.claimId, command.expected, command.outcome.repairCode);
}

/**
 * Reclaim a refresh whose holder died.
 *
 * Sends the row to `REPAIR_REQUIRED`, never to `IDLE` — see
 * `domain/installation.ts`. A crash between redeeming and committing is
 * indistinguishable from one before redeeming, and the optimistic reading burns
 * a live grant.
 */
export async function reclaimStaleInstallationRefresh(
  dependencies: Dependencies,
  installationId: ChannelInstallationId,
): Promise<Result<ChannelInstallation>> {
  return runResult(dependencies.unitOfWork, async (transaction) => {
    const installation = await current(dependencies, installationId);
    if (!installation.ok) return installation;

    const reclaimed = reclaimStaleRefresh(
      installation.value,
      dependencies.policy.refresh.staleClaimMilliseconds,
      dependencies.policy.refresh.repairCode,
      dependencies.clock.now(),
    );
    if (!reclaimed.ok) return err<ChannelInstallation>(reclaimed.error);
    return dependencies.repository.saveInstallation(reclaimed.value, transaction);
  });
}
