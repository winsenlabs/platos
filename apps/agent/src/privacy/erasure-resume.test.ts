import { beforeEach, describe, expect, it } from "vitest";
import { ErasureService } from "./erasure.service";
import { AdminAuditService } from "../monitoring/admin-audit.service";
import { LEASE_TTL_MS } from "./erasure-queue";
import type { ErasureAuditActor } from "./erasure-audit";
import { database, redisDouble, type Row } from "./erasure-doubles.test-fixture";

/**
 * What happens to an erasure whose store did not settle.
 *
 * The real ErasureService and the real AdminAuditService, over one in-memory
 * Postgres and one in-memory Redis. Neither is stubbed: the properties under
 * test are that a failed pass leaves behind enough state for a later one to
 * finish the job, that the later one does not redo the work the first one
 * completed, and that both are recorded — and all three are statements about
 * what these components leave in a store, which a stub would assert nothing
 * about.
 */

// ── fixture ─────────────────────────────────────────────────────────────────

const ORG = "org_1";
const REQUESTED_EXTERNAL_ID = "walle-77";
const SLACK_HANDLE = "U0ALICE";
const EMAIL = "alice@example.com";

const actor: ErasureAuditActor = {
  credentialId: "credential_1",
  userId: "operator_7",
  environmentId: "env_credential",
  projectId: "project_credential",
};

function seed(db: Row) {
  db.endUser.rows.push({ id: "end_user_1", organizationId: ORG, displayName: null });
  db.endUserIdentity.rows.push(
    { id: "identity_external", endUserId: "end_user_1", organizationId: ORG,
      issuer: "platos:external", channel: "external", subject: REQUESTED_EXTERNAL_ID,
      disabledAt: null },
    { id: "identity_slack", endUserId: "end_user_1", organizationId: ORG,
      issuer: "channel:slack:T_ACME", channel: "slack", subject: SLACK_HANDLE, disabledAt: null },
    { id: "identity_email", endUserId: "end_user_1", organizationId: ORG,
      issuer: "email", channel: "email", subject: EMAIL, disabledAt: null },
  );
  db.thread.rows.push({ id: "thread_1", endUserId: "end_user_1", environmentId: "env_1" });
}

describe("an unsettled store is resumable, and the resume does not redo settled work", () => {
  let db: Row;
  let redis: ReturnType<typeof redisDouble>;
  let erasure: ErasureService;

  beforeEach(() => {
    process.env.PLATOS_ERASURE_HASH_SALT = "resume-test-salt";
    delete process.env.PLATOS_ERASURE_MAX_ATTEMPTS;
    db = database();
    redis = redisDouble();
    seed(db);
    redis.store.set("platos:trace:thread:thread_1", "{}");
    erasure = new ErasureService(db as any, redis as any, undefined, undefined,
      new AdminAuditService(db as any));
  });

  /** Redis cannot be scanned on this pass, so it cannot settle. */
  async function sweepWithBrokenRedis() {
    redis.state.scanFails = true;
    const receipt = await erasure.requestErasure({
      externalUserId: REQUESTED_EXTERNAL_ID,
      organizationId: ORG,
      idempotencyKey: "key_1",
      actor,
    });
    redis.state.scanFails = false;
    return receipt;
  }

  const operationRow = () => db.erasureOperation.rows[0]!;

  it("leaves the state a later pass needs, and hands the row back to the queue", async () => {
    const receipt = await sweepWithBrokenRedis();

    expect(receipt.status).toBe("partial_failure");
    expect(receipt.stores.find((s) => s.store === "redis")).toMatchObject({ status: "failed" });

    const row = operationRow();
    // The locators, captured while Postgres still held them. Discovery cannot
    // produce these again: the identity row it matches on is now deleted.
    expect(row.resumePlan).toMatchObject({
      version: 1,
      platosEndUserIds: ["end_user_1"],
      threadIds: ["thread_1"],
      scopes: [{ organizationId: ORG, projectId: "project_1", environmentId: "env_1" }],
    });
    expect(row.nextAttemptAt).toBeInstanceOf(Date);
    expect(row.retryCount).toBe(1);
    // Lease released, so the queue can pick it up rather than waiting it out.
    expect(row.leaseToken).toBeNull();
    expect(row.leaseExpiresAt).toBeNull();
  });

  it("keeps the identifier out of the resumable state", async () => {
    await sweepWithBrokenRedis();
    const serialized = JSON.stringify(operationRow().resumePlan);
    for (const identifier of [REQUESTED_EXTERNAL_ID, SLACK_HANDLE, EMAIL]) {
      expect(serialized).not.toContain(identifier);
    }
  });

  it("re-runs only the store that did not settle", async () => {
    await sweepWithBrokenRedis();
    const transactionsAfterSweep = db.transactions;
    expect(redis.store.size).toBe(1);

    await erasure.resumeErasure(operationRow().id, actor);

    // Redis ran and finished its work.
    expect(redis.store.size).toBe(0);
    // Postgres did not run a second time. Re-issuing deletes over data already
    // gone is harmless, but a receipt reporting fresh counts for work that
    // finished on the previous pass misleads whoever reads it as evidence.
    expect(db.transactions).toBe(transactionsAfterSweep);
  });

  it("finds the operation from the queue with no identifier in hand", async () => {
    await sweepWithBrokenRedis();
    // Backdate the schedule the way the passage of time would.
    operationRow().nextAttemptAt = new Date(Date.now() - 1000);

    const resumed = await erasure.resumeDueErasures({ organizationId: ORG, actor });

    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.operationId).toBe(operationRow().id);
    expect(redis.store.size).toBe(0);
  });

  it("does not offer a settled operation to the queue", async () => {
    // A clean sweep clears nextAttemptAt, which is what takes the row out of
    // the selection — there is no separate "done" flag to fall out of sync.
    await erasure.requestErasure({
      externalUserId: REQUESTED_EXTERNAL_ID,
      organizationId: ORG,
      idempotencyKey: "key_clean",
      actor,
    });

    expect(operationRow().nextAttemptAt).toBeNull();
    await expect(erasure.resumeDueErasures({ organizationId: ORG, actor })).resolves.toEqual([]);
  });
});

