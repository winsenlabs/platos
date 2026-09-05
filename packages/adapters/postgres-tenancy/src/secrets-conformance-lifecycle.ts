// The credential LIFECYCLE half of the one conformance scenario: rotation,
// re-encryption, the purge sweep and revocation.
//
// IT IS A THIRD FILE FOR THE REASON THE SECOND ONE IS. ADR M0.3 §6's budget kept
// pointing at a seam here and the seam is real: `secrets-conformance.ts` is
// about what a credential IS — created, found by three different queries, listed
// — and this is about what happens to it over time. The two ask different
// questions of the same store, and the steps below are the ones where the
// database and the double could most easily part: a rewrap writes the SAME
// revision under a new root key, a purge re-checks every eligibility clause
// INSIDE its delete, and a revoke leaves the credential in the inventory while
// taking it out of the find path.
//
// THE ORDER OF THE PURGE CANDIDATES IS THE POINT OF THE FIXTURE. `purgeOrder` is
// oldest-`createdAt` first with the identifier as tie-break, and the first
// version is stamped an hour LATER than the second, so those two orderings
// DISAGREE. A store that sorted on the identifier alone would hand the two
// candidates back the other way round and the transcripts would part.

import type {
  EnvironmentId,
  RetiredSecretVersionCandidate,
} from "@platos/context-secrets/application/ports/index.js";

import type {
  RecordStep,
  SecretsConformanceEnvironment,
} from "./secrets-conformance-variables.js";
import {
  AT,
  CUTOFF,
  LATER,
  auditDraft,
  credentialIdOf,
  revisionOf,
  rootKeyOf,
  sortedRootKeyUsage,
  versionDraft,
  versionIdOf,
} from "./secrets-harness.js";

function candidateFor(
  environmentId: EnvironmentId,
  credentialId: string,
  secretVersionId: string,
  secretRevision: number,
  rootKeyVersion: number,
): RetiredSecretVersionCandidate {
  return {
    secretVersionId: versionIdOf(secretVersionId),
    credentialId: credentialIdOf(credentialId),
    environmentId,
    secretRevision: revisionOf(secretRevision),
    rootKeyVersion: rootKeyOf(rootKeyVersion),
  };
}

