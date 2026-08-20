import { beforeEach, describe, expect, it } from "vitest";
import { ErasureService } from "./erasure.service";
import { AdminAuditService } from "../monitoring/admin-audit.service";
import { SubjectErasedError } from "./erasure-register";
import { LEASE_TTL_MS } from "./erasure-queue";
import { ConversationService } from "../memory/conversation.service";
import type { ErasureAuditActor } from "./erasure-audit";
import { database, redisDouble, type Row } from "./erasure-doubles.test-fixture";

/**
 * End-to-end proof that an erasure stays erased.
 *
 * The real ErasureService sweeps, and the real ConversationService then tries
 * to resolve an identity the way a live turn would. Neither is mocked — the
 * substitute is only Postgres and Redis, because the property under test is
 * precisely that these two components agree about a subject across a store,
 * and stubbing either half would assert nothing.
 */

// ── fixture ─────────────────────────────────────────────────────────────────

const ORG = "org_1";
const REQUESTED_EXTERNAL_ID = "walle-77";
const SLACK_HANDLE = "U0ALICE";

/**
 * One person, reachable four ways. The erasure will be requested under the
 * external id only; every other handle has to fall with it.
 */
function seed(db: Row) {
  db.endUser.rows.push({ id: "end_user_1", organizationId: ORG, displayName: null });
  db.endUserIdentity.rows.push(
    { id: "identity_external", endUserId: "end_user_1", organizationId: ORG,
      issuer: "platos:external", channel: "external", subject: REQUESTED_EXTERNAL_ID,
      disabledAt: null, verifiedAt: new Date("2026-08-01T00:00:00.000Z") },
    { id: "identity_session", endUserId: "end_user_1", organizationId: ORG,
      issuer: "platos", channel: "session", subject: REQUESTED_EXTERNAL_ID,
      disabledAt: null, verifiedAt: new Date("2026-08-01T00:00:00.000Z") },
    { id: "identity_slack", endUserId: "end_user_1", organizationId: ORG,
      issuer: "channel:slack:T_ACME", channel: "slack", subject: SLACK_HANDLE,
      disabledAt: null, verifiedAt: new Date("2026-08-01T00:00:00.000Z") },
    // Already disabled, and still an alias the sweep deletes.
    { id: "identity_email", endUserId: "end_user_1", organizationId: ORG,
      issuer: "email", channel: "email", subject: "alice@example.com",
      disabledAt: new Date("2026-08-05T00:00:00.000Z"), verifiedAt: null },
  );
  db.thread.rows.push({ id: "thread_1", endUserId: "end_user_1", environmentId: "env_1" });
}

/** A Slack turn: the caller never mentions the erased external id. */
function slackTurn(handle: string) {
  return {
    organizationId: ORG,
    projectId: "project_1",
    environmentId: "env_1",
    // Synthesized per-channel principal — NOT the id the erasure was requested by.
    userId: `slack:T_ACME:${handle}`,
    userIdentities: [{ channel: "slack", handle, verified: true }],
  } as any;
}

