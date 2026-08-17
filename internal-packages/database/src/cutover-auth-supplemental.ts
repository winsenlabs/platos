import { timingSafeEqual } from "node:crypto";
import { decryptSecret, encryptSecret, generateTotp, hashSecret } from "./auth";
import {
  assertSecretFreeCutoverEvidence,
  convertLegacyTotpSecretToBase32,
  decodeBase32TotpSecret,
  decodeLegacySecretStoreJson,
} from "./cutover-crypto";
import { mapCutoverId } from "./cutover-id";
import type { CutoverDatabase } from "./cutover-types";
import { CutoverFailure } from "./cutover-types";

const DAY_MS = 24 * 60 * 60 * 1000;
const TOTP_PERIOD_MS = 30_000;

export const SUPPLEMENTAL_INVITATION_TTL_MS = 7 * DAY_MS;
export const SUPPLEMENTAL_PENDING_MFA_TTL_MS = 15 * 60 * 1000;

export const supplementalAuthSourceModels = [
  "OrgMemberInvite",
  "ImpersonationAuditLog",
  "User",
  "SecretReference",
  "SecretStore",
] as const;

export interface SupplementalAuthCutoverOptions {
  readonly cutoverAt: Date;
  readonly legacyEncryptionKey: string;
  readonly targetAuthEncryptionKey: string | Buffer;
}

export interface SupplementalInvitationSource {
  readonly sourceId: string;
  readonly targetId?: string;
  readonly organizationId: string;
  readonly targetOrganizationId?: string;
  readonly inviterId: string;
  readonly targetInviterId?: string;
  readonly token: string;
  readonly email: string;
  readonly role: string;
  readonly createdAt: Date;
}

export interface SupplementalInvitationTarget {
  readonly id: string;
  readonly organizationId: string;
  readonly inviterId: string;
  readonly email: string;
  readonly role: "ADMIN" | "MEMBER";
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface SupplementalImpersonationSource {
  readonly sourceId: string;
  readonly targetId?: string;
  readonly adminId: string;
  readonly targetUserSourceId: string;
  readonly targetActorUserId?: string;
  readonly targetTargetUserId?: string;
  readonly action: string;
  readonly ipAddress: string | null;
  readonly createdAt: Date;
}

export interface SupplementalRetiredImpersonationSessionTarget {
  readonly id: string;
  readonly tokenHash: string;
  readonly userId: string;
  readonly impersonatedUserId: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date;
  readonly createdAt: Date;
}

export interface SupplementalImpersonationAuditTarget {
  readonly id: string;
  readonly action: "START" | "STOP";
  readonly actorUserId: string;
  readonly targetUserId: string;
  readonly impersonationSessionId: string;
  readonly ipAddress: string | null;
  readonly userAgent: null;
  readonly createdAt: Date;
}

export interface SupplementalMfaSource {
  readonly userSourceId: string;
  readonly targetUserId?: string;
  readonly targetMfaId?: string;
  readonly userCreatedAt: Date;
  readonly userUpdatedAt: Date;
  readonly enabledAt: Date | null;
  readonly secretReferenceId: string | null;
  readonly referenceId: string | null;
  readonly referenceKey: string | null;
  readonly referenceProvider: string | null;
  readonly referenceCreatedAt: Date | null;
  readonly referenceUpdatedAt: Date | null;
  readonly storeKey: string | null;
  readonly storeVersion: unknown;
  readonly storeValue: unknown;
  readonly storeCreatedAt: Date | null;
  readonly storeUpdatedAt: Date | null;
}

export interface SupplementalMfaTarget {
  readonly id: string;
  readonly userId: string;
  readonly encryptedSecret: string | null;
  readonly enabledAt: Date | null;
  readonly lastUsedCounter: bigint | null;
  readonly pendingEncryptedSecret: string | null;
  readonly pendingExpiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SupplementalAuthEvidence {
  readonly invitationRows: number;
  readonly impersonationAuditRows: number;
  readonly retiredImpersonationSessionRows: number;
  readonly enabledMfaRows: number;
  readonly pendingMfaRows: number;
  readonly disabledMfaUsers: number;
  readonly recoveryCodeRows: 0;
}

interface SupplementalAuthPlan {
  readonly invitations: readonly SupplementalInvitationTarget[];
  readonly retiredSessions: readonly SupplementalRetiredImpersonationSessionTarget[];
  readonly impersonationAudits: readonly SupplementalImpersonationAuditTarget[];
  readonly mfaRows: readonly SupplementalMfaTarget[];
  readonly disabledMfaUsers: number;
  readonly evidence: SupplementalAuthEvidence;
}

function assertDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new CutoverFailure(
      "AUTH_SUPPLEMENTAL_SOURCE_INVALID",
      `supplemental auth source ${field} must be a valid timestamp`
    );
  }
  return value;
}