export async function runLifecycleConformance(
  environment: SecretsConformanceEnvironment,
  record: RecordStep,
): Promise<void> {
  const { repository, environmentId, ids } = environment;
  const credential = credentialIdOf;
  const version = versionIdOf;

  // ---- rotate, then rewrap ------------------------------------------------
  await environment.run(async (transaction) => {
    record(
      "loadAlphaForUpdate",
      await repository.loadForUpdate(environmentId, credential(ids.alphaCredentialId), transaction),
    );
    record(
      "loadMissingForUpdate",
      await repository.loadForUpdate(environmentId, credential(ids.missingCredentialId), transaction),
    );
    record(
      "insertAlphaSecondVersion",
      await repository.insertSecretVersion(
        versionDraft({
          id: ids.alphaSecondVersionId,
          credentialId: ids.alphaCredentialId,
          secretRevision: 2,
          rootKeyVersion: 1,
          fill: 0x20,
          at: AT,
        }),
        transaction,
      ),
    );
    record(
      "retireAlphaFirstVersion",
      await repository.retireSecretVersion(version(ids.alphaFirstVersionId), LATER, null, transaction),
    );
    record(
      "pointAlphaAtSecondVersion",
      await repository.setActiveSecretVersion(
        credential(ids.alphaCredentialId),
        version(ids.alphaSecondVersionId),
        LATER,
        transaction,
      ),
    );
    record(
      "auditRotate",
      await repository.appendAudit(
        auditDraft({
          id: ids.auditIds[1] as string,
          environmentId,
          credentialId: ids.alphaCredentialId,
          action: "ROTATE",
          secretRevision: 2,
          fromRootKeyVersion: 1,
          toRootKeyVersion: 1,
          at: LATER,
        }),
        transaction,
      ),
    );
  });

  await environment.run(async (transaction) => {
    // THE SAME REVISION UNDER A NEW ROOT KEY. This is the one write the store's
    // `[credentialId, secretRevision, rootKeyVersion]` unique key exists to
    // ALLOW, and it is why the refusal above is a duplicate rather than a
    // re-encryption.
    record(
      "rewrapAlphaSecondVersion",
      await repository.insertSecretVersion(
        versionDraft({
          id: ids.alphaRewrappedVersionId,
          credentialId: ids.alphaCredentialId,
          secretRevision: 2,
          rootKeyVersion: 2,
          fill: 0x30,
          at: LATER,
        }),
        transaction,
      ),
    );
    record(
      "retireAlphaSecondVersion",
      await repository.retireSecretVersion(version(ids.alphaSecondVersionId), LATER, null, transaction),
    );
    record(
      "pointAlphaAtRewrappedVersion",
      await repository.setActiveSecretVersion(
        credential(ids.alphaCredentialId),
        version(ids.alphaRewrappedVersionId),
        LATER,
        transaction,
      ),
    );
    record(
      "retireMissingVersion",
      await repository.retireSecretVersion(version(ids.missingVersionId), LATER, null, transaction),
    );
    record(
      "pointMissingCredential",
      await repository.setActiveSecretVersion(
        credential(ids.missingCredentialId),
        null,
        LATER,
        transaction,
      ),
    );
  });
  record("usageAfterRewrap", await sortedRootKeyUsage(repository));

  // ---- purge --------------------------------------------------------------
  await environment.run(async (transaction) => {
    const candidates = await repository.listPurgeCandidates(CUTOFF, 10, transaction);
    record("purgeCandidates", candidates);
    record(
      "purgeSecondVersion",
      await repository.purgeSecretVersion(
        candidateFor(environmentId, ids.alphaCredentialId, ids.alphaSecondVersionId, 2, 1),
        CUTOFF,
        transaction,
      ),
    );
    record(
      "purgeSecondVersionAgain",
      await repository.purgeSecretVersion(
        candidateFor(environmentId, ids.alphaCredentialId, ids.alphaSecondVersionId, 2, 1),
        CUTOFF,
        transaction,
      ),
    );
    // The ACTIVE version, offered to the purge as if it were a candidate. Every
    // eligibility clause is re-checked inside the delete, so the answer is ZERO
    // rows rather than a foreign-key exception that would poison the batch.
    record(
      "purgeActiveVersion",
      await repository.purgeSecretVersion(
        candidateFor(environmentId, ids.alphaCredentialId, ids.alphaRewrappedVersionId, 2, 2),
        CUTOFF,
        transaction,
      ),
    );
    record(
      "auditPurge",
      await repository.appendAudit(
        auditDraft({
          id: ids.auditIds[2] as string,
          environmentId,
          credentialId: ids.alphaCredentialId,
          action: "PURGE",
          secretRevision: 2,
          fromRootKeyVersion: 1,
          at: CUTOFF,
        }),
        transaction,
      ),
    );
  });
  record("usageAfterPurge", await sortedRootKeyUsage(repository));

  // ---- revoke -------------------------------------------------------------
  await environment.run(async (transaction) => {
    record(
      "retireAlphaRewrappedVersion",
      await repository.retireSecretVersion(
        version(ids.alphaRewrappedVersionId),
        LATER,
        CUTOFF,
        transaction,
      ),
    );
    record(
      "clearAlphaActiveVersion",
      await repository.setActiveSecretVersion(credential(ids.alphaCredentialId), null, LATER, transaction),
    );
    record(
      "revokeAlpha",
      await repository.revokeCredential(credential(ids.alphaCredentialId), LATER, transaction),
    );
    record(
      "revokeMissing",
      await repository.revokeCredential(credential(ids.missingCredentialId), LATER, transaction),
    );
    record(
      "auditRevoke",
      await repository.appendAudit(
        auditDraft({
          id: ids.auditIds[3] as string,
          environmentId,
          credentialId: ids.alphaCredentialId,
          action: "REVOKE",
          at: LATER,
        }),
        transaction,
      ),
    );
  });
  record(
    "findAlphaAfterRevoke",
    await repository.findCredential({ environmentId, credentialId: credential(ids.alphaCredentialId) }),
  );
  record("listAfterRevoke", await repository.listCredentials(environmentId));

}
