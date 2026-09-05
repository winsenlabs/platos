// Row <-> record mapping for `governance`'s five canonical rows, and the one
// place each of their columns is trusted or refused.
//
// Every function here is PURE and takes a STRUCTURAL row type rather than a
// generated one, for the reason `mapping.ts` gives: a mapping suite that could
// only run after `prisma generate` is a suite nobody runs. The structural types
// are checked against the generated ones at the call sites in the five stores.
//
// THREE VOCABULARY COLUMNS ARE VALIDATED, NOT CAST, and this is the finding that
// shaped the file. `SafetyEvent.detector`, `.action` and `.severity` are plain
// `String` columns — the closed sets live in `domain/safety-event.ts` and NOWHERE
// in the database, not as an enum and not as a CHECK. The legacy source wrote
// whatever it was handed. So a stored `"PII"` is readable as a string and is not
// a `SafetyDetector`, and a store that cast it would feed a value outside the
// union into `summarise`, whose histograms are keyed BY the union: the row would
// land in no bucket and the total would stop equalling the sum of the parts.
// Three refusals, three codes, because a wrong detector and a wrong severity are
// different operational events during an expand/contract window.
//
// THE SAFETY METADATA COLUMN CARRIES THREE FIELDS THAT HAVE NO COLUMN.
// `AdmittedSafetyEvent` declares `principalId`, `rule` and `detailTruncated`;
// the canonical model declares none of them. `domain/safety-event.ts` already
// names the carrier for the first — the subject is "persisted into the row's
// metadata adapter by the repository" — and the other two have the same shape of
// problem and no other home, so all three ride in the same envelope.
//
// THE ENVELOPE IS DISCRIMINATED, NOT MERGED, so a legacy row still reads. Merging
// the three keys into the producer's own object would make them indistinguishable
// from detector attributes, and a detector that happened to emit `rule` would
// have its attribute read as the ledger's rule. Instead the stored object is
// `{ __governance: 1, attributes, principalId, rule, detailTruncated }`, and a
// stored object WITHOUT `__governance` is read as a legacy row whose whole body
// is the attributes and whose three carried fields are absent. That is ADR
// M0.3's expand/contract rule applied to a JSON column: rows written without the
// newer fields are read, and no new column was needed to do it.
//
// A PRODUCER MAY NOT FORGE ONE. `governance-guards.ts` refuses a metadata object
// carrying `__governance` at its root, because a producer that could write the
// marker could write its own `principalId` and re-point somebody else's erasure.

import type {
  ActorId,
  AdmittedGoldenSet,
  AdmittedSafetyEvent,
  AgentEval,
  AgentEvalId,
  AgentId,
  AgentVersionId,
  CriterionSnapshot,
  EndUserId,
  EnvironmentScope,
  EvalCriterion,
  EvalCriterionId,
  GoldenSet,
  GoldenSetId,
  JsonValue,
  MessageRating,
  MessageRatingId,
  RatingValue,
  SafetyAction,
  SafetyDetector,
  SafetyEvent,
  SafetyEventId,
  SafetySeverity,
  TenantScope,
  ThreadId,
  TurnId,
} from "@platos/context-governance/application/ports/index.js";
import {
  asGovernanceIdentifier,
  isSafetyAction,
  isSafetyDetector,
  isSafetySeverity,
} from "@platos/context-governance/application/ports/index.js";

import { UnreadableRowError } from "./mapping.js";

/** A stored safety detector this binary does not recognise. */
export const UNKNOWN_SAFETY_DETECTOR = "governance.row.unknown_safety_detector";

/** A stored safety action this binary does not recognise. */
export const UNKNOWN_SAFETY_ACTION = "governance.row.unknown_safety_action";

/** A stored safety severity this binary does not recognise. */
export const UNKNOWN_SAFETY_SEVERITY = "governance.row.unknown_safety_severity";

/** `SafetyEvent.metadata` holds an envelope this binary cannot decode. */
export const UNREADABLE_SAFETY_METADATA = "governance.row.unreadable_safety_metadata";

