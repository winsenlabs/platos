// The `__runtime` envelope: how a snapshot fits into an `AgentVersion` row.
//
// `AgentVersion` has columns for a handful of the snapshot's fields — model,
// systemPrompt, maxSteps, contextLimit, promptBlocks, dynamicBlocks,
// toolsBlockConfig, modelRoutes, outputSchema — and no columns for the rest.
// The running system carries the rest inside `memoryConfig` under a single
// reserved key, `__runtime`. Everything outside that key is the operator's own
// memory configuration and is handed back to them; everything inside it is
// carried state that no surface should ever show.
//
// THIS FILE IS THE ONLY PLACE THAT KNOWS THAT. A reader that forgets to strip
// `__runtime` shows an operator a blob of internal fields inside a settings
// panel; a writer that forgets to re-attach it drops every carried field on the
// next save. Both have happened, both are one-line mistakes, and both are
// impossible if the pack and the read are one pair of functions with a
// round-trip test between them.
//
// TWO FIELDS MOVE BETWEEN CONTAINERS AND THAT IS THE SUBTLE PART.
//
//   `enabledTools` is written to `__runtime`, NOT into the tools config column,
//   and is read back INTO the projected tools config. So a reader of the raw
//   column sees a tools config with no `enabledTools`, and a reader of the
//   projection sees one with it. Both are correct for their audience, and
//   inverting either direction silently empties an agent's tool list.
//
//   `toolMode` is written into the tools config column as `mode` — but only when
//   the column does not already carry one. The snapshot keeps its own
//   `toolMode`, so the two agree by construction rather than by convention.
//
// SO THE ROUND TRIP IS A FIXPOINT, NOT AN IDENTITY, AND THE DIFFERENCE MATTERS.
// A snapshot whose tools config carried no `mode` gains one on its first trip
// through the pack — that is the materialisation above — and nothing moves on
// any trip after it. `version-envelope.test.ts` pins both halves: every OTHER
// field survives the first trip unchanged, and the second trip changes nothing
// at all. Asserting a plain identity would have been asserting a behaviour the
// running system does not have.

import type { JsonValue } from "@platos/kernel";

import { coerceBlockList } from "./blocks.js";
import { readRoutes, writeRoutes } from "./model-route.js";
import type { AgentDefaultsPolicy } from "./policy.js";
import {
  buildSnapshot,
  type AgentVersionSnapshot,
  type JsonObject,
  type ToolDefaultPolicy,
} from "./snapshot.js";
import type { ActorId } from "./identifiers.js";

/** The reserved key inside `memoryConfig`. Never shown to an operator. */
export const RUNTIME_ENVELOPE_KEY = "__runtime";

/** The one field that lives in the envelope but projects into the tools config. */
export const CARRIED_TOOL_LIST_KEY = "enabledTools";

/** The columns and JSON a version row is written from. */
export interface AgentVersionRowData {
  readonly versionNumber: number;
  readonly model: string;
  readonly systemPrompt: string | null;
  readonly maxSteps: number;
  readonly contextLimit: number;
  readonly toolDefaultPolicy: ToolDefaultPolicy;
  readonly promptBlocks: readonly JsonValue[];
  readonly dynamicBlocks: readonly JsonValue[];
  readonly toolsBlockConfig: JsonObject;
  readonly modelRoutes: readonly JsonValue[];
  readonly memoryConfig: JsonObject;
  /** Omitted entirely when the snapshot has none — the column stays null. */
  readonly outputSchema?: JsonObject;
  readonly note: string | null;
  readonly createdBy: ActorId;
}

/** What a stored version row looks like on the way back in. */
export interface AgentVersionRow {
  readonly model: unknown;
  readonly systemPrompt: unknown;
  readonly maxSteps: unknown;
  readonly contextLimit: unknown;
  readonly promptBlocks: unknown;
  readonly dynamicBlocks: unknown;
  readonly toolsBlockConfig: unknown;
  readonly modelRoutes: unknown;
  readonly memoryConfig: unknown;
  readonly outputSchema: unknown;
}

function asObject(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Readonly<Record<string, unknown>>;
}

/** The carried state inside a stored `memoryConfig`, or an empty envelope. */
export function runtimeEnvelope(memoryConfig: unknown): Readonly<Record<string, unknown>> {
  return asObject(asObject(memoryConfig)[RUNTIME_ENVELOPE_KEY]);
}

/** The operator's own memory configuration: everything except the envelope. */
export function publicMemoryConfig(memoryConfig: unknown): JsonObject | null {
  const stored = asObject(memoryConfig);
  const entries = Object.entries(stored).filter(([key]) => key !== RUNTIME_ENVELOPE_KEY);
  return entries.length === 0 ? null : (Object.fromEntries(entries) as JsonObject);
}

/**
 * The tools config an operator sees: the column, plus the carried tool list.
 *
 * Null when neither contributes a key, which is what lets a version saved before
 * the tool layer existed project without inventing an empty object for it.
 */
export function publicToolsConfig(row: Pick<AgentVersionRow, "toolsBlockConfig" | "memoryConfig">): JsonObject | null {
  const config: Record<string, unknown> = { ...asObject(row.toolsBlockConfig) };
  const carried = runtimeEnvelope(row.memoryConfig)[CARRIED_TOOL_LIST_KEY];
  if (Array.isArray(carried)) config[CARRIED_TOOL_LIST_KEY] = [...carried];
  return Object.keys(config).length === 0 ? null : (config as JsonObject);
}

