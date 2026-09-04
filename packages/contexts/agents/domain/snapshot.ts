// `AgentVersionSnapshot` — every user-editable field of an agent, at one instant.
//
// A version IS its snapshot. The editor diffs two of them, a rollback writes an
// old one forward as a new version, and the change detector decides whether a
// save mints a version at all by comparing the incoming snapshot with the
// current one. So the snapshot has to be TOTAL — a field missing from it is a
// field a rollback silently drops — and it has to be CANONICAL, because two
// encodings of the same configuration must compare equal.
//
// ONE FIELD IN THIS TYPE IS A SCAR AND IT IS KEPT. `executionMode` was absent
// from the record type while the column existed, which is precisely why cloning
// an agent silently dropped durable execution: the clone copied the record, and
// the record did not carry the field. It is on the snapshot here, defaulted, and
// covered by a test, because the cost of the omission was a whole class of agent
// quietly changing how it ran.
//
// THE DEFAULTS ARE THE SERVICE'S, NOT THE COLUMN'S. `maxSteps` and
// `contextLimit` fall back to the policy's service defaults; see
// `domain/policy.ts` for why `contextLimit` disagrees with its own column
// default and why both numbers are named.
//
// `toolMode` HAS A TWO-STEP FALLBACK AND THE ORDER MATTERS. The explicit field
// first, then the tools-config's own `mode`, then the policy default. Reversing
// the first two would let a stale nested `mode` override the field an operator
// just set.

import type { JsonValue } from "@platos/kernel";

import {
  coerceBlockList,
  objectsIn,
  readPromptBlocks,
  type DynamicBlockTemplate,
  type PromptBlock,
} from "./blocks.js";
import type { ModelRoute } from "./model-route.js";
import type { AgentDefaultsPolicy } from "./policy.js";
import type { ProviderKeyId } from "./identifiers.js";
import { readToolsBlockConfig, type ToolsBlockConfig } from "./tools-config.js";

export type JsonObject = Readonly<Record<string, JsonValue>>;

/** How a version treats tools it has no explicit policy row for. */
export const TOOL_DEFAULT_POLICIES = ["NONE", "ALL"] as const;
export type ToolDefaultPolicy = (typeof TOOL_DEFAULT_POLICIES)[number];

export interface SubAgentConfig {
  readonly model?: string;
  readonly maxSteps?: number;
  readonly systemPrompt?: string;
  readonly toolMode?: "direct" | "meta-tool";
  readonly promptCaching?: boolean;
}

export interface AgentVersionSnapshot {
  readonly model: string;
  readonly modelRoutes: readonly ModelRoute[] | null;
  readonly systemPrompt: string | null;
  readonly promptBlocks: readonly PromptBlock[] | null;
  readonly dynamicBlocks: readonly DynamicBlockTemplate[] | null;
  readonly maxSteps: number;
  readonly contextLimit: number;
  readonly historyMode: string;
  readonly compactThreshold: number;
  readonly enableUserProfiling: boolean;
  readonly toolMode: string;
  /** The scar. See the note at the top. */
  readonly executionMode: string;
  readonly toolsBlockConfig: ToolsBlockConfig | null;
  readonly subAgentConfig: SubAgentConfig | null;
  readonly memoryConfig: JsonObject | null;
  readonly metaTools: Readonly<Record<string, boolean>> | null;
  readonly featureFlags: Readonly<Record<string, boolean>> | null;
  readonly outputSchema: JsonObject | null;
  readonly extractionPolicy: JsonObject | null;
  readonly enableThreading: boolean;
  readonly threadingConfig: JsonObject | null;
  readonly contextMapping: JsonObject | null;
  /** The version-level provider-key pin. Distinct from a route's. */
  readonly providerKeyId: ProviderKeyId | null;
  readonly visibility: string | null;
  readonly maxJobsPerTurn: number | null;
  readonly agentRetryConfig: JsonObject | null;
}

/** The loose shape a snapshot is built from — a row, a request, or a record. */
export interface SnapshotSource {
  readonly model?: unknown;
  readonly modelRoutes?: readonly ModelRoute[] | null;
  readonly systemPrompt?: unknown;
  readonly promptBlocks?: unknown;
  readonly dynamicBlocks?: unknown;
  readonly maxSteps?: unknown;
  readonly contextLimit?: unknown;
  readonly historyMode?: unknown;
  readonly compactThreshold?: unknown;
  readonly enableUserProfiling?: unknown;
  readonly toolMode?: unknown;
  readonly executionMode?: unknown;
  readonly toolsBlockConfig?: unknown;
  readonly subAgentConfig?: unknown;
  readonly memoryConfig?: unknown;
  readonly metaTools?: unknown;
  readonly featureFlags?: unknown;
  readonly outputSchema?: unknown;
  readonly extractionPolicy?: unknown;
  readonly enableThreading?: unknown;
  readonly threadingConfig?: unknown;
  readonly contextMapping?: unknown;
  readonly providerKeyId?: unknown;
  readonly visibility?: unknown;
  readonly maxJobsPerTurn?: unknown;
  readonly agentRetryConfig?: unknown;
}