/** `AgentEval.criterionSnapshot` is not the seven-field frozen criterion. */
export const UNREADABLE_CRITERION_SNAPSHOT = "governance.row.unreadable_criterion_snapshot";

/** `AgentEval.costCents` is a `Decimal` the driver handed back unreadably. */
export const UNREADABLE_EVAL_COST = "governance.row.unreadable_eval_cost";

/** The discriminator that tells an envelope from a legacy attribute bag. */
export const SAFETY_METADATA_MARKER = "__governance";

/** Restrict a read to one environment. Every read in the five stores uses it. */
export function scopedWhere(scope: EnvironmentScope): { readonly environmentId: string } {
  return { environmentId: scope.environmentId };
}

/**
 * Restrict a read to the environments a TENANT scope reaches.
 *
 * An erasure addresses a subject at an organization, a project or an
 * environment, and every row here stores exactly one `environmentId`. The
 * containment is therefore a RELATION filter through `Environment` and
 * `Project`, resolved by the database in the SAME statement — not a widening
 * read of the tree followed by an `IN` list, which is the N+1 this shape is easy
 * to write by accident.
 */
export function tenantWhere(scope: TenantScope): Record<string, unknown> {
  if (scope.level === "environment") return { environmentId: scope.environmentId };
  if (scope.level === "project") return { environment: { projectId: scope.projectId } };
  return { environment: { project: { organizationId: scope.organizationId } } };
}

// ---------------------------------------------------------------- SafetyEvent

/** The stored shape of the three fields the canonical model has no column for. */
interface SafetyEnvelope {
  readonly attributes: Readonly<Record<string, JsonValue>> | null;
  readonly principalId: string | null;
  readonly rule: string | null;
  readonly detailTruncated: boolean;
}

export interface SafetyEventRow {
  readonly id: string;
  readonly environmentId: string;
  readonly agentId: string | null;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly endUserId: string | null;
  readonly detector: string;
  readonly action: string;
  readonly severity: string;
  readonly detail: string | null;
  readonly metadata: unknown;
  readonly toolName: string | null;
  readonly toolCallId: string | null;
  readonly createdAt: Date;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, column: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new UnreadableRowError(UNREADABLE_SAFETY_METADATA, column, String(value));
  }
  return value;
}

/**
 * Split a stored `metadata` column into the producer's attributes and the three
 * fields that ride with them.
 *
 * A column holding SQL NULL is a row with neither. A column holding an object
 * WITHOUT the marker is a legacy row: the whole object is the attributes and the
 * three carried fields take their absent values, which is what makes a row
 * written before this adapter existed readable by it.
 */
export function readSafetyEnvelope(metadata: unknown): SafetyEnvelope {
  if (metadata === null || metadata === undefined) {
    return { attributes: null, principalId: null, rule: null, detailTruncated: false };
  }
  if (!isObject(metadata)) {
    throw new UnreadableRowError(UNREADABLE_SAFETY_METADATA, "SafetyEvent.metadata", typeof metadata);
  }
  if (metadata[SAFETY_METADATA_MARKER] === undefined) {
    return {
      attributes: metadata as Readonly<Record<string, JsonValue>>,
      principalId: null,
      rule: null,
      detailTruncated: false,
    };
  }
  const attributes = metadata["attributes"];
  if (attributes !== null && attributes !== undefined && !isObject(attributes)) {
    throw new UnreadableRowError(
      UNREADABLE_SAFETY_METADATA,
      "SafetyEvent.metadata.attributes",
      typeof attributes,
    );
  }
  const truncated = metadata["detailTruncated"];
  if (truncated !== undefined && typeof truncated !== "boolean") {
    throw new UnreadableRowError(
      UNREADABLE_SAFETY_METADATA,
      "SafetyEvent.metadata.detailTruncated",
      String(truncated),
    );
  }
  return {
    attributes: (attributes ?? null) as Readonly<Record<string, JsonValue>> | null,
    principalId: optionalString(metadata["principalId"], "SafetyEvent.metadata.principalId"),
    rule: optionalString(metadata["rule"], "SafetyEvent.metadata.rule"),
    detailTruncated: truncated === true,
  };
}

