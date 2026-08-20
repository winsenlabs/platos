import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  aliasKeyHash,
  aliasHashes,
  assertSubjectNotErased,
  CANONICAL_ALIAS_CHANNEL,
  DEFAULT_TOMBSTONE_TTL_DAYS,
  ErasureRegisterUnavailableError,
  normalizeAlias,
  purgeExpiredTombstones,
  sealErasedSubject,
  SubjectErasedError,
  tombstoneTtlDays,
} from "./erasure-register";

const SALT = "test-salt";
const ORG = "org_1";

/**
 * In-memory stand-in for the tombstone table.
 *
 * Not a mock of the barrier: the barrier is the module under test and runs for
 * real. This only stands in for Postgres, and it enforces the one constraint
 * the semantics depend on — the (organizationId, aliasHash) uniqueness that
 * makes re-sealing idempotent.
 */
function registerStore(identities: Array<{ channel: string; subject: string }> = []) {
  const rows: Array<{
    organizationId: string;
    aliasHash: string;
    operationId: string;
    policyVersion: string;
    sealedAt: Date;
    expiresAt: Date;
  }> = [];
  return {
    rows,
    endUserIdentity: {
      findMany: vi.fn(async () => identities),
    },
    erasureTombstone: {
      findFirst: vi.fn(async ({ where }: any) => {
        const found = rows.find(
          (r) =>
            r.organizationId === where.organizationId &&
            where.aliasHash.in.includes(r.aliasHash) &&
            r.expiresAt > where.expiresAt.gt,
        );
        return found ? { aliasHash: found.aliasHash } : null;
      }),
      createMany: vi.fn(async ({ data }: any) => {
        let count = 0;
        for (const row of data) {
          const clash = rows.some(
            (r) => r.organizationId === row.organizationId && r.aliasHash === row.aliasHash,
          );
          if (clash) continue;
          rows.push(row);
          count++;
        }
        return { count };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const row of rows) {
          if (row.organizationId !== where.organizationId) continue;
          if (!where.aliasHash.in.includes(row.aliasHash)) continue;
          Object.assign(row, data);
          count++;
        }
        return { count };
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          const row = rows[i]!;
          if (row.expiresAt <= where.expiresAt.lte) rows.splice(i, 1);
        }
        return { count: before - rows.length };
      }),
    },
  };
}

