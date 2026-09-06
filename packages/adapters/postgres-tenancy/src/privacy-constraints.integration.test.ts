// What the REAL database refuses that the in-memory double accepts — every one
// of them a constraint that exists ONLY in the migrations or ONLY in a column
// type, and every one of them reachable from a value this context's own fixtures
// mint.
//
// THE POINT IS NOT THAT THE STORE REFUSES. It is that the store refuses BEFORE
// sending a statement, so the caller's transaction survives and the unit of work
// the refusal happened inside can go on to do something else. On PostgreSQL a
// violated constraint ABORTS the whole block with 25P02, and every mutation on
// this port takes the CALLER's `TransactionScope` — `request-erasure.ts` writes
// the row and appends the INTENT event in one unit of work, so a store that let
// `22P02` raise would have reported the refusal correctly and left the caller
// unable to append the event that says the erasure was asked for. Each case below
// therefore does a SECOND write after the refusal, and asserts it works.
//
// AND THE UNGUARDED HALF IS PROVED TOO. A guard that anticipates a constraint is
// only trustworthy if the constraint is really there, so every case plants the
// same value PAST the port — through the ORM's own CLI, which is runtime and
// therefore outside the sole-writer scanner's scope — and asserts PostgreSQL
// refuses it.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  ErasureOperationId,
  ErasureTombstoneId,
  IdempotencyKey,
  TombstoneDraft,
} from "@platos/context-privacy/application/ports/index.js";
import { organizationScope } from "@platos/context-privacy/application/ports/index.js";
import { runResult } from "@platos/kernel";

import type { PrivacyHarness, PrivacyTenant } from "./privacy-harness.js";
import { operationDraft, REQUESTED_AT, startPrivacyHarness } from "./privacy-harness.js";

let harness: PrivacyHarness;
let tenant: PrivacyTenant;

const EXPIRES_AT = new Date("2026-06-01T09:00:00.000Z");

