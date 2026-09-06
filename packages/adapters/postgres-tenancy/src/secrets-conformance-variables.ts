// The `EnvironmentVariable` half of the one conformance scenario, and the
// environment both halves are driven through.
//
// IT IS A SECOND FILE FOR THE REASON THE PORT IS A SECOND PORT.
// `environment-variable-repository.ts` keeps the vault and the configuration row
// in separate vocabularies on purpose, and the two halves of the scenario read
// as two subjects: one is a credential's whole lifecycle, the other is a row
// that POINTS at one. Splitting them also keeps each inside ADR M0.3 §6's file
// budget, which is the same seam the budget kept pointing at in tranche 5's
// other three stores.
//
// THE SECRET VARIABLE IS WHERE THE DOUBLE AND THE DATABASE ARE FURTHEST APART,
// and the scenario deliberately stays on the ground they share.
// `enforce_win124_credential_kind` re-reads the named credential from inside the
// variable's own write and demands it be in the SAME environment, of kind
// `SECRET_REFERENCE`, unrevoked, and already pointing at an active secret
// version. The double checks none of that. So the SECRET row here names a
// credential that satisfies every clause, and the four ways of failing them have
// their own named cases in the constraints suite.
//
// THE UPSERT REUSES THE ROW'S OWN ID, and that too is the shared ground rather
// than the whole truth. The double keys `upsert` on `input.id`; the store keys it
// on `[environmentId, key]`, which is what the database is unique on. Both agree
// while the caller reuses the id — which `setEnvironmentVariable` does, because
// it reads the row first — and they part the moment it does not. That divergence
// is pinned as its own case rather than smuggled in here, where it would have
// looked like a store defect.

import type {
  EnvironmentId,
  EnvironmentVariableRepository,
  SecretsRepository,
  TransactionScope,
} from "@platos/context-secrets/application/ports/index.js";

import { AT, LATER, credentialIdOf, variableIdOf } from "./secrets-harness.js";
import type { SecretsConformanceIds } from "./secrets-conformance.js";

export type SecretsObservation = Record<string, unknown>;

/** What the scenario needs to run against either store. */
export interface SecretsConformanceEnvironment {
  readonly repository: SecretsRepository;
  readonly variables: EnvironmentVariableRepository;
  readonly environmentId: EnvironmentId;
  readonly ids: SecretsConformanceIds;
  run<Value>(work: (transaction: TransactionScope) => Promise<Value>): Promise<Value>;
}

export type RecordStep = (step: string, value: unknown) => void;

