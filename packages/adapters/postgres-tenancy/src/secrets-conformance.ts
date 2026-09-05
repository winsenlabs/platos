// One scenario, written once, so `inMemorySecretsStore` and this adapter can be
// asked the SAME questions and their answers compared.
//
// Same instrument as `./conformance.ts`, `./identity-conformance.ts` and
// `./cost-conformance.ts`, and the same reason: two independently written suites
// measure two things and agree by coincidence. This module drives one sequence
// of port calls and records what came back; a test runs it twice and compares
// verbatim. A divergence is then a named step with a value on each side.
//
// EVERY IDENTIFIER IS SUPPLIED BY THE CALLER, so neither store mints one, and
// every one is a real uuid. That is not tidiness: eleven columns across the four
// rows are `@db.Uuid`, the double stores whatever string it is handed, and
// PostgreSQL parses it. The scenario uses values BOTH stores accept, so a
// divergence here is a behaviour difference rather than a shape difference; the
// shape refusals have their own named cases in the constraints suite.
//
// THE TWO REFUSING INSERTS ARE ALONE IN THEIR TRANSACTIONS, and that is a
// finding rather than a convention. On PostgreSQL a statement that violates a
// unique index aborts the WHOLE transaction, so a scenario that inserted a
// duplicate credential and then carried on writing in the same unit of work
// would measure 25P02 rather than the refusal it meant to. The double has no
// transaction to poison and would have agreed either way.
//
// THE ENVELOPE ORDER IS DELIBERATELY NOT THE IDENTIFIER ORDER. `purgeOrder` is
// oldest-`createdAt` first with the id as tie-break, and the two candidates are
// created so those two orderings DISAGREE — the first version stamped an hour
// LATER than the second. A store that ordered on the id alone would return them
// the other way round and the transcripts would part.
//
// NOTHING IS NORMALISED. Dates, byte arrays, counts, `null`-versus-absent and
// the `Result` errors themselves all compare literally.

import type {
  CredentialKind,
  EnvironmentId,
  RetiredSecretVersionCandidate,
  SecretsRepository,
  TransactionScope,
} from "@platos/context-secrets/application/ports/index.js";

import { runVariableConformance } from "./secrets-conformance-variables.js";
import type {
  SecretsConformanceEnvironment,
  SecretsObservation,
} from "./secrets-conformance-variables.js";
import {
  AT,
  CUTOFF,
  LATER,
  auditDraft,
  credentialDraft,
  credentialIdOf,
  revisionOf,
  rootKeyOf,
  versionDraft,
  versionIdOf,
} from "./secrets-harness.js";

export type { SecretsConformanceEnvironment, SecretsObservation };

/** Every identifier the scenario needs. All uuids; both stores use the same. */
export interface SecretsConformanceIds {
  readonly alphaCredentialId: string;
  readonly bravoCredentialId: string;
  readonly charlieCredentialId: string;
  readonly missingCredentialId: string;
  readonly alphaFirstVersionId: string;
  readonly alphaSecondVersionId: string;
  readonly alphaRewrappedVersionId: string;
  readonly bravoVersionId: string;
  readonly charlieVersionId: string;
  readonly missingVersionId: string;
  readonly alphaVariableId: string;
  readonly bravoVariableId: string;
  readonly charlieVariableId: string;
  readonly auditIds: readonly string[];
}

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

/** Root-key usage, sorted, because a `GROUP BY` answers in no order at all. */
async function usage(repository: SecretsRepository): Promise<unknown> {
  const counted = await repository.countVersionsByRootKey();
  if (!counted.ok) return counted;
  return {
    ok: true,
    value: [...counted.value].sort((left, right) => left.rootKeyVersion - right.rootKeyVersion),
  };
}

async function seedLiveCredential(
  environment: SecretsConformanceEnvironment,
  credentialId: string,
  versionId: string,
  name: string,
  kind: CredentialKind,
  provider: string | null,
  transaction: TransactionScope,
): Promise<void> {
  const { repository, environmentId } = environment;
  await repository.insertCredential(
    credentialDraft({ id: credentialId, environmentId, kind, name, provider }),
    transaction,
  );
  await repository.insertSecretVersion(
    versionDraft({
      id: versionId,
      credentialId,
      secretRevision: 1,
      rootKeyVersion: 1,
      fill: 0x40,
    }),
    transaction,
  );
  await repository.setActiveSecretVersion(
    credentialIdOf(credentialId),
    versionIdOf(versionId),
    AT,
    transaction,
  );
}

