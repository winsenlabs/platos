import { createCipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { decryptSecret, generateTotp, hashSecret } from "./auth";
import {
  backfillSupplementalAuthCutover,
  SUPPLEMENTAL_INVITATION_TTL_MS,
  SUPPLEMENTAL_PENDING_MFA_TTL_MS,
  supplementalAuthSourceModels,
  supplementalMfaCutoverCounter,
  transformSupplementalImpersonation,
  transformSupplementalInvitation,
  transformSupplementalMfa,
  verifySupplementalMfaCodeOnce,
  type SupplementalMfaSource,
} from "./cutover-auth-supplemental";
import { assertSecretFreeCutoverEvidence, decodeBase32TotpSecret } from "./cutover-crypto";
import { mapCutoverId } from "./cutover-id";
import type { CutoverDatabase, QueryResultLike } from "./cutover-types";

const legacyEncryptionKey = Buffer.alloc(32, 0x11).toString("hex");
const targetAuthEncryptionKey = Buffer.alloc(32, 0x22).toString("hex");
const cutoverAt = new Date("2026-08-17T12:00:00.000Z");
const legacyRawSecret = "A1B2C3D4E5F6G7H8I9J0K1L2";
const canonicalSecret = "IEYUEMSDGNCDIRJVIY3EON2IHBETSSRQJMYUYMQ";

function encryptLegacyV2(value: unknown, keyHex = legacyEncryptionKey) {
  const nonce = Buffer.alloc(12, 0x33);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("hex"),
    nonce: nonce.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
  };
}

function mfaSource(overrides: Partial<SupplementalMfaSource> = {}): SupplementalMfaSource {
  return {
    userSourceId: "cllegacymfauser0001",
    userCreatedAt: new Date("2025-01-01T00:00:00.000Z"),
    userUpdatedAt: new Date("2025-02-01T00:00:00.000Z"),
    enabledAt: new Date("2025-01-03T00:00:00.000Z"),
    secretReferenceId: "cllegacymfaref0001",
    referenceId: "cllegacymfaref0001",
    referenceKey: "mfa:fixture:enabled-v1",
    referenceProvider: "DATABASE",
    referenceCreatedAt: new Date("2025-01-02T00:00:00.000Z"),
    referenceUpdatedAt: new Date("2025-01-04T00:00:00.000Z"),
    storeKey: "mfa:fixture:enabled-v1",
    storeVersion: "1",
    storeValue: { secret: legacyRawSecret },
    storeCreatedAt: new Date("2025-01-02T00:00:00.000Z"),
    storeUpdatedAt: new Date("2025-01-05T00:00:00.000Z"),
    ...overrides,
  };
}

const options = { cutoverAt, legacyEncryptionKey, targetAuthEncryptionKey } as const;