function mappedId(
  sourceModel: string,
  sourceId: string,
  supplied: string | undefined,
  suffix?: string
): string {
  const deterministic = mapCutoverId({ sourceModel, sourceId, suffix });
  if (supplied !== undefined && supplied !== deterministic) {
    throw new CutoverFailure(
      "AUTH_SUPPLEMENTAL_MAPPING_INVALID",
      "supplemental auth deterministic mapping does not match the cutover contract"
    );
  }
  return deterministic;
}

/** Hashes inherited invite tokens and applies the target service's seven-day policy. */
export function transformSupplementalInvitation(
  source: SupplementalInvitationSource
): SupplementalInvitationTarget {
  const createdAt = assertDate(source.createdAt, "invitation createdAt");
  if (typeof source.token !== "string" || source.token.length === 0) {
    throw new CutoverFailure(
      "AUTH_SUPPLEMENTAL_SOURCE_INVALID",
      "supplemental auth invitation token is missing"
    );
  }
  const email = source.email.trim().toLowerCase();
  if (email.length === 0) {
    throw new CutoverFailure(
      "AUTH_SUPPLEMENTAL_SOURCE_INVALID",
      "supplemental auth invitation email is missing"
    );
  }
  const role = source.role === "ADMIN" ? "ADMIN" : source.role === "MEMBER" ? "MEMBER" : null;
  if (role === null) {
    throw new CutoverFailure(
      "AUTH_SUPPLEMENTAL_SOURCE_INVALID",
      "supplemental auth invitation role is unsupported"
    );
  }

  return Object.freeze({
    id: mappedId("OrgMemberInvite", source.sourceId, source.targetId),
    organizationId: mappedId("Organization", source.organizationId, source.targetOrganizationId),
    inviterId: mappedId("User", source.inviterId, source.targetInviterId),
    email,
    role,
    tokenHash: hashSecret(source.token),
    expiresAt: new Date(createdAt.getTime() + SUPPLEMENTAL_INVITATION_TTL_MS),
    createdAt: new Date(createdAt),
  });
}

/**
 * Historical impersonation rows need a target session FK. A deterministic,
 * already-expired and already-revoked support row is created with the same UUID;
 * it is never an authenticatable live session.
 */
export function transformSupplementalImpersonation(source: SupplementalImpersonationSource): {
  readonly retiredSession: SupplementalRetiredImpersonationSessionTarget;
  readonly audit: SupplementalImpersonationAuditTarget;
} {
  const createdAt = assertDate(source.createdAt, "impersonation createdAt");
  const id = mappedId("ImpersonationAuditLog", source.sourceId, source.targetId);
  const actorUserId = mappedId("User", source.adminId, source.targetActorUserId);
  const targetUserId = mappedId("User", source.targetUserSourceId, source.targetTargetUserId);
  const action = source.action === "START" ? "START" : source.action === "STOP" ? "STOP" : null;
  if (action === null) {
    throw new CutoverFailure(
      "AUTH_SUPPLEMENTAL_SOURCE_INVALID",
      "supplemental auth impersonation action is unsupported"
    );
  }

  return Object.freeze({
    retiredSession: Object.freeze({
      id,
      tokenHash: hashSecret(`platos-cutover-retired-session:${id}`),
      userId: actorUserId,
      impersonatedUserId: targetUserId,
      expiresAt: new Date(createdAt),
      revokedAt: new Date(createdAt),
      createdAt: new Date(createdAt),
    }),
    audit: Object.freeze({
      id,
      action,
      actorUserId,
      targetUserId,
      impersonationSessionId: id,
      ipAddress: source.ipAddress,
      userAgent: null,
      createdAt: new Date(createdAt),
    }),
  });
}

export function supplementalMfaCutoverCounter(cutoverAt: Date): bigint {
  return BigInt(Math.floor(assertDate(cutoverAt, "cutoverAt").getTime() / TOTP_PERIOD_MS));
}

/**
 * Converts legacy raw TOTP bytes to canonical unpadded Base32 and writes only
 * the target auth AES-GCM format. A non-null reference is always decoded or the
 * cutover fails; there is no plaintext or missing-row fallback.
 */
