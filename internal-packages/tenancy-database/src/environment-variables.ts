import {
  CredentialKind,
  EnvironmentVariableKind,
  type Prisma,
  type PrismaClient,
} from "../generated/control";
import type {
  EnvironmentAuthorization,
  EnvironmentOperatorAuthorization,
  EnvironmentRuntimeAuthorization,
  EnvironmentServiceAuthorization,
} from "./auth";
import { PlatosSecretStore, SecretMaterial } from "./secrets";

const ENVIRONMENT_VARIABLE_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
export const ENVIRONMENT_VARIABLE_VALUE_MAX_LENGTH = 8192;

export const ENVIRONMENT_VARIABLE_SAFE_SELECT = {
  id: true,
  environmentId: true,
  key: true,
  kind: true,
  version: true,
  lastUpdatedBy: true,
  createdAt: true,
  updatedAt: true,
  credentialId: true,
} satisfies Prisma.EnvironmentVariableSelect;

export type SafeEnvironmentVariable = Prisma.EnvironmentVariableGetPayload<{
  select: typeof ENVIRONMENT_VARIABLE_SAFE_SELECT;
}> & {
  value?: string;
  hasSecret: boolean;
};

export type EnvironmentVariableMutationAuthorization =
  | EnvironmentOperatorAuthorization
  | EnvironmentServiceAuthorization;

export class EnvironmentVariableStoreError extends Error {
  constructor(
    public readonly code:
      | "variable_unavailable"
      | "variable_forbidden"
      | "name_invalid"
      | "value_required"
      | "value_too_long",
  ) {
    super(code);
    this.name = "EnvironmentVariableStoreError";
  }
}

/** Environment-owned variable storage. Secret values only exist in Credential. */
export class EnvironmentVariableStore {
  constructor(
    private readonly database: PrismaClient,
    private readonly secrets: PlatosSecretStore,
  ) {}

  async list(authorization: EnvironmentAuthorization): Promise<SafeEnvironmentVariable[]> {
    const variables = await this.database.environmentVariable.findMany({
      where: { environmentId: authorization.environmentId },
      orderBy: { key: "asc" },
      select: {
        ...ENVIRONMENT_VARIABLE_SAFE_SELECT,
        value: true,
      },
    });
    return variables.map((variable) => ({
      ...withoutSecretValue(variable),
      ...(variable.kind === EnvironmentVariableKind.PLAIN ? { value: variable.value ?? "" } : {}),
      hasSecret: variable.kind === EnvironmentVariableKind.SECRET && !!variable.credentialId,
    }));
  }

  async read(params: {
    authorization: EnvironmentRuntimeAuthorization;
    key: string;
  }): Promise<string | SecretMaterial> {
    const variable = await this.database.environmentVariable.findFirst({
      where: { environmentId: params.authorization.environmentId, key: params.key },
      select: { kind: true, value: true, credentialId: true },
    });
    if (!variable) throw new EnvironmentVariableStoreError("variable_unavailable");
    if (variable.kind === EnvironmentVariableKind.PLAIN && variable.value !== null) {
      return variable.value;
    }
    if (variable.kind !== EnvironmentVariableKind.SECRET || !variable.credentialId) {
      throw new EnvironmentVariableStoreError("variable_unavailable");
    }
    return this.secrets.readForRuntime({
      authorization: params.authorization,
      credentialId: variable.credentialId,
      kind: CredentialKind.SECRET_REFERENCE,
    });
  }