describe("isolated supplemental auth cutover", () => {
  test("pins source scope, deterministic IDs, token hashing, expiry, and role mapping", () => {
    expect(supplementalAuthSourceModels).toEqual([
      "OrgMemberInvite",
      "ImpersonationAuditLog",
      "User",
      "SecretReference",
      "SecretStore",
    ]);
    const token = ["fixture", "invite", "token"].join("-");
    const transformed = transformSupplementalInvitation({
      sourceId: "cllegacyinvite0001",
      organizationId: "cllegacyorg0001",
      inviterId: "cllegacyuser0001",
      token,
      email: " Invited@Example.COM ",
      role: "ADMIN",
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
    });

    expect(transformed).toEqual({
      id: mapCutoverId({ sourceModel: "OrgMemberInvite", sourceId: "cllegacyinvite0001" }),
      organizationId: mapCutoverId({
        sourceModel: "Organization",
        sourceId: "cllegacyorg0001",
      }),
      inviterId: mapCutoverId({ sourceModel: "User", sourceId: "cllegacyuser0001" }),
      email: "invited@example.com",
      role: "ADMIN",
      tokenHash: hashSecret(token),
      expiresAt: new Date("2025-01-08T00:00:00.000Z"),
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
    });
    expect(transformed.expiresAt.getTime() - transformed.createdAt.getTime()).toBe(
      SUPPLEMENTAL_INVITATION_TTL_MS
    );
    expect(JSON.stringify(transformed)).not.toContain(token);

    expect(
      transformSupplementalInvitation({
        sourceId: "cllegacyinvite0002",
        organizationId: "cllegacyorg0001",
        inviterId: "cllegacyuser0001",
        token: "another-token",
        email: "member@example.com",
        role: "MEMBER",
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
      }).role
    ).toBe("MEMBER");
    expect(() =>
      transformSupplementalInvitation({
        sourceId: "cllegacyinvite0003",
        organizationId: "cllegacyorg0001",
        inviterId: "cllegacyuser0001",
        token: "another-token",
        email: "owner@example.com",
        role: "OWNER",
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
      })
    ).toThrow("role is unsupported");
  });

  test("maps historical impersonation to a deterministic inert session and audit", () => {
    const transformed = transformSupplementalImpersonation({
      sourceId: "cllegacyaudit0001",
      adminId: "cllegacyuser0001",
      targetUserSourceId: "cllegacyuser0002",
      action: "START",
      ipAddress: "192.0.2.1",
      createdAt: new Date("2025-03-01T00:00:00.000Z"),
    });
    const expectedId = mapCutoverId({
      sourceModel: "ImpersonationAuditLog",
      sourceId: "cllegacyaudit0001",
    });

    expect(transformed.audit).toMatchObject({
      id: expectedId,
      action: "START",
      impersonationSessionId: expectedId,
      userAgent: null,
    });
    expect(transformed.retiredSession).toMatchObject({
      id: expectedId,
      expiresAt: new Date("2025-03-01T00:00:00.000Z"),
      revokedAt: new Date("2025-03-01T00:00:00.000Z"),
    });
    expect(transformed.retiredSession.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      transformSupplementalImpersonation({
        sourceId: "cllegacyaudit0002",
        adminId: "cllegacyuser0001",
        targetUserSourceId: "cllegacyuser0002",
        action: "PAUSE",
        ipAddress: null,
        createdAt: new Date("2025-03-01T00:00:00.000Z"),
      })
    ).toThrow("action is unsupported");
  });

  test("decodes enabled SecretStore v1 raw bytes and writes target auth encryption", () => {
    const transformed = transformSupplementalMfa(mfaSource(), options)!;

    expect(transformed.id).toBe(
      mapCutoverId({
        sourceModel: "User",
        sourceId: "cllegacymfauser0001",
        suffix: "operator-mfa-totp",
      })
    );
    expect(transformed.enabledAt).toEqual(new Date("2025-01-03T00:00:00.000Z"));
    expect(transformed.lastUsedCounter).toBe(supplementalMfaCutoverCounter(cutoverAt));
    expect(transformed.pendingEncryptedSecret).toBeNull();
    expect(decryptSecret(transformed.encryptedSecret!, targetAuthEncryptionKey)).toBe(
      canonicalSecret
    );
    expect(decodeBase32TotpSecret(canonicalSecret).toString("utf8")).toBe(legacyRawSecret);
  });

  test("preserves a pending v2 enrollment with deterministic target expiry", () => {
    const transformed = transformSupplementalMfa(
      mfaSource({
        userSourceId: "cllegacymfauser0002",
        enabledAt: null,
        referenceKey: "mfa:fixture:pending-v2",
        storeKey: "mfa:fixture:pending-v2",
        storeVersion: "2",
        storeValue: encryptLegacyV2({ secret: legacyRawSecret }),
      }),
      options
    )!;

    expect(transformed.encryptedSecret).toBeNull();
    expect(transformed.enabledAt).toBeNull();
    expect(transformed.lastUsedCounter).toBeNull();
    expect(transformed.pendingExpiresAt).toEqual(
      new Date(cutoverAt.getTime() + SUPPLEMENTAL_PENDING_MFA_TTL_MS)
    );
    expect(decryptSecret(transformed.pendingEncryptedSecret!, targetAuthEncryptionKey)).toBe(
      canonicalSecret
    );
  });

  test("omits disabled MFA and rejects an enabled user with a null reference", () => {
    expect(
      transformSupplementalMfa(
        mfaSource({
          enabledAt: null,
          secretReferenceId: null,
          referenceId: null,
          referenceKey: null,
          referenceProvider: null,
          referenceCreatedAt: null,
          referenceUpdatedAt: null,
          storeKey: null,
          storeVersion: null,
          storeValue: null,
          storeCreatedAt: null,
          storeUpdatedAt: null,
        }),
        options
      )
    ).toBeNull();
    expect(() =>
      transformSupplementalMfa(
        mfaSource({
          secretReferenceId: null,
          referenceId: null,
          referenceKey: null,
          referenceProvider: null,
          referenceCreatedAt: null,
          referenceUpdatedAt: null,
          storeKey: null,
          storeVersion: null,
          storeValue: null,
          storeCreatedAt: null,
          storeUpdatedAt: null,
        }),
        options
      )
    ).toThrow("enabled supplemental auth MFA has no inherited reference");
  });

  test("fails closed for missing, undecryptable, unsupported, and non-legacy TOTP material", () => {
    const cases: SupplementalMfaSource[] = [
      mfaSource({ storeKey: null, storeCreatedAt: null, storeUpdatedAt: null }),
      mfaSource({ storeValue: encryptLegacyV2({ secret: legacyRawSecret }), storeVersion: "2" }),
      mfaSource({ storeVersion: "3" }),
      mfaSource({ storeValue: { secret: "lowercase-is-not-legacy" } }),
      mfaSource({ storeValue: { secret: canonicalSecret } }),
    ];
    for (const source of cases) {
      const caseOptions =
        source.storeVersion === "2"
          ? { ...options, legacyEncryptionKey: Buffer.alloc(32, 0x77).toString("hex") }
          : options;
      expect(() => transformSupplementalMfa(source, caseOptions)).toThrow(
        "non-null supplemental auth MFA reference is unreadable"
      );
    }
  });

  test("rejects the cutover timestep and accepts the next timestep only once", () => {
    const transformed = transformSupplementalMfa(mfaSource(), options)!;
    const barrier = transformed.lastUsedCounter!;
    const currentCode = generateTotp(canonicalSecret, cutoverAt);
    expect(
      verifySupplementalMfaCodeOnce({
        encryptedSecret: transformed.encryptedSecret!,
        targetAuthEncryptionKey,
        submittedCode: currentCode,
        at: cutoverAt,
        lastUsedCounter: barrier,
      })
    ).toBeNull();

    const nextAt = new Date(cutoverAt.getTime() + 30_000);
    const nextCode = generateTotp(canonicalSecret, nextAt);
    const acceptedCounter = verifySupplementalMfaCodeOnce({
      encryptedSecret: transformed.encryptedSecret!,
      targetAuthEncryptionKey,
      submittedCode: nextCode,
      at: nextAt,
      lastUsedCounter: barrier,
    });
    expect(acceptedCounter).toBe(barrier + 1n);
    expect(
      verifySupplementalMfaCodeOnce({
        encryptedSecret: transformed.encryptedSecret!,
        targetAuthEncryptionKey,
        submittedCode: nextCode,
        at: nextAt,
        lastUsedCounter: acceptedCounter,
      })
    ).toBeNull();
  });

  test("preflights all decrypts before writes and returns secret-free conservation evidence", async () => {
    const inviteToken = ["never", "retain", "invite"].join("-");
    const queries: { sql: string; values?: readonly unknown[] }[] = [];
    const invitationId = mapCutoverId({
      sourceModel: "OrgMemberInvite",
      sourceId: "cllegacyinvite0001",
    });
    const organizationId = mapCutoverId({
      sourceModel: "Organization",
      sourceId: "cllegacyorg0001",
    });
    const actorId = mapCutoverId({ sourceModel: "User", sourceId: "cllegacyuser0001" });
    const targetId = mapCutoverId({ sourceModel: "User", sourceId: "cllegacyuser0002" });
    const auditId = mapCutoverId({
      sourceModel: "ImpersonationAuditLog",
      sourceId: "cllegacyaudit0001",
    });
    const enabled = mfaSource({
      targetUserId: mapCutoverId({ sourceModel: "User", sourceId: "cllegacymfauser0001" }),
      targetMfaId: mapCutoverId({
        sourceModel: "User",
        sourceId: "cllegacymfauser0001",
        suffix: "operator-mfa-totp",
      }),
    });
    const disabled = mfaSource({
      userSourceId: "cllegacymfauser0002",
      targetUserId: mapCutoverId({ sourceModel: "User", sourceId: "cllegacymfauser0002" }),
      targetMfaId: mapCutoverId({
        sourceModel: "User",
        sourceId: "cllegacymfauser0002",
        suffix: "operator-mfa-totp",
      }),
      enabledAt: null,
      secretReferenceId: null,
      referenceId: null,
      referenceKey: null,
      referenceProvider: null,
      referenceCreatedAt: null,
      referenceUpdatedAt: null,
      storeKey: null,
      storeVersion: null,
      storeValue: null,
      storeCreatedAt: null,
      storeUpdatedAt: null,
    });
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(
        sql: string,
        values?: readonly unknown[]
      ): Promise<QueryResultLike<Row>> {
        queries.push({ sql, values });
        let rows: Record<string, unknown>[] = [];
        if (sql.includes("WITH issues AS") && sql.includes("invitation-mapping-or-parent")) {
          rows = [];
        } else if (sql.includes('FROM cutover_legacy."OrgMemberInvite" source')) {
          rows = [
            {
              source_id: "cllegacyinvite0001",
              target_id: invitationId,
              organization_source_id: "cllegacyorg0001",
              organization_id: organizationId,
              inviter_source_id: "cllegacyuser0001",
              inviter_id: actorId,
              token: inviteToken,
              email: "invite@example.com",
              role: "ADMIN",
              created_at: new Date("2025-01-01T00:00:00.000Z"),
            },
          ];
        } else if (sql.includes('FROM cutover_legacy."ImpersonationAuditLog" source')) {
          rows = [
            {
              source_id: "cllegacyaudit0001",
              target_id: auditId,
              admin_source_id: "cllegacyuser0001",
              actor_user_id: actorId,
              target_source_id: "cllegacyuser0002",
              target_user_id: targetId,
              action: "STOP",
              ip_address: null,
              created_at: new Date("2025-01-01T00:00:00.000Z"),
            },
          ];
        } else if (sql.includes('FROM cutover_legacy."User" source')) {
          rows = [enabled, disabled].map((source) => ({
            user_source_id: source.userSourceId,
            target_user_id: source.targetUserId,
            target_mfa_id: source.targetMfaId,
            user_created_at: source.userCreatedAt,
            user_updated_at: source.userUpdatedAt,
            enabled_at: source.enabledAt,
            secret_reference_id: source.secretReferenceId,
            reference_id: source.referenceId,
            reference_key: source.referenceKey,
            reference_provider: source.referenceProvider,
            reference_created_at: source.referenceCreatedAt,
            reference_updated_at: source.referenceUpdatedAt,
            store_key: source.storeKey,
            store_version: source.storeVersion,
            store_value: source.storeValue,
            store_created_at: source.storeCreatedAt,
            store_updated_at: source.storeUpdatedAt,
          }));
        }
        return { rows: rows as Row[], rowCount: rows.length };
      },
    };

    const evidence = await backfillSupplementalAuthCutover(database, options);
    expect(evidence).toEqual({
      invitationRows: 1,
      impersonationAuditRows: 1,
      retiredImpersonationSessionRows: 1,
      enabledMfaRows: 1,
      pendingMfaRows: 0,
      disabledMfaUsers: 1,
      recoveryCodeRows: 0,
    });
    expect(() =>
      assertSecretFreeCutoverEvidence(evidence, [inviteToken, legacyRawSecret])
    ).not.toThrow();
    expect(JSON.stringify(evidence)).not.toContain(inviteToken);
    expect(JSON.stringify(evidence)).not.toContain(legacyRawSecret);
    expect(
      queries.some((query) => query.sql.includes('INSERT INTO public."OperatorMfaRecoveryCode"'))
    ).toBe(false);
    const invitationInsert = queries.find((query) =>
      query.sql.includes('INSERT INTO public."OrganizationInvitation"')
    )!;
    expect(invitationInsert.values).toContain(hashSecret(inviteToken));
    expect(invitationInsert.values).not.toContain(inviteToken);
  });

  test("blocks during preflight before reading or writing sensitive rows", async () => {
    const queries: string[] = [];
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(sql: string): Promise<QueryResultLike<Row>> {
        queries.push(sql);
        return {
          rows: [{ issue: "mfa-reference-or-store" }] as unknown as Row[],
          rowCount: 1,
        };
      },
    };

    await expect(backfillSupplementalAuthCutover(database, options)).rejects.toThrow(
      "mfa-reference-or-store"
    );
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toContain("store.value AS store_value");
  });

  test("checks in a fixture covering every supplemental MFA source classification", () => {
    const fixture = readFileSync(
      resolve(__dirname, "../test-fixtures/legacy-auth-supplemental-seed.sql"),
      "utf8"
    );
    for (const marker of [
      "enabled-v1",
      "disabled-null-reference",
      "pending-v2",
      "enabled-null-reference",
      "missing-store",
      "undecryptable-v2",
      "non-base32-source",
      "no-recovery-code-cutover",
    ]) {
      expect(fixture).toContain(marker);
    }
  });
});