export function transformSupplementalMfa(
  source: SupplementalMfaSource,
  options: SupplementalAuthCutoverOptions
): SupplementalMfaTarget | null {
  assertDate(options.cutoverAt, "cutoverAt");
  assertDate(source.userCreatedAt, "user createdAt");
  assertDate(source.userUpdatedAt, "user updatedAt");

  if (source.secretReferenceId === null) {
    if (source.enabledAt !== null) {
      throw new CutoverFailure(
        "AUTH_SUPPLEMENTAL_MFA_UNREADABLE",
        "enabled supplemental auth MFA has no inherited reference"
      );
    }
    return null;
  }

  if (
    source.referenceId !== source.secretReferenceId ||
    source.referenceProvider !== "DATABASE" ||
    typeof source.referenceKey !== "string" ||
    source.referenceKey.length === 0 ||
    source.storeKey !== source.referenceKey ||
    source.referenceCreatedAt === null ||
    source.referenceUpdatedAt === null ||
    source.storeCreatedAt === null ||
    source.storeUpdatedAt === null
  ) {
    throw new CutoverFailure(
      "AUTH_SUPPLEMENTAL_MFA_UNREADABLE",
      "non-null supplemental auth MFA reference is unreadable"
    );
  }

  let canonicalSecret: string;
  try {
    const decoded = decodeLegacySecretStoreJson(
      { version: source.storeVersion, value: source.storeValue },
      options.legacyEncryptionKey
    );
    canonicalSecret = convertLegacyTotpSecretToBase32(decoded);
    decodeBase32TotpSecret(canonicalSecret);
  } catch {
    throw new CutoverFailure(
      "AUTH_SUPPLEMENTAL_MFA_UNREADABLE",
      "non-null supplemental auth MFA reference is unreadable"
    );
  }

  const encrypted = encryptSecret(canonicalSecret, options.targetAuthEncryptionKey);
  const enabledAt =
    source.enabledAt === null ? null : assertDate(source.enabledAt, "MFA enabledAt");
  const createdAt = new Date(source.referenceCreatedAt);
  const updatedAt = new Date(
    Math.max(
      source.userUpdatedAt.getTime(),
      source.referenceUpdatedAt.getTime(),
      source.storeUpdatedAt.getTime()
    )
  );

  return Object.freeze({
    id: mappedId("User", source.userSourceId, source.targetMfaId, "operator-mfa-totp"),
    userId: mappedId("User", source.userSourceId, source.targetUserId),
    encryptedSecret: enabledAt === null ? null : encrypted,
    enabledAt: enabledAt === null ? null : new Date(enabledAt),
    lastUsedCounter: enabledAt === null ? null : supplementalMfaCutoverCounter(options.cutoverAt),
    pendingEncryptedSecret: enabledAt === null ? encrypted : null,
    pendingExpiresAt:
      enabledAt === null
        ? new Date(options.cutoverAt.getTime() + SUPPLEMENTAL_PENDING_MFA_TTL_MS)
        : null,
    createdAt,
    updatedAt,
  });
}

/** Post-cutover probe matching the target auth ±1-step window and replay rule. */
export function verifySupplementalMfaCodeOnce(params: {
  readonly encryptedSecret: string;
  readonly targetAuthEncryptionKey: string | Buffer;
  readonly submittedCode: string;
  readonly at: Date;
  readonly lastUsedCounter: bigint | null;
}): bigint | null {
  if (!/^\d{6}$/.test(params.submittedCode)) return null;
  const secret = decryptSecret(params.encryptedSecret, params.targetAuthEncryptionKey);
  decodeBase32TotpSecret(secret);
  const currentCounter = supplementalMfaCutoverCounter(params.at);
  for (let offset = -1; offset <= 1; offset += 1) {
    const counter = currentCounter + BigInt(offset);
    if (counter < 0n) continue;
    const expected = generateTotp(secret, new Date(Number(counter) * TOTP_PERIOD_MS));
    if (
      safeCodeEqual(params.submittedCode, expected) &&
      (params.lastUsedCounter === null || counter > params.lastUsedCounter)
    ) {
      return counter;
    }
  }
  return null;
}

function safeCodeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

interface InvitationQueryRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  organization_source_id: string;
  organization_id: string;
  inviter_source_id: string;
  inviter_id: string;
  token: string;
  email: string;
  role: string;
  created_at: Date;
}

interface ImpersonationQueryRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  admin_source_id: string;
  actor_user_id: string;
  target_source_id: string;
  target_user_id: string;
  action: string;
  ip_address: string | null;
  created_at: Date;
}

interface MfaQueryRow extends Record<string, unknown> {
  user_source_id: string;
  target_user_id: string;
  target_mfa_id: string;
  user_created_at: Date;
  user_updated_at: Date;
  enabled_at: Date | null;
  secret_reference_id: string | null;
  reference_id: string | null;
  reference_key: string | null;
  reference_provider: string | null;
  reference_created_at: Date | null;
  reference_updated_at: Date | null;
  store_key: string | null;
  store_version: unknown;
  store_value: unknown;
  store_created_at: Date | null;
  store_updated_at: Date | null;
}

