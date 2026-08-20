import { beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@platos/tenancy-database";
import { ErasureIdempotencyConflictError, ErasureService } from "./erasure.service";
import { AdminAuditService } from "../monitoring/admin-audit.service";
import type { ErasureAuditActor } from "./erasure-audit";
import type { ErasureReceipt } from "./erasure-receipt";
import { operatorTable, type Row } from "./erasure-doubles.test-fixture";
import {
  ALICE, BOB, CORPUS_SALT, ORG,
  aggregateRedisKeys, corpusBucket, corpusDatabase, corpusRedis,
  remainingKeys, subjectRedisKeys,
} from "./erasure-corpus.test-fixture";

/**
 * WIN-131 acceptance: what an operator is entitled to rely on.
 *
 * These are end-to-end statements over the real service and a seeded corpus,
 * and they are deliberately not phrased in terms of the receipt. A receipt is
 * the system's own account of what it did; accepting it as evidence for the
 * claim "the data is gone" is the failure mode the whole module was written to
 * prevent. So every assertion here reads the stores directly, and the receipt
 * is checked separately for whether it agrees with them.
 */

const actor: ErasureAuditActor = {
  credentialId: "credential_1",
  userId: "operator_7",
  environmentId: "env_eu",
  projectId: "project_eu",
};

/** Every identifier and every piece of content that must not survive. */
const ALICE_TRACES = [ALICE.external, ALICE.slack, ALICE.email, ALICE.content, ...ALICE.objects];

/**
 * Tables still naming any of `needles`, scanned row by row.
 *
 * Generic on purpose: an erasure is only as good as its least-remembered
 * table, so this looks at everything the fixture holds rather than at the list
 * of tables the sweep happens to know about.
 */
function tablesStillNaming(db: Row, needles: string[], except: string[] = []): string[] {
  const hits: string[] = [];
  for (const [name, delegate] of Object.entries(db)) {
    if (!delegate || typeof delegate !== "object") continue;
    const rows = (delegate as Row).rows;
    if (!Array.isArray(rows) || except.includes(name)) continue;
    const blob = JSON.stringify(rows);
    for (const needle of needles) if (blob.includes(needle)) hits.push(`${name}:${needle}`);
  }
  return [...new Set(hits)].sort();
}

/** Delegate name for a Prisma model, as the client exposes it. */
const delegateFor = (model: string) => model.charAt(0).toLowerCase() + model.slice(1);

/** Models whose rows belong to an end user, straight from the schema. */
function subjectKeyedModels(): string[] {
  return (Prisma as any).dmmf.datamodel.models
    .filter((m: any) => m.fields.some((f: any) => f.name === "endUserId"))
    .map((m: any) => m.name);
}

/**
 * Models whose `userId` is the PLATOS OPERATOR — the human who logs in.
 *
 * Read from the schema rather than from subject-graph.ts's constant, because
 * the constant is what a change would be checked against and the schema is
 * what a change would actually destroy.
 */
function operatorKeyedModels(): string[] {
  return (Prisma as any).dmmf.datamodel.models
    .filter((m: any) => m.fields.some((f: any) => f.name === "userId"))
    .map((m: any) => m.name);
}

describe("an erasure destroys the subject in every store", () => {
  let db: Row;
  let redis: ReturnType<typeof corpusRedis>;
  let bucket: ReturnType<typeof corpusBucket>;
  let erasure: ErasureService;

  beforeEach(() => {
    process.env.PLATOS_ERASURE_HASH_SALT = CORPUS_SALT;
    delete process.env.PLATOS_LEGAL_HOLD_USER_IDS;
    db = corpusDatabase();
    redis = corpusRedis();
    bucket = corpusBucket();
    erasure = new ErasureService(
      db as any, redis as any, bucket as any, undefined, new AdminAuditService(db as any),
    );
  });

  const sweep = (idempotencyKey = "key_1") =>
    erasure.requestErasure({
      externalUserId: ALICE.external,
      organizationId: ORG,
      idempotencyKey,
      actor,
    });

  it("reports every store as verified, or absent from this deployment", async () => {
    const receipt = await sweep();

    expect(receipt.status).toBe("completed");
    expect(receipt.stores.map((s) => [s.store, s.status, s.verificationStatus])).toEqual([
      ["minio", "done", "passed"],
      ["redis", "done", "passed"],
      // Not wired here, and reported as such rather than as a clean sweep.
      ["clickhouse", "not_provisioned", "not_applicable"],
      ["postgres", "done", "passed"],
    ]);
  });

  it("leaves no row anywhere naming the subject", async () => {
    await sweep();

    // Checked over every table in the fixture, including the ones the sweep
    // does not name — a table nobody remembered is exactly where the subject
    // survives.
    expect(tablesStillNaming(db, ALICE_TRACES)).toEqual([]);
    // The canonical uuid is allowed to survive in one place only: the operation
    // row keeps it as a resume locator, because after this pass nothing else
    // can address the subject if a store has to be re-swept.
    expect(tablesStillNaming(db, [ALICE.endUserId], ["erasureOperation"])).toEqual([]);
  });

  it("empties the keyspace and the bucket of the subject alone", async () => {
    await sweep();

    expect(remainingKeys(redis)).toEqual(
      [...subjectRedisKeys(BOB.threads, BOB.external), ...aggregateRedisKeys()].sort(),
    );
    expect([...bucket.store.keys()]).toEqual(BOB.objects);
  });

  it("keeps the tool-call audits, stripped of everything that identified them", async () => {
    const before = db.toolCallAudit.rows.length;

    await sweep();

    // Retained deliberately: they are the record that the erasure happened, so
    // they are anonymized rather than deleted. Bob's two are untouched.
    expect(db.toolCallAudit.rows).toHaveLength(before);
    const anonymized = db.toolCallAudit.rows.filter((r: Row) => r.id.startsWith("audit_alice"));
    expect(anonymized).toHaveLength(2);
    for (const row of anonymized) {
      // `Prisma.DbNull` on the way in, a plain null on the way back out — which
      // is what the sweep re-reads to prove the row came out content-free.
      expect(row).toMatchObject({
        endUserId: null,
        arguments: { __platosAudit: { userId: null, mcpUserId: null, endUserId: null } },
        result: null,
        error: null,
      });
    }
  });

  it("leaves the bystander in the same tenant whole", async () => {
    const bobBefore = JSON.stringify(
      Object.entries(db)
        .filter(([, d]) => Array.isArray((d as Row)?.rows))
        .map(([name, d]) => [name, (d as Row).rows.filter((r: Row) =>
          JSON.stringify(r).includes(BOB.endUserId) || JSON.stringify(r).includes(BOB.external))]),
    );

    await sweep();

    const bobAfter = JSON.stringify(
      Object.entries(db)
        .filter(([, d]) => Array.isArray((d as Row)?.rows))
        .map(([name, d]) => [name, (d as Row).rows.filter((r: Row) =>
          JSON.stringify(r).includes(BOB.endUserId) || JSON.stringify(r).includes(BOB.external))]),
    );
    expect(bobAfter).toBe(bobBefore);
    expect(bucket.store.has(BOB.objects[0]!)).toBe(true);
  });
});

describe("a replayed request returns the original receipt", () => {
  let db: Row;
  let redis: ReturnType<typeof corpusRedis>;
  let bucket: ReturnType<typeof corpusBucket>;
  let erasure: ErasureService;

  beforeEach(() => {
    process.env.PLATOS_ERASURE_HASH_SALT = CORPUS_SALT;
    delete process.env.PLATOS_LEGAL_HOLD_USER_IDS;
    db = corpusDatabase();
    redis = corpusRedis();
    bucket = corpusBucket();
    erasure = new ErasureService(
      db as any, redis as any, bucket as any, undefined, new AdminAuditService(db as any),
    );
  });

  const request = (externalUserId: string, idempotencyKey: string) =>
    erasure.requestErasure({ externalUserId, organizationId: ORG, idempotencyKey, actor });

  /** Everything that would move if a second destructive pass had run. */
  const work = () => ({
    transactions: db.transactions,
    redisDeletes: redis.deleteTargets.length,
    objectDeletes: bucket.deleted.length,
    operations: db.erasureOperation.rows.length,
    tombstones: db.erasureTombstone.rows.length,
    audits: db.adminAudit.rows.length,
  });

  it("hands back the first receipt and runs nothing a second time", async () => {
    const first = await request(ALICE.external, "key_1");
    const afterFirst = work();

    const replay = await request(ALICE.external, "key_1");

    // The ORIGINAL receipt, down to the attempt count and the completion time:
    // a replay that re-swept would report a second pass's counts for work that
    // finished the first time round.
    expect(replay).toEqual<ErasureReceipt>(first);
    expect(work()).toEqual(afterFirst);
  });

  it("refuses a key already bound to another subject, and sweeps nobody", async () => {
    await request(ALICE.external, "key_1");
    const afterFirst = work();

    await expect(request(BOB.external, "key_1")).rejects.toBeInstanceOf(
      ErasureIdempotencyConflictError,
    );

    // Bob is untouched: the conflict is detected from the stored subject hash,
    // before discovery and before any executor.
    expect(work()).toMatchObject({
      transactions: afterFirst.transactions,
      redisDeletes: afterFirst.redisDeletes,
      objectDeletes: afterFirst.objectDeletes,
      operations: afterFirst.operations,
      tombstones: afterFirst.tombstones,
    });
    expect(db.endUser.rows.map((r: Row) => r.id)).toEqual([BOB.endUserId]);
  });
});

describe("a legal hold blocks before any store is touched", () => {
  let db: Row;
  let redis: ReturnType<typeof corpusRedis>;
  let bucket: ReturnType<typeof corpusBucket>;
  let erasure: ErasureService;

  beforeEach(() => {
    process.env.PLATOS_ERASURE_HASH_SALT = CORPUS_SALT;
    db = corpusDatabase();
    redis = corpusRedis();
    bucket = corpusBucket();
    erasure = new ErasureService(
      db as any, redis as any, bucket as any, undefined, new AdminAuditService(db as any),
    );
  });

  const sweep = () =>
    erasure.requestErasure({
      externalUserId: ALICE.external,
      organizationId: ORG,
      idempotencyKey: "key_hold",
      actor,
    });

  it("blocks a request made under an alias the register does not name", async () => {
    // The register names the Slack handle. The request names the Walle external
    // id. Same person — and a hold that only stops the identifier it was
    // written under leaves every held subject erasable through any other one.
    process.env.PLATOS_LEGAL_HOLD_USER_IDS = ALICE.slack;

    const receipt = await sweep();

    expect(receipt.status).toBe("blocked_legal_hold");
    expect(receipt.stores).toEqual([]);
  });

  it("blocks on a disabled alias too", async () => {
    // The email identity is already disabled. The rows behind it are still the
    // subject's, and the sweep would still delete them.
    process.env.PLATOS_LEGAL_HOLD_USER_IDS = `someone-else, ${ALICE.email}`;

    await expect(sweep()).resolves.toMatchObject({ status: "blocked_legal_hold" });
  });

  it("touches no store and seals no tombstone while the hold stands", async () => {
    process.env.PLATOS_LEGAL_HOLD_USER_IDS = ALICE.slack;
    const rowsBefore = JSON.stringify(db.endUser.rows);

    await sweep();

    expect(db.transactions).toBe(0);
    expect(redis.deleteTargets).toEqual([]);
    expect(bucket.deleted).toEqual([]);
    expect(JSON.stringify(db.endUser.rows)).toBe(rowsBefore);
    // No barrier either: refusing writes for a subject nobody is allowed to
    // erase would be a second, quieter harm.
    expect(db.erasureTombstone.rows).toEqual([]);
  });

  it("records the refusal, with the register entry as its only identifier", async () => {
    process.env.PLATOS_LEGAL_HOLD_USER_IDS = ALICE.slack;

    const receipt = await sweep();

    const refusals = db.adminAudit.rows.filter(
      (r: Row) => r.action === "privacy.erasure.refused",
    );
    expect(refusals.length).toBeGreaterThan(0);
    for (const row of [...refusals, receipt]) {
      // The matched entry is named on purpose: "blocked" with no reason is
      // indistinguishable from a bug, and an operator has to be able to find
      // which line of their own register did it. It is also the ONLY identifier
      // permitted anywhere in these records — and it is permitted here because
      // nothing was destroyed. The content-free rule exists to stop a receipt
      // outliving the data it documents; a held subject's data is, by
      // definition, the data being kept.
      const payload = (row as Row).after ?? row;
      expect(payload.legalHoldPolicyId).toBe(ALICE.slack);
      const withoutHold = JSON.stringify({ ...payload, legalHoldPolicyId: null });
      for (const trace of ALICE_TRACES) expect(withoutHold).not.toContain(trace);
    }
    for (const row of refusals) {
      expect(row.subjectId).toBe(receipt.subjectKeyHash);
      expect(row.reason).toBe("legal hold in force");
    }
  });

  it("does not block a subject nobody registered", async () => {
    process.env.PLATOS_LEGAL_HOLD_USER_IDS = `${BOB.external}, someone-else`;

    await expect(sweep()).resolves.toMatchObject({ status: "completed" });
  });
});

describe("operator data is never mistaken for the subject's", () => {
  let db: Row;
  let erasure: ErasureService;

  beforeEach(() => {
    process.env.PLATOS_ERASURE_HASH_SALT = CORPUS_SALT;
    delete process.env.PLATOS_LEGAL_HOLD_USER_IDS;
    db = corpusDatabase();
    // The worst case, not a comfortable one: an operator whose `userId` is
    // character-for-character the id the erasure was requested under. A sweep
    // that deleted by column name rather than by table would take their
    // account, their tokens and their MFA recovery codes with it.
    for (const model of operatorKeyedModels()) {
      db[delegateFor(model)] = operatorTable(model, [
        { id: `${model}_row`, userId: ALICE.external, organizationId: ORG },
      ]);
    }
    erasure = new ErasureService(
      db as any, corpusRedis() as any, corpusBucket() as any, undefined,
      new AdminAuditService(db as any),
    );
  });

  const sweep = () =>
    erasure.requestErasure({
      externalUserId: ALICE.external,
      organizationId: ORG,
      idempotencyKey: "key_1",
      actor,
    });

  it("keeps the two userId namespaces apart in the schema itself", () => {
    // The premise of the test below. `userId` is not one namespace — on the
    // end-user tables it means the subject, on these it means the human who
    // logs in to the dashboard — and a model carrying both columns would make
    // the two sweeps' claims about it contradictory.
    const both = subjectKeyedModels().filter((m) => operatorKeyedModels().includes(m));
    expect(both).toEqual([]);
  });

  it("leaves every operator-owned table untouched", async () => {
    const receipt = await sweep();

    for (const model of operatorKeyedModels()) {
      const delegate = db[delegateFor(model)];
      expect([model, ...delegate.destructive]).toEqual([model]);
      expect(delegate.rows).toHaveLength(1);
    }
    // Not vacuous: the sweep ran, over the same organization, to completion.
    expect(receipt.status).toBe("completed");
  });

  it("sweeps every table the schema says belongs to an end user", async () => {
    await sweep();

    // Derived from the schema, not from a list in this repo that a new model
    // would not be added to: a table that grows an endUserId column and is not
    // wired into the executor fails here rather than silently retaining data.
    const missed = subjectKeyedModels().filter(
      (model) => (db[delegateFor(model)]?.destructive ?? []).length === 0,
    );
    expect(missed).toEqual([]);
  });
});

describe("the receipt is content-free", () => {
  let db: Row;
  let erasure: ErasureService;
  let receipt: ErasureReceipt;

  beforeEach(async () => {
    process.env.PLATOS_ERASURE_HASH_SALT = CORPUS_SALT;
    delete process.env.PLATOS_LEGAL_HOLD_USER_IDS;
    db = corpusDatabase();
    erasure = new ErasureService(
      db as any, corpusRedis() as any, corpusBucket() as any, undefined,
      new AdminAuditService(db as any),
    );
    receipt = await erasure.requestErasure({
      externalUserId: ALICE.external,
      organizationId: ORG,
      idempotencyKey: "key_1",
      actor,
    });
  });

  it("carries no identifier and no content, in any field", async () => {
    const serialized = JSON.stringify(receipt);

    for (const trace of [...ALICE_TRACES, ALICE.endUserId, ...ALICE.threads]) {
      expect(serialized).not.toContain(trace);
    }
  });

  it("identifies the subject only by a salted, organization-scoped hash", async () => {
    expect(receipt.subjectKeyHash).toMatch(/^[0-9a-f]{64}$/);
    // Salted: the same person in another deployment hashes differently, so the
    // receipt cannot be used as a lookup table of who was erased.
    const elsewhere = new ErasureService(db as any, corpusRedis() as any);
    process.env.PLATOS_ERASURE_HASH_SALT = "a-different-deployment";
    const rehashed = new ErasureService(db as any, corpusRedis() as any);
    expect((elsewhere as any).hash(ALICE.external, ORG)).toBe(receipt.subjectKeyHash);
    expect((rehashed as any).hash(ALICE.external, ORG)).not.toBe(receipt.subjectKeyHash);
    expect((elsewhere as any).hash(ALICE.external, "org_other")).not.toBe(receipt.subjectKeyHash);
  });

  it("says what happened in counts, statuses and error classes", async () => {
    const notes = Object.fromEntries(receipt.stores.map((s) => [s.store, s.note ?? ""]));

    expect(notes.minio).toBe("verified 3/3 objects absent");
    expect(notes.redis).toMatch(/^21 deleted, 0 aggregate keys retained \(4 patterns\); 0 survivors$/);
    expect(notes.postgres).toMatch(
      /^verification: threads=0 memories=0 audits=0 safetyEvents=0 endUsers=0$/,
    );
  });

  it("does not put the identifier in the durable record either", async () => {
    const operation = db.erasureOperation.rows[0]!;

    expect(JSON.stringify(operation)).not.toContain(ALICE.external);
    expect(operation.subjectKeyHash).toBe(receipt.subjectKeyHash);
  });
});
