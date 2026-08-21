import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { CredentialKind, Prisma, type PrismaClient } from "../generated/control";
import type {
  EnvironmentAuthorization,
  EnvironmentOperatorAuthorization,
  EnvironmentRuntimeAuthorization,
  EnvironmentServiceAuthorization,
} from "./auth";

const FORMAT_VERSION = 1;
const DOMAIN = "platos:credential-secret:v1";
const REDACTED = "[REDACTED SecretMaterial]";
export const PURGE_RETIRED_HARD_LIMIT = 100;
export const DEFAULT_REVOKED_SECRET_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const MAX_REVOKED_SECRET_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
type DatabaseClient = PrismaClient | Prisma.TransactionClient;
type CredentialMutationAuthorization =
  | EnvironmentOperatorAuthorization
  | EnvironmentServiceAuthorization;

export const CREDENTIAL_SAFE_SELECT = {
  id: true,
  environmentId: true,
  kind: true,
  name: true,
  provider: true,
  permissions: true,
  expiresAt: true,
  lastUsedAt: true,
  revokedAt: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  activeSecretVersion: {
    select: {
      id: true,
      secretRevision: true,
      formatVersion: true,
      rootKeyVersion: true,
      retiredAt: true,
      readableUntil: true,
      createdAt: true,
    },
  },
} satisfies Prisma.CredentialSelect;

export const PROVIDER_KEY_SAFE_SELECT = {
  id: true,
  environmentId: true,
  credentialId: true,
  provider: true,
  label: true,
  environmentKeyName: true,
  isDefault: true,
  createdBy: true,
  lastUsedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProviderKeySelect;

export type SafeCredential = Prisma.CredentialGetPayload<{
  select: typeof CREDENTIAL_SAFE_SELECT;
}>;

export type SafeProviderKey = Prisma.ProviderKeyGetPayload<{
  select: typeof PROVIDER_KEY_SAFE_SELECT;
}>;

export class PlatosSecretStoreError extends Error {
  constructor(
    public readonly code:
      | "credential_unavailable"
      | "credential_forbidden"
      | "provider_key_unavailable"
      | "invalid_key_ring"
      | "invalid_secret_material"
      | "invalid_purge_request"
      | "invalid_retention_request"
  ) {
    super(code);
    this.name = "PlatosSecretStoreError";
  }
}

export class SecretMaterial {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
    Object.freeze(this);
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

export interface CredentialRootKeyRingInput {
  activeVersion: number;
  keys: Readonly<Record<number, string | Buffer>>;
}

export class CredentialRootKeyRing {
  readonly activeVersion: number;
  readonly #keys: ReadonlyMap<number, Buffer>;

  constructor(input: CredentialRootKeyRingInput) {
    if (!Number.isSafeInteger(input.activeVersion) || input.activeVersion <= 0) {
      throw new PlatosSecretStoreError("invalid_key_ring");
    }
    const keys = new Map<number, Buffer>();
    for (const [rawVersion, rawKey] of Object.entries(input.keys)) {
      const version = Number(rawVersion);
      const key = Buffer.isBuffer(rawKey)
        ? Buffer.from(rawKey)
        : /^[0-9a-fA-F]{64}$/.test(rawKey)
        ? Buffer.from(rawKey, "hex")
        : Buffer.alloc(0);
      if (!Number.isSafeInteger(version) || version <= 0 || key.length !== 32) {
        throw new PlatosSecretStoreError("invalid_key_ring");
      }
      keys.set(version, key);
    }
    if (!keys.has(input.activeVersion)) throw new PlatosSecretStoreError("invalid_key_ring");
    this.activeVersion = input.activeVersion;
    this.#keys = keys;
  }

  key(version: number): Buffer {
    const key = this.#keys.get(version);
    if (!key) throw new PlatosSecretStoreError("credential_unavailable");
    return key;
  }
}

const credentialRootOperationsBrand: unique symbol = Symbol("CredentialRootOperationsAuthorization");

export interface CredentialRootOperationsAuthorization {
  readonly [credentialRootOperationsBrand]: true;
  readonly principalType: "operations";
  readonly deploymentScope: "global";
  readonly actorId: string;
}

/** Creates a deployment-global capability after operational authentication. */
export function authorizeCredentialRootOperations(principal: {
  actorId: string;
  deploymentRole: "credential-root-operator";
}): CredentialRootOperationsAuthorization {
  if (!principal.actorId || principal.deploymentRole !== "credential-root-operator") {
    throw new PlatosSecretStoreError("credential_forbidden");
  }
  return Object.freeze({
    [credentialRootOperationsBrand]: true as const,
    principalType: "operations" as const,
    deploymentScope: "global" as const,
    actorId: principal.actorId,
  });
}

export interface CredentialRootStatus {
  activeRootKeyVersion: number;
  unpurgedVersionsByRoot: Readonly<Record<number, number>>;
}

export interface PurgeRetiredResult {
  purgedCount: number;
}

interface RetiredSecretVersionCandidate {
  id: string;
  credentialId: string;
  environmentId: string;
  secretRevision: number;
  rootKeyVersion: number;
}

interface EnvelopeContext {
  credentialId: string;
  environmentId: string;
  secretRevision: number;
  formatVersion: number;
  rootKeyVersion: number;
}

interface EncryptedEnvelope {
  salt: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  authTag: Uint8Array;
}

export function encryptCredentialSecret(
  rootKey: Buffer,
  context: EnvelopeContext,
  plaintext: string
): EncryptedEnvelope {
  if (!plaintext) throw new PlatosSecretStoreError("invalid_secret_material");
  const salt = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(rootKey, salt, context), nonce);
  cipher.setAAD(aad(context));
  return {
    salt,
    nonce,
    ciphertext: Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]),
    authTag: cipher.getAuthTag(),
  };
}