/** The envelope an append writes. Always the marked shape; never a bare bag. */
export function writeSafetyEnvelope(event: AdmittedSafetyEvent): Record<string, JsonValue> {
  return {
    [SAFETY_METADATA_MARKER]: 1,
    attributes: (event.metadata ?? null) as JsonValue,
    principalId: event.principalId,
    rule: event.rule,
    detailTruncated: event.detailTruncated,
  };
}

export function readSafetyDetector(value: string): SafetyDetector {
  if (!isSafetyDetector(value)) {
    throw new UnreadableRowError(UNKNOWN_SAFETY_DETECTOR, "SafetyEvent.detector", value);
  }
  return value;
}

export function readSafetyAction(value: string): SafetyAction {
  if (!isSafetyAction(value)) {
    throw new UnreadableRowError(UNKNOWN_SAFETY_ACTION, "SafetyEvent.action", value);
  }
  return value;
}

export function readSafetySeverity(value: string): SafetySeverity {
  if (!isSafetySeverity(value)) {
    throw new UnreadableRowError(UNKNOWN_SAFETY_SEVERITY, "SafetyEvent.severity", value);
  }
  return value;
}

export function readSafetyEvent(row: SafetyEventRow): SafetyEvent {
  const envelope = readSafetyEnvelope(row.metadata);
  return {
    safetyEventId: asGovernanceIdentifier<SafetyEventId>(row.id),
    environmentId: row.environmentId,
    detector: readSafetyDetector(row.detector),
    action: readSafetyAction(row.action),
    severity: readSafetySeverity(row.severity),
    detail: row.detail,
    detailTruncated: envelope.detailTruncated,
    metadata: envelope.attributes,
    agentId: row.agentId === null ? null : asGovernanceIdentifier<AgentId>(row.agentId),
    threadId: row.threadId === null ? null : asGovernanceIdentifier<ThreadId>(row.threadId),
    turnId: row.turnId === null ? null : asGovernanceIdentifier<TurnId>(row.turnId),
    endUserId: row.endUserId === null ? null : asGovernanceIdentifier<EndUserId>(row.endUserId),
    principalId: envelope.principalId,
    toolName: row.toolName,
    toolCallId: row.toolCallId,
    rule: envelope.rule,
    createdAt: row.createdAt,
  };
}

// -------------------------------------------------------------- MessageRating

