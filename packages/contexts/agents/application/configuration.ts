// The editable surface of an agent, in one place.
//
// Create and update take almost the same fields, and in the running system they
// are two separate interfaces that have drifted: one carries `enableThreading`
// and the other does not, one carries `clusteringId` and the other does not, and
// `executionMode` was missing from a third shape entirely — which is exactly why
// cloning an agent silently dropped durable execution. Naming the intake once,
// here, is what stops a field from being editable through one door and invisible
// through the other.
//
// EVERY FIELD IS OPTIONAL AND `undefined` MEANS "LEAVE IT ALONE". That is not
// the same as `null`, which means "clear it", and the two are kept apart for
// every field where the column is nullable. A shape that collapsed them would
// erase an output schema on every rename.

import type {
  JsonObject,
  ModelRoute,
  RouteIntake,
  SkillAssignment,
  SnapshotSource,
  SubAgentConfig,
} from "../domain/index.js";

export interface AgentConfigurationIntake {
  readonly model?: string | null;
  readonly systemPrompt?: string | null;
  readonly promptBlocks?: unknown;
  readonly dynamicBlocks?: unknown;
  readonly maxSteps?: number;
  readonly contextLimit?: number;
  readonly historyMode?: string;
  readonly compactThreshold?: number;
  readonly enableUserProfiling?: boolean;
  readonly enableThreading?: boolean;
  readonly threadingConfig?: JsonObject | null;
  readonly executionMode?: string;
  readonly toolMode?: string;
  readonly toolsBlockConfig?: unknown;
  readonly subAgentConfig?: SubAgentConfig | null;
  readonly memoryConfig?: JsonObject | null;
  readonly metaTools?: Readonly<Record<string, boolean>> | null;
  readonly featureFlags?: Readonly<Record<string, boolean>> | null;
  readonly outputSchema?: JsonObject | null;
  readonly extractionPolicy?: JsonObject | null;
  readonly contextMapping?: JsonObject | null;
  readonly providerKeyId?: string | null;
  readonly visibility?: string | null;
  readonly maxJobsPerTurn?: number | null;
  readonly agentRetryConfig?: JsonObject | null;
}

/** The fields a use case has already resolved before it builds a snapshot. */
export interface ResolvedConfiguration {
  readonly model: string | null;
  readonly modelRoutes: readonly ModelRoute[] | null;
  readonly systemPrompt: string | null;
  readonly toolsBlockConfig: unknown;
}

/**
 * Fold an intake and the fields a use case resolved into one snapshot source.
 *
 * The resolved fields WIN, because they are the ones that went through a rule:
 * the model may have come from the routing table, the system prompt may have
 * been serialized from blocks, and the tools config has been through the
 * mode-coercion. Letting the raw intake override them would put the un-ruled
 * value back.
 */
export function snapshotSourceFrom(
  intake: AgentConfigurationIntake,
  resolved: ResolvedConfiguration,
): SnapshotSource {
  return {
    ...intake,
    model: resolved.model ?? undefined,
    modelRoutes: resolved.modelRoutes,
    systemPrompt: resolved.systemPrompt,
    toolsBlockConfig: resolved.toolsBlockConfig,
  };
}

/** The keys a caller may supply that are not part of the version snapshot. */
export interface AgentRowIntake {
  readonly name?: string;
  readonly description?: string | null;
  readonly isActive?: boolean;
}

/** A loadout supplied wholesale, for the paths that set one rather than edit it. */
export type LoadoutIntake = readonly SkillAssignment[];

/** Re-exported so a caller building a command names one module, not three. */
export type { RouteIntake };