export function decryptCredentialSecret(
  rootKey: Buffer,
  context: EnvelopeContext,
  envelope: EncryptedEnvelope
): SecretMaterial {
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveKey(rootKey, envelope.salt, context),
      envelope.nonce
    );
    decipher.setAAD(aad(context));
    decipher.setAuthTag(envelope.authTag);
    return new SecretMaterial(
      Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString("utf8")
    );
  } catch {
    throw new PlatosSecretStoreError("credential_unavailable");
  }
}

export class PlatosSecretStore {
  constructor(
    private readonly database: PrismaClient,
    private readonly keyRing: CredentialRootKeyRing
  ) {}

  async create(params: {
    authorization: CredentialMutationAuthorization;
    name: string;
    provider?: string;
    plaintext: string;
    kind?: CredentialKind;
  }): Promise<SafeCredential> {
    requireMutation(params.authorization);
    return this.database.$transaction((tx) => this.createInTransaction(tx, params));
  }

  async readForRuntime(params: {
    authorization: EnvironmentRuntimeAuthorization;
    credentialId?: string;
    name?: string;
    provider?: string;
    kind?: CredentialKind;
  }): Promise<SecretMaterial> {
    return this.database.$transaction(async (tx) => {
      const credential = await findActiveCredential(tx, params.authorization.environmentId, params);
      if (!credential?.activeSecretVersion) throw unavailable();
      const version = credential.activeSecretVersion;
      const context = contextFor(
        credential.id,
        credential.environmentId,
        version.secretRevision,
        version.rootKeyVersion,
        version.formatVersion
      );
      const material = decryptCredentialSecret(
        this.keyRing.key(version.rootKeyVersion),
        context,
        version
      );
      await audit(
        tx,
        params.authorization,
        credential.id,
        "READ",
        version.secretRevision,
        version.rootKeyVersion,
        version.rootKeyVersion
      );
      return material;
    });
  }

  async rotateCredential(params: {
    authorization: CredentialMutationAuthorization;
    credentialId: string;
    plaintext: string;
    readableUntil?: Date;
  }): Promise<SafeCredential> {
    requireMutation(params.authorization);
    return this.database.$transaction((tx) => this.rotateInTransaction(tx, params));
  }

