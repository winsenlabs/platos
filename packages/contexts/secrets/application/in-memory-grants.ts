// A minted grant of each shape, for one environment.
//
// Minting is the ONLY way to obtain an authorization (see domain/authorization.ts),
// so a smoke test of the composition root, and every colocated test here, has to
// go through the same door a production caller does. That is the point: there is
// no test-only back door, because a back door would be a production back door.

import { asIdentifier } from "@platos/kernel";
import type { EnvironmentId, OrganizationId, ProjectId } from "@platos/kernel";

import {
  authorizeEnvironmentOperator,
  authorizeEnvironmentRuntime,
  authorizeEnvironmentService,
  authorizeRootKeyOperations,
} from "../domain/authorization.js";
import type {
  EnvironmentOperatorAuthorization,
  EnvironmentRuntimeAuthorization,
  EnvironmentServiceAuthorization,
  RootKeyOperationsAuthorization,
} from "../domain/authorization.js";
import { asSecretsIdentifier } from "../domain/ids.js";
import type { ActorId } from "../domain/ids.js";

export interface InMemoryGrants {
  readonly environmentId: EnvironmentId;
  /** Operator holding `secret:mutate`. */
  readonly operator: EnvironmentOperatorAuthorization;
  /** Operator holding `metadata` only — the read-only grant. */
  readonly readOnlyOperator: EnvironmentOperatorAuthorization;
  readonly runtime: EnvironmentRuntimeAuthorization;
  readonly service: EnvironmentServiceAuthorization;
  readonly rootKeyOperator: RootKeyOperationsAuthorization;
}

export function inMemoryGrants(suffix = "1"): InMemoryGrants {
  const ancestry = {
    organizationId: asIdentifier<OrganizationId>(`org-${suffix}`),
    projectId: asIdentifier<ProjectId>(`proj-${suffix}`),
    environmentId: asIdentifier<EnvironmentId>(`env-${suffix}`),
  };
  const user = asSecretsIdentifier<ActorId>(`user-${suffix}`);
  return {
    environmentId: ancestry.environmentId,
    operator: authorizeEnvironmentOperator({
      ancestry,
      access: "secret:mutate",
      actorUserId: user,
      effectiveUserId: user,
    }),
    readOnlyOperator: authorizeEnvironmentOperator({
      ancestry,
      access: "metadata",
      actorUserId: user,
      effectiveUserId: user,
    }),
    runtime: authorizeEnvironmentRuntime({
      ancestry,
      actorId: asSecretsIdentifier<ActorId>(`runtime-${suffix}`),
    }),
    service: authorizeEnvironmentService({
      ancestry,
      actorId: asSecretsIdentifier<ActorId>(`service-${suffix}`),
    }),
    rootKeyOperator: authorizeRootKeyOperations({
      actorId: asSecretsIdentifier<ActorId>(`ops-${suffix}`),
    }),
  };
}
