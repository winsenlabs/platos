/**
 * WIN-296 — AuthService.tryConsumeAccessKeyBootstrap.
 *
 * The scope.guard.test.ts covers how the ScopeGuard WIRES the first-install
 * bootstrap into the AccessKey lifecycle. This file covers the guarantee the
 * method itself must uphold:
 *
 *   - it is OFF unless an install secret is configured;
 *   - it refuses a wrong or missing secret (timing-safe);
 *   - it refuses past the configured expiry;
 *   - it self-disables the moment an active AccessKey already exists;
 *   - it consumes the grant ATOMICALLY — the UNIQUE(environmentId) row is the
 *     single-winner gate, so a replay or a concurrent race resolves to exactly
 *     one success (not a check-then-set race);
 *   - it writes an audit row on the granted consume, and never records the raw
 *     install secret.
 *
 * The mock DB models the UNIQUE(environmentId) constraint with a synchronous
 * check-and-insert inside `create`, so two concurrent writers cannot both
 * insert — exactly the behaviour a real Postgres unique index provides.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "./auth.service";

const PARAMS = {
  organizationId: "org_1",
  projectId: "proj_1",
  environmentId: "env_1",
  userId: "user_1",
} as const;

const INSTALL_SECRET = "first-install-secret-value-32-chars";

/**
 * Mock control-plane DB. `accessKeyBootstrapGrant.create` enforces the
 * UNIQUE(environmentId) constraint synchronously (check-then-insert with no
 * await between), so a second insert for the same environment throws a
 * P2002-shaped error exactly as Postgres would.
 */
function makeBootstrapDb(opts?: { existingKeys?: number }) {
  const consumedEnvironmentIds = new Set<string>();
  const grantRows: Array<Record<string, unknown>> = [];
  const auditRows: Array<Record<string, unknown>> = [];

  const tx = {
    accessKeyBootstrapGrant: {
      create: vi.fn(async ({ data, select }: any) => {
        // Atomic single-winner gate — models UNIQUE(environmentId).
        if (consumedEnvironmentIds.has(data.environmentId)) {
          const err: any = new Error(
            "Unique constraint failed on the fields: (`environmentId`)"
          );
          err.code = "P2002";
          throw err;
        }
        consumedEnvironmentIds.add(data.environmentId);
        const row = { id: `grant_${grantRows.length + 1}`, ...data };
        grantRows.push(row);
        return select ? { id: row.id } : row;
      }),
    },
    adminAudit: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `audit_${auditRows.length + 1}`, ...data };
        auditRows.push(row);
        return row;
      }),
    },
  };

  const prisma = {
    accessKey: {
      count: vi.fn(async () => opts?.existingKeys ?? 0),
    },
    // Interactive transaction — invokes the callback with the tx client and
    // rejects (rolling back) if it throws.
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };

  return { prisma, tx, grantRows, auditRows, consumedEnvironmentIds };
}

function makeAuth(prisma: unknown) {
  return new AuthService(prisma as any, {} as any);
}

