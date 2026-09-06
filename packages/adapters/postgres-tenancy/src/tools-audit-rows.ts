// The audit envelope's storage layout, and the `ToolCall` mapping beside it.
//
// SEVEN OF THE EIGHT ENVELOPE FIELDS HAVE NO COLUMN. `ToolCallAudit` carries
// `environmentId`, `toolId`, `endUserId`, `agentId`, `threadId`, `toolName`,
// `arguments`, `result`, `error`, `status`, `latencyMs`, `costCents`, `traceId`
// and `createdAt` — and `AuditEnvelope` names `externalEntityId`, `actorUserId`,
// `spanId`, `parentSpanId`, `source`, `mcpPrincipalId` and `mcpClientId`, none of
// which is among them. `endUserId` is the one that is both.
//
// So the envelope is stored INSIDE the `arguments` column under a reserved key,
// which is what the source does and what `domain/audit.ts` says it does. The
// layout is TRANSCRIBED rather than invented: `apps/agent`'s
// `tool-audit.service.ts` writes `{ __platosAudit: {...}, value: <arguments> }`
// and reads it back with `!!storedArgs.__platosAudit` as the discriminator, so
// rows written by the shipping binary are readable by this one and rows written
// by this one are readable by it. Inventing a layout here would have made the
// list endpoint and the replay endpoint disagree about where `endUserId` lives,
// which is the failure `domain/audit.ts` names.
//
// TWO OF THE SOURCE'S KEY NAMES ARE NOT THE DOMAIN'S, and the difference is
// carried here rather than renamed away: `entityId` is the envelope's
// `externalEntityId` (an `Entity.externalId`, never the primary key — the source
// keeps `entityPk` separately for that) and `mcpUserId` is `mcpPrincipalId`.
//
// A ROW WITH NO RESERVED KEY IS A PRE-ENVELOPE ROW, not a corrupt one. Its whole
// `arguments` column is the arguments and its envelope is `EMPTY_AUDIT_ENVELOPE`.
// That is the expand/contract read this adapter owes the rows already in the
// database, and `tools-constraints.integration.test.ts` seeds one in raw SQL to
// prove it, because nothing this package can call writes one any more.
//
// THE `result` COLUMN CANNOT HOLD A SCALAR. `ToolCallAudit_result_json_root` and
// `ToolCall_result_json_root` both admit only `object` or `array`, and
// `AuditEntry.result` is `unknown` — so `42`, `"ok"` and `true` are values the
// domain permits and the database refuses. The source wraps them as
// `{ __platosScalarResult: value }`; that wrapper is transcribed too, and
// unwrapped on read, so a scalar result round-trips instead of failing a CHECK
// at three in the morning.

import type {
  AgentId,
  AuditEntry,
  AuditEnvelope,
  Branded,
  DispatchSource,
  EndUserId,
  EnvironmentId,
  ExternalEntityId,
  StepId,
  ThreadId,
  ToolCall,
  ToolCallAuditId,
  ToolCallId,
  ToolId,
  ToolName,
} from "@platos/context-tools/application/ports/index.js";
import {
  asToolsIdentifier,
  DISPATCH_SOURCES,
  EMPTY_AUDIT_ENVELOPE,
} from "@platos/context-tools/application/ports/index.js";

import { readCallStatus, readJsonObject } from "./tools-rows.js";

/** The source's reserved key. Changing it orphans every row already written. */
export const AUDIT_ENVELOPE_KEY = "__platosAudit";

/** The source's key for the arguments themselves, beside the envelope. */
export const AUDIT_VALUE_KEY = "value";

/** The source's wrapper for a result the json-root CHECK would refuse. */
export const SCALAR_RESULT_KEY = "__platosScalarResult";

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Split a stored `arguments` column into its envelope and its arguments. */
export function readAuditArguments(stored: unknown): {
  readonly envelope: AuditEnvelope;
  readonly argumentsValue: Readonly<Record<string, unknown>>;
} {
  const column = readJsonObject(stored);
  const raw = column[AUDIT_ENVELOPE_KEY];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    // A pre-envelope row. The whole column is the arguments.
    return { envelope: EMPTY_AUDIT_ENVELOPE, argumentsValue: column };
  }
  const packed = raw as Readonly<Record<string, unknown>>;
  const source = readString(packed.source);
  return {
    envelope: {
      externalEntityId: asOrNull<ExternalEntityId>(readString(packed.entityId)),
      endUserId: asOrNull<EndUserId>(readString(packed.endUserId)),
      actorUserId: asOrNull(readString(packed.actorUserId)),
      spanId: readString(packed.spanId),
      parentSpanId: readString(packed.parentSpanId),
      // An unrecognised source is NULL rather than a refusal: the field's own
      // comment says it is "null on rows written before the tag existed", so a
      // value this binary has not heard of is the same operational fact.
      source: DISPATCH_SOURCES.find((known) => known === source) ?? null,
      mcpPrincipalId: readString(packed.mcpUserId),
      mcpClientId: readString(packed.mcpClientId),
    },
    argumentsValue: readJsonObject(column[AUDIT_VALUE_KEY]),
  };
}