export interface MessageRatingRow {
  readonly id: string;
  readonly environmentId: string;
  readonly turnId: string;
  readonly agentId: string;
  readonly agentVersionId: string | null;
  readonly endUserId: string;
  readonly rating: number;
  readonly revision: number;
  readonly comment: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * A stored rating, carried through as the domain's `RatingValue`.
 *
 * NOT VALIDATED, and that is the one place in this file the asymmetry is
 * deliberate. `domain/rating.ts` declares `RatingValue = 1 | -1` and its own
 * `tally` counts anything else as `discarded` rather than refusing it, because
 * the source's five-star rows are real history — and `MessageRating_rating_check`
 * in the migrations admits exactly `1..5`, so those rows are the ONLY ones an
 * install can have. Refusing them here would make a satisfaction rollup
 * unreadable for exactly the installs that have data.
 */
export function readMessageRating(row: MessageRatingRow): MessageRating {
  return {
    messageRatingId: asGovernanceIdentifier<MessageRatingId>(row.id),
    environmentId: row.environmentId,
    turnId: asGovernanceIdentifier<TurnId>(row.turnId),
    agentId: asGovernanceIdentifier<AgentId>(row.agentId),
    agentVersionId:
      row.agentVersionId === null ? null : asGovernanceIdentifier<AgentVersionId>(row.agentVersionId),
    endUserId: asGovernanceIdentifier<EndUserId>(row.endUserId),
    rating: row.rating as RatingValue,
    revision: row.revision,
    comment: row.comment,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// -------------------------------------------------------------- EvalCriterion

export interface EvalCriterionRow {
  readonly id: string;
  readonly environmentId: string;
  readonly agentId: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly judgePrompt: string;
  readonly rubric: string | null;
  readonly judgeModel: string | null;
  readonly scoreScaleMin: number;
  readonly scoreScaleMax: number;
  readonly isActive: boolean;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function readCriterion(row: EvalCriterionRow): EvalCriterion {
  return {
    evalCriterionId: asGovernanceIdentifier<EvalCriterionId>(row.id),
    environmentId: row.environmentId,
    agentId: row.agentId === null ? null : asGovernanceIdentifier<AgentId>(row.agentId),
    name: row.name,
    description: row.description,
    judgePrompt: row.judgePrompt,
    rubric: row.rubric,
    judgeModel: row.judgeModel,
    scoreScaleMin: row.scoreScaleMin,
    scoreScaleMax: row.scoreScaleMax,
    isActive: row.isActive,
    createdBy: asGovernanceIdentifier<ActorId>(row.createdBy),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ------------------------------------------------------------------ AgentEval

export interface AgentEvalRow {
  readonly id: string;
  readonly environmentId: string;
  readonly agentId: string;
  readonly agentVersionId: string | null;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly criterionId: string;
  readonly criterionSnapshot: unknown;
  readonly judgeModel: string;
  readonly judgePromptUsed: string;
  readonly rawResponse: string | null;
  readonly score: number;
  readonly rationale: string | null;
  readonly passed: boolean;
  readonly costCents: unknown;
  readonly latencyMs: number | null;
  readonly createdAt: Date;
}

function snapshotString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string") {
    throw new UnreadableRowError(
      UNREADABLE_CRITERION_SNAPSHOT,
      `AgentEval.criterionSnapshot.${key}`,
      String(value),
    );
  }
  return value;
}

function snapshotNullableString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new UnreadableRowError(
      UNREADABLE_CRITERION_SNAPSHOT,
      `AgentEval.criterionSnapshot.${key}`,
      String(value),
    );
  }
  return value;
}

function snapshotNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new UnreadableRowError(
      UNREADABLE_CRITERION_SNAPSHOT,
      `AgentEval.criterionSnapshot.${key}`,
      String(value),
    );
  }
  return value;
}

/**
 * Decode the frozen criterion an eval carries.
 *
 * REFUSED RATHER THAN DEFAULTED, unlike the rating above, because the snapshot is
 * the whole reason an eval survives its criterion being edited or deleted. A
 * snapshot missing `scoreScaleMax` and defaulted to anything would re-render a
 * scale block different from the one a judge was actually shown, which is the
 * field an audit of a historical score turns on.
 */
export function readCriterionSnapshot(value: unknown): CriterionSnapshot {
  if (!isObject(value)) {
    throw new UnreadableRowError(UNREADABLE_CRITERION_SNAPSHOT, "AgentEval.criterionSnapshot", typeof value);
  }
  return {
    name: snapshotString(value, "name"),
    description: snapshotNullableString(value, "description"),
    judgePrompt: snapshotString(value, "judgePrompt"),
    rubric: snapshotNullableString(value, "rubric"),
    judgeModel: snapshotNullableString(value, "judgeModel"),
    scoreScaleMin: snapshotNumber(value, "scoreScaleMin"),
    scoreScaleMax: snapshotNumber(value, "scoreScaleMax"),
  };
}

/** The seven fields the snapshot column stores, and no eighth. */
export function writeCriterionSnapshot(snapshot: CriterionSnapshot): Record<string, JsonValue> {
  return {
    name: snapshot.name,
    description: snapshot.description,
    judgePrompt: snapshot.judgePrompt,
    rubric: snapshot.rubric,
    judgeModel: snapshot.judgeModel,
    scoreScaleMin: snapshot.scoreScaleMin,
    scoreScaleMax: snapshot.scoreScaleMax,
  };
}

