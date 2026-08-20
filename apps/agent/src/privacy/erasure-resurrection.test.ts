import { beforeEach, describe, expect, it } from "vitest";
import { ErasureService } from "./erasure.service";
import { SubjectErasedError } from "./erasure-register";
import { ConversationService } from "../memory/conversation.service";

/**
 * End-to-end proof that an erasure stays erased.
 *
 * The real ErasureService sweeps, and the real ConversationService then tries
 * to resolve an identity the way a live turn would. Neither is mocked — the
 * substitute is only Postgres and Redis, because the property under test is
 * precisely that these two components agree about a subject across a store,
 * and stubbing either half would assert nothing.
 */

// ── in-memory Postgres ──────────────────────────────────────────────────────

type Row = Record<string, any>;

/**
 * Enough of the Prisma filter language for the queries these two services
 * actually issue. Nested relation filters (`environment: { project: … }`) are
 * treated as satisfied: the tables they constrain are empty in these fixtures,
 * and the ancestry rules they express are covered in erasure.service.test.ts.
 */
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, condition] of Object.entries(where)) {
    if (key === "OR") {
      if (!(condition as Row[]).some((clause) => matches(row, clause))) return false;
      continue;
    }
    const value = row[key];
    if (condition === null) {
      if (value !== null && value !== undefined) return false;
    } else if (condition instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== condition.getTime()) return false;
    } else if (condition && typeof condition === "object") {
      const c = condition as Row;
      if (Array.isArray(c.in)) {
        if (!c.in.includes(value)) return false;
      } else if ("not" in c) {
        if (c.not === null ? value === null || value === undefined : value === c.not) return false;
      } else if ("gt" in c) {
        if (!(value > c.gt)) return false;
      } else if ("lte" in c) {
        if (!(value <= c.lte)) return false;
      } else {
        // Relation filter — see the note above.
        continue;
      }
    } else if (value !== condition) {
      return false;
    }
  }
  return true;
}

let sequence = 0;
function newId(prefix: string): string {
  sequence++;
  return `${prefix}_${sequence}`;
}

function table(name: string, rows: Row[] = []) {
  const compound = (where: Row): Row => {
    const key = Object.keys(where)[0]!;
    return key.includes("_") && typeof where[key] === "object" ? where[key] : where;
  };
  const delegate = {
    rows,
    findFirst: async ({ where }: Row = {}) => rows.find((r) => matches(r, where)) ?? null,
    findUnique: async ({ where }: Row) => rows.find((r) => matches(r, compound(where))) ?? null,
    findMany: async ({ where }: Row = {}) => rows.filter((r) => matches(r, where)),
    count: async ({ where }: Row = {}) => rows.filter((r) => matches(r, where)).length,
    create: async ({ data }: Row) => {
      const row = { id: data.id ?? newId(name), ...data };
      rows.push(row);
      return row;
    },
    createMany: async ({ data, skipDuplicates }: Row) => {
      let count = 0;
      for (const item of data as Row[]) {
        const clash =
          skipDuplicates &&
          rows.some(
            (r) => r.organizationId === item.organizationId && r.aliasHash === item.aliasHash,
          );
        if (clash) continue;
        rows.push({ id: newId(name), ...item });
        count++;
      }
      return { count };
    },
    update: async ({ where, data }: Row) => {
      const row = rows.find((r) => matches(r, compound(where)));
      if (!row) throw new Error(`${name} row not found`);
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: Row) => {
      const hits = rows.filter((r) => matches(r, where));
      for (const row of hits) Object.assign(row, data);
      return { count: hits.length };
    },
    upsert: async ({ where, create, update }: Row) => {
      const row = rows.find((r) => matches(r, compound(where)));
      if (row) {
        Object.assign(row, update);
        return row;
      }
      const created = { id: newId(name), ...compound(where), ...create };
      rows.push(created);
      return created;
    },
    deleteMany: async ({ where }: Row = {}) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (matches(rows[i]!, where)) rows.splice(i, 1);
      }
      return { count: before - rows.length };
    },
  };
  return delegate;
}

function database() {
  const db: Row = {
    endUser: table("end_user"),
    endUserIdentity: table("identity"),
    erasureOperation: table("operation"),
    erasureTombstone: table("tombstone"),
    thread: table("thread"),
    memory: table("memory"),
    memoryEntity: table("memory_entity"),
    memoryRelationship: table("memory_relationship"),
    messageRating: table("rating"),
    messageAttachment: table("attachment"),
    toolCallAudit: table("audit"),
    safetyEvent: table("safety"),
    environment: table("environment", [
      { id: "env_1", projectId: "project_1" },
    ]),
  };
  db.$transaction = async (arg: any) =>
    typeof arg === "function" ? arg(db) : Promise.all(arg);
  return db;
}

/** ioredis stand-in. Keys are stored on the wire, with the prefix attached. */
function redisDouble() {
  const keys = new Map<string, string>();
  return {
    store: keys,
    keys: async (pattern: string) => {
      const re = new RegExp(`^platos:${pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
      return [...keys.keys()].filter((k) => re.test(k));
    },
    del: async (key: string) => (keys.delete(`platos:${key}`) ? 1 : 0),
    exists: async (key: string) => (keys.has(`platos:${key}`) ? 1 : 0),
  };
}

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