describe("a second pass cannot overlap the first", () => {
  let db: Row;
  let redis: ReturnType<typeof redisDouble>;
  let erasure: ErasureService;

  beforeEach(() => {
    process.env.PLATOS_ERASURE_HASH_SALT = "resume-test-salt";
    db = database();
    redis = redisDouble();
    seed(db);
    redis.store.set("platos:trace:thread:thread_1", "{}");
    erasure = new ErasureService(db as any, redis as any, undefined, undefined,
      new AdminAuditService(db as any));
    redis.state.scanFails = true;
  });

  async function sweep() {
    const receipt = await erasure.requestErasure({
      externalUserId: REQUESTED_EXTERNAL_ID,
      organizationId: ORG,
      idempotencyKey: "key_1",
      actor,
    });
    redis.state.scanFails = false;
    return receipt;
  }

  it("refuses to start while another pass holds the lease", async () => {
    await sweep();
    const row = db.erasureOperation.rows[0]!;
    const attemptsBefore = row.retryCount;
    row.leaseToken = "held-by-another-pass";
    row.leaseExpiresAt = new Date(Date.now() + LEASE_TTL_MS);

    await erasure.resumeErasure(row.id, actor);

    // Nothing swept, nothing recorded, nothing overwritten.
    expect(redis.store.size).toBe(1);
    expect(row.retryCount).toBe(attemptsBefore);
    expect(row.leaseToken).toBe("held-by-another-pass");
  });

  it("lets exactly one of two concurrent resumes through", async () => {
    await sweep();
    const row = db.erasureOperation.rows[0]!;

    await Promise.all([
      erasure.resumeErasure(row.id, actor),
      erasure.resumeErasure(row.id, actor),
    ]);

    // One pass, not two: a second destructive pass over the same subject would
    // report counts describing neither.
    expect(row.retryCount).toBe(2);
    expect(redis.store.size).toBe(0);
  });

  it("reclaims an operation whose pass died holding the lease", async () => {
    await sweep();
    const row = db.erasureOperation.rows[0]!;
    row.leaseToken = "abandoned";
    row.leaseExpiresAt = new Date(Date.now() - 1);

    await erasure.resumeErasure(row.id, actor);

    expect(redis.store.size).toBe(0);
    expect(row.leaseToken).toBeNull();
  });
});