const preflightSql = `
  WITH issues AS (
    SELECT 'invitation-mapping-or-parent' AS issue
      WHERE EXISTS (
        SELECT 1 FROM cutover_legacy."OrgMemberInvite" source
        WHERE NOT EXISTS (SELECT 1 FROM cutover_legacy.cutover_id_map map
                           WHERE map.mapping_version = 1 AND map.source_model = 'OrgMemberInvite'
                             AND map.source_id = source.id AND map.target_model = 'OrganizationInvitation'
                             AND map.stable_suffix = '')
           OR NOT EXISTS (SELECT 1 FROM cutover_legacy.cutover_id_map map
                           WHERE map.mapping_version = 1 AND map.source_model = 'Organization'
                             AND map.source_id = source."organizationId" AND map.target_model = 'Organization')
           OR NOT EXISTS (SELECT 1 FROM cutover_legacy.cutover_id_map map
                           WHERE map.mapping_version = 1 AND map.source_model = 'User'
                             AND map.source_id = source."inviterId" AND map.target_model = 'User'))
    UNION ALL
    SELECT 'invitation-fields'
      WHERE EXISTS (SELECT 1 FROM cutover_legacy."OrgMemberInvite"
                     WHERE token = '' OR btrim(email) = '' OR role::text NOT IN ('ADMIN', 'MEMBER'))
    UNION ALL
    SELECT 'impersonation-mapping-or-parent'
      WHERE EXISTS (
        SELECT 1 FROM cutover_legacy."ImpersonationAuditLog" source
        WHERE NOT EXISTS (SELECT 1 FROM cutover_legacy.cutover_id_map map
                           WHERE map.mapping_version = 1 AND map.source_model = 'ImpersonationAuditLog'
                             AND map.source_id = source.id AND map.target_model = 'ImpersonationAudit'
                             AND map.stable_suffix = '')
           OR NOT EXISTS (SELECT 1 FROM cutover_legacy.cutover_id_map map
                           WHERE map.mapping_version = 1 AND map.source_model = 'User'
                             AND map.source_id = source."adminId" AND map.target_model = 'User')
           OR NOT EXISTS (SELECT 1 FROM cutover_legacy.cutover_id_map map
                           WHERE map.mapping_version = 1 AND map.source_model = 'User'
                             AND map.source_id = source."targetId" AND map.target_model = 'User'))
    UNION ALL
    SELECT 'impersonation-action'
      WHERE EXISTS (SELECT 1 FROM cutover_legacy."ImpersonationAuditLog"
                     WHERE action::text NOT IN ('START', 'STOP'))
    UNION ALL
    SELECT 'enabled-mfa-without-reference'
      WHERE EXISTS (SELECT 1 FROM cutover_legacy."User"
                     WHERE "mfaEnabledAt" IS NOT NULL AND "mfaSecretReferenceId" IS NULL)
    UNION ALL
    SELECT 'shared-mfa-reference'
      WHERE EXISTS (SELECT 1 FROM cutover_legacy."User"
                     WHERE "mfaSecretReferenceId" IS NOT NULL
                     GROUP BY "mfaSecretReferenceId" HAVING count(*) > 1)
    UNION ALL
    SELECT 'mfa-mapping'
      WHERE EXISTS (
        SELECT 1 FROM cutover_legacy."User" source
        WHERE source."mfaSecretReferenceId" IS NOT NULL AND (
          NOT EXISTS (SELECT 1 FROM cutover_legacy.cutover_id_map map
                       WHERE map.mapping_version = 1 AND map.source_model = 'User'
                         AND map.source_id = source.id AND map.target_model = 'User')
          OR NOT EXISTS (SELECT 1 FROM cutover_legacy.cutover_id_map map
                          WHERE map.mapping_version = 1 AND map.source_model = 'User'
                            AND map.source_id = source.id AND map.target_model = 'OperatorMfaTotp'
                            AND map.stable_suffix = 'operator-mfa-totp')))
    UNION ALL
    SELECT 'mfa-reference-or-store'
      WHERE EXISTS (
        SELECT 1 FROM cutover_legacy."User" source
        LEFT JOIN cutover_legacy."SecretReference" reference
          ON reference.id = source."mfaSecretReferenceId"
        LEFT JOIN cutover_legacy."SecretStore" store ON store.key = reference.key
        WHERE source."mfaSecretReferenceId" IS NOT NULL
          AND (reference.id IS NULL OR reference.provider::text <> 'DATABASE' OR store.key IS NULL))
  )
  SELECT issue FROM issues ORDER BY issue`;

