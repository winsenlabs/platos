import type { EnvironmentOperatorAuthorization } from "@platos/tenancy-database";
import { platosControlDatabase } from "~/services/platosControlDatabase.server";
import { listCanonicalEnvironmentVariables } from "~/services/platosEnvironmentVariables.server";
import type { EnvironmentVariableUpdater } from "~/v3/environmentVariables/repository";

type Result = Awaited<ReturnType<EnvironmentVariablesPresenter["call"]>>;
export type EnvironmentVariableWithSetValues = Result["environmentVariables"][number];

/** Canonical Environment-owned dashboard projection. Secret values remain redacted. */
export class EnvironmentVariablesPresenter {
  public async call(params: {
    authorization: EnvironmentOperatorAuthorization;
  }) {
    const environment = await platosControlDatabase.environment.findUniqueOrThrow({
      where: { id: params.authorization.environmentId },
      select: { id: true, slug: true },
    });
    const variables = await listCanonicalEnvironmentVariables(params.authorization);
    const environmentType = presentEnvironmentType(environment.slug);

    return {
      environmentVariables: variables
        .map((variable) => {
          const lastUpdatedBy = parseUpdater(variable.lastUpdatedBy);
          return {
            id: variable.id,
            key: variable.key,
            environment: { type: environmentType, id: environment.id, branchName: null },
            value: variable.kind === "PLAIN" ? variable.value ?? "" : "",
            isSecret: variable.kind === "SECRET",
            version: variable.version,
            lastUpdatedBy,
            updatedByUser: null,
            updatedAt: variable.updatedAt,
          };
        })
        .sort((a, b) => a.key.localeCompare(b.key)),
      environments: [
        {
          id: environment.id,
          type: environmentType,
          isBranchableEnvironment: false,
          branchName: null,
        },
      ],
      hasStaging: environmentType === "STAGING",
      vercelIntegration: null,
    };
  }
}

function parseUpdater(value: string | null): EnvironmentVariableUpdater | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as EnvironmentVariableUpdater;
    return parsed?.type === "user" || parsed?.type === "integration" ? parsed : null;
  } catch {
    return null;
  }
}

function presentEnvironmentType(slug: string): "DEVELOPMENT" | "STAGING" | "PRODUCTION" | "PREVIEW" {
  const normalized = slug.toUpperCase();
  if (
    normalized === "DEVELOPMENT" ||
    normalized === "STAGING" ||
    normalized === "PRODUCTION" ||
    normalized === "PREVIEW"
  ) return normalized;
  return "DEVELOPMENT";
}