export async function runVariableConformance(
  environment: SecretsConformanceEnvironment,
  record: RecordStep,
): Promise<void> {
  const { variables, environmentId, ids } = environment;
  const variableId = variableIdOf;
  const credentialId = credentialIdOf;

  record("findVariableBeforeAnyWrite", await variables.findByKey(environmentId, "ALPHA"));
  record("listVariablesBeforeAnyWrite", await variables.list(environmentId));

  await environment.run(async (transaction) => {
    record(
      "upsertAlphaPlain",
      await variables.upsert(
        {
          id: variableId(ids.alphaVariableId),
          environmentId,
          key: "ALPHA",
          kind: "PLAIN",
          value: "one",
          credentialId: null,
          lastUpdatedBy: "operator-1",
          at: AT,
          expectedVersion: null,
        },
        transaction,
      ),
    );
    // THE SAME ROW AGAIN, WITH ITS OWN ID. `version` must reach 2 and
    // `createdAt` must not move: a version that silently repeats is worse than
    // no version at all, and a `createdAt` that moved would make an edit
    // indistinguishable from a re-creation.
    record(
      "upsertAlphaAgain",
      await variables.upsert(
        {
          id: variableId(ids.alphaVariableId),
          environmentId,
          key: "ALPHA",
          kind: "PLAIN",
          value: "two",
          credentialId: null,
          lastUpdatedBy: "operator-2",
          // FENCED ON 1, the version `upsertAlphaPlain` just produced. Both
          // stores must apply this and both must reach 2.
          expectedVersion: 1,
          at: LATER,
        },
        transaction,
      ),
    );
    record(
      "upsertBravoPlain",
      await variables.upsert(
        {
          id: variableId(ids.bravoVariableId),
          environmentId,
          key: "BRAVO",
          kind: "PLAIN",
          value: "three",
          credentialId: null,
          lastUpdatedBy: null,
          at: AT,
          expectedVersion: null,
        },
        transaction,
      ),
    );
    // A SECRET carries a credential and NO value. `CHARLIE_KEY` is unrevoked,
    // is a `SECRET_REFERENCE`, and already points at an active version — every
    // clause the database rule re-reads.
    record(
      "upsertCharlieSecret",
      await variables.upsert(
        {
          id: variableId(ids.charlieVariableId),
          environmentId,
          key: "CHARLIE",
          kind: "SECRET",
          value: null,
          credentialId: credentialId(ids.charlieCredentialId),
          lastUpdatedBy: "operator-1",
          at: AT,
          expectedVersion: null,
        },
        transaction,
      ),
    );
    // THE FENCE REFUSING, recorded on BOTH stores. `ALPHA` is at 2 by now, so a
    // write decided from version 1 is a writer that lost a race, and it must be
    // told so rather than being allowed to overwrite what it never read. The
    // adapter learns this from P2025 on an UPDATE that matched nothing; the
    // double learns it from a comparison. A differential over the two is the
    // only thing that shows they answer the same.
    record(
      "upsertAlphaFromStaleVersion",
      await variables.upsert(
        {
          id: variableId(ids.alphaVariableId),
          environmentId,
          key: "ALPHA",
          kind: "PLAIN",
          value: "three",
          credentialId: null,
          lastUpdatedBy: "operator-3",
          at: LATER,
          expectedVersion: 1,
        },
        transaction,
      ),
    );
    // AND THE OTHER SHAPE OF THE SAME LOSS: a caller that read NO row for a key
    // another writer has since created. `create` is refused by the compound
    // unique index, and the answer is the same conflict — an insert that
    // silently became an overwrite is the lost update wearing a different hat.
    record(
      "upsertBravoAsFreshWhenPresent",
      await variables.upsert(
        {
          id: variableId(ids.deltaVariableId),
          environmentId,
          key: "BRAVO",
          kind: "PLAIN",
          value: "four",
          credentialId: null,
          lastUpdatedBy: "operator-3",
          at: LATER,
          expectedVersion: null,
        },
        transaction,
      ),
    );
  });

  record("findAlphaVariable", await variables.findByKey(environmentId, "ALPHA"));
  record("findMissingVariable", await variables.findByKey(environmentId, "DELTA"));
  record("listVariables", await variables.list(environmentId));
  record(
    "referencesToCharlieCredential",
    await variables.countReferences(credentialId(ids.charlieCredentialId)),
  );
  record(
    "referencesToAlphaCredential",
    await variables.countReferences(credentialId(ids.alphaCredentialId)),
  );

  await environment.run(async (transaction) => {
    record(
      "removeBravo",
      await variables.remove(environmentId, variableId(ids.bravoVariableId), transaction),
    );
    // The SECOND remove is the idempotence claim: an absent row is `false`, not
    // a raised P2025 that would poison the transaction its caller is inside.
    record(
      "removeBravoAgain",
      await variables.remove(environmentId, variableId(ids.bravoVariableId), transaction),
    );
    // A read taken INSIDE the same transaction as the delete above. On the pool
    // it would still see the removed row, and `revokeIfUnreferenced` — the one
    // caller — would leave live readable material behind a variable nothing
    // points at.
    record("listVariablesInsideTransaction", await variables.list(environmentId));
  });

  record("listVariablesAfterRemove", await variables.list(environmentId));
}
