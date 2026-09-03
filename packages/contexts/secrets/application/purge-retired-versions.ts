// Destroying retired envelopes — the only operation here that loses data.
//
// It is installation-scoped, bounded and fail-closed, in that order:
//
//   * INSTALLATION-SCOPED. Purging crosses every tenant, so no environment grant
//     can authorize it. `RootKeyOperationsAuthorization` is a separate principal
//     type for exactly this reason.
//   * BOUNDED. A cutoff in the future would destroy envelopes retired seconds ago,
//     so it is rejected. A batch larger than the hard maximum is clamped, not
//     honoured, so one call can never turn into an unbounded delete.
//   * FAIL-CLOSED. The repository re-checks every eligibility clause inside the
//     delete and reports the row count. Anything other than exactly one row means
//     the world changed underneath the candidate list, and the whole batch rolls
//     back rather than guessing.
//
// Every purge writes a metadata-only audit row. Once the envelope is gone that row
// is the only remaining evidence it existed.

import { err, ok } from "@platos/kernel";
import type { Result, TransactionScope } from "@platos/kernel";

import { requireRootKeyOperations } from "../domain/access-rules.js";
import type { RootKeyOperationsAuthorization } from "../domain/authorization.js";
import { credentialUnavailable, invalidPurgeRequest } from "../domain/errors.js";
import { recordAudit } from "./audit-log.js";
import type { SecretsDependencies } from "./dependencies.js";
import type { RetiredSecretVersionCandidate } from "./ports/index.js";
import { inTransaction } from "./transaction.js";

export const PURGE_RETIRED_HARD_LIMIT = 100;

export interface PurgeRetiredCommand {
  readonly authorization: RootKeyOperationsAuthorization;
  readonly cutoff: Date;
  readonly limit?: number;
}

export interface PurgeReport {
  readonly purgedCount: number;
}

function validate(command: PurgeRetiredCommand, now: Date): Result<number> {
  const cutoff = command.cutoff;
  if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime())) {
    return err(invalidPurgeRequest("cutoff_not_a_valid_instant"));
  }
  if (cutoff.getTime() > now.getTime()) {
    return err(invalidPurgeRequest("cutoff_in_the_future"));
  }
  if (command.limit !== undefined && (!Number.isSafeInteger(command.limit) || command.limit <= 0)) {
    return err(invalidPurgeRequest("limit_not_a_positive_integer"));
  }
  return ok(Math.min(command.limit ?? PURGE_RETIRED_HARD_LIMIT, PURGE_RETIRED_HARD_LIMIT));
}

async function purgeOne(
  deps: SecretsDependencies,
  authorization: RootKeyOperationsAuthorization,
  candidate: RetiredSecretVersionCandidate,
  cutoff: Date,
  transaction: TransactionScope,
): Promise<Result<void>> {
  const removed = await deps.repository.purgeSecretVersion(candidate, cutoff, transaction);
  if (!removed.ok) return err(removed.error);
  if (removed.value !== 1) return err(credentialUnavailable("secret_version_not_active"));

  return recordAudit(
    deps,
    {
      authorization,
      environmentId: candidate.environmentId,
      credentialId: candidate.credentialId,
      action: "PURGE",
      secretRevision: candidate.secretRevision,
      fromRootKeyVersion: candidate.rootKeyVersion,
    },
    transaction,
  );
}

export async function purgeRetiredSecretVersions(
  deps: SecretsDependencies,
  command: PurgeRetiredCommand,
): Promise<Result<PurgeReport>> {
  const granted = requireRootKeyOperations(command.authorization);
  if (!granted.ok) return err(granted.error);
  const limit = validate(command, deps.clock.now());
  if (!limit.ok) return err(limit.error);

  return inTransaction(deps.unitOfWork, async (transaction) => {
    const candidates = await deps.repository.listPurgeCandidates(
      command.cutoff,
      limit.value,
      transaction,
    );
    if (!candidates.ok) return err(candidates.error);

    for (const candidate of candidates.value) {
      const purged = await purgeOne(deps, granted.value, candidate, command.cutoff, transaction);
      if (!purged.ok) return err(purged.error);
    }
    return ok({ purgedCount: candidates.value.length });
  });
}
