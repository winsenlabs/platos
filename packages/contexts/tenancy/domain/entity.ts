// `Entity` — tenancy's fourth owned aggregate, and the one the charter
// describes wrongly.
//
// THE SHAPE IS NOT A CHAIN. The charter and ADR M0.3 §1 both write the tenant
// tree as "Organization -> Project -> Environment -> Entity", which reads as a
// four-level chain with Entity below Environment. The schema says otherwise:
//
//   model Entity {
//     projectId  String  @db.Uuid
//     externalId String
//     project    Project @relation(fields: [projectId], references: [id], ...)
//     @@unique([projectId, externalId])
//   }
//
// `Entity` hangs off `Project`. It is a SIBLING of `Environment`, not a child
// of it. Nothing keys an Entity by environment, and an Entity is reachable from
// every environment of its project at once.
//
// The relationship that does exist between the two is the many-to-many join
// `EnvironmentEntityTool` — which is owned by the `tools` context, not by
// tenancy, and expresses "this entity's tool is enabled in this environment"
// rather than containment. So an Entity is not scoped by `EnvironmentScope`,
// and `resolvePath()` cannot address one. Anything that needs "the entities
// visible in environment E" resolves E's project first and asks for that
// project's entities; anything that needs "which of them are wired into E"
// belongs to `tools`.
//
// Getting this backwards produces a plausible-looking cross-tenant read: an
// entity fetched "under" the wrong environment of the right project looks
// correct and is not.

import type { EntityId, ProjectId } from "@platos/kernel";

export interface EntityRecord {
  readonly id: EntityId;
  /** The parent. There is no `environmentId` on this row, by design. */
  readonly projectId: ProjectId;
  /** The caller's own identifier; unique within the project. */
  readonly externalId: string;
  readonly displayName: string;
  readonly connectionStatus: string;
  readonly connectionKind: string;
  readonly mcpUrls: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly capabilities: readonly string[];
  readonly lastConnectedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The natural key: `@@unique([projectId, externalId])`. Deliberately built from
 * the project and never from an environment, so a caller cannot construct a key
 * that implies an entity belongs to one environment of a project.
 */
export function entityKey(projectId: ProjectId, externalId: string): string {
  return `proj/${projectId}/entity/${externalId}`;
}

export function entityBelongsToProject(entity: EntityRecord, projectId: ProjectId): boolean {
  return entity.projectId === projectId;
}

export function markEntityConnected(entity: EntityRecord, at: Date): EntityRecord {
  return { ...entity, lastConnectedAt: at, updatedAt: at };
}
