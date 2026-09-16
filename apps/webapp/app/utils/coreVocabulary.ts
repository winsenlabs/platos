// THE CLOSED VOCABULARIES THE DASHBOARD SHARES WITH THE SERVICES IT CALLS.
//
// WIN-257 T8. Four of the fourteen webapp files coupled to `@platos/tenancy-
// database` imported nothing from it but CONSTANTS: `OrganizationRole` and
// `ProjectRole` in three routes, and the four memory lists in the memories
// screen. Not a client, not a query — a handful of frozen string arrays that
// arrived attached to a generated Prisma client, and therefore kept Prisma in the
// dashboard's production dependency closure to render a `<select>`.
//
// So they are RESTATED HERE, and joined to their authorities by a test rather
// than by an import:
//
//   ORGANIZATION_ROLES   packages/contexts/tenancy/domain/roles.ts
//   MEMORY_*             internal-packages/tenancy-database/src/memory-contract.ts
//
// `ProjectRole` and `EnvironmentVariableKind` are NOT here, and their absence is
// the measure of how much of this the V1 routes took over. `projects.new` sent
// `ProjectRole.ADMIN` and `createProject` now decides it; `environment-
// variables.new` sent `EnvironmentVariableKind.PLAIN` and
// `setEnvironmentVariable` now decides it from `secret`. Restating a constant
// nothing sends would be carrying the coupling forward with none of its use.
//
// `test/coreVocabulary.test.ts` READS BOTH FILES OFF DISK and fails if either
// list moves. That is the same technique `apps/core-api/src/transports/rest/
// session-cookie-value.ts` uses for Remix's cookie encoding, and the reason is
// the same: the alternative is a dependency edge that costs far more than the
// four lines it carries, and a copy nobody checks is worse than either.
//
// A LIST THAT GROWS IS A RED TEST, NOT A SILENT DIVERGENCE. That is the whole
// point: adding a fourth organization role in the domain and forgetting the
// screen that renders them would otherwise be invisible until an operator could
// not assign it.

/** `enum OrganizationRole` — the roles an organization membership can hold. */
export const ORGANIZATION_ROLES = ["OWNER", "ADMIN", "MEMBER"] as const;
export type OrganizationRoleName = (typeof ORGANIZATION_ROLES)[number];

export function isOrganizationRole(value: string): value is OrganizationRoleName {
  return (ORGANIZATION_ROLES as readonly string[]).includes(value);
}

export const MEMORY_KINDS = ["fact", "preference", "event", "relationship", "profile"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_VISIBILITIES = ["agent_visible", "hidden", "private"] as const;
export type MemoryVisibility = (typeof MEMORY_VISIBILITIES)[number];

export const MEMORY_SOURCES = ["manual", "extracted", "imported", "rag"] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

export const MEMORY_ARCHIVE_STATES = ["active", "archived", "all"] as const;
export type MemoryArchiveState = (typeof MEMORY_ARCHIVE_STATES)[number];