export async function runSecretsConformance(
  environment: SecretsConformanceEnvironment,
): Promise<SecretsObservation> {
  const { repository, environmentId, ids } = environment;
  const observed: Record<string, unknown> = {};
  const record = (step: string, value: unknown): void => {
    observed[step] = value;
  };
  const credential = credentialIdOf;
  const version = versionIdOf;

  // ---- create ------------------------------------------------------------
  await environment.run(async (transaction) => {
    record(
      "insertAlpha",
      await repository.insertCredential(
        credentialDraft({
          id: ids.alphaCredentialId,
          environmentId,
          kind: "SECRET_REFERENCE",
          name: "ALPHA_KEY",
        }),
        transaction,
      ),
    );
    record(
      "insertAlphaFirstVersion",
      await repository.insertSecretVersion(
        versionDraft({
          id: ids.alphaFirstVersionId,
          credentialId: ids.alphaCredentialId,
          secretRevision: 1,
          rootKeyVersion: 1,
          fill: 0x10,
          // An hour LATER than the version that will replace it, so
          // oldest-first and id-order DISAGREE at the purge sweep below.
          at: LATER,
        }),
        transaction,
      ),
    );
    record(
      "pointAlphaAtFirstVersion",
      await repository.setActiveSecretVersion(
        credential(ids.alphaCredentialId),
        version(ids.alphaFirstVersionId),
        AT,
        transaction,
      ),
    );
    record(
      "auditCreate",
      await repository.appendAudit(
        auditDraft({
          id: ids.auditIds[0] as string,
          environmentId,
          credentialId: ids.alphaCredentialId,
          action: "CREATE",
          secretRevision: 1,
          toRootKeyVersion: 1,
        }),
        transaction,
      ),
    );
    await seedLiveCredential(
      environment,
      ids.bravoCredentialId,
      ids.bravoVersionId,
      "BRAVO_KEY",
      "SERVICE_CREDENTIAL",
      "postgres",
      transaction,
    );
    await seedLiveCredential(
      environment,
      ids.charlieCredentialId,
      ids.charlieVersionId,
      "CHARLIE_KEY",
      "SECRET_REFERENCE",
      null,
      transaction,
    );
  });

  // ---- reads -------------------------------------------------------------
  record("findAlphaById", await repository.findCredential({ environmentId, credentialId: credential(ids.alphaCredentialId) }));
  record(
    "findAlphaByName",
    await repository.findCredential({ environmentId, name: "ALPHA_KEY", kind: "SECRET_REFERENCE" }),
  );
  record(
    "findBravoByProvider",
    await repository.findCredential({ environmentId, provider: "postgres" }),
  );
  record(
    "findMissing",
    await repository.findCredential({ environmentId, credentialId: credential(ids.missingCredentialId) }),
  );
  record("listAfterCreate", await repository.listCredentials(environmentId));
  record("usageAfterCreate", await usage(repository));

  // ---- the two refusals, each alone in its transaction --------------------
  record(
    "insertAlphaAgain",
    await environment.run((transaction) =>
      repository.insertCredential(
        credentialDraft({
          id: ids.missingCredentialId,
          environmentId,
          kind: "SECRET_REFERENCE",
          name: "ALPHA_KEY",
        }),
        transaction,
      ),
    ),
  );
  record(
    "insertDuplicateVersion",
    await environment.run((transaction) =>
      repository.insertSecretVersion(
        versionDraft({
          id: ids.missingVersionId,
          credentialId: ids.alphaCredentialId,
          secretRevision: 1,
          rootKeyVersion: 1,
          fill: 0x70,
        }),
        transaction,
      ),
    ),
  );

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
  record("usageAfterRewrap", await usage(repository));

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
  record("usageAfterPurge", await usage(repository));

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

  await runVariableConformance(environment, record);
  return observed;
}
