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

/**
 * `Entity.connectionStatus`, as the tool-sync socket writes it.
 *
 * TWO VALUES AND NOT AN ENUM. The column is a bare `String` in the schema, and
 * the oracle (`apps/agent/src/tool-gateway/tool-sync-ws.service.ts`) writes
 * exactly `"connected"` on a successful handshake and `"disconnected"` when the
 * entity's LAST environment connection closes. Nothing else writes it, so this
 * is the whole live vocabulary rather than a widening of one: a third value
 * would be a status no reader in the tree knows how to render.
 *
 * LOWER CASE, WHICH IS NOT COSMETIC. `packages/adapters/postgres-tenancy`'s
 * conformance rows carry `"CONNECTED"` because that is what a fixture author
 * typed; the rows the RUNNING PRODUCT writes are lower case, and a writer that
 * normalised them would silently rewrite every live row the first time an entity
 * reconnected. The mapping layer passes the column through untouched and so does
 * this.
 */
export const ENTITY_CONNECTION_STATUSES = ["connected", "disconnected"] as const;

export type EntityConnectionStatus = (typeof ENTITY_CONNECTION_STATUSES)[number];

export function isEntityConnectionStatus(value: unknown): value is EntityConnectionStatus {
  return (
    typeof value === "string" && (ENTITY_CONNECTION_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The connect half of the oracle's pair.
 *
 * `{ connectionStatus: "connected", lastConnectedAt: new Date() }` — both
 * columns, in one write, because the oracle sets both in one `entity.update`
 * and a reader that saw `connected` with a stale `lastConnectedAt` would date
 * the session wrongly.
 */
export function markEntityConnected(entity: EntityRecord, at: Date): EntityRecord {
  return { ...entity, connectionStatus: "connected", lastConnectedAt: at, updatedAt: at };
}

/**
 * The disconnect half.
 *
 * `lastConnectedAt` IS DELIBERATELY NOT CLEARED AND NOT ADVANCED. The oracle
 * writes `{ connectionStatus: "disconnected" }` and nothing else, so the column
 * keeps meaning "when this entity was last seen to connect" rather than
 * collapsing into "when it last changed state". Advancing it here would make
 * every disconnect look like a connection to any dashboard reading the column.
 */
export function markEntityDisconnected(entity: EntityRecord, at: Date): EntityRecord {
  return { ...entity, connectionStatus: "disconnected", updatedAt: at };
}