describe("alias keying", () => {
  it("namespaces by channel so an erased email does not refuse an unrelated external id", () => {
    const email = aliasKeyHash({ channel: "email", subject: "a@example.com" }, ORG, SALT);
    const external = aliasKeyHash({ channel: "external", subject: "a@example.com" }, ORG, SALT);
    expect(email).not.toEqual(external);
  });

  it("scopes by organization so the same person in two tenants is not correlatable", () => {
    const left = aliasKeyHash({ channel: "slack", subject: "u_alice" }, "org_1", SALT);
    const right = aliasKeyHash({ channel: "slack", subject: "u_alice" }, "org_2", SALT);
    expect(left).not.toEqual(right);
  });

  it("never embeds the raw handle it hashes", () => {
    const hash = aliasKeyHash({ channel: "email", subject: "alice@example.com" }, ORG, SALT);
    expect(hash).not.toContain("alice");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("case-folds both sides so a cased variant cannot walk back in", () => {
    expect(normalizeAlias({ channel: "Email", subject: " Alice@Example.com " })).toEqual({
      channel: "email",
      subject: "alice@example.com",
    });
  });

  it("drops empty aliases rather than hashing a blank into the register", () => {
    expect(normalizeAlias({ channel: "email", subject: "  " })).toBeNull();
    expect(aliasHashes([{ channel: "", subject: "x" }], ORG, SALT)).toEqual([]);
  });
});

describe("retention rule", () => {
  const original = process.env.PLATOS_ERASURE_TOMBSTONE_TTL_DAYS;
  beforeEach(() => {
    if (original === undefined) delete process.env.PLATOS_ERASURE_TOMBSTONE_TTL_DAYS;
    else process.env.PLATOS_ERASURE_TOMBSTONE_TTL_DAYS = original;
  });

  it("defaults to the window that outlives the longest reference to the subject", () => {
    delete process.env.PLATOS_ERASURE_TOMBSTONE_TTL_DAYS;
    expect(tombstoneTtlDays()).toBe(DEFAULT_TOMBSTONE_TTL_DAYS);
  });

  it("refuses a sub-day window rather than letting the barrier be configured away", () => {
    process.env.PLATOS_ERASURE_TOMBSTONE_TTL_DAYS = "0";
    expect(tombstoneTtlDays()).toBe(DEFAULT_TOMBSTONE_TTL_DAYS);
    process.env.PLATOS_ERASURE_TOMBSTONE_TTL_DAYS = "not-a-number";
    expect(tombstoneTtlDays()).toBe(DEFAULT_TOMBSTONE_TTL_DAYS);
  });

  it("stops blocking once the window closes, without waiting for a sweep", async () => {
    const store = registerStore();
    const sealedAt = new Date("2026-08-20T00:00:00.000Z");
    await sealErasedSubject(store, {
      organizationId: ORG,
      operationId: "operation_1",
      policyVersion: "v1",
      platosEndUserIds: [],
      extraAliases: [{ channel: "external", subject: "person_1" }],
      salt: SALT,
      ttlDays: 30,
      now: () => sealedAt,
    });
    const aliases = [{ channel: "external", subject: "person_1" }];

    const inWindow = new Date("2026-09-10T00:00:00.000Z");
    await expect(
      assertSubjectNotErased(store, { organizationId: ORG, aliases, salt: SALT, now: () => inWindow }),
    ).rejects.toBeInstanceOf(SubjectErasedError);

    // Read-time expiry: the row is still there, and still must not block.
    const afterWindow = new Date("2026-10-01T00:00:00.000Z");
    expect(store.rows).toHaveLength(1);
    await expect(
      assertSubjectNotErased(store, { organizationId: ORG, aliases, salt: SALT, now: () => afterWindow }),
    ).resolves.toBeUndefined();
  });

  it("purges expired rows so the register cannot grow without bound", async () => {
    const store = registerStore();
    store.rows.push(
      { organizationId: ORG, aliasHash: "a", operationId: "o", policyVersion: "v1",
        sealedAt: new Date("2026-06-01T00:00:00.000Z"), expiresAt: new Date("2026-07-01T00:00:00.000Z") },
      { organizationId: ORG, aliasHash: "b", operationId: "o", policyVersion: "v1",
        sealedAt: new Date("2026-08-01T00:00:00.000Z"), expiresAt: new Date("2026-09-01T00:00:00.000Z") },
    );

    await expect(
      purgeExpiredTombstones(store, { now: () => new Date("2026-08-20T00:00:00.000Z") }),
    ).resolves.toEqual({ purged: 1 });
    expect(store.rows.map((r) => r.aliasHash)).toEqual(["b"]);
  });
});

describe("sealing covers every alias the subject graph resolves", () => {
  it("seals channel handles, the requested id and the canonical uuid together", async () => {
    const store = registerStore([
      { channel: "external", subject: "person_1" },
      { channel: "session", subject: "person_1" },
      { channel: "slack", subject: "U0ALICE" },
      { channel: "email", subject: "alice@example.com" },
    ]);

    const sealed = await sealErasedSubject(store, {
      organizationId: ORG,
      operationId: "operation_1",
      policyVersion: "v1",
      platosEndUserIds: ["end_user_1"],
      extraAliases: [{ channel: "external", subject: "person_1" }],
      salt: SALT,
    });

    // 4 identity rows + the canonical uuid; the requested id de-duplicates
    // against the identity row it was discovered by.
    expect(sealed.aliases).toBe(5);
    const hashes = new Set(store.rows.map((r) => r.aliasHash));
    for (const alias of [
      { channel: "slack", subject: "u0alice" },
      { channel: "email", subject: "alice@example.com" },
      { channel: "external", subject: "person_1" },
      { channel: CANONICAL_ALIAS_CHANNEL, subject: "end_user_1" },
    ]) {
      expect(hashes.has(aliasKeyHash(alias, ORG, SALT))).toBe(true);
    }
  });

  it("reads identity rows that are already disabled, because the sweep deletes those too", async () => {
    const store = registerStore();
    await sealErasedSubject(store, {
      organizationId: ORG,
      operationId: "operation_1",
      policyVersion: "v1",
      platosEndUserIds: ["end_user_1"],
      salt: SALT,
    });
    expect(store.endUserIdentity.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, endUserId: { in: ["end_user_1"] } },
      select: { channel: true, subject: true },
    });
  });

  it("re-seals idempotently and extends the window without opening the barrier", async () => {
    const store = registerStore([{ channel: "slack", subject: "U0ALICE" }]);
    const first = new Date("2026-08-20T00:00:00.000Z");
    await sealErasedSubject(store, {
      organizationId: ORG, operationId: "operation_1", policyVersion: "v1",
      platosEndUserIds: ["end_user_1"], salt: SALT, ttlDays: 30, now: () => first,
    });
    const rowCount = store.rows.length;

    const second = new Date("2026-08-25T00:00:00.000Z");
    const again = await sealErasedSubject(store, {
      organizationId: ORG, operationId: "operation_1", policyVersion: "v1",
      platosEndUserIds: ["end_user_1"], salt: SALT, ttlDays: 30, now: () => second,
    });

    expect(again.sealed).toBe(0);
    expect(store.rows).toHaveLength(rowCount);
    // Every row now expires from the later seal, never from an earlier delete.
    expect(store.erasureTombstone.deleteMany.mock.calls.length).toBeGreaterThan(0);
    for (const row of store.rows) {
      expect(row.expiresAt.toISOString()).toBe("2026-09-24T00:00:00.000Z");
    }
  });

  it("writes nothing for a subject that resolved to no aliases at all", async () => {
    const store = registerStore();
    await expect(
      sealErasedSubject(store, {
        organizationId: ORG, operationId: "operation_1", policyVersion: "v1",
        platosEndUserIds: [], salt: SALT,
      }),
    ).resolves.toEqual({ aliases: 0, sealed: 0, purged: 0 });
    expect(store.erasureTombstone.createMany).not.toHaveBeenCalled();
  });
});