async function loadSupplementalAuthPlan(
  database: CutoverDatabase,
  options: SupplementalAuthCutoverOptions
): Promise<SupplementalAuthPlan> {
  const preflight = await database.query<{ issue: string }>(preflightSql);
  if (preflight.rows.length > 0) {
    throw new CutoverFailure(
      "AUTH_SUPPLEMENTAL_PREFLIGHT_FAILED",
      `supplemental auth preflight failed: ${preflight.rows.map((row) => row.issue).join(", ")}`
    );
  }

  const invitationRows = await database.query<InvitationQueryRow>(`
    SELECT source.id::text AS source_id, invitation_map.target_id::text AS target_id,
           source."organizationId"::text AS organization_source_id,
           organization_map.target_id::text AS organization_id,
           source."inviterId"::text AS inviter_source_id, inviter_map.target_id::text AS inviter_id,
           source.token, source.email, source.role::text AS role, source."createdAt" AS created_at
      FROM cutover_legacy."OrgMemberInvite" source
      JOIN cutover_legacy.cutover_id_map invitation_map
        ON invitation_map.mapping_version = 1 AND invitation_map.source_model = 'OrgMemberInvite'
       AND invitation_map.source_id = source.id AND invitation_map.target_model = 'OrganizationInvitation'
       AND invitation_map.stable_suffix = ''
      JOIN cutover_legacy.cutover_id_map organization_map
        ON organization_map.mapping_version = 1 AND organization_map.source_model = 'Organization'
       AND organization_map.source_id = source."organizationId" AND organization_map.target_model = 'Organization'
      JOIN cutover_legacy.cutover_id_map inviter_map
        ON inviter_map.mapping_version = 1 AND inviter_map.source_model = 'User'
       AND inviter_map.source_id = source."inviterId" AND inviter_map.target_model = 'User'
     ORDER BY source.id`);
  const invitations = invitationRows.rows.map((row) =>
    transformSupplementalInvitation({
      sourceId: row.source_id,
      targetId: row.target_id,
      organizationId: row.organization_source_id,
      targetOrganizationId: row.organization_id,
      inviterId: row.inviter_source_id,
      targetInviterId: row.inviter_id,
      token: row.token,
      email: row.email,
      role: row.role,
      createdAt: row.created_at,
    })
  );

  const impersonationRows = await database.query<ImpersonationQueryRow>(`
    SELECT source.id::text AS source_id, audit_map.target_id::text AS target_id,
           source."adminId"::text AS admin_source_id, actor_map.target_id::text AS actor_user_id,
           source."targetId"::text AS target_source_id, target_map.target_id::text AS target_user_id,
           source.action::text AS action, source."ipAddress" AS ip_address,
           source."createdAt" AS created_at
      FROM cutover_legacy."ImpersonationAuditLog" source
      JOIN cutover_legacy.cutover_id_map audit_map
        ON audit_map.mapping_version = 1 AND audit_map.source_model = 'ImpersonationAuditLog'
       AND audit_map.source_id = source.id AND audit_map.target_model = 'ImpersonationAudit'
       AND audit_map.stable_suffix = ''
      JOIN cutover_legacy.cutover_id_map actor_map
        ON actor_map.mapping_version = 1 AND actor_map.source_model = 'User'
       AND actor_map.source_id = source."adminId" AND actor_map.target_model = 'User'
      JOIN cutover_legacy.cutover_id_map target_map
        ON target_map.mapping_version = 1 AND target_map.source_model = 'User'
       AND target_map.source_id = source."targetId" AND target_map.target_model = 'User'
     ORDER BY source.id`);
  const transformedImpersonations = impersonationRows.rows.map((row) =>
    transformSupplementalImpersonation({
      sourceId: row.source_id,
      targetId: row.target_id,
      adminId: row.admin_source_id,
      targetUserSourceId: row.target_source_id,
      targetActorUserId: row.actor_user_id,
      targetTargetUserId: row.target_user_id,
      action: row.action,
      ipAddress: row.ip_address,
      createdAt: row.created_at,
    })
  );

  const mfaSourceRows = await database.query<MfaQueryRow>(`
    SELECT source.id::text AS user_source_id, user_map.target_id::text AS target_user_id,
           mfa_map.target_id::text AS target_mfa_id,
           source."createdAt" AS user_created_at, source."updatedAt" AS user_updated_at,
           source."mfaEnabledAt" AS enabled_at,
           source."mfaSecretReferenceId"::text AS secret_reference_id,
           reference.id::text AS reference_id, reference.key AS reference_key,
           reference.provider::text AS reference_provider,
           reference."createdAt" AS reference_created_at,
           reference."updatedAt" AS reference_updated_at,
           store.key AS store_key, store.version AS store_version, store.value AS store_value,
           store."createdAt" AS store_created_at, store."updatedAt" AS store_updated_at
      FROM cutover_legacy."User" source
      JOIN cutover_legacy.cutover_id_map user_map
        ON user_map.mapping_version = 1 AND user_map.source_model = 'User'
       AND user_map.source_id = source.id AND user_map.target_model = 'User'
      JOIN cutover_legacy.cutover_id_map mfa_map
        ON mfa_map.mapping_version = 1 AND mfa_map.source_model = 'User'
       AND mfa_map.source_id = source.id AND mfa_map.target_model = 'OperatorMfaTotp'
       AND mfa_map.stable_suffix = 'operator-mfa-totp'
      LEFT JOIN cutover_legacy."SecretReference" reference
        ON reference.id = source."mfaSecretReferenceId"
      LEFT JOIN cutover_legacy."SecretStore" store ON store.key = reference.key
     ORDER BY source.id`);
  const transformedMfa = mfaSourceRows.rows.map((row) =>
    transformSupplementalMfa(
      {
        userSourceId: row.user_source_id,
        targetUserId: row.target_user_id,
        targetMfaId: row.target_mfa_id,
        userCreatedAt: row.user_created_at,
        userUpdatedAt: row.user_updated_at,
        enabledAt: row.enabled_at,
        secretReferenceId: row.secret_reference_id,
        referenceId: row.reference_id,
        referenceKey: row.reference_key,
        referenceProvider: row.reference_provider,
        referenceCreatedAt: row.reference_created_at,
        referenceUpdatedAt: row.reference_updated_at,
        storeKey: row.store_key,
        storeVersion: row.store_version,
        storeValue: row.store_value,
        storeCreatedAt: row.store_created_at,
        storeUpdatedAt: row.store_updated_at,
      },
      options
    )
  );
  const mfaRows = transformedMfa.filter((row): row is SupplementalMfaTarget => row !== null);
  const disabledMfaUsers = transformedMfa.length - mfaRows.length;
  const evidence = Object.freeze({
    invitationRows: invitations.length,
    impersonationAuditRows: transformedImpersonations.length,
    retiredImpersonationSessionRows: transformedImpersonations.length,
    enabledMfaRows: mfaRows.filter((row) => row.enabledAt !== null).length,
    pendingMfaRows: mfaRows.filter((row) => row.enabledAt === null).length,
    disabledMfaUsers,
    recoveryCodeRows: 0 as const,
  });
  assertSecretFreeCutoverEvidence(evidence);

  return Object.freeze({
    invitations,
    retiredSessions: transformedImpersonations.map((row) => row.retiredSession),
    impersonationAudits: transformedImpersonations.map((row) => row.audit),
    mfaRows,
    disabledMfaUsers,
    evidence,
  });
}