/**
 * Brand a nullable column, or keep the null.
 *
 * The constraint is the kernel's `Branded` rather than `string`, because
 * `asToolsIdentifier` is an ASSERTION and a looser constraint here would let it
 * be called on a plain `string` — the one caller it exists to refuse.
 */
function asOrNull<Id extends Branded<string, string>>(value: string | null): Id | null {
  return value === null ? null : asToolsIdentifier<Id>(value);
}

/** Pack an envelope and arguments into the one column that holds both. */
export function writeAuditArguments(entry: AuditEntry): Readonly<Record<string, unknown>> {
  const envelope = entry.envelope;
  return {
    [AUDIT_ENVELOPE_KEY]: {
      entityId: envelope.externalEntityId,
      // WRITTEN AS WELL AS COLUMN-STORED, exactly as the source writes it. The
      // column is `ON DELETE SET NULL`, so after an end user is erased the
      // column is null and this key is the only surviving record that the row
      // ever had a subject — which is the property the erasure service relies
      // on when it anonymises rather than deletes.
      endUserId: envelope.endUserId,
      actorUserId: envelope.actorUserId,
      spanId: envelope.spanId,
      parentSpanId: envelope.parentSpanId,
      source: envelope.source,
      mcpUserId: envelope.mcpPrincipalId,
      mcpClientId: envelope.mcpClientId,
    },
    [AUDIT_VALUE_KEY]: entry.arguments,
  };
}

/**
 * A `result` the json-root CHECK will accept.
 *
 * `null` stays null — the column is nullable and `IS NULL` is one of the two
 * arms of the CHECK. Everything else that is not an object or an array is
 * wrapped, because the alternative is a driver error on a value the domain
 * declared legal.
 */
export function writeResult(result: unknown): unknown {
  if (result === null || result === undefined) return null;
  if (typeof result === "object") return result;
  return { [SCALAR_RESULT_KEY]: result };
}

/** The inverse. A wrapper written by either binary unwraps to its value. */
export function readResult(stored: unknown): unknown {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return stored;
  const record = stored as Readonly<Record<string, unknown>>;
  return SCALAR_RESULT_KEY in record ? record[SCALAR_RESULT_KEY] : stored;
}

export interface AuditRow {
  readonly id: string;
  readonly environmentId: string;
  readonly toolId: string | null;
  readonly toolName: string;
  readonly agentId: string | null;
  readonly threadId: string | null;
  readonly endUserId: string | null;
  readonly traceId: string | null;
  readonly arguments: unknown;
  readonly result: unknown;
  readonly error: string | null;
  readonly status: string;
  readonly latencyMs: number;
  /** `Decimal(18, 6)`. The driver hands back an object with `toString`. */
  readonly costCents: { toString(): string } | null;
  readonly createdAt: Date;
}

export function toAuditEntry(row: AuditRow): AuditEntry {
  const split = readAuditArguments(row.arguments);
  return {
    toolCallAuditId: asToolsIdentifier<ToolCallAuditId>(row.id),
    environmentId: asToolsIdentifier<EnvironmentId>(row.environmentId),
    toolId: asOrNull<ToolId>(row.toolId),
    toolName: asToolsIdentifier<ToolName>(row.toolName),
    agentId: asOrNull<AgentId>(row.agentId),
    threadId: asOrNull<ThreadId>(row.threadId),
    // The COLUMN wins over the envelope copy. After erasure the column is null
    // and the envelope still names the subject; reading the envelope first
    // would resurrect an identity the erasure removed.
    endUserId: asOrNull<EndUserId>(row.endUserId),
    traceId: row.traceId,
    arguments: split.argumentsValue,
    result: readResult(row.result),
    error: row.error,
    status: readCallStatus("ToolCallAudit.status", row.status),
    latencyMs: row.latencyMs,
    // A STRING and never a number. `Decimal(18, 6)` does not fit a double, and
    // the field's own comment says so.
    costCents: row.costCents === null ? null : row.costCents.toString(),
    envelope: split.envelope,
    createdAt: row.createdAt,
  };
}

export interface ToolCallRow {
  readonly id: string;
  readonly stepId: string;
  readonly toolId: string | null;
  readonly sequence: number;
  readonly toolName: string;
  readonly arguments: unknown;
  readonly result: unknown;
  readonly status: string;
  readonly retryCount: number;
  readonly error: string | null;
  readonly latencyMs: number | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
}

export function toToolCall(row: ToolCallRow): ToolCall {
  return {
    toolCallId: asToolsIdentifier<ToolCallId>(row.id),
    stepId: asToolsIdentifier<StepId>(row.stepId),
    toolId: asOrNull<ToolId>(row.toolId),
    sequence: row.sequence,
    toolName: asToolsIdentifier<ToolName>(row.toolName),
    // No envelope here: `ToolCall.arguments` has no overflow to carry, so the
    // column is the value. The json-root CHECK is the same one, which is why
    // `result` still passes through the scalar wrapper.
    arguments: readJsonObject(row.arguments),
    result: readResult(row.result),
    status: readCallStatus("ToolCall.status", row.status),
    retryCount: row.retryCount,
    error: row.error,
    latencyMs: row.latencyMs,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
  };
}