describe("AuthService.tryConsumeAccessKeyBootstrap — WIN-296 first-install grant", () => {
  let previousToken: string | undefined;
  let previousExpiry: string | undefined;

  beforeEach(() => {
    previousToken = process.env.PLATOS_BOOTSTRAP_TOKEN;
    previousExpiry = process.env.PLATOS_BOOTSTRAP_TOKEN_EXPIRES_AT;
    process.env.PLATOS_BOOTSTRAP_TOKEN = INSTALL_SECRET;
    delete process.env.PLATOS_BOOTSTRAP_TOKEN_EXPIRES_AT;
  });

  afterEach(() => {
    if (previousToken === undefined) delete process.env.PLATOS_BOOTSTRAP_TOKEN;
    else process.env.PLATOS_BOOTSTRAP_TOKEN = previousToken;
    if (previousExpiry === undefined) delete process.env.PLATOS_BOOTSTRAP_TOKEN_EXPIRES_AT;
    else process.env.PLATOS_BOOTSTRAP_TOKEN_EXPIRES_AT = previousExpiry;
  });

  // ── OFF unless configured ────────────────────────────────────────────────
  it("is disabled when no install secret is configured", async () => {
    delete process.env.PLATOS_BOOTSTRAP_TOKEN;
    const { prisma, grantRows } = makeBootstrapDb();
    const auth = makeAuth(prisma);

    const outcome = await auth.tryConsumeAccessKeyBootstrap({
      ...PARAMS,
      providedToken: INSTALL_SECRET,
    });

    expect(outcome).toEqual({ ok: false, reason: "disabled" });
    // Never touches the DB when the path is off.
    expect(prisma.accessKey.count).not.toHaveBeenCalled();
    expect(grantRows).toHaveLength(0);
  });

  // ── invalid credential ───────────────────────────────────────────────────
  it("rejects a wrong install secret", async () => {
    const { prisma, grantRows } = makeBootstrapDb();
    const auth = makeAuth(prisma);

    const outcome = await auth.tryConsumeAccessKeyBootstrap({
      ...PARAMS,
      providedToken: "not-the-secret",
    });

    expect(outcome).toEqual({ ok: false, reason: "invalid_token" });
    expect(prisma.accessKey.count).not.toHaveBeenCalled();
    expect(grantRows).toHaveLength(0);
  });

  it("rejects a missing install secret", async () => {
    const { prisma } = makeBootstrapDb();
    const auth = makeAuth(prisma);

    const outcome = await auth.tryConsumeAccessKeyBootstrap({
      ...PARAMS,
      providedToken: undefined,
    });

    expect(outcome).toEqual({ ok: false, reason: "invalid_token" });
  });

  // ── expired credential ───────────────────────────────────────────────────
  it("rejects a valid secret past the configured expiry", async () => {
    process.env.PLATOS_BOOTSTRAP_TOKEN_EXPIRES_AT = "2000-01-01T00:00:00.000Z";
    const { prisma, grantRows } = makeBootstrapDb();
    const auth = makeAuth(prisma);

    const outcome = await auth.tryConsumeAccessKeyBootstrap({
      ...PARAMS,
      providedToken: INSTALL_SECRET,
    });

    expect(outcome).toEqual({ ok: false, reason: "expired" });
    // Expiry is checked before any consume — nothing is written.
    expect(prisma.accessKey.count).not.toHaveBeenCalled();
    expect(grantRows).toHaveLength(0);
  });

  it("accepts a valid secret before a future expiry", async () => {
    process.env.PLATOS_BOOTSTRAP_TOKEN_EXPIRES_AT = new Date(
      Date.now() + 60_000
    ).toISOString();
    const { prisma } = makeBootstrapDb();
    const auth = makeAuth(prisma);

    const outcome = await auth.tryConsumeAccessKeyBootstrap({
      ...PARAMS,
      providedToken: INSTALL_SECRET,
    });

    expect(outcome.ok).toBe(true);
  });

  // ── zero-key state → granted + audited ───────────────────────────────────
  it("grants and audits the first-install consume in zero-key state", async () => {
    const { prisma, grantRows, auditRows } = makeBootstrapDb({ existingKeys: 0 });
    const auth = makeAuth(prisma);

    const outcome = await auth.tryConsumeAccessKeyBootstrap({
      ...PARAMS,
      providedToken: INSTALL_SECRET,
      source: "unit-test",
    });

    expect(outcome).toEqual({ ok: true, grantId: "grant_1" });
    expect(grantRows).toHaveLength(1);

    // The grant records a fingerprint of the secret — never the raw secret.
    const expectedFingerprint = createHash("sha256").update(INSTALL_SECRET).digest("hex");
    expect(grantRows[0]).toMatchObject({
      environmentId: "env_1",
      organizationId: "org_1",
      projectId: "proj_1",
      actorUserId: "user_1",
      tokenFingerprint: expectedFingerprint,
    });
    expect(JSON.stringify(grantRows[0])).not.toContain(INSTALL_SECRET);

    // Exactly one audit row, committed with the consume.
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      environmentId: "env_1",
      actorUserId: "user_1",
      action: "access_key.bootstrap.consumed",
      subjectType: "AccessKeyBootstrapGrant",
      subjectId: "grant_1",
    });
    expect(JSON.stringify(auditRows[0])).not.toContain(INSTALL_SECRET);
  });

  // ── existing-key state → self-disabled ───────────────────────────────────
  it("self-disables once an active AccessKey already exists", async () => {
    const { prisma, grantRows, auditRows } = makeBootstrapDb({ existingKeys: 1 });
    const auth = makeAuth(prisma);

    const outcome = await auth.tryConsumeAccessKeyBootstrap({
      ...PARAMS,
      providedToken: INSTALL_SECRET,
    });

    expect(outcome).toEqual({ ok: false, reason: "not_zero_state" });
    expect(prisma.accessKey.count).toHaveBeenCalledTimes(1);
    // No consume, no audit — the path is closed.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(grantRows).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });

  // ── replay → one-use ─────────────────────────────────────────────────────
  it("rejects a replay: the second consume of the same environment is refused", async () => {
    // existingKeys stays 0 across both calls so the ONLY thing rejecting the
    // replay is the UNIQUE grant, not the zero-key self-disable gate.
    const { prisma, grantRows, auditRows } = makeBootstrapDb({ existingKeys: 0 });
    const auth = makeAuth(prisma);

    const first = await auth.tryConsumeAccessKeyBootstrap({
      ...PARAMS,
      providedToken: INSTALL_SECRET,
    });
    const second = await auth.tryConsumeAccessKeyBootstrap({
      ...PARAMS,
      providedToken: INSTALL_SECRET,
    });

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: "already_consumed" });
    // Exactly one grant + one audit — the replay wrote nothing.
    expect(grantRows).toHaveLength(1);
    expect(auditRows).toHaveLength(1);
  });

  // ── concurrency → exactly one winner ─────────────────────────────────────
  it("resolves concurrent consumes to exactly one winner (atomic, not check-then-act)", async () => {
    // Both callers observe zero keys (the check-then-act window). Correctness
    // depends solely on the UNIQUE(environmentId) consume — a design that gated
    // only on the count would let BOTH succeed here.
    const { prisma, grantRows, auditRows } = makeBootstrapDb({ existingKeys: 0 });
    const auth = makeAuth(prisma);

    const [a, b] = await Promise.all([
      auth.tryConsumeAccessKeyBootstrap({ ...PARAMS, providedToken: INSTALL_SECRET }),
      auth.tryConsumeAccessKeyBootstrap({ ...PARAMS, providedToken: INSTALL_SECRET }),
    ]);

    const oks = [a, b].filter((r) => r.ok);
    const rejected = [a, b].filter((r) => !r.ok);
    expect(oks).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toEqual({ ok: false, reason: "already_consumed" });

    // Exactly one grant + one audit persisted.
    expect(grantRows).toHaveLength(1);
    expect(auditRows).toHaveLength(1);
  });
});