function objectOrNull(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonObject;
}

function booleanMap(value: unknown): Readonly<Record<string, boolean>> | null {
  const object = objectOrNull(value);
  if (object === null) return null;
  const out: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(object)) {
    if (typeof entry === "boolean") out[key] = entry;
  }
  return out;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Build a canonical snapshot from a loose source.
 *
 * Every field is defaulted here rather than at the call sites, which is what
 * makes two snapshots comparable: a create request that omitted `maxSteps` and a
 * stored row that has it produce the same value, so the change detector does not
 * mint a version for a field nobody touched.
 */
export function buildSnapshot(
  source: SnapshotSource,
  defaults: AgentDefaultsPolicy,
): AgentVersionSnapshot {
  const toolsBlockConfig = readToolsBlockConfig(source.toolsBlockConfig);
  return {
    model: typeof source.model === "string" && source.model !== "" ? source.model : defaults.model,
    modelRoutes: source.modelRoutes ?? null,
    systemPrompt: stringOrNull(source.systemPrompt),
    promptBlocks: readPromptBlocks(source.promptBlocks),
    dynamicBlocks: readDynamicBlocks(source.dynamicBlocks),
    maxSteps: numberOr(source.maxSteps, defaults.maxSteps),
    contextLimit: numberOr(source.contextLimit, defaults.contextLimit),
    historyMode: stringOrNull(source.historyMode) ?? defaults.historyMode,
    compactThreshold: numberOr(source.compactThreshold, defaults.compactThreshold),
    enableUserProfiling: source.enableUserProfiling === true,
    toolMode: stringOrNull(source.toolMode) ?? toolsBlockConfig?.mode ?? defaults.toolMode,
    executionMode: stringOrNull(source.executionMode) ?? defaults.executionMode,
    toolsBlockConfig,
    subAgentConfig: objectOrNull(source.subAgentConfig) as SubAgentConfig | null,
    memoryConfig: objectOrNull(source.memoryConfig),
    metaTools: booleanMap(source.metaTools),
    featureFlags: booleanMap(source.featureFlags),
    outputSchema: objectOrNull(source.outputSchema),
    extractionPolicy: objectOrNull(source.extractionPolicy),
    enableThreading: source.enableThreading === true,
    threadingConfig: objectOrNull(source.threadingConfig),
    contextMapping: objectOrNull(source.contextMapping),
    providerKeyId:
      typeof source.providerKeyId === "string" && source.providerKeyId !== ""
        ? (source.providerKeyId as ProviderKeyId)
        : null,
    visibility: stringOrNull(source.visibility),
    maxJobsPerTurn: typeof source.maxJobsPerTurn === "number" ? source.maxJobsPerTurn : null,
    agentRetryConfig: objectOrNull(source.agentRetryConfig),
  };
}

/**
 * Read a dynamic-block column.
 *
 * A dynamic block is a DIFFERENT shape from a prompt block — it is a template
 * with a key and a default body, not a rendered section — so it gets its own
 * reader rather than borrowing the prompt-block one. The column holds it as free
 * JSON; only the three fields every reader relies on are pinned, and an optional
 * field absent from the stored object stays absent here rather than becoming an
 * explicit `undefined` that would encode differently.
 */
function readDynamicBlocks(value: unknown): readonly DynamicBlockTemplate[] | null {
  const list = coerceBlockList(value);
  if (list === null) return null;
  return objectsIn(list).map((entry) => ({
    key: typeof entry["key"] === "string" ? entry["key"] : "",
    name: typeof entry["name"] === "string" ? entry["name"] : "",
    defaultContent: typeof entry["defaultContent"] === "string" ? entry["defaultContent"] : "",
    ...(typeof entry["description"] === "string" ? { description: entry["description"] } : {}),
    ...(typeof entry["order"] === "number" ? { order: entry["order"] } : {}),
  }));
}

/**
 * A key-ordered encoding of any JSON value.
 *
 * THE SOURCE COMPARES `JSON.stringify(a) !== JSON.stringify(b)`, WHICH IS
 * ORDER-SENSITIVE, AND THIS IS A DELIBERATE DIVERGENCE FROM THAT. The snapshot's
 * own keys are fixed by `buildSnapshot`, so the top level already compares
 * stably; but `memoryConfig`, `threadingConfig` and `contextMapping` are free
 * JSON supplied by a client, and two clients that serialize the same object with
 * different key order would otherwise be seen as a change. That mints a version
 * for a save that altered nothing, on every save, forever — and version history
 * is the thing an operator reads to find out what actually changed. Ordering the
 * keys makes the comparison structural, which is what the source meant.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

/** True when a save must mint a new version. */
export function snapshotsDiffer(left: AgentVersionSnapshot, right: AgentVersionSnapshot): boolean {
  return canonicalJson(left) !== canonicalJson(right);
}