function parameterTuples(rowCount: number, width: number): string {
  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const offset = rowIndex * width;
    return `(${Array.from(
      { length: width },
      (__, columnIndex) => `$${offset + columnIndex + 1}`
    ).join(", ")})`;
  }).join(", ");
}

/** Preflights every source (including decrypts) before writing any target row. */
export async function backfillSupplementalAuthCutover(
  database: CutoverDatabase,
  options: SupplementalAuthCutoverOptions
): Promise<SupplementalAuthEvidence> {
  const plan = await loadSupplementalAuthPlan(database, options);

  if (plan.invitations.length > 0) {
    await database.query(
      `INSERT INTO public."OrganizationInvitation"
        (id, "organizationId", "inviterId", email, role, "tokenHash", "expiresAt", "createdAt")
       VALUES ${parameterTuples(plan.invitations.length, 8)}`,
      plan.invitations.flatMap((row) => [
        row.id,
        row.organizationId,
        row.inviterId,
        row.email,
        row.role,
        row.tokenHash,
        row.expiresAt,
        row.createdAt,
      ])
    );
  }

  if (plan.retiredSessions.length > 0) {
    await database.query(
      `INSERT INTO public."OperatorSession"
        (id, "tokenHash", tier, "userId", "impersonatedUserId", "expiresAt", "revokedAt", "createdAt")
       VALUES ${parameterTuples(plan.retiredSessions.length, 8)}`,
      plan.retiredSessions.flatMap((row) => [
        row.id,
        row.tokenHash,
        "OPERATOR",
        row.userId,
        row.impersonatedUserId,
        row.expiresAt,
        row.revokedAt,
        row.createdAt,
      ])
    );
    await database.query(
      `INSERT INTO public."ImpersonationAudit"
        (id, action, "actorUserId", "targetUserId", "impersonationSessionId",
         "ipAddress", "userAgent", "createdAt")
       VALUES ${parameterTuples(plan.impersonationAudits.length, 8)}`,
      plan.impersonationAudits.flatMap((row) => [
        row.id,
        row.action,
        row.actorUserId,
        row.targetUserId,
        row.impersonationSessionId,
        row.ipAddress,
        row.userAgent,
        row.createdAt,
      ])
    );
  }

  if (plan.mfaRows.length > 0) {
    await database.query(
      `INSERT INTO public."OperatorMfaTotp"
        (id, "userId", "encryptedSecret", "enabledAt", "lastUsedCounter",
         "pendingEncryptedSecret", "pendingExpiresAt", "createdAt", "updatedAt")
       VALUES ${parameterTuples(plan.mfaRows.length, 9)}`,
      plan.mfaRows.flatMap((row) => [
        row.id,
        row.userId,
        row.encryptedSecret,
        row.enabledAt,
        row.lastUsedCounter,
        row.pendingEncryptedSecret,
        row.pendingExpiresAt,
        row.createdAt,
        row.updatedAt,
      ])
    );
  }

  return plan.evidence;
}