  /**
   * Creates or rotates a provider Credential and links its ProviderKey in the
   * same transaction. A failed link/default update rolls back every envelope
   * and audit mutation.
   */
  async createProviderCredentialAndKey(params: {
    authorization: EnvironmentOperatorAuthorization;
    provider: string;
    name: string;
    plaintext: string;
    label: string;
    isDefault: boolean;
  }): Promise<{ credential: SafeCredential; key: SafeProviderKey }> {
    requireMutation(params.authorization);
    return this.database.$transaction(async (tx) => {
      const existing = await tx.credential.findFirst({
        where: {
          environmentId: params.authorization.environmentId,
          kind: CredentialKind.SERVICE_CREDENTIAL,
          name: params.name,
        },
        select: CREDENTIAL_SAFE_SELECT,
      });
      if (
        existing &&
        (existing.provider !== params.provider ||
          existing.revokedAt ||
          !existing.activeSecretVersion)
      ) {
        throw unavailable();
      }

      const credential = existing
        ? await this.rotateInTransaction(tx, {
            authorization: params.authorization,
            credentialId: existing.id,
            plaintext: params.plaintext,
          })
        : await this.createInTransaction(tx, {
            authorization: params.authorization,
            name: params.name,
            provider: params.provider,
            plaintext: params.plaintext,
          });
      const key = await linkProviderKeyInTransaction(tx, {
        authorization: params.authorization,
        credential,
        provider: params.provider,
        label: params.label,
        isDefault: params.isDefault,
      });
      return { credential, key };
    });
  }

  /** Rotates only the Credential currently linked by the named ProviderKey. */
  async rotateProviderCredentialAndKey(params: {
    authorization: EnvironmentOperatorAuthorization;
    keyId: string;
    plaintext: string;
  }): Promise<{ credential: SafeCredential; key: SafeProviderKey }> {
    requireMutation(params.authorization);
    return this.database.$transaction(async (tx) => {
      const key = await tx.providerKey.findFirst({
        where: {
          id: params.keyId,
          environmentId: params.authorization.environmentId,
        },
        select: PROVIDER_KEY_SAFE_SELECT,
      });
      if (!key) throw new PlatosSecretStoreError("provider_key_unavailable");

      const credential = await tx.credential.findFirst({
        where: {
          id: key.credentialId,
          environmentId: params.authorization.environmentId,
          name: key.environmentKeyName,
          provider: key.provider,
          revokedAt: null,
          activeSecretVersionId: { not: null },
        },
        select: CREDENTIAL_SAFE_SELECT,
      });
      if (!credential) throw unavailable();

      const rotated = await this.rotateInTransaction(tx, {
        authorization: params.authorization,
        credentialId: credential.id,
        plaintext: params.plaintext,
      });
      const linked = await tx.providerKey.update({
        where: { id: key.id },
        data: {
          credentialId: rotated.id,
          environmentKeyName: rotated.name,
        },
        select: PROVIDER_KEY_SAFE_SELECT,
      });
      return { credential: rotated, key: linked };
    });
  }

  /** Links an existing same-Environment/provider Credential transactionally. */
  async linkProviderKey(params: {
    authorization: EnvironmentOperatorAuthorization;
    provider: string;
    label: string;
    envVarName: string;
    isDefault: boolean;
  }): Promise<SafeProviderKey> {
    requireMutation(params.authorization);
    return this.database.$transaction(async (tx) => {
      const credential = await findProviderCredential(
        tx,
        params.authorization.environmentId,
        params.envVarName,
        params.provider
      );
      if (!credential) throw unavailable();
      return linkProviderKeyInTransaction(tx, {
        authorization: params.authorization,
        credential,
        provider: params.provider,
        label: params.label,
        isDefault: params.isDefault,
      });
    });
  }

  /** Relinks a ProviderKey to an existing same-Environment/provider Credential. */
  async relinkProviderKey(params: {
    authorization: EnvironmentOperatorAuthorization;
    keyId: string;
    envVarName: string;
    label?: string;
  }): Promise<{ key: SafeProviderKey; previousEnvVarName: string }> {
    requireMutation(params.authorization);
    return this.database.$transaction(async (tx) => {
      const existing = await tx.providerKey.findFirst({
        where: {
          id: params.keyId,
          environmentId: params.authorization.environmentId,
        },
        select: PROVIDER_KEY_SAFE_SELECT,
      });
      if (!existing) throw new PlatosSecretStoreError("provider_key_unavailable");
      const credential = await findProviderCredential(
        tx,
        params.authorization.environmentId,
        params.envVarName,
        existing.provider
      );
      if (!credential) throw unavailable();
      const key = await tx.providerKey.update({
        where: { id: existing.id },
        data: {
          credentialId: credential.id,
          environmentKeyName: credential.name,
          ...(params.label ? { label: params.label } : {}),
        },
        select: PROVIDER_KEY_SAFE_SELECT,
      });
      return { key, previousEnvVarName: existing.environmentKeyName };
    });
  }

