// Identifiers owned by the `memory` context (ADR M0.3 §1, context 8).
//
// The kernel brands the tenancy tree; these brand the three rows this context is
// SOLE WRITER of — Memory, MemoryEntity, MemoryRelationship — plus the six
// foreign keys and opaque names those rows carry.
//
// FIVE OF THESE ARE COLUMNS THIS CONTEXT NEVER WRITES. `EndUserId` belongs to
// identity-access, `AgentId` and `ClusterId` to agents, `ThreadId` and `TurnId`
// to conversations, and ADR M0.3 §1 row 8 gives this context none of them: its
// allow-list is `tenancy`, `providers` and the kernel. So the ids are branded
// HERE, as this context's names for other people's keys, which is the only shape
// the layering permits. Branding them is not decoration: every one is a `@db.Uuid`
// column on the same three rows, they all read as the same 36 characters in a log
// line, and `agentId` and `clusterId` in particular sit next to each other in
// every write path in the extraction source.
//
// `ThreadId` and `TurnId` are the two that matter most. Extraction is initiated
// by a `TurnFinalized` event and this context must NEVER import conversations
// (§1 row 8, stated in the row itself), so the only thing that ever crosses is
// the id — and the id must not be substitutable for the thread that contains it.

import type { Branded } from "@platos/kernel";

/** `Memory.id` — uuid. */
export type MemoryId = Branded<string, "MemoryId">;

/** `MemoryEntity.id` — uuid. */
export type MemoryEntityId = Branded<string, "MemoryEntityId">;

/** `MemoryRelationship.id` — uuid. */
export type MemoryRelationshipId = Branded<string, "MemoryRelationshipId">;

/**
 * `Memory.endUserId`. The subject every row in this context is keyed by, and the
 * one column that makes a memory personal data. identity-access is its sole
 * writer (§1 row 1); this context only ever reads and filters on it.
 */
export type EndUserId = Branded<string, "EndUserId">;

/**
 * `Memory.agentId`. Which agent formed the memory. `onDelete: Restrict` in the
 * baseline schema: an agent with memories cannot be removed out from under them.
 */
export type AgentId = Branded<string, "AgentId">;

/**
 * `Memory.clusterId` — the AgentCluster the writing agent belonged to, or null.
 *
 * This is the whole of cross-agent sharing. Two agents see each other's memories
 * exactly when they are bound into one cluster (`domain/scope.ts`), so a value
 * that is silently an `AgentId` would widen or narrow recall without any code
 * changing shape.
 */
export type ClusterId = Branded<string, "ClusterId">;

/** `Memory.sourceThreadId` — conversations' row, named and never imported. */
export type ThreadId = Branded<string, "ThreadId">;

/** A member of `Memory.sourceTurnIds` — conversations' row, likewise. */
export type TurnId = Branded<string, "TurnId">;

/**
 * `MemoryEntity.entityKey` — the deterministic slug an extractor assigns a
 * person, organisation or project so the same subject resolves to one node
 * across sessions. It is NOT a row id: `domain/entity.ts` derives it from a
 * label, and two environments can hold the same key for different nodes.
 */
export type EntityKey = Branded<string, "EntityKey">;

/**
 * `Memory.profileKey` — the dotted name of one structured fact about a user
 * (`name`, `role`, `preferences.theme`). Non-null exactly on `kind = "profile"`
 * rows, which are upserted per key rather than appended.
 */
export type ProfileKey = Branded<string, "ProfileKey">;

/**
 * `Memory.contentHash` — the digest that makes re-extracting an unchanged
 * transcript idempotent. It is the hash of the CONTENT, computed before any
 * encryption, so two adapters with different envelopes still deduplicate.
 */
export type ContentHash = Branded<string, "ContentHash">;

/**
 * Whoever acted, for the same reason `providers` gives: this context may not
 * import identity-access, so it names the actor without adopting identity's
 * model of one.
 */
export type ActorId = Branded<string, "ActorId">;

/**
 * Tag an already-provenanced string. Like the kernel's `asIdentifier`, this is
 * an assertion and not validation: adapters reading a row, and transports
 * parsing a request, are the only callers that should reach for it.
 */
export function asMemoryIdentifier<Id extends Branded<string, string>>(value: string): Id {
  return value as Id;
}