const conservationSql = `
  WITH equations(id, source_count, target_count) AS (
    VALUES
      ('invitations',
       (SELECT count(*) FROM cutover_legacy."OrgMemberInvite"),
       (SELECT count(*) FROM public."OrganizationInvitation" target
         JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
          AND map.source_model = 'OrgMemberInvite' AND map.target_model = 'OrganizationInvitation'
          AND map.target_id = target.id)),
      ('impersonation-audits',
       (SELECT count(*) FROM cutover_legacy."ImpersonationAuditLog"),
       (SELECT count(*) FROM public."ImpersonationAudit" target
         JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
          AND map.source_model = 'ImpersonationAuditLog' AND map.target_model = 'ImpersonationAudit'
          AND map.target_id = target.id)),
      ('retired-impersonation-sessions',
       (SELECT count(*) FROM cutover_legacy."ImpersonationAuditLog"),
       (SELECT count(*) FROM public."OperatorSession" session
         JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
          AND map.source_model = 'ImpersonationAuditLog' AND map.target_model = 'ImpersonationAudit'
          AND map.target_id = session.id)),
      ('mfa-totp',
       (SELECT count(*) FROM cutover_legacy."User" WHERE "mfaSecretReferenceId" IS NOT NULL),
       (SELECT count(*) FROM public."OperatorMfaTotp" target
         JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
          AND map.source_model = 'User' AND map.target_model = 'OperatorMfaTotp'
          AND map.stable_suffix = 'operator-mfa-totp' AND map.target_id = target.id)),
      ('mfa-recovery-codes', 0,
       (SELECT count(*) FROM public."OperatorMfaRecoveryCode" recovery
         JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
          AND map.source_model = 'User' AND map.target_model = 'User'
          AND map.target_id = recovery."userId"))
  )
  SELECT id FROM equations WHERE source_count <> target_count ORDER BY id`;

interface TargetMfaProbeRow extends Record<string, unknown> {
  encrypted_secret: string | null;
  enabled_at: Date | null;
  last_used_counter: string | bigint | null;
  pending_encrypted_secret: string | null;
  pending_expires_at: Date | null;
}