  async rewrapActive(params: {
    authorization: EnvironmentOperatorAuthorization;
    credentialId: string;
  }): Promise<SafeCredential> {
    requireMutation(params.authorization);
    return this.database.$transaction(async (tx) => {
      const credential = await findLockedActiveCredential(
        tx,
        params.authorization.environmentId,
        params.credentialId
      );
      if (!credential?.activeSecretVersion) throw unavailable();
      const previous = credential.activeSecretVersion;
      if (previous.rootKeyVersion === this.keyRing.activeVersion) {
        return tx.credential.findUniqueOrThrow({
          where: { id: credential.id },
          select: CREDENTIAL_SAFE_SELECT,
        });
      }
      const previousContext = contextFor(
        credential.id,
        credential.environmentId,
        previous.secretRevision,
        previous.rootKeyVersion,
        previous.formatVersion
      );
      const material = decryptCredentialSecret(
        this.keyRing.key(previous.rootKeyVersion),
        previousContext,
        previous
      );
      const nextContext = contextFor(
        credential.id,
        credential.environmentId,
        previous.secretRevision,
        this.keyRing.activeVersion
      );
      const envelope = encryptCredentialSecret(
        this.keyRing.key(nextContext.rootKeyVersion),
        nextContext,
        material.reveal()
      );
      const next = await tx.credentialSecretVersion.create({
        data: {
          credentialId: credential.id,
          secretRevision: nextContext.secretRevision,
          formatVersion: nextContext.formatVersion,
          rootKeyVersion: nextContext.rootKeyVersion,
          ...envelope,
        },
      });
      await tx.credentialSecretVersion.update({
        where: { id: previous.id },
        data: { retiredAt: new Date() },
      });
      const updated = await tx.credential.update({
        where: { id: credential.id },
        data: { activeSecretVersionId: next.id },
        select: CREDENTIAL_SAFE_SELECT,
      });
      await audit(
        tx,
        params.authorization,
        credential.id,
        "REWRAP",
        previous.secretRevision,
        previous.rootKeyVersion,
        nextContext.rootKeyVersion
      );
      return updated;
    });
  }

  async status(authorization: CredentialRootOperationsAuthorization): Promise<CredentialRootStatus> {
    requireRootOperations(authorization);
    const grouped = await this.database.credentialSecretVersion.groupBy({
      by: ["rootKeyVersion"],
      _count: { _all: true },
    });
    return {
      activeRootKeyVersion: this.keyRing.activeVersion,
      unpurgedVersionsByRoot: Object.freeze(
        Object.fromEntries(grouped.map((entry) => [entry.rootKeyVersion, entry._count._all]))
      ),
    };
  }

  async canRemoveRoot(
    authorization: CredentialRootOperationsAuthorization,
    rootKeyVersion: number
  ): Promise<boolean> {
    if (!Number.isSafeInteger(rootKeyVersion) || rootKeyVersion <= 0) return false;
    const status = await this.status(authorization);
    return (
      rootKeyVersion !== status.activeRootKeyVersion &&
      !status.unpurgedVersionsByRoot[rootKeyVersion]
    );
  }