/**
 * Pack a snapshot into the row a store writes.
 *
 * `outputSchema` is OMITTED rather than set to null when the snapshot has none,
 * because the source omits it: including an explicit null would overwrite a
 * schema on a store that treats an absent key as "leave alone".
 */
export function packVersionRow(
  snapshot: AgentVersionSnapshot,
  authorship: { readonly createdBy: ActorId; readonly note: string | null },
  versionNumber: number,
  toolDefaultPolicy: ToolDefaultPolicy,
  defaults: AgentDefaultsPolicy,
): AgentVersionRowData {
  const tools: Record<string, unknown> = { ...(snapshot.toolsBlockConfig ?? {}) };
  const enabledTools = Array.isArray(tools[CARRIED_TOOL_LIST_KEY])
    ? [...(tools[CARRIED_TOOL_LIST_KEY] as unknown[])]
    : undefined;
  delete tools[CARRIED_TOOL_LIST_KEY];
  if (snapshot.toolMode !== "" && tools["mode"] === undefined) tools["mode"] = snapshot.toolMode;

  const publicMemory: Record<string, unknown> = { ...(snapshot.memoryConfig ?? {}) };
  delete publicMemory[RUNTIME_ENVELOPE_KEY];

  const envelope: Record<string, unknown> = {
    historyMode: snapshot.historyMode,
    compactThreshold: snapshot.compactThreshold,
    enableUserProfiling: snapshot.enableUserProfiling,
    toolMode: snapshot.toolMode,
    executionMode: snapshot.executionMode === "" ? defaults.executionMode : snapshot.executionMode,
    subAgentConfig: snapshot.subAgentConfig,
    metaTools: snapshot.metaTools,
    featureFlags: snapshot.featureFlags,
    extractionPolicy: snapshot.extractionPolicy,
    enableThreading: snapshot.enableThreading,
    threadingConfig: snapshot.threadingConfig,
    contextMapping: snapshot.contextMapping,
    providerKeyId: snapshot.providerKeyId,
    visibility: snapshot.visibility,
    maxJobsPerTurn: snapshot.maxJobsPerTurn,
    agentRetryConfig: snapshot.agentRetryConfig,
    ...(enabledTools === undefined ? {} : { [CARRIED_TOOL_LIST_KEY]: enabledTools }),
  };

  return {
    versionNumber,
    model: snapshot.model === "" ? defaults.model : snapshot.model,
    systemPrompt: snapshot.systemPrompt,
    maxSteps: snapshot.maxSteps,
    contextLimit: snapshot.contextLimit,
    toolDefaultPolicy,
    promptBlocks: (coerceBlockList(snapshot.promptBlocks) ?? []) as readonly JsonValue[],
    dynamicBlocks: (coerceBlockList(snapshot.dynamicBlocks) ?? []) as readonly JsonValue[],
    toolsBlockConfig: tools as JsonObject,
    modelRoutes: writeRoutes(snapshot.modelRoutes ?? []) as unknown as readonly JsonValue[],
    memoryConfig: { ...publicMemory, [RUNTIME_ENVELOPE_KEY]: envelope } as JsonObject,
    ...(snapshot.outputSchema === null ? {} : { outputSchema: snapshot.outputSchema }),
    note: authorship.note,
    createdBy: authorship.createdBy,
  };
}

/**
 * Read a stored version row back into a snapshot.
 *
 * The inverse of `packVersionRow` for every field either of them touches, which
 * is what `version-envelope.test.ts` pins as a round trip. Fields the envelope
 * never carried come back as the policy defaults, so a row written before a
 * field existed reads as that field's default rather than as `undefined`.
 */
export function readVersionRow(row: AgentVersionRow, defaults: AgentDefaultsPolicy): AgentVersionSnapshot {
  const envelope = runtimeEnvelope(row.memoryConfig);
  return buildSnapshot(
    {
      model: row.model,
      modelRoutes: readRoutes(row.modelRoutes),
      systemPrompt: row.systemPrompt,
      promptBlocks: row.promptBlocks,
      dynamicBlocks: row.dynamicBlocks,
      maxSteps: row.maxSteps,
      contextLimit: row.contextLimit,
      historyMode: envelope["historyMode"],
      compactThreshold: envelope["compactThreshold"],
      enableUserProfiling: envelope["enableUserProfiling"],
      toolMode: envelope["toolMode"],
      executionMode: envelope["executionMode"],
      toolsBlockConfig: publicToolsConfig(row),
      subAgentConfig: envelope["subAgentConfig"],
      memoryConfig: publicMemoryConfig(row.memoryConfig),
      metaTools: envelope["metaTools"],
      featureFlags: envelope["featureFlags"],
      outputSchema: row.outputSchema,
      extractionPolicy: envelope["extractionPolicy"],
      enableThreading: envelope["enableThreading"],
      threadingConfig: envelope["threadingConfig"],
      contextMapping: envelope["contextMapping"],
      providerKeyId: envelope["providerKeyId"],
      visibility: envelope["visibility"],
      maxJobsPerTurn: envelope["maxJobsPerTurn"],
      agentRetryConfig: envelope["agentRetryConfig"],
    },
    defaults,
  );
}