/**
 * `AgentEval.costCents` — a `Decimal(18, 6)` the driver hands back as its own
 * decimal object rather than as a number.
 *
 * Converted through the value's own `toString`, because the alternative is
 * `Number(value)` on something that is a string, a number or a decimal depending
 * on driver version, and a silent `NaN` here would put a cost of nothing on an
 * eval that cost money.
 */
export function readEvalCost(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const text =
    typeof value === "string" || typeof value === "number"
      ? String(value)
      : isObject(value) && typeof value["toString"] === "function"
        ? (value as { toString(): string }).toString()
        : null;
  if (text === null) {
    throw new UnreadableRowError(UNREADABLE_EVAL_COST, "AgentEval.costCents", typeof value);
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    throw new UnreadableRowError(UNREADABLE_EVAL_COST, "AgentEval.costCents", text);
  }
  return parsed;
}

/**
 * `rawResponseTruncated` reads as FALSE, always, and that is a reported
 * limitation rather than a decision taken here.
 *
 * `domain/agent-eval.ts` puts the flag "on the ROW, not only on the admitted
 * draft", and the canonical model has no column for it and no metadata column to
 * carry one in: `criterionSnapshot` is the frozen criterion and has the fixed
 * seven-field shape written above, so widening it would corrupt the one field an
 * audit turns on. `append` therefore echoes the flag it was HANDED — the
 * writer's own knowledge — and every read of the same row afterwards answers
 * false. See the header of `governance-evals.ts`.
 */
export function readEval(row: AgentEvalRow): AgentEval {
  return {
    agentEvalId: asGovernanceIdentifier<AgentEvalId>(row.id),
    environmentId: row.environmentId,
    agentId: asGovernanceIdentifier<AgentId>(row.agentId),
    agentVersionId:
      row.agentVersionId === null ? null : asGovernanceIdentifier<AgentVersionId>(row.agentVersionId),
    threadId: asGovernanceIdentifier<ThreadId>(row.threadId),
    turnId: row.turnId === null ? null : asGovernanceIdentifier<TurnId>(row.turnId),
    criterionId: asGovernanceIdentifier<EvalCriterionId>(row.criterionId),
    criterionSnapshot: readCriterionSnapshot(row.criterionSnapshot),
    judgeModel: row.judgeModel,
    judgePromptUsed: row.judgePromptUsed,
    rawResponse: row.rawResponse,
    rawResponseTruncated: false,
    score: row.score,
    rationale: row.rationale,
    passed: row.passed,
    costCents: readEvalCost(row.costCents),
    latencyMs: row.latencyMs,
    createdAt: row.createdAt,
  };
}

// ------------------------------------------------------------------ GoldenSet

export interface GoldenSetRow {
  readonly id: string;
  readonly environmentId: string;
  readonly agentId: string;
  readonly name: string;
  readonly description: string | null;
  readonly threadIds: readonly string[];
  readonly criterionIds: readonly string[];
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function readGoldenSet(row: GoldenSetRow): GoldenSet {
  return {
    goldenSetId: asGovernanceIdentifier<GoldenSetId>(row.id),
    environmentId: row.environmentId,
    agentId: asGovernanceIdentifier<AgentId>(row.agentId),
    name: row.name,
    description: row.description,
    threadIds: row.threadIds.map((value) => asGovernanceIdentifier<ThreadId>(value)),
    criterionIds: row.criterionIds.map((value) => asGovernanceIdentifier<EvalCriterionId>(value)),
    createdBy: asGovernanceIdentifier<ActorId>(row.createdBy),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The columns a golden-set insert supplies. The id and stamps are the store's. */
export function writeGoldenSet(
  scope: EnvironmentScope,
  set: AdmittedGoldenSet,
  createdBy: ActorId,
): {
  readonly environmentId: string;
  readonly agentId: string;
  readonly name: string;
  readonly description: string | null;
  readonly threadIds: string[];
  readonly criterionIds: string[];
  readonly createdBy: string;
} {
  return {
    environmentId: scope.environmentId,
    agentId: set.agentId,
    name: set.name,
    description: set.description,
    threadIds: [...set.threadIds],
    criterionIds: [...set.criterionIds],
    createdBy,
  };
}