describe("the barrier", () => {
  it("refuses a write via an alias that was NOT the one originally requested", async () => {
    // The operator erases the subject by their Walle external id. They never
    // mention Slack. The next inbound Slack message must still be refused.
    const store = registerStore([
      { channel: "external", subject: "person_1" },
      { channel: "slack", subject: "U0ALICE" },
    ]);
    await sealErasedSubject(store, {
      organizationId: ORG,
      operationId: "operation_1",
      policyVersion: "v1",
      platosEndUserIds: ["end_user_1"],
      extraAliases: [{ channel: "external", subject: "person_1" }],
      salt: SALT,
    });

    await expect(
      assertSubjectNotErased(store, {
        organizationId: ORG,
        aliases: [{ channel: "slack", subject: "U0ALICE" }],
        salt: SALT,
      }),
    ).rejects.toBeInstanceOf(SubjectErasedError);
  });

  it("refuses a write carrying only the raw end-user uuid a late task captured", async () => {
    const store = registerStore([{ channel: "external", subject: "person_1" }]);
    await sealErasedSubject(store, {
      organizationId: ORG, operationId: "operation_1", policyVersion: "v1",
      platosEndUserIds: ["end_user_1"], salt: SALT,
    });

    await expect(
      assertSubjectNotErased(store, {
        organizationId: ORG,
        aliases: [{ channel: CANONICAL_ALIAS_CHANNEL, subject: "end_user_1" }],
        salt: SALT,
      }),
    ).rejects.toBeInstanceOf(SubjectErasedError);
  });

  it("does not refuse the same handle in another organization", async () => {
    const store = registerStore([{ channel: "slack", subject: "U0ALICE" }]);
    await sealErasedSubject(store, {
      organizationId: ORG, operationId: "operation_1", policyVersion: "v1",
      platosEndUserIds: ["end_user_1"], salt: SALT,
    });

    await expect(
      assertSubjectNotErased(store, {
        organizationId: "org_2",
        aliases: [{ channel: "slack", subject: "U0ALICE" }],
        salt: SALT,
      }),
    ).resolves.toBeUndefined();
  });

  it("lets an unrelated subject through", async () => {
    const store = registerStore([{ channel: "slack", subject: "U0ALICE" }]);
    await sealErasedSubject(store, {
      organizationId: ORG, operationId: "operation_1", policyVersion: "v1",
      platosEndUserIds: ["end_user_1"], salt: SALT,
    });

    await expect(
      assertSubjectNotErased(store, {
        organizationId: ORG,
        aliases: [{ channel: "slack", subject: "U0BOB" }],
        salt: SALT,
      }),
    ).resolves.toBeUndefined();
  });

  it("fails CLOSED when the register cannot be consulted", async () => {
    const store = registerStore();
    store.erasureTombstone.findFirst.mockRejectedValue(new TypeError("connection terminated"));

    await expect(
      assertSubjectNotErased(store, {
        organizationId: ORG,
        aliases: [{ channel: "external", subject: "person_1" }],
        salt: SALT,
      }),
    ).rejects.toBeInstanceOf(ErasureRegisterUnavailableError);
  });

  it("reports an unreachable register by error class only, never the handle", async () => {
    const store = registerStore();
    store.erasureTombstone.findFirst.mockRejectedValue(new TypeError("host alice@example.com"));

    await assertSubjectNotErased(store, {
      organizationId: ORG,
      aliases: [{ channel: "email", subject: "alice@example.com" }],
      salt: SALT,
    }).catch((err: Error) => {
      expect(err.message).toContain("TypeError");
      expect(err.message).not.toContain("alice@example.com");
    });
    expect.assertions(2);
  });

  it("does not query at all when the caller presents no usable alias", async () => {
    const store = registerStore();
    await expect(
      assertSubjectNotErased(store, { organizationId: ORG, aliases: [], salt: SALT }),
    ).resolves.toBeUndefined();
    expect(store.erasureTombstone.findFirst).not.toHaveBeenCalled();
  });
});