describe("a resume without the identifier may delete but may not certify", () => {
  let db: Row;
  let redis: ReturnType<typeof redisDouble>;
  let erasure: ErasureService;

  beforeEach(() => {
    process.env.PLATOS_ERASURE_HASH_SALT = "resume-test-salt";
    db = database();
    redis = redisDouble();
    seed(db);
    redis.store.set("platos:trace:thread:thread_1", "{}");
    erasure = new ErasureService(db as any, redis as any, undefined, undefined,
      new AdminAuditService(db as any));
    redis.state.scanFails = true;
  });

  async function sweep() {
    const receipt = await erasure.requestErasure({
      externalUserId: REQUESTED_EXTERNAL_ID,
      organizationId: ORG,
      idempotencyKey: "key_1",
      actor,
    });
    redis.state.scanFails = false;
    return receipt;
  }

  it("reports the narrowed verification as unknown, keeping the operation open", async () => {
    await sweep();
    const row = db.erasureOperation.rows[0]!;

    const resumed = await erasure.resumeErasure(row.id, actor);

    const redisOutcome = resumed!.stores.find((s) => s.store === "redis")!;
    expect(redisOutcome.deleted).toBe(1);
    // Deleted, but the per-user cost counters keyed by the legacy id were never
    // scanned — so this pass cannot say the store is clean.
    expect(redisOutcome.verificationStatus).toBe("unknown");
    expect(redisOutcome.note).toContain("without the subject id");
    expect(resumed!.status).toBe("partial_failure");
  });

  it("completes once an operator supplies the identifier", async () => {
    await sweep();
    const row = db.erasureOperation.rows[0]!;

    const retried = await erasure.retryErasureById(row.id, REQUESTED_EXTERNAL_ID, actor);

    // Postgres deleted the identity row the first time round, so discovery on
    // its own resolves nothing; the persisted plan supplies the locators and
    // the caller supplies the legacy id.
    expect(retried!.status).toBe("completed");
    expect(retried!.stores.find((s) => s.store === "redis")!.verificationStatus).toBe("passed");
    expect(row.nextAttemptAt).toBeNull();
  });

  it("stops re-driving an operation with no plan to resume from", async () => {
    await sweep();
    const row = db.erasureOperation.rows[0]!;
    row.resumePlan = "not-an-object";

    await erasure.resumeErasure(row.id, actor);

    expect(row.nextAttemptAt).toBeNull();
    // Nothing swept against an empty subject.
    expect(redis.store.size).toBe(1);
  });
});

