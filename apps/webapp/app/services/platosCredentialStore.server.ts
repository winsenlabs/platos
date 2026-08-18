import {
  CredentialRootKeyRing,
  PlatosSecretStore,
  PROVIDER_KEY_SAFE_SELECT,
  PrismaClient,
  authorizeEnvironmentOperator,
  type EnvironmentAuthorizationAccess,
  type OperatorAuthorization,
} from "@platos/tenancy-database";
import { singleton } from "~/utils/singleton";

const DEVELOPMENT_ROOT_KEY = "feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface";

const database = singleton(
  "platos-tenancy-prisma",
  () => new PrismaClient({ datasourceUrl: requiredEnvironmentValue("DATABASE_URL") })
);

const secretStore = singleton(
  "platos-credential-store",
  () =>
    new PlatosSecretStore(
      database,
      new CredentialRootKeyRing({
        activeVersion: credentialRootKeyVersion(),
        keys: credentialRootKeys(),
      })
    )
);

export async function listProviderCredentialMetadata(params: {
  userId: string;
  environmentId: string;
}) {
  const authorization = await environmentAuthorization(
    params.userId,
    params.environmentId,
    "metadata"
  );
  const [providerKeys, credentials] = await Promise.all([
    database.providerKey.findMany({
      where: { environmentId: authorization.environmentId },
      orderBy: [{ provider: "asc" }, { isDefault: "desc" }, { createdAt: "asc" }],
      select: PROVIDER_KEY_SAFE_SELECT,
    }),
    secretStore.listSafe(authorization),
  ]);
  const credentialsById = new Map(credentials.map((credential) => [credential.id, credential]));

  return {
    keys: providerKeys.map((key) => {
      const credential = credentialsById.get(key.credentialId);
      return {
        ...key,
        referenceName: key.environmentKeyName,
        status: credential?.activeSecretVersion && !credential.revokedAt ? "unknown" : "failed",
        createdAt: key.createdAt.toISOString(),
        lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
        updatedAt: key.updatedAt.toISOString(),
      };
    }),
  };
}

export async function createProviderCredential(params: {
  userId: string;
  environmentId: string;
  provider: string;
  referenceName: string;
  plaintext: string;
  label: string;
  isDefault: boolean;
}) {
  const authorization = await environmentAuthorization(
    params.userId,
    params.environmentId,
    "secret:mutate"
  );
  return secretStore.createProviderCredentialAndKey({
    authorization,
    name: params.referenceName,
    provider: params.provider,
    plaintext: params.plaintext,
    label: params.label,
    isDefault: params.isDefault,
  });
}

export async function rotateProviderCredential(params: {
  userId: string;
  environmentId: string;
  provider: string;
  keyId: string;
  credentialId: string;
  plaintext: string;
}) {
  const authorization = await environmentAuthorization(
    params.userId,
    params.environmentId,
    "secret:mutate"
  );
  return secretStore.rotateProviderCredentialAndKey({
    authorization,
    keyId: params.keyId,
    credentialId: params.credentialId,
    provider: params.provider,
    plaintext: params.plaintext,
  });
}

async function environmentAuthorization(
  userId: string,
  environmentId: string,
  access: EnvironmentAuthorizationAccess
) {
  const operator: OperatorAuthorization = {
    sessionId: "platos-webapp-session",
    actorUserId: userId,
    effectiveUserId: userId,
    email: "",
    expiresAt: new Date(Date.now() + 60_000),
    mfaVerifiedAt: null,
    impersonation: null,
  };
  return authorizeEnvironmentOperator(database, operator, environmentId, access);
}

function credentialRootKeyVersion(): number {
  const raw = process.env.PLATOS_CREDENTIAL_ROOT_KEY_VERSION;
  if (!raw && process.env.NODE_ENV !== "production") return 1;
  const version = Number(raw);
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new Error("Credential store configuration is invalid");
  }
  return version;
}

function credentialRootKeys(): Record<number, string> {
  const raw = process.env.PLATOS_CREDENTIAL_ROOT_KEYS;
  if (!raw && process.env.NODE_ENV !== "production") return { 1: DEVELOPMENT_ROOT_KEY };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "");
  } catch {
    throw new Error("Credential store configuration is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Credential store configuration is invalid");
  }

  const keys: Record<number, string> = {};
  for (const [rawVersion, key] of Object.entries(parsed)) {
    const version = Number(rawVersion);
    if (
      !Number.isSafeInteger(version) ||
      version <= 0 ||
      typeof key !== "string" ||
      !/^[a-fA-F0-9]{64}$/.test(key)
    ) {
      throw new Error("Credential store configuration is invalid");
    }
    keys[version] = key;
  }
  if (Object.keys(keys).length === 0) throw new Error("Credential store configuration is invalid");
  return keys;
}

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
