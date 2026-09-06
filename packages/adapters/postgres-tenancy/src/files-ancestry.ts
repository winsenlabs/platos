// One question both halves of this store have to ask the database, asked in one
// place: does the environment this caller named really sit under the project and
// organization the caller claims?
//
// WHY IT CANNOT BE ANSWERED FROM THE VALUE. `MessageAttachment` and `Artifact`
// store `environmentId` and nothing above it, while `AttachmentScope` and
// `ThreadScope` both carry a full `EnvironmentScope` — three ids. The database's
// own rules check the STORED chain and say nothing about the claim: for an
// attachment `MessageAttachment_ancestry` demands that the end user belong to the
// environment's organization and the agent to its project, and for an artifact
// `Artifact_ancestry` demands only that the thread be in the row's environment.
// Neither has any opinion about which project the CALLER thinks the environment
// belongs to.
//
// WHAT GOES WRONG WITHOUT IT, EXACTLY. `threadPath()` — the kernel
// `resolvePath()` of the scope plus the thread — is what every scoped read
// compares on, what the object-store prefix is derived from, and what
// `assertStorageKeyInScope` denies a cross-tenant reach with. A row written
// under a forged organization would read back under the TRUE one, so the write
// would succeed and every subsequent read addressed the way it was written would
// answer `null`: an attachment nobody can reach, whose blob nothing points at,
// and a storage key whose prefix names a tenant that does not own it.
//
// THREE ANSWERS, NOT TWO, AND THAT IS THE POINT. A missing environment and a
// forged parent are DIFFERENT operational events — the first is a deleted tenant
// and the second is a caller lying about one — so they carry distinct codes, in
// the same way `channels-connections.ts` separates `unknown_environment` from
// `scope_ancestry_forged`. Collapsing them would make a tenant deletion look
// like an attack and an attack look like a tenant deletion.

import type { EnvironmentScope } from "@platos/context-files/application/ports/index.js";

import { FilesWriteRefused, SCOPE_ANCESTRY_FORGED, SCOPE_ENVIRONMENT_UNKNOWN } from "./files-guards.js";
import type { TenancyReader } from "./client.js";

interface ResolvedAncestry {
  readonly projectId: string;
  readonly organizationId: string;
}

/**
 * One statement, and it is a raw one for the reason `channels-connections.ts`
 * gives: the delegate spelling — `environment.findUnique` selecting
 * `project: { organizationId }` — is TWO round trips, because the client loads
 * each relation level as its own query. The SQL is a static tagged template with
 * one interpolated VALUE, so `scripts/arch/sole-writer.mjs` can still attribute
 * it, and it names only tables it reads.
 */
export async function requireAncestry(
  reader: TenancyReader,
  scope: EnvironmentScope,
): Promise<void> {
  const rows = await reader.$queryRaw<readonly ResolvedAncestry[]>`
    SELECT environment."projectId" AS "projectId", project."organizationId" AS "organizationId"
    FROM "public"."Environment" environment
    JOIN "public"."Project" project ON project."id" = environment."projectId"
    WHERE environment."id" = ${scope.environmentId}::uuid`;
  const resolved = rows[0];
  if (resolved === undefined) {
    throw new FilesWriteRefused(
      SCOPE_ENVIRONMENT_UNKNOWN,
      `environment ${scope.environmentId} does not exist`,
    );
  }
  if (resolved.projectId !== scope.projectId || resolved.organizationId !== scope.organizationId) {
    throw new FilesWriteRefused(
      SCOPE_ANCESTRY_FORGED,
      `environment ${scope.environmentId} is under project ${resolved.projectId} of organization ${resolved.organizationId}, not project ${scope.projectId} of organization ${scope.organizationId}`,
    );
  }
}
