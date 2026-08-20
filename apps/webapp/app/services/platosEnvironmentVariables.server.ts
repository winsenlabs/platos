import {
  authorizeEnvironmentRuntime,
  authorizeEnvironmentService,
  EnvironmentVariableStore,
  SecretMaterial,
  type EnvironmentAuthorization,
  type EnvironmentRuntimeAuthorization,
  type EnvironmentServiceAuthorization,
  type EnvironmentVariableMutationAuthorization,
} from "@platos/tenancy-database";
import { prisma } from "~/db.server";
import { singleton } from "~/utils/singleton";
import { platosControlDatabase } from "./platosControlDatabase.server";
import { platosSecretStore } from "./platosCredentialStore.server";

const store = singleton(
  "platos-environment-variable-store",
  () => new EnvironmentVariableStore(platosControlDatabase, platosSecretStore)
);

export async function listCanonicalEnvironmentVariables(
  authorization: EnvironmentAuthorization
) {
  return store.list(authorization);
}

export async function setCanonicalEnvironmentVariable(params: {
  authorization: EnvironmentVariableMutationAuthorization;
  key: string;
  value: string;
  secret: boolean;
  lastUpdatedBy: string;
}) {
  return store.set({
    authorization: params.authorization,
    key: params.key,
    value: params.value,
    secret: params.secret,
  });
}

export async function updateCanonicalEnvironmentVariableById(params: {
  authorization: EnvironmentVariableMutationAuthorization;
  id: string;
  value: string;
  lastUpdatedBy: string;
}) {
  const existing = await platosControlDatabase.environmentVariable.findFirst({
    where: { id: params.id, environmentId: params.authorization.environmentId },
    select: { key: true, kind: true },
  });
  if (!existing) return false;
  await store.set({
    authorization: params.authorization,
    key: existing.key,
    value: params.value,
    secret: existing.kind === "SECRET",
  });
  return true;
}

export async function deleteCanonicalEnvironmentVariableById(params: {
  authorization: EnvironmentVariableMutationAuthorization;
  id: string;
}) {
  const existing = await platosControlDatabase.environmentVariable.findFirst({
    where: { id: params.id, environmentId: params.authorization.environmentId },
    select: { key: true },
  });
  if (!existing) return false;
  await store.delete({ authorization: params.authorization, key: existing.key });
  return true;
}

type LegacyRuntimeEnvironmentIdentity = {
  id: string;
};

export async function resolveCanonicalEnvironmentId(
  legacyEnvironment: LegacyRuntimeEnvironmentIdentity
): Promise<string> {
  const legacy = await prisma.runtimeEnvironment.findUnique({
    where: { id: legacyEnvironment.id },
    select: {
      id: true,
      slug: true,
      project: {
        select: {
          slug: true,
          organization: { select: { slug: true } },
        },
      },
    },
  });
  if (!legacy) throw new Error("Environment not found");

  const exactId = await platosControlDatabase.environment.findFirst({
    where: {
      id: legacy.id,
      archivedAt: null,
      project: {
        archivedAt: null,
        slug: legacy.project.slug,
        organization: {
          archivedAt: null,
          slug: legacy.project.organization.slug,
        },
      },
    },
    select: { id: true },
  });
  if (exactId) return exactId.id;

  const byAncestry = await platosControlDatabase.environment.findMany({
    where: {
      slug: legacy.slug,
      archivedAt: null,
      project: {
        archivedAt: null,
        slug: legacy.project.slug,
        organization: {
          archivedAt: null,
          slug: legacy.project.organization.slug,
        },
      },
    },
    select: { id: true },
    take: 2,
  });
  if (byAncestry.length !== 1) throw new Error("Canonical Environment mapping not found");
  return byAncestry[0].id;
}

export async function authorizeCanonicalEnvironmentRuntime(params: {
  environment: LegacyRuntimeEnvironmentIdentity;
  actorId: string;
}): Promise<EnvironmentRuntimeAuthorization> {
  return authorizeEnvironmentRuntime(platosControlDatabase, {
    actorId: params.actorId,
    environmentId: await resolveCanonicalEnvironmentId(params.environment),
  });
}

export async function authorizeCanonicalEnvironmentService(params: {
  environment: LegacyRuntimeEnvironmentIdentity;
  actorId: string;
}): Promise<EnvironmentServiceAuthorization> {
  return authorizeEnvironmentService(platosControlDatabase, {
    actorId: params.actorId,
    environmentId: await resolveCanonicalEnvironmentId(params.environment),
  });
}

export async function resolveCanonicalEnvironmentVariablesForRuntime(params: {
  environment: LegacyRuntimeEnvironmentIdentity;
  parentEnvironment?: LegacyRuntimeEnvironmentIdentity;
  actorId: string;
}): Promise<Array<{ key: string; value: string }>> {
  const environments = params.parentEnvironment
    ? [params.parentEnvironment, params.environment]
    : [params.environment];
  const resolved = new Map<string, string>();

  for (const environment of environments) {
    const authorization = await authorizeCanonicalEnvironmentRuntime({
      environment,
      actorId: params.actorId,
    });
    const variables = await store.list(authorization);
    for (const variable of variables) {
      const value = await store.read({ authorization, key: variable.key });
      resolved.set(variable.key, value instanceof SecretMaterial ? value.reveal() : value);
    }
  }

  return Array.from(resolved, ([key, value]) => ({ key, value }));
}

export async function importCanonicalEnvironmentVariables(params: {
  authorization: EnvironmentVariableMutationAuthorization;
  variables: Record<string, string>;
  override: boolean;
  parentAuthorization?: EnvironmentVariableMutationAuthorization;
}): Promise<
  | { success: true }
  | { success: false; error: string; variableErrors: Record<string, string> }
> {
  const [existing, parent] = await Promise.all([
    store.list(params.authorization),
    params.parentAuthorization ? store.list(params.parentAuthorization) : Promise.resolve([]),
  ]);
  const existingByKey = new Map(existing.map((variable) => [variable.key, variable]));
  const parentByKey = new Map(parent.map((variable) => [variable.key, variable]));
  const variableErrors: Record<string, string> = {};

  for (const [key, value] of Object.entries(params.variables)) {
    const current = existingByKey.get(key);
    if (current && !params.override) continue;
    try {
      await store.set({
        authorization: params.authorization,
        key,
        value,
        secret: (current ?? parentByKey.get(key))?.kind === "SECRET",
      });
    } catch (error) {
      variableErrors[key] = error instanceof Error ? error.message : "variable_unavailable";
    }
  }

  return Object.keys(variableErrors).length === 0
    ? { success: true }
    : { success: false, error: "Failed to import environment variables", variableErrors };
}