  async set(params: {
    authorization: EnvironmentVariableMutationAuthorization;
    key: string;
    value: string;
    secret: boolean;
  }): Promise<SafeEnvironmentVariable> {
    requireMutation(params.authorization);
    const key = normalizeInput(params.key, params.value);
    return this.database.$transaction(async (tx) => {
      const existing = await tx.environmentVariable.findUnique({
        where: {
          environmentId_key: {
            environmentId: params.authorization.environmentId,
            key,
          },
        },
        select: {
          id: true,
          kind: true,
          credentialId: true,
          version: true,
        },
      });

      let credentialId: string | null = null;
      if (params.secret) {
        const reusableCredentialId = existing?.credentialId ?? (
          await tx.credential.findFirst({
            where: {
              environmentId: params.authorization.environmentId,
              kind: CredentialKind.SECRET_REFERENCE,
              name: key,
              revokedAt: null,
              activeSecretVersionId: { not: null },
            },
            select: { id: true },
          })
        )?.id;
        if (reusableCredentialId) {
          const credential = await this.secrets.rotateInTransaction(tx, {
            authorization: params.authorization,
            credentialId: reusableCredentialId,
            plaintext: params.value,
          });
          credentialId = credential.id;
        } else {
          const credential = await this.secrets.createInTransaction(tx, {
            authorization: params.authorization,
            name: key,
            plaintext: params.value,
            kind: CredentialKind.SECRET_REFERENCE,
          });
          credentialId = credential.id;
        }
      }

      const row = existing
        ? await tx.environmentVariable.update({
            where: { id: existing.id },
            data: {
              kind: params.secret ? EnvironmentVariableKind.SECRET : EnvironmentVariableKind.PLAIN,
              value: params.secret ? null : params.value,
              credentialId,
              version: { increment: 1 },
              lastUpdatedBy:
                params.authorization.principalType === "operator"
                  ? params.authorization.effectiveUserId
                  : params.authorization.actorId,
            },
            select: {
              ...ENVIRONMENT_VARIABLE_SAFE_SELECT,
              value: true,
            },
          })
        : await tx.environmentVariable.create({
            data: {
              environmentId: params.authorization.environmentId,
              key,
              kind: params.secret ? EnvironmentVariableKind.SECRET : EnvironmentVariableKind.PLAIN,
              value: params.secret ? null : params.value,
              credentialId,
              lastUpdatedBy:
                params.authorization.principalType === "operator"
                  ? params.authorization.effectiveUserId
                  : params.authorization.actorId,
            },
            select: {
              ...ENVIRONMENT_VARIABLE_SAFE_SELECT,
              value: true,
            },
          });
      if (!params.secret && existing?.credentialId) {
        await this.revokeIfUnreferenced(tx, params.authorization, existing.credentialId);
      }
      return {
        ...withoutSecretValue(row),
        ...(row.kind === EnvironmentVariableKind.PLAIN ? { value: row.value ?? "" } : {}),
        hasSecret: row.kind === EnvironmentVariableKind.SECRET && !!row.credentialId,
      };
    });
  }

  async delete(params: {
    authorization: EnvironmentVariableMutationAuthorization;
    key: string;
  }): Promise<{ deleted: boolean; key: string }> {
    requireMutation(params.authorization);
    const key = normalizeKey(params.key);
    return this.database.$transaction(async (tx) => {
      const existing = await tx.environmentVariable.findUnique({
        where: {
          environmentId_key: {
            environmentId: params.authorization.environmentId,
            key,
          },
        },
        select: { id: true, credentialId: true },
      });
      if (!existing) return { deleted: false, key };
      await tx.environmentVariable.delete({ where: { id: existing.id } });
      if (existing.credentialId) {
        await this.revokeIfUnreferenced(tx, params.authorization, existing.credentialId);
      }
      return { deleted: true, key };
    });
  }

  private async revokeIfUnreferenced(
    tx: Prisma.TransactionClient,
    authorization: EnvironmentVariableMutationAuthorization,
    credentialId: string,
  ): Promise<void> {
    const references = await tx.environmentVariable.count({ where: { credentialId } });
    if (references === 0) {
      await this.secrets.revokeInTransaction(tx, { authorization, credentialId });
    }
  }
}

function normalizeInput(keyInput: string, value: string): string {
  const key = normalizeKey(keyInput);
  if (typeof value !== "string" || value.length === 0) {
    throw new EnvironmentVariableStoreError("value_required");
  }
  if (value.length > ENVIRONMENT_VARIABLE_VALUE_MAX_LENGTH) {
    throw new EnvironmentVariableStoreError("value_too_long");
  }
  return key;
}

function normalizeKey(input: string): string {
  const key = typeof input === "string" ? input.trim() : "";
  if (!ENVIRONMENT_VARIABLE_KEY.test(key)) {
    throw new EnvironmentVariableStoreError("name_invalid");
  }
  return key;
}

function requireMutation(
  authorization: EnvironmentVariableMutationAuthorization,
): void {
  if (
    !(
      (authorization.principalType === "operator" && authorization.access === "secret:mutate") ||
      (authorization.principalType === "service" && authorization.access === "secret:write")
    )
  ) {
    throw new EnvironmentVariableStoreError("variable_forbidden");
  }
}

function withoutSecretValue<T extends { value: string | null }>(
  variable: T,
): Omit<T, "value"> {
  const { value: _value, ...safe } = variable;
  return safe;
}