describe("every erasure lands in the admin audit log", () => {
  let db: Row;
  let redis: ReturnType<typeof redisDouble>;
  let erasure: ErasureService;

  beforeEach(() => {
    process.env.PLATOS_ERASURE_HASH_SALT = "resume-test-salt";
    delete process.env.PLATOS_LEGAL_HOLD_USER_IDS;
    db = database();
    redis = redisDouble();
    seed(db);
    erasure = new ErasureService(db as any, redis as any, undefined, undefined,
      new AdminAuditService(db as any));
  });

  async function sweep(overrides: Record<string, unknown> = {}) {
    return erasure.requestErasure({
      externalUserId: REQUESTED_EXTERNAL_ID,
      organizationId: ORG,
      idempotencyKey: "key_1",
      actor,
      ...overrides,
    });
  }

  it("records who asked, before anything is destroyed, and what happened after", async () => {
    await sweep();

    const actions = db.adminAudit.rows.map((r: Row) => r.action);
    expect(actions).toEqual(["privacy.erasure.requested", "privacy.erasure.finished"]);
    for (const row of db.adminAudit.rows) {
      expect(row.actorUserId).toBe("operator_7");
      expect(row.subjectType).toBe("privacy.erasure_subject");
      // The subject is the salted hash, the same primitive the receipt uses.
      expect(row.subjectId).toMatch(/^[0-9a-f]{64}$/);
      expect(row.after.actor.credentialId).toBe("credential_1");
    }
  });

  it("files the record in the environment the data was destroyed in", async () => {
    await sweep();
    expect(db.adminAudit.rows.map((r: Row) => r.environmentId)).toEqual(["env_1", "env_1"]);
  });

  it("carries the per-store outcome and the retention class", async () => {
    await sweep();

    const finished = db.adminAudit.rows.at(-1)!;
    expect(finished.after.status).toBe("completed");
    expect(finished.after.stores.map((s: Row) => s.store)).toEqual([
      "minio", "redis", "clickhouse", "postgres",
    ]);
    expect(finished.after.retention).toMatchObject({
      class: "erasure-evidence",
      retainedIndefinitely: true,
      barrierClass: "erasure-barrier",
    });
  });

  it("writes no content and no raw identifier, anywhere in the trail", async () => {
    await sweep();

    const serialized = JSON.stringify(db.adminAudit.rows);
    for (const identifier of [REQUESTED_EXTERNAL_ID, SLACK_HANDLE, EMAIL, "end_user_1"]) {
      expect(serialized).not.toContain(identifier);
    }
  });

  it("records the refusal when a legal hold stops the erasure", async () => {
    await sweep({ legalHoldPolicyId: "LH-7", idempotencyKey: "key_held" });

    const refusals = db.adminAudit.rows.filter((r: Row) => r.action === "privacy.erasure.refused");
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.after).toMatchObject({ legalHoldPolicyId: "LH-7" });
    // Nothing ran, so there is nothing to resume and no plan to leave lying
    // around for a subject we have been told not to touch.
    expect(db.erasureOperation.rows[0]!.resumePlan).toBeUndefined();
    expect(db.erasureOperation.rows[0]!.nextAttemptAt).toBeNull();
  });

  it("records the refusal when a key is reused against another subject", async () => {
    await sweep();
    db.adminAudit.rows.length = 0;

    await expect(
      erasure.requestErasure({
        externalUserId: "someone-else",
        organizationId: ORG,
        idempotencyKey: "key_1",
        actor,
      }),
    ).rejects.toThrow(/already bound to another subject/);

    // Targeting person B with person A's key used to be a 409 and nothing else.
    expect(db.adminAudit.rows.map((r: Row) => r.action)).toEqual(["privacy.erasure.refused"]);
    expect(db.adminAudit.rows[0]!.environmentId).toBe("env_credential");
  });

  it("records a read of the subject's footprint", async () => {
    const subject = await erasure.discoverSubject(REQUESTED_EXTERNAL_ID, ORG);
    const inventory = await erasure.inventory(subject, ORG);

    await erasure.auditInventoryRead({
      externalUserId: REQUESTED_EXTERNAL_ID,
      organizationId: ORG,
      subject,
      inventory,
      actor,
    });

    const read = db.adminAudit.rows.at(-1)!;
    expect(read.action).toBe("privacy.erasure.inventoried");
    expect(read.after.inventory).toMatchObject({ threads: 1 });
    expect(JSON.stringify(read)).not.toContain(REQUESTED_EXTERNAL_ID);
  });
});

describe("crash recovery", () => {
  it("is already due and already leased while the sweep is still running", async () => {
    process.env.PLATOS_ERASURE_HASH_SALT = "resume-test-salt";
    const db = database();
    const redis = redisDouble();
    seed(db);
    const erasure = new ErasureService(db as any, redis as any, undefined, undefined,
      new AdminAuditService(db as any));

    // Postgres runs last; freezing it mid-sweep is the moment a crashed process
    // would have left the row behind.
    const realTransaction = db.$transaction;
    let midSweep: Row | undefined;
    db.$transaction = async (arg: any) => {
      db.$transaction = realTransaction;
      midSweep = { ...db.erasureOperation.rows[0] };
      return realTransaction(arg);
    };

    await erasure.requestErasure({
      externalUserId: REQUESTED_EXTERNAL_ID,
      organizationId: ORG,
      idempotencyKey: "key_1",
      actor,
    });

    // The row was never in the state the old code left behind — PENDING with no
    // schedule and no lease, indistinguishable from an erasure never started.
    expect(midSweep!.status).toBe("PENDING");
    expect(midSweep!.nextAttemptAt).toBeInstanceOf(Date);
    expect(midSweep!.leaseExpiresAt).toBeInstanceOf(Date);
    expect(midSweep!.resumePlan).toMatchObject({ platosEndUserIds: ["end_user_1"] });
  });
});