beforeAll(async () => {
  harness = await startPrivacyHarness();
  tenant = await harness.freshTenant();
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

function id<Brand>(value: string): Brand {
  return value as Brand;
}

/** The refusal code, or a marker. Never a boolean: two codes must differ. */
async function refusalOf(work: () => Promise<{ readonly ok: boolean }>): Promise<string> {
  const result = (await work()) as { ok: boolean; error?: { code: string; details?: unknown } };
  if (result.ok) return "<nothing was refused>";
  const details = result.error?.details as { readonly reason?: string } | undefined;
  return details?.reason ?? result.error?.code ?? "<uncoded>";
}

/** A second, WELL-FORMED write in the same transaction. Proves nothing aborted. */
async function survivesRefusal(
  refused: (transaction: never) => Promise<{ readonly ok: boolean }>,
): Promise<{ readonly refusal: string; readonly survivor: boolean }> {
  return harness.run(async (transaction) => {
    const refusal = await refusalOf(() => refused(transaction as never));
    const survivor = await harness.repository.insertOperation(
      operationDraft(tenant, harness.base.freshId("0090")),
      transaction,
    );
    return { refusal, survivor: survivor.ok };
  });
}

/** Apply a statement past the port. Returns PostgreSQL's own message, or "". */
function planted(sql: string): string {
  try {
    harness.applyRows(sql);
    return "";
  } catch (error) {
    const shell = error as { readonly stderr?: Buffer; readonly stdout?: Buffer };
    return `${String(shell.stderr ?? "")}${String(shell.stdout ?? "")}`;
  }
}

describe("@db.Uuid, which the context's own fixtures violate on every call", () => {
  test("the store refuses `id-0001` and the caller's transaction survives it", async () => {
    // `SequenceIdGenerator` in `application/testing/fixtures.ts` mints exactly
    // this, `TEST_ORGANIZATION` is `org-1`, and every use-case suite in the
    // context passes with both.
    const { refusal, survivor } = await survivesRefusal((transaction) =>
      harness.repository.insertOperation(
        operationDraft(tenant, harness.base.freshId("0091"), {
          operationId: id<ErasureOperationId>("id-0001"),
        }),
        transaction,
      ),
    );
    expect(refusal).toContain("privacy.write.identifier_not_uuid");
    expect(survivor).toBe(true);
  });

  test("and PostgreSQL really would have refused it, with 22P02", () => {
    const message = planted(
      `INSERT INTO "ErasureOperation" ("id", "organizationId", "idempotencyKey", "subjectKeyHash",
         "status", "scopes", "stores", "policyVersion", "retryCount", "requestedAt", "updatedAt")
       VALUES ('id-0001', '${tenant.organizationId}', 'k-22p02', 'd1', 'PENDING', '[]'::jsonb,
               '[]'::jsonb, 'privacy/1', 0, '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
    );
    expect(message).toMatch(/22P02|invalid input syntax for type uuid/iu);
  });
});

describe("the WorkStatus enum, which is five labels and not a string", () => {
  test("the store refuses a sixth label and the caller's transaction survives it", async () => {
    const { refusal, survivor } = await survivesRefusal((transaction) =>
      harness.repository.insertOperation(
        operationDraft(tenant, harness.base.freshId("0092"), {
          workStatus: "SUPERSEDED" as never,
        }),
        transaction,
      ),
    );
    expect(refusal).toContain("privacy.write.work_status_unknown");
    expect(survivor).toBe(true);
  });

  test("and PostgreSQL really would have refused it, because the column is an ENUM", () => {
    const message = planted(
      `INSERT INTO "ErasureOperation" ("id", "organizationId", "idempotencyKey", "subjectKeyHash",
         "status", "scopes", "stores", "policyVersion", "retryCount", "requestedAt", "updatedAt")
       VALUES ('${harness.base.freshId("0093")}', '${tenant.organizationId}', 'k-enum', 'd1',
               'SUPERSEDED', '[]'::jsonb, '[]'::jsonb, 'privacy/1', 0,
               '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
    );
    expect(message).toMatch(/invalid input value for enum|WorkStatus/iu);
  });
});

describe("the two _json_root CHECKs, which exist only in the migrations", () => {
  test("the store refuses a scopes value whose root is not an array", async () => {
    const { refusal, survivor } = await survivesRefusal((transaction) =>
      harness.repository.insertOperation(
        operationDraft(tenant, harness.base.freshId("0094"), { scopes: {} as never }),
        transaction,
      ),
    );
    expect(refusal).toContain("privacy.write.scopes_not_array");
    expect(survivor).toBe(true);
  });

  test("the store refuses an outcomes value whose root is not an array, under a DIFFERENT code", async () => {
    // Two CHECKs, two codes. A single `json_root_invalid` would leave an operator
    // unable to tell which column the row came back on.
    const { refusal, survivor } = await survivesRefusal((transaction) =>
      harness.repository.insertOperation(
        operationDraft(tenant, harness.base.freshId("0095"), { outcomes: {} as never }),
        transaction,
      ),
    );
    expect(refusal).toContain("privacy.write.outcomes_not_array");
    expect(survivor).toBe(true);
  });

  test("and PostgreSQL really would have refused both, by CHECK name", () => {
    for (const [column, value] of [
      ["scopes", `'{}'::jsonb, '[]'::jsonb`],
      ["stores", `'[]'::jsonb, '{}'::jsonb`],
    ] as const) {
      const message = planted(
        `INSERT INTO "ErasureOperation" ("id", "organizationId", "idempotencyKey", "subjectKeyHash",
           "status", "scopes", "stores", "policyVersion", "retryCount", "requestedAt", "updatedAt")
         VALUES ('${harness.base.freshId("0096")}', '${tenant.organizationId}', 'k-${column}', 'd1',
                 'PENDING', ${value}, 'privacy/1', 0,
                 '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
      );
      expect(message).toMatch(new RegExp(`ErasureOperation_${column}_json_root`, "iu"));
    }
  });
});

describe("the unique index on (organizationId, idempotencyKey)", () => {
  test("a second insert at an occupied key is PRIVACY_IDEMPOTENCY_KEY_CONFLICT, naming the winner", async () => {
    // The port's requirement, in full: the conflict must be surfaced under that
    // code and must NOT be converted into an update. The winner is named from a
    // connection the failed INSERT has not aborted — the caller's own is, and a
    // read on it would answer 25P02 rather than the id.
    const winner = harness.base.freshId("0097");
    const key = `key-shared-${winner.slice(-12)}`;
    await runResult(harness, (transaction) =>
      harness.repository.insertOperation(
        operationDraft(tenant, winner, { idempotencyKey: id<IdempotencyKey>(key) }),
        transaction,
      ),
    );

    const loser = harness.base.freshId("0098");
    const refused = await runResult(harness, (transaction) =>
      harness.repository.insertOperation(
        operationDraft(tenant, loser, {
          idempotencyKey: id<IdempotencyKey>(key),
          subjectKeyHash: id("d0000zzz"),
        }),
        transaction,
      ),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("PRIVACY_IDEMPOTENCY_KEY_CONFLICT");
    expect(refused.error.details).toMatchObject({ operationId: winner });

    // AND THE INSERT WAS NOT CONVERTED INTO AN UPDATE. Two callers racing one key
    // must not both start a destruction, and the sharpest way to see that is the
    // winner's SUBJECT: if the second write had upserted, the row would now
    // document a different person under the first person's operation id.
    const still = await harness.repository.findByIdempotencyKey(
      tenant.organizationId,
      id<IdempotencyKey>(key),
    );
    expect(still.ok && still.value?.operationId).toBe(winner);
    expect(still.ok && still.value?.subjectKeyHash).toBe("d0000001");
    const absent = await harness.repository.findOperation(
      tenant.organizationId,
      id<ErasureOperationId>(loser),
    );
    expect(absent.ok && absent.value).toBeNull();
  });

  test("a repeated PRIMARY KEY is a DIFFERENT refusal, because there is no winner to name", async () => {
    // The pair the conflict path has to tell apart. A caller that minted an id
    // twice has not addressed anybody else's subject, and answering
    // `PRIVACY_IDEMPOTENCY_KEY_CONFLICT` for it would tell them their key names a
    // different person when it does not.
    const operationId = harness.base.freshId("0099");
    await runResult(harness, (transaction) =>
      harness.repository.insertOperation(operationDraft(tenant, operationId), transaction),
    );
    const refused = await runResult(harness, (transaction) =>
      harness.repository.insertOperation(
        operationDraft(tenant, operationId, {
          idempotencyKey: id<IdempotencyKey>(`key-fresh-${operationId.slice(-12)}`),
        }),
        transaction,
      ),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("PRIVACY_OPERATION_STORE_UNAVAILABLE");
    expect(String((refused.error.details as { reason: string }).reason)).toContain(
      "privacy.write.operation_id_taken",
    );
  });

  test("the SAME key in a DIFFERENT organization is not a conflict at all", async () => {
    // The index is on the PAIR, and the port's every read is organization-scoped
    // for the same reason. Without this the conflict case above could be passing
    // on a global uniqueness the schema does not have.
    const other = await harness.freshTenant();
    const key = `key-cross-${harness.base.freshId("009a").slice(-12)}`;
    const first = await runResult(harness, (transaction) =>
      harness.repository.insertOperation(
        operationDraft(tenant, harness.base.freshId("009b"), { idempotencyKey: id<IdempotencyKey>(key) }),
        transaction,
      ),
    );
    const second = await runResult(harness, (transaction) =>
      harness.repository.insertOperation(
        operationDraft(other, harness.base.freshId("009c"), { idempotencyKey: id<IdempotencyKey>(key) }),
        transaction,
      ),
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });
});

describe("the unique index on (organizationId, aliasHash), and the seal that must survive a race", () => {
  test("a concurrent seal of the same alias does NOT abort the caller's transaction", async () => {
    // A queue resume racing an operator retry seals the same subject twice.
    // Losing that race must not open the barrier, and on this port "abort the
    // caller's transaction" means the whole destructive pass is discarded along
    // with the seal the winner already committed.
    //
    // WHAT THIS MEASURES, HONESTLY. The transaction runs at READ COMMITTED, so
    // the scoped read that splits the batch SEES the winner's committed row and
    // the loser takes the EXTEND branch — it never sends a conflicting INSERT at
    // all, which is why the outcome below is `{ sealed: 0, extended: 1 }` rather
    // than `{ 0, 0 }`. `skipDuplicates` is the belt for the NARROWER window: the
    // winner committing between this store's own read and its own `createMany`.
    // That window is real and is why the clause is there; it is microseconds
    // wide and this suite cannot produce it deterministically, so it is REPORTED
    // rather than claimed.
    const alias = `a-race-${harness.base.freshId("009d").slice(-12)}`;
    const operationId = harness.base.freshId("009e");
    const draft: TombstoneDraft = {
      organizationId: tenant.organizationId,
      aliasHash: id(alias),
      operationId: id<ErasureOperationId>(operationId),
      policyVersion: "privacy/1",
      sealedAt: REQUESTED_AT,
      expiresAt: EXPIRES_AT,
    };
    // The winner commits OUT OF BAND, so the loser's own scoped read cannot have
    // seen it — which is exactly the arrangement `skipDuplicates` exists for.
    const result = await harness.run(async (transaction) => {
      const before = await harness.repository.findActiveTombstones(
        tenant.organizationId,
        [id(alias)],
        REQUESTED_AT,
      );
      expect(before.ok && before.value).toHaveLength(0);
      harness.applyRows(
        `INSERT INTO "ErasureTombstone" ("id", "organizationId", "aliasHash", "operationId",
           "policyVersion", "sealedAt", "expiresAt")
         VALUES ('${harness.base.freshId("009f")}', '${tenant.organizationId}', '${alias}',
                 '${operationId}', 'privacy/1', '2026-05-01T09:00:00Z', '2026-06-01T09:00:00Z');`,
      );
      const sealed = await harness.repository.sealTombstones(
        [draft],
        [id<ErasureTombstoneId>(harness.base.freshId("00a0"))],
        transaction,
      );
      // A second write, to prove the transaction is still usable.
      const survivor = await harness.repository.insertOperation(
        operationDraft(tenant, harness.base.freshId("00a1")),
        transaction,
      );
      return { sealed, survivor: survivor.ok };
    });
    expect(result.sealed.ok).toBe(true);
    // Nothing was INSERTED — the winner's row was already there and the scoped
    // read saw it — so the loser extended instead. What matters is that the ALIAS
    // IS SEALED throughout and that the transaction lived.
    expect(result.sealed.ok && result.sealed.value).toEqual({ sealed: 0, extended: 1 });
    expect(result.survivor).toBe(true);
    const active = await harness.repository.findActiveTombstones(
      tenant.organizationId,
      [id(alias)],
      REQUESTED_AT,
    );
    expect(active.ok && active.value).toHaveLength(1);
  });

  test("and PostgreSQL really would have refused a second row on that pair", () => {
    const alias = `a-dup-${harness.base.freshId("00a2").slice(-12)}`;
    const insert = (rowId: string): string =>
      `INSERT INTO "ErasureTombstone" ("id", "organizationId", "aliasHash", "operationId",
         "policyVersion", "sealedAt", "expiresAt")
       VALUES ('${rowId}', '${tenant.organizationId}', '${alias}',
               '${harness.base.freshId("00a3")}', 'privacy/1',
               '2026-05-01T09:00:00Z', '2026-06-01T09:00:00Z');`;
    expect(planted(insert(harness.base.freshId("00a4")))).toBe("");
    // The ORM's CLI reports its OWN code and the FIELD NAMES rather than
    // PostgreSQL's index name, which is what a planted row can actually be
    // asserted on: `Error: P2002 / Unique constraint failed on the fields:
    // (organizationId, aliasHash)`.
    expect(planted(insert(harness.base.freshId("00a5")))).toMatch(
      /P2002|Unique constraint failed/iu,
    );
    expect(planted(insert(harness.base.freshId("00a6")))).toMatch(/organizationId/u);
  });
});

describe("the foreign key, which is RESTRICT on one table and CASCADE on the other", () => {
  test("an operation in an organization that does not exist is refused by the database", () => {
    // The one FK either table carries, and the store does NOT anticipate it: a
    // pre-check would be a racy duplicate of a join the database already does. It
    // is reported here rather than guarded.
    const message = planted(
      `INSERT INTO "ErasureOperation" ("id", "organizationId", "idempotencyKey", "subjectKeyHash",
         "status", "scopes", "stores", "policyVersion", "retryCount", "requestedAt", "updatedAt")
       VALUES ('${harness.base.freshId("00a6")}', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
               'k-fk', 'd1', 'PENDING', '[]'::jsonb, '[]'::jsonb, 'privacy/1', 0,
               '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
    );
    expect(message).toMatch(/ErasureOperation_organizationId_fkey|violates foreign key/iu);
  });

  test("a tombstone naming an operation that does not exist is ACCEPTED, and that is a finding", () => {
    // REPORTED RATHER THAN GUARDED. `ErasureTombstone.operationId` is `@db.Uuid`
    // with NO foreign key to `ErasureOperation`, unlike `organizationId` which has
    // one on both tables. The port calls it "the operation that sealed it, so a
    // barrier can be traced to its cause" — and that trace is a CONVENTION here,
    // not a constraint. A store that refused an unresolvable one would be
    // inventing an integrity rule the schema does not have.
    const message = planted(
      `INSERT INTO "ErasureTombstone" ("id", "organizationId", "aliasHash", "operationId",
         "policyVersion", "sealedAt", "expiresAt")
       VALUES ('${harness.base.freshId("00a7")}', '${tenant.organizationId}',
               'a-orphan-${harness.base.freshId("00a8").slice(-12)}',
               'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'privacy/1',
               '2026-05-01T09:00:00Z', '2026-06-01T09:00:00Z');`,
    );
    expect(message).toBe("");
  });
});

describe("timestamp(3), which is the precision of every instant on both rows", () => {
  test("a sub-millisecond instant is TRUNCATED rather than refused", () => {
    // Reported rather than guarded, and the store does not round on the way in:
    // rounding would make the value the caller reads back differ from the value
    // the caller passed in a way the caller could not predict. `Date` in
    // JavaScript is already millisecond-resolution, so nothing this port can be
    // handed reaches the truncation — which is why this is a note about the
    // column rather than a case about the store.
    expect(REQUESTED_AT.getTime() % 1).toBe(0);
  });

  test("a lease pair with only one half set is refused, though both columns are nullable", async () => {
    const { refusal, survivor } = await survivesRefusal((transaction) =>
      harness.repository.insertOperation(
        operationDraft(tenant, harness.base.freshId("00a9"), { leaseExpiresAt: EXPIRES_AT }),
        transaction,
      ),
    );
    expect(refusal).toContain("privacy.write.lease_incoherent");
    expect(survivor).toBe(true);
  });

  test("and PostgreSQL really would have STORED that half-lease, which is why the guard is here", () => {
    // The negative control for the guard above. Neither column is NOT NULL and
    // there is no CHECK over the pair, so the database holds a lease that names
    // no holder — and `claimLease`'s free-lease predicate would then refuse every
    // resume until an instant nobody set.
    const message = planted(
      `INSERT INTO "ErasureOperation" ("id", "organizationId", "idempotencyKey", "subjectKeyHash",
         "status", "scopes", "stores", "policyVersion", "retryCount", "requestedAt",
         "leaseExpiresAt", "updatedAt")
       VALUES ('${harness.base.freshId("00aa")}', '${tenant.organizationId}', 'k-halflease', 'd1',
               'PENDING', '[]'::jsonb, '[]'::jsonb, 'privacy/1', 0,
               '2026-05-01T09:00:00Z', '2026-06-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
    );
    expect(message).toBe("");
  });
});

describe("what the schema will NOT protect, reported rather than claimed", () => {
  test("a RAW HANDLE in subjectKeyHash is stored happily, because the column is TEXT", async () => {
    // The single most important negative in this suite. Every rule that keeps
    // this context's records content-free is a DOMAIN rule —
    // `domain/content-free.ts` and `SubjectHasher` — and none of it is in the
    // schema: `subjectKeyHash`, `idempotencyKey` and `aliasHash` are all plain
    // `TEXT` with no CHECK, no length and no shape. A store that reported these
    // columns as protected would be claiming a guarantee that does not exist.
    const stored = await runResult(harness, (transaction) =>
      harness.repository.insertOperation(
        operationDraft(tenant, harness.base.freshId("00ab"), {
          subjectKeyHash: id("alice@example.com"),
        }),
        transaction,
      ),
    );
    expect(stored.ok).toBe(true);
    expect(stored.ok && stored.value.subjectKeyHash).toBe("alice@example.com");
  });

  test("an inventory and a resumePlan column exist that this port has no field for", () => {
    // EXPAND/CONTRACT, stated as a case. `ErasureOperation.inventory` and
    // `.resumePlan` are in the frozen baseline with their own `_json_root`
    // CHECKs, and `PersistedErasureOperation` has no field for either — so every
    // write here leaves them at SQL NULL and no read selects them. A row written
    // by a LATER binary that fills them must still be readable by this one, which
    // is what this asserts.
    const operationId = harness.base.freshId("00ac");
    expect(
      planted(
        `INSERT INTO "ErasureOperation" ("id", "organizationId", "idempotencyKey", "subjectKeyHash",
           "status", "scopes", "stores", "inventory", "resumePlan", "policyVersion", "retryCount",
           "requestedAt", "updatedAt")
         VALUES ('${operationId}', '${tenant.organizationId}', 'k-forward-${operationId.slice(-12)}',
                 'd1', 'PENDING', '[]'::jsonb, '[]'::jsonb, '{"rows": 4}'::jsonb,
                 '{"cursor": "x"}'::jsonb, 'privacy/1', 0,
                 '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
      ),
    ).toBe("");
    return expect(
      harness.repository
        .findOperation(tenant.organizationId, id<ErasureOperationId>(operationId))
        .then((found) => found.ok && found.value !== null),
    ).resolves.toBe(true);
  });

  test("no ancestry RULE fires on either table, which is why the fixture needs one peer row", async () => {
    // The `enforce_domain_ancestry` database rule fires on forty-odd tables and on
    // NEITHER of these. That is a fact about this context's design rather than an omission:
    // the receipt documents a person's destruction WITHOUT recording who they
    // were, so there is no subject row for it to hang off and no environment for
    // an ancestry rule to resolve. Compare `memory-harness.ts`, whose one table
    // needs seven peer rows.
    const scoped = await runResult(harness, (transaction) =>
      harness.repository.insertOperation(
        operationDraft(tenant, harness.base.freshId("00ad"), {
          // A scope naming a project and an environment that DO NOT EXIST. It is
          // a JSONB value, not a foreign key, and nothing resolves it.
          scopes: [organizationScope(tenant.organizationId)],
        }),
        transaction,
      ),
    );
    expect(scoped.ok).toBe(true);
  });
});