describe("an erased subject cannot be reintroduced by a later write", () => {
  let db: Row;
  let redis: ReturnType<typeof redisDouble>;
  let erasure: ErasureService;
  let conversations: ConversationService;

  beforeEach(() => {
    process.env.PLATOS_ERASURE_HASH_SALT = "resurrection-test-salt";
    db = database();
    redis = redisDouble();
    seed(db);
    redis.store.set("platos:trace:thread:thread_1", "{}");
    erasure = new ErasureService(db as any, redis as any);
    conversations = new ConversationService(db as any);
  });

  async function sweep() {
    return erasure.requestErasure({
      externalUserId: REQUESTED_EXTERNAL_ID,
      organizationId: ORG,
      idempotencyKey: "key_1",
    });
  }

  it("sweeps the subject away and leaves a tombstone for every alias", async () => {
    const receipt = await sweep();

    expect(receipt.status).toBe("completed");
    expect(db.endUser.rows).toHaveLength(0);
    expect(db.endUserIdentity.rows).toHaveLength(0);
    expect(db.thread.rows).toHaveLength(0);
    expect(redis.store.size).toBe(0);
    // external, session, slack, email, plus the canonical uuid.
    expect(db.erasureTombstone.rows).toHaveLength(5);
    // Content-free: the register holds hashes, never the handles it protects.
    const serialized = JSON.stringify(db.erasureTombstone.rows);
    for (const handle of [REQUESTED_EXTERNAL_ID, SLACK_HANDLE, "alice@example.com", "end_user_1"]) {
      expect(serialized).not.toContain(handle);
    }
  });

  it("refuses a later write arriving under an alias nobody named in the request", async () => {
    await sweep();

    // The erasure was requested by external id. This turn arrives over Slack,
    // with a different principal and a handle the operator never mentioned.
    await expect(conversations.resolveEndUser(slackTurn(SLACK_HANDLE))).rejects.toBeInstanceOf(
      SubjectErasedError,
    );
    expect(db.endUser.rows).toHaveLength(0);
    expect(db.endUserIdentity.rows).toHaveLength(0);
  });

  it("refuses the original external id too, session token still in hand", async () => {
    await sweep();

    await expect(
      conversations.resolveEndUser({
        organizationId: ORG,
        projectId: "project_1",
        environmentId: "env_1",
        userId: REQUESTED_EXTERNAL_ID,
        userIdentities: [],
      } as any),
    ).rejects.toBeInstanceOf(SubjectErasedError);
    expect(db.endUser.rows).toHaveLength(0);
  });

  it("still admits a different person on the same channel", async () => {
    await sweep();

    await expect(conversations.resolveEndUser(slackTurn("U0BOB"))).resolves.toEqual(
      expect.any(String),
    );
    expect(db.endUser.rows).toHaveLength(1);
  });

  it("admits the erased handle again once the retention window closes", async () => {
    await sweep();
    for (const row of db.erasureTombstone.rows) {
      row.expiresAt = new Date(Date.now() - 1000);
    }

    await expect(conversations.resolveEndUser(slackTurn(SLACK_HANDLE))).resolves.toEqual(
      expect.any(String),
    );
  });

  it("refuses the write when the register itself cannot be read", async () => {
    await sweep();
    db.erasureTombstone.findFirst = async () => {
      throw new TypeError("connection terminated");
    };

    await expect(conversations.resolveEndUser(slackTurn("U0BOB"))).rejects.toThrow(
      /Erasure register unavailable/,
    );
    // Fail closed: the unrelated person is refused rather than admitted blind.
    expect(db.endUser.rows).toHaveLength(0);
  });

  it("seals a pass the queue drove, not just one an operator asked for", async () => {
    // The request path abandons before sealing when the intent record cannot be
    // written — deliberately, and its comment nominates the queue as the
    // recovery. So the queue is the pass that actually sweeps this subject, and
    // a queue pass that does not seal destroys them with no barrier: the next
    // turn from a live session token rebuilds the person under a fresh uuid the
    // receipt cannot see, which is the whole hole this register closes.
    const actor: ErasureAuditActor = {
      credentialId: "credential_1",
      userId: "operator_7",
      environmentId: "env_1",
      projectId: "project_1",
    };
    const audited = new ErasureService(db as any, redis as any, undefined, undefined,
      new AdminAuditService(db as any));
    const realCreate = db.adminAudit.create;
    db.adminAudit.create = async () => {
      throw new Error("audit sink unavailable");
    };
    await expect(
      audited.requestErasure({
        externalUserId: REQUESTED_EXTERNAL_ID,
        organizationId: ORG,
        idempotencyKey: "key_1",
        actor,
      }),
    ).rejects.toThrow(/audit sink unavailable/);
    db.adminAudit.create = realCreate;
    // Nothing swept and nothing sealed: the request never got past its intent.
    expect(db.endUser.rows).toHaveLength(1);
    expect(db.erasureTombstone.rows).toEqual([]);

    // The queue picks it up once the lease lapses. It has no external id — only
    // the locators — so the aliases come from the identity rows, which are
    // still there because this is the pass that is about to delete them.
    await audited.resumeDueErasures({
      organizationId: ORG,
      actor,
      now: new Date(Date.now() + LEASE_TTL_MS + 1000),
    });

    expect(db.endUser.rows).toHaveLength(0);
    expect(db.endUserIdentity.rows).toHaveLength(0);
    expect(db.erasureTombstone.rows).toHaveLength(5);
    // The barrier is what has to hold, so the barrier is what is asserted: a
    // turn over Slack, under a handle nobody named in the request.
    await expect(conversations.resolveEndUser(slackTurn(SLACK_HANDLE))).rejects.toBeInstanceOf(
      SubjectErasedError,
    );
    expect(db.endUser.rows).toHaveLength(0);
  });

  it("seals before the executors run, so a mid-sweep turn is already refused", async () => {
    // Postgres runs last; freezing it mid-sweep leaves the subject's rows in
    // place, which is exactly the window a turn used to slip through.
    const realTransaction = db.$transaction;
    let barrierDuringSweep: unknown;
    // One shot, and the real delegate is back before the turn runs: the turn
    // opens a transaction of its own, and intercepting that too would recurse.
    db.$transaction = async (arg: any) => {
      db.$transaction = realTransaction;
      barrierDuringSweep = await conversations
        .resolveEndUser(slackTurn(SLACK_HANDLE))
        .then(() => null)
        .catch((err: unknown) => err);
      return realTransaction(arg);
    };

    await sweep();

    expect(barrierDuringSweep).toBeInstanceOf(SubjectErasedError);
    // The subject's rows were still in place when the turn was refused — the
    // barrier, not the absence of data, is what stopped it.
    expect(db.endUser.rows).toHaveLength(0);
  });
});
