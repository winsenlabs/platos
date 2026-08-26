/** Canonical persisted Memory taxonomy shared by the API and dashboard. */
export const MEMORY_KINDS = [
  "fact",
  "preference",
  "event",
  "relationship",
  "profile",
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

/**
 * Visibility is independent from ownership. AgentCluster widening comes only
 * from the persisted AgentBinding.clusterId boundary.
 *
 * - agent_visible: eligible for Agent recall inside the persisted owner scope.
 * - hidden: operator-visible persistence that is excluded from Agent recall.
 * - private: explicitly private persistence that is excluded from Agent recall.
 */
export const MEMORY_VISIBILITIES = ["agent_visible", "hidden", "private"] as const;
export type MemoryVisibility = (typeof MEMORY_VISIBILITIES)[number];

export const MEMORY_SOURCES = ["manual", "extracted", "imported", "rag"] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

export const MEMORY_ARCHIVE_STATES = ["active", "archived", "all"] as const;
export type MemoryArchiveState = (typeof MEMORY_ARCHIVE_STATES)[number];

export const MEMORY_PAGE_DEFAULT = 50;
export const MEMORY_PAGE_MAX = 100;
export const MEMORY_OFFSET_MAX = 100_000;

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === "string" && MEMORY_KINDS.includes(value as MemoryKind);
}

export function isMemoryVisibility(value: unknown): value is MemoryVisibility {
  return typeof value === "string" && MEMORY_VISIBILITIES.includes(value as MemoryVisibility);
}

export function isMemorySource(value: unknown): value is MemorySource {
  return typeof value === "string" && MEMORY_SOURCES.includes(value as MemorySource);
}

export function normalizeMemoryProfileKey(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

export function isMemoryArchiveState(value: unknown): value is MemoryArchiveState {
  return typeof value === "string" && MEMORY_ARCHIVE_STATES.includes(value as MemoryArchiveState);
}