/** Conservation, policy, target-format, and replay-barrier postflight. */
export async function validateSupplementalAuthCutover(
  database: CutoverDatabase,
  options: SupplementalAuthCutoverOptions
): Promise<void> {
  const conservation = await database.query<{ id: string }>(conservationSql);
  if (conservation.rows.length > 0) {
    throw new CutoverFailure(
      "AUTH_SUPPLEMENTAL_CONSERVATION_FAILED",
      `supplemental auth conservation failed: ${conservation.rows.map((row) => row.id).join(", ")}`
    );
  }

  const policy = await database.query<{ issue: string }>(`
    WITH issues AS (
      SELECT 'invitation-policy' AS issue
        FROM public."OrganizationInvitation" target
        JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
         AND map.source_model = 'OrgMemberInvite' AND map.target_model = 'OrganizationInvitation'
         AND map.target_id = target.id
        JOIN cutover_legacy."OrgMemberInvite" source ON source.id = map.source_id
        JOIN cutover_legacy.cutover_id_map organization_map ON organization_map.mapping_version = 1
         AND organization_map.source_model = 'Organization'
         AND organization_map.source_id = source."organizationId"
         AND organization_map.target_model = 'Organization'
        JOIN cutover_legacy.cutover_id_map inviter_map ON inviter_map.mapping_version = 1
         AND inviter_map.source_model = 'User' AND inviter_map.source_id = source."inviterId"
         AND inviter_map.target_model = 'User'
       WHERE target."expiresAt" <> target."createdAt" + interval '7 days'
          OR target."acceptedAt" IS NOT NULL OR target."revokedAt" IS NOT NULL
          OR target."tokenHash" !~ '^[0-9a-f]{64}$'
          OR target."organizationId" <> organization_map.target_id
          OR target."inviterId" <> inviter_map.target_id
          OR target.email <> lower(btrim(source.email))
          OR target.role::text <> source.role::text
      UNION ALL
      SELECT 'impersonation-session-policy'
        FROM public."ImpersonationAudit" audit
        JOIN public."OperatorSession" session ON session.id = audit."impersonationSessionId"
        JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
         AND map.source_model = 'ImpersonationAuditLog' AND map.target_model = 'ImpersonationAudit'
         AND map.target_id = audit.id
        JOIN cutover_legacy."ImpersonationAuditLog" source ON source.id = map.source_id
        JOIN cutover_legacy.cutover_id_map actor_map ON actor_map.mapping_version = 1
         AND actor_map.source_model = 'User' AND actor_map.source_id = source."adminId"
         AND actor_map.target_model = 'User'
        JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version = 1
         AND target_map.source_model = 'User' AND target_map.source_id = source."targetId"
         AND target_map.target_model = 'User'
       WHERE session."revokedAt" IS DISTINCT FROM session."createdAt"
          OR session."expiresAt" IS DISTINCT FROM session."createdAt"
          OR session.tier::text <> 'OPERATOR' OR session."parentSessionId" IS NOT NULL
          OR session."userId" <> audit."actorUserId"
          OR session."impersonatedUserId" <> audit."targetUserId"
          OR audit."actorUserId" <> actor_map.target_id
          OR audit."targetUserId" <> target_map.target_id
          OR audit.action::text <> source.action::text
          OR audit."userAgent" IS NOT NULL
      UNION ALL
      SELECT 'disabled-mfa-row'
        FROM cutover_legacy."User" source
        JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
         AND map.source_model = 'User' AND map.source_id = source.id
         AND map.target_model = 'OperatorMfaTotp' AND map.stable_suffix = 'operator-mfa-totp'
        JOIN public."OperatorMfaTotp" target ON target.id = map.target_id
       WHERE source."mfaSecretReferenceId" IS NULL
      UNION ALL
      SELECT 'mfa-state-policy'
        FROM cutover_legacy."User" source
        JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
         AND map.source_model = 'User' AND map.source_id = source.id
         AND map.target_model = 'OperatorMfaTotp' AND map.stable_suffix = 'operator-mfa-totp'
        JOIN public."OperatorMfaTotp" target ON target.id = map.target_id
       WHERE source."mfaSecretReferenceId" IS NOT NULL
         AND ((source."mfaEnabledAt" IS NULL) <> (target."enabledAt" IS NULL)
              OR (source."mfaEnabledAt" IS NOT NULL
                  AND source."mfaEnabledAt" <> target."enabledAt"))
    )
    SELECT DISTINCT issue FROM issues ORDER BY issue`);
  if (policy.rows.length > 0) {
    throw new CutoverFailure(
      "AUTH_SUPPLEMENTAL_POLICY_FAILED",
      `supplemental auth policy validation failed: ${policy.rows
        .map((row) => row.issue)
        .join(", ")}`
    );
  }

  const invitationProbes = await database.query<{
    source_token: string;
    target_token_hash: string;
  }>(`
    SELECT source.token AS source_token, target."tokenHash" AS target_token_hash
      FROM cutover_legacy."OrgMemberInvite" source
      JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'OrgMemberInvite' AND map.source_id = source.id
       AND map.target_model = 'OrganizationInvitation' AND map.stable_suffix = ''
      JOIN public."OrganizationInvitation" target ON target.id = map.target_id
     ORDER BY source.id`);
  if (invitationProbes.rows.some((row) => hashSecret(row.source_token) !== row.target_token_hash)) {
    throw new CutoverFailure(
      "AUTH_SUPPLEMENTAL_POLICY_FAILED",
      "supplemental auth invitation policy validation failed"
    );
  }

  const probes = await database.query<TargetMfaProbeRow>(`
    SELECT target."encryptedSecret" AS encrypted_secret, target."enabledAt" AS enabled_at,
           target."lastUsedCounter"::text AS last_used_counter,
           target."pendingEncryptedSecret" AS pending_encrypted_secret,
           target."pendingExpiresAt" AS pending_expires_at
      FROM public."OperatorMfaTotp" target
      JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'User' AND map.target_model = 'OperatorMfaTotp'
       AND map.stable_suffix = 'operator-mfa-totp' AND map.target_id = target.id
     ORDER BY map.source_id`);
  const barrier = supplementalMfaCutoverCounter(options.cutoverAt);
  for (const row of probes.rows) {
    const encrypted = row.enabled_at === null ? row.pending_encrypted_secret : row.encrypted_secret;
    if (encrypted === null) {
      throw new CutoverFailure(
        "AUTH_SUPPLEMENTAL_MFA_PROBE_FAILED",
        "supplemental auth MFA target probe failed"
      );
    }
    try {
      const canonical = decryptSecret(encrypted, options.targetAuthEncryptionKey);
      decodeBase32TotpSecret(canonical);
    } catch {
      throw new CutoverFailure(
        "AUTH_SUPPLEMENTAL_MFA_PROBE_FAILED",
        "supplemental auth MFA target probe failed"
      );
    }
    const lastUsed =
      row.last_used_counter === null ? null : BigInt(row.last_used_counter as string | bigint);
    if (
      (row.enabled_at !== null &&
        (lastUsed !== barrier ||
          row.pending_encrypted_secret !== null ||
          row.pending_expires_at !== null)) ||
      (row.enabled_at === null &&
        (lastUsed !== null ||
          row.encrypted_secret !== null ||
          row.pending_expires_at?.getTime() !==
            options.cutoverAt.getTime() + SUPPLEMENTAL_PENDING_MFA_TTL_MS))
    ) {
      throw new CutoverFailure(
        "AUTH_SUPPLEMENTAL_MFA_PROBE_FAILED",
        "supplemental auth MFA target probe failed"
      );
    }
  }
}