  async purgeRetired(params: {
    authorization: CredentialRootOperationsAuthorization;
    cutoff: Date;
    limit?: number;
  }): Promise<PurgeRetiredResult> {
    requireRootOperations(params.authorization);
    const now = new Date();
    if (
      !(params.cutoff instanceof Date) ||
      !Number.isFinite(params.cutoff.getTime()) ||
      params.cutoff.getTime() > now.getTime() ||
      (params.limit !== undefined &&
        (!Number.isSafeInteger(params.limit) || params.limit <= 0))
    ) {
      throw new PlatosSecretStoreError("invalid_purge_request");
    }
    const limit = Math.min(params.limit ?? PURGE_RETIRED_HARD_LIMIT, PURGE_RETIRED_HARD_LIMIT);

    return this.database.$transaction(async (tx) => {
      const candidates = await tx.$queryRaw<RetiredSecretVersionCandidate[]>(Prisma.sql`
        SELECT
          version."id",
          version."credentialId",
          credential."environmentId",
          version."secretRevision",
          version."rootKeyVersion"
        FROM "public"."CredentialSecretVersion" AS version
        INNER JOIN "public"."Credential" AS credential
          ON credential."id" = version."credentialId"
        WHERE version."retiredAt" IS NOT NULL
          AND version."retiredAt" <= ${params.cutoff}
          AND (version."readableUntil" IS NULL OR version."readableUntil" <= ${params.cutoff})
          AND credential."activeSecretVersionId" IS DISTINCT FROM version."id"
        ORDER BY version."createdAt" ASC, version."id" ASC
        LIMIT ${limit}
        FOR UPDATE OF version
      `);

      for (const candidate of candidates) {
        const deleted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          DELETE FROM "public"."CredentialSecretVersion" AS version
          USING "public"."Credential" AS credential
          WHERE version."id" = ${candidate.id}::uuid
            AND version."credentialId" = ${candidate.credentialId}::uuid
            AND credential."id" = version."credentialId"
            AND version."retiredAt" IS NOT NULL
            AND version."retiredAt" <= ${params.cutoff}
            AND (version."readableUntil" IS NULL OR version."readableUntil" <= ${params.cutoff})
            AND credential."activeSecretVersionId" IS DISTINCT FROM version."id"
          RETURNING version."id"
        `);
        if (deleted.length !== 1) {
          throw new PlatosSecretStoreError("credential_unavailable");
        }
        await tx.credentialAudit.create({
          data: {
            environmentId: candidate.environmentId,
            credentialId: candidate.credentialId,
            action: "PURGE",
            outcome: "SUCCESS",
            actorType: params.authorization.principalType,
            actorId: params.authorization.actorId,
            secretRevision: candidate.secretRevision,
            fromRootKeyVersion: candidate.rootKeyVersion,
          },
        });
      }

      return { purgedCount: candidates.length };
    });
  }

  async listSafe(authorization: EnvironmentAuthorization): Promise<SafeCredential[]> {
    return this.database.credential.findMany({
      where: { environmentId: authorization.environmentId },
      select: CREDENTIAL_SAFE_SELECT,
      orderBy: { name: "asc" },
    });
  }

  async revoke(params: {
    authorization: CredentialMutationAuthorization;
    credentialId: string;
    retentionMs?: number;
  }): Promise<SafeCredential> {
    return this.database.$transaction((tx) => this.revokeInTransaction(tx, params));
  }

  /** Compose Credential revocation into a caller-owned control-plane transaction. */
  async revokeInTransaction(
    tx: Prisma.TransactionClient,
    params: {
      authorization: CredentialMutationAuthorization;
      credentialId: string;
      retentionMs?: number;
    },
  ): Promise<SafeCredential> {
    requireMutation(params.authorization);
    const retentionMs = params.retentionMs ?? DEFAULT_REVOKED_SECRET_RETENTION_MS;
    if (
      !Number.isSafeInteger(retentionMs) ||
      retentionMs <= 0 ||
      retentionMs > MAX_REVOKED_SECRET_RETENTION_MS
    ) {
      throw new PlatosSecretStoreError("invalid_retention_request");
    }
    const current = await findLockedActiveCredential(
      tx,
      params.authorization.environmentId,
      params.credentialId
    );
    if (!current?.activeSecretVersion) throw unavailable();
    const retiredAt = new Date();
    const readableUntil = new Date(retiredAt.getTime() + retentionMs);
    await tx.credentialSecretVersion.update({
      where: { id: current.activeSecretVersion.id },
      data: { retiredAt, readableUntil },
    });
    const revoked = await tx.credential.update({
      where: { id: current.id },
      data: { revokedAt: retiredAt, activeSecretVersionId: null },
      select: CREDENTIAL_SAFE_SELECT,
    });
    await audit(
      tx,
      params.authorization,
      current.id,
      "REVOKE",
      current.activeSecretVersion.secretRevision,
      current.activeSecretVersion.rootKeyVersion
    );
    return revoked;
  }

  /** Compose a credential create into a caller-owned control-plane transaction. */
  async createInTransaction(
    tx: Prisma.TransactionClient,
    params: {
      authorization: CredentialMutationAuthorization;
      name: string;
      provider?: string;
      plaintext: string;
      kind?: CredentialKind;
    }
  ): Promise<SafeCredential> {
    requireMutation(params.authorization);
    const credential = await tx.credential.create({
      data: {
        environmentId: params.authorization.environmentId,
        kind: params.kind ?? CredentialKind.SERVICE_CREDENTIAL,
        name: params.name,
        provider: params.provider,
        createdBy:
          params.authorization.principalType === "operator"
            ? params.authorization.effectiveUserId
            : params.authorization.actorId,
      },
    });
    const context = contextFor(
      credential.id,
      credential.environmentId,
      1,
      this.keyRing.activeVersion
    );
    const envelope = encryptCredentialSecret(
      this.keyRing.key(context.rootKeyVersion),
      context,
      params.plaintext
    );
    const version = await tx.credentialSecretVersion.create({
      data: {
        credentialId: credential.id,
        secretRevision: context.secretRevision,
        formatVersion: context.formatVersion,
        rootKeyVersion: context.rootKeyVersion,
        ...envelope,
      },
    });
    const updated = await tx.credential.update({
      where: { id: credential.id },
      data: { activeSecretVersionId: version.id },
      select: CREDENTIAL_SAFE_SELECT,
    });
    await audit(
      tx,
      params.authorization,
      credential.id,
      "CREATE",
      1,
      undefined,
      context.rootKeyVersion
    );
    return updated;
  }

  /** Compose a credential rotation into a caller-owned control-plane transaction. */
  async rotateInTransaction(
    tx: Prisma.TransactionClient,
    params: {
      authorization: CredentialMutationAuthorization;
      credentialId: string;
      plaintext: string;
      readableUntil?: Date;
    }
  ): Promise<SafeCredential> {
    requireMutation(params.authorization);
    const credential = await findLockedActiveCredential(
      tx,
      params.authorization.environmentId,
      params.credentialId
    );
    if (!credential?.activeSecretVersion) throw unavailable();
    const revision = credential.activeSecretVersion.secretRevision + 1;
    const context = contextFor(
      credential.id,
      credential.environmentId,
      revision,
      this.keyRing.activeVersion
    );
    const envelope = encryptCredentialSecret(
      this.keyRing.key(context.rootKeyVersion),
      context,
      params.plaintext
    );
    const next = await tx.credentialSecretVersion.create({
      data: {
        credentialId: credential.id,
        secretRevision: context.secretRevision,
        formatVersion: context.formatVersion,
        rootKeyVersion: context.rootKeyVersion,
        ...envelope,
      },
    });
    await tx.credentialSecretVersion.update({
      where: { id: credential.activeSecretVersion.id },
      data: { retiredAt: new Date(), readableUntil: params.readableUntil },
    });
    const updated = await tx.credential.update({
      where: { id: credential.id },
      data: { activeSecretVersionId: next.id },
      select: CREDENTIAL_SAFE_SELECT,
    });
    await audit(
      tx,
      params.authorization,
      credential.id,
      "ROTATE",
      revision,
      credential.activeSecretVersion.rootKeyVersion,
      context.rootKeyVersion
    );
    return updated;
  }
}

function deriveKey(rootKey: Buffer, salt: Uint8Array, context: EnvelopeContext): Buffer {
  return Buffer.from(
    hkdfSync("sha256", rootKey, salt, Buffer.from(`${DOMAIN}:key:${serialize(context)}`), 32)
  );
}

function aad(context: EnvelopeContext): Buffer {
  return Buffer.from(`${DOMAIN}:aad:${serialize(context)}`);
}

function serialize(context: EnvelopeContext): string {
  return [
    context.environmentId,
    context.credentialId,
    context.secretRevision,
    context.formatVersion,
    context.rootKeyVersion,
  ].join("\u0000");
}

function contextFor(
  credentialId: string,
  environmentId: string,
  secretRevision: number,
  rootKeyVersion: number,
  formatVersion = FORMAT_VERSION
): EnvelopeContext {
  return { credentialId, environmentId, secretRevision, formatVersion, rootKeyVersion };
}

function requireMutation(authorization: CredentialMutationAuthorization): void {
  if (
    !(
      (authorization.principalType === "operator" && authorization.access === "secret:mutate") ||
      (authorization.principalType === "service" && authorization.access === "secret:write")
    )
  ) {
    throw new PlatosSecretStoreError("credential_forbidden");
  }
}

function requireRootOperations(authorization: CredentialRootOperationsAuthorization): void {
  if (
    authorization?.[credentialRootOperationsBrand] !== true ||
    authorization.principalType !== "operations" ||
    authorization.deploymentScope !== "global"
  ) {
    throw new PlatosSecretStoreError("credential_forbidden");
  }
}

function unavailable(): PlatosSecretStoreError {
  return new PlatosSecretStoreError("credential_unavailable");
}

async function findActiveCredential(
  tx: DatabaseClient,
  environmentId: string,
  params: { credentialId?: string; name?: string; provider?: string; kind?: CredentialKind }
) {
  return tx.credential.findFirst({
    where: {
      environmentId,
      revokedAt: null,
      ...(params.credentialId ? { id: params.credentialId } : {}),
      ...(params.name ? { name: params.name } : {}),
      ...(params.provider ? { provider: params.provider } : {}),
      ...(params.kind ? { kind: params.kind } : {}),
    },
    include: { activeSecretVersion: true },
  });
}

async function findLockedActiveCredential(
  tx: Prisma.TransactionClient,
  environmentId: string,
  credentialId: string
) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "public"."Credential"
    WHERE "id" = ${credentialId}::uuid
      AND "environmentId" = ${environmentId}::uuid
      AND "revokedAt" IS NULL
    FOR UPDATE
  `);
  if (locked.length !== 1) return null;
  return tx.credential.findUnique({
    where: { id: credentialId },
    include: { activeSecretVersion: true },
  });
}

async function findProviderCredential(
  tx: DatabaseClient,
  environmentId: string,
  name: string,
  provider: string
): Promise<SafeCredential | null> {
  return tx.credential.findFirst({
    where: {
      environmentId,
      name,
      provider,
      revokedAt: null,
      activeSecretVersionId: { not: null },
    },
    select: CREDENTIAL_SAFE_SELECT,
  });
}

async function linkProviderKeyInTransaction(
  tx: Prisma.TransactionClient,
  params: {
    authorization: EnvironmentOperatorAuthorization;
    credential: SafeCredential;
    provider: string;
    label: string;
    isDefault: boolean;
  }
): Promise<SafeProviderKey> {
  if (
    params.credential.environmentId !== params.authorization.environmentId ||
    params.credential.provider !== params.provider ||
    params.credential.revokedAt ||
    !params.credential.activeSecretVersion
  ) {
    throw unavailable();
  }
  if (params.isDefault) {
    await tx.$queryRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`${params.authorization.environmentId}:${params.provider}`}, 0)
      )::text AS locked
    `);
    await tx.providerKey.updateMany({
      where: {
        environmentId: params.authorization.environmentId,
        provider: params.provider,
        isDefault: true,
      },
      data: { isDefault: false },
    });
  }
  return tx.providerKey.create({
    data: {
      environmentId: params.authorization.environmentId,
      credentialId: params.credential.id,
      provider: params.provider,
      label: params.label,
      environmentKeyName: params.credential.name,
      isDefault: params.isDefault,
      createdBy: params.authorization.effectiveUserId,
    },
    select: PROVIDER_KEY_SAFE_SELECT,
  });
}

async function audit(
  tx: DatabaseClient,
  authorization: EnvironmentAuthorization,
  credentialId: string,
  action: string,
  secretRevision?: number,
  fromRootKeyVersion?: number,
  toRootKeyVersion?: number
): Promise<void> {
  await tx.credentialAudit.create({
    data: {
      environmentId: authorization.environmentId,
      credentialId,
      action,
      outcome: "SUCCESS",
      actorType: authorization.principalType,
      actorId:
        authorization.principalType === "runtime" || authorization.principalType === "service"
          ? authorization.actorId
          : authorization.actorUserId,
      effectiveUserId:
        authorization.principalType === "operator" ? authorization.effectiveUserId : undefined,
      secretRevision,
      fromRootKeyVersion,
      toRootKeyVersion,
    },
  });
}
