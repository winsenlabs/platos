import { beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@platos/tenancy-database";
import { ErasureIdempotencyConflictError, ErasureService } from "./erasure.service";
import { AdminAuditService } from "../monitoring/admin-audit.service";
import { LEASE_TTL_MS } from "./erasure-queue";
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

    // The ORIGINAL receipt, down to the retry count and the completion time:
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

  it("records the refusal, naming the register entry without quoting it", async () => {
    process.env.PLATOS_LEGAL_HOLD_USER_IDS = `someone-else, ${ALICE.slack}`;

    const receipt = await sweep();

    const refusals = db.adminAudit.rows.filter(
      (r: Row) => r.action === "privacy.erasure.refused",
    );
    expect(refusals.length).toBeGreaterThan(0);
    for (const row of [...refusals, receipt]) {
      // The matched entry is NAMED but not QUOTED: "blocked" with no reason is
      // indistinguishable from a bug, and an operator has to be able to find
      // which line of their own register did it — the second line, here. What
      // they must not be handed is the entry itself, because a register is
      // written by a human and its entries are the subject's own handles. A
      // held subject's data is kept; their Slack id still has no business being
      // copied into an erasure record that outlives every other trace of them.
      const payload = (row as Row).after ?? row;
      expect(payload.legalHoldPolicyId).toBe("legal-hold-register#2:" +
        receipt.legalHoldPolicyId!.split(":")[1]);
      for (const trace of ALICE_TRACES) expect(JSON.stringify(payload)).not.toContain(trace);
    }
    for (const row of refusals) {
      expect(row.subjectId).toBe(receipt.subjectKeyHash);
      expect(row.reason).toBe("legal hold in force");
    }
    // Durable too. The operation row outlives the request, and this is the one
    // field that used to carry a raw handle into it.
    expect(JSON.stringify(db.erasureOperation.rows)).not.toContain(ALICE.slack);
  });

  it("records the refusal when the hold names the id the erasure was requested under", async () => {
    // The common case, and the one that used to leave no trail at all. The
    // matched entry WAS the requested id, so a refusal quoting it tripped the
    // content-free guard, the guard threw, and `auditBestEffort` swallowed the
    // throw into a log line — so the trail recorded a hold registered under an
    // alias and silently dropped one registered under the subject's own id.
    process.env.PLATOS_LEGAL_HOLD_USER_IDS = ALICE.external;

    const receipt = await sweep();

    expect(receipt.status).toBe("blocked_legal_hold");
    const refusals = db.adminAudit.rows.filter(
      (r: Row) => r.action === "privacy.erasure.refused",
    );
    // One per environment the subject appears in, as every erasure record is:
    // an operator reading environment US's log has to see the refusal too.
    expect(refusals.map((r: Row) => r.environmentId)).toEqual(["env_eu", "env_us"]);
    expect(refusals[0]!.reason).toBe("legal hold in force");
    expect(JSON.stringify(refusals)).not.toContain(ALICE.external);
    // And the subject is still there, which is what the trail is a record of.
    expect(db.endUser.rows.map((r: Row) => r.id)).toContain(ALICE.endUserId);
  });

  it("does not block a subject nobody registered", async () => {
    process.env.PLATOS_LEGAL_HOLD_USER_IDS = `${BOB.external}, someone-else`;

    await expect(sweep()).resolves.toMatchObject({ status: "completed" });
  });
});

describe("a hold filed after the operation exists still stops the queue", () => {
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

  /**
   * An erasure that was requested and never ran.
   *
   * The intent record raises rather than degrading — if we cannot record who
   * asked for an irreversible deletion we do not perform it — so an unhealthy
   * audit sink leaves the row PENDING, due, and nominated for the queue. That
   * is the designed recovery, and it is what opens the window this test is
   * about: the operation now outlives the moment its holds were checked.
   */
  async function requestThatNeverRan() {
    const realCreate = db.adminAudit.create;
    db.adminAudit.create = async () => {
      throw new Error("audit sink unavailable");
    };
    await expect(
      erasure.requestErasure({
        externalUserId: ALICE.external,
        organizationId: ORG,
        idempotencyKey: "key_1",
        actor,
      }),
    ).rejects.toThrow(/audit sink unavailable/);
    db.adminAudit.create = realCreate;
    return db.erasureOperation.rows[0]!;
  }

  it("refuses to drain an operation counsel put on hold in the meantime", async () => {
    const row = await requestThatNeverRan();
    // Nothing was destroyed, which is what makes the hold meaningful.
    expect(db.endUser.rows.map((r: Row) => r.id)).toContain(ALICE.endUserId);
    // Counsel files the hold under the handle they know the person by.
    process.env.PLATOS_LEGAL_HOLD_USER_IDS = ALICE.slack;

    const resumed = await erasure.resumeDueErasures({
      organizationId: ORG,
      actor,
      // Past the lease the aborted request left behind.
      now: new Date(Date.now() + LEASE_TTL_MS + 1000),
    });

    expect(resumed).toEqual([
      { operationId: row.id, status: "blocked_legal_hold", retryCount: 0 },
    ]);
    // The register is consulted on every pass, not once at request time: an
    // automated drain has no human in it to notice a hold nobody re-checked.
    expect(tablesStillNaming(db, ALICE_TRACES, ["adminAudit"])).not.toEqual([]);
    expect(db.endUser.rows.map((r: Row) => r.id)).toContain(ALICE.endUserId);
    expect(db.memory.rows.filter((r: Row) => r.endUserId === ALICE.endUserId)).toHaveLength(2);
    expect(db.transactions).toBe(0);
    expect(redis.deleteTargets).toEqual([]);
    expect(bucket.deleted).toEqual([]);
    // No barrier either: a subject nobody is allowed to erase must not be
    // tombstoned out of their own account.
    expect(db.erasureTombstone.rows).toEqual([]);
  });

  it("takes the held operation out of the queue and says which entry did it", async () => {
    await requestThatNeverRan();
    process.env.PLATOS_LEGAL_HOLD_USER_IDS = `first-entry, ${ALICE.email}`;

    await erasure.resumeDueErasures({
      organizationId: ORG,
      actor,
      now: new Date(Date.now() + LEASE_TTL_MS + 1000),
    });

    const row = db.erasureOperation.rows[0]!;
    expect(row.legalHoldPolicyId).toMatch(/^legal-hold-register#2:[0-9a-f]{12}$/);
    expect(row.nextRetryAt).toBeNull();
    // Recorded, and content-free: the entry matched a disabled email identity,
    // and the row that documents the refusal must not become the last place
    // that address survives.
    const refusals = db.adminAudit.rows.filter(
      (r: Row) => r.action === "privacy.erasure.refused",
    );
    expect(refusals.map((r: Row) => r.environmentId)).toEqual(["env_eu", "env_us"]);
    expect(refusals[0]!.reason).toBe("legal hold in force");
    expect(JSON.stringify([row, ...refusals])).not.toContain(ALICE.email);
    // And it stays out of the drain from here.
    await expect(
      erasure.resumeDueErasures({
        organizationId: ORG,
        actor,
        now: new Date(Date.now() + LEASE_TTL_MS + 2000),
      }),
    ).resolves.toEqual([]);
  });
});

describe("an operation from before the resume plan existed", () => {
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

  /**
   * A first pass that leaves both addressable stores unsettled, then loses its
   * plan — the shape of every operation created by the code this branch
   * replaces, since `resumePlan` is a column it adds.
   */
  async function halfSweptWithoutAPlan() {
    redis.state.scanFails = true;
    bucket.state.deleteFails.add(ALICE.objects[0]!);
    const first = await erasure.requestErasure({
      externalUserId: ALICE.external,
      organizationId: ORG,
      idempotencyKey: "key_1",
      actor,
    });
    redis.state.scanFails = false;
    bucket.state.deleteFails.clear();
    expect(first.status).toBe("verification_failed");

    const row = db.erasureOperation.rows[0]!;
    row.resumePlan = null;
    return row;
  }

  it("refuses the operator retry it cannot address, rather than certifying nothing", async () => {
    const row = await halfSweptWithoutAPlan();

    const retried = await erasure.retryErasureById(row.id, ALICE.external, actor);

    // Postgres ran on the first pass, so the identity row discovery matches on
    // is gone and there is no plan to supply the locators in its place. The
    // caller's id proves WHO this operation is about; it does not make them
    // addressable. A pass that runs anyway finds no attachment row, no thread
    // and no scope — and every executor reports "0 discovered, 0 survivors,
    // verified", which would settle the operation and, because a completed
    // operation cannot be retried, make it permanently unrecoverable.
    expect(retried!.status).toBe("verification_failed");
    const byStore = Object.fromEntries(retried!.stores.map((s) => [s.store, s]));
    expect(byStore.minio).toMatchObject({
      verificationStatus: "failed",
      note: "verified 2/3 objects absent",
    });
    expect(byStore.redis!.verificationStatus).toBe("unknown");
    expect(row.status).toBe("FAILED");

    // The evidence the receipt would have been certifying about, still there.
    expect(bucket.store.has(ALICE.objects[0]!)).toBe(true);
    expect(remainingKeys(redis)).toEqual(
      [
        ...subjectRedisKeys(ALICE.threads, ALICE.external),
        ...subjectRedisKeys(BOB.threads, BOB.external),
        ...aggregateRedisKeys(),
      ].sort(),
    );
  });

  it("records the refusal, so a retry that can do nothing does not look like one that did", async () => {
    const row = await halfSweptWithoutAPlan();
    db.adminAudit.rows.length = 0;

    await erasure.retryErasureById(row.id, ALICE.external, actor);

    const refusals = db.adminAudit.rows.filter(
      (r: Row) => r.action === "privacy.erasure.refused",
    );
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals[0]!.reason).toBe(
      "no resume plan and nothing left to discover; subject is unaddressable",
    );
    expect(JSON.stringify(refusals)).not.toContain(ALICE.external);
  });

  it("still resumes normally when the plan is there", async () => {
    // The control. The refusal above must be about the missing plan, not about
    // the retry route having stopped working.
    redis.state.scanFails = true;
    await erasure.requestErasure({
      externalUserId: ALICE.external,
      organizationId: ORG,
      idempotencyKey: "key_1",
      actor,
    });
    redis.state.scanFails = false;

    const retried = await erasure.retryErasureById(
      db.erasureOperation.rows[0]!.id, ALICE.external, actor,
    );

    expect(retried!.status).toBe("completed");
    expect(remainingKeys(redis)).toEqual(
      [...subjectRedisKeys(BOB.threads, BOB.external), ...aggregateRedisKeys()].sort(),
    );
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
