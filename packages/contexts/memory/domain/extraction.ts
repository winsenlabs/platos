// Extraction: the rules that turn a finished conversation into durable memories.
//
// ADR M0.3 §1 row 8 states the boundary in the row itself: "Extraction initiated
// on a `TurnFinalized` event — never imports conversations." So everything this
// module knows about a conversation is a TRANSCRIPT and a list of turn ids that
// arrived on an event. There is no thread lookup here, no message model, and no
// type imported from the turn engine.
//
// THE POLICY IS PER AGENT AND EVERY FIELD IS CLAMPED. It arrives as free-form
// JSON out of an agent version's `memoryConfig`, which means it is operator
// input that has been through a database, and `resolveExtractionPolicy` treats
// it as such: an unreadable value falls back to the default field by field,
// never wholesale, so one bad number does not discard four good ones.
//
// THE JUDGE'S ANSWER IS UNTRUSTED TEXT. `parseJudgeEnvelope` reads it the way
// the source does — fenced block first, then the widest brace span, then the raw
// string — and every candidate is then re-admitted against the same kind rules a
// hand-written memory faces. A judge cannot write a memory this context would
// have refused from an operator.
//
// ORDERING IS BY CONFIDENCE, DESCENDING, AND THAT IS LOAD-BEARING. `maxPerSession`
// cuts the list, so an unsorted pass would keep whichever candidates the judge
// happened to emit first and drop better-attested ones. Ties keep the judge's
// order, which is stable.

import { err, ok, type JsonValue, type Result } from "@platos/kernel";

import { extractionEnvelopeInvalid } from "./errors.js";
import { ATOM_KINDS, isMemoryKind, type MemoryKind } from "./taxonomy.js";

/** The version stamped on every row this extractor writes. */
export const EXTRACTOR_VERSION = "v1";

export interface ExtractionPolicy {
  readonly enabled: boolean;
  /** Which kinds may be written. `profile` is never here — synthesis writes it. */
  readonly kinds: readonly MemoryKind[];
  readonly confidenceThreshold: number;
  readonly maxPerSession: number;
  readonly minMessagesBeforeRun: number;
}

export const DEFAULT_EXTRACTION_POLICY: ExtractionPolicy = Object.freeze({
  enabled: true,
  kinds: ATOM_KINDS,
  confidenceThreshold: 0.6,
  maxPerSession: 10,
  minMessagesBeforeRun: 6,
});

/**
 * Read an agent's stored policy, field by field.
 *
 * Every bound below is the source's. `kinds` is filtered to the four atom kinds
 * rather than validated as a whole: an operator who added `profile` to the list
 * gets the other four honoured, and `profile` silently dropped, because the
 * synthesized profile is written by consolidation and not by the judge.
 */
export function resolveExtractionPolicy(raw: unknown): ExtractionPolicy {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_EXTRACTION_POLICY;
  const stated = raw as Record<string, unknown>;
  const kinds = readKinds(stated["kinds"]);
  return {
    enabled: typeof stated["enabled"] === "boolean" ? stated["enabled"] : DEFAULT_EXTRACTION_POLICY.enabled,
    kinds: kinds.length > 0 ? kinds : DEFAULT_EXTRACTION_POLICY.kinds,
    confidenceThreshold: clampNumber(
      stated["confidenceThreshold"],
      0,
      1,
      DEFAULT_EXTRACTION_POLICY.confidenceThreshold,
    ),
    maxPerSession: clampWhole(stated["maxPerSession"], 1, 100, DEFAULT_EXTRACTION_POLICY.maxPerSession),
    minMessagesBeforeRun: clampWhole(
      stated["minMessagesBeforeRun"],
      1,
      200,
      DEFAULT_EXTRACTION_POLICY.minMessagesBeforeRun,
    ),
  };
}

/** Layer a per-call override on a stored policy, then re-clamp the result. */
export function overrideExtractionPolicy(
  base: ExtractionPolicy,
  override: Partial<ExtractionPolicy> | undefined,
): ExtractionPolicy {
  if (override === undefined) return base;
  return resolveExtractionPolicy({ ...base, ...override });
}

/**
 * How many turns of transcript the judge is shown.
 *
 * The source expresses the window in MESSAGES and then halves it, because a turn
 * carries one input and one output. The floor of 20 messages is what keeps a
 * conservative `minMessagesBeforeRun` from starving the judge of context;
 * the ceiling of 80 is what keeps a permissive one from running away with token
 * cost.
 */
export function transcriptWindow(policy: ExtractionPolicy): { messages: number; turns: number } {
  const messages = Math.max(Math.min(policy.minMessagesBeforeRun * 2, 80), 20);
  return { messages, turns: Math.ceil(messages / 2) };
}

/** One turn of transcript, as the `TurnFinalized` event carries it. */
export interface TranscriptTurn {
  readonly turnId: string;
  readonly sequence: number;
  readonly inputText: string | null;
  readonly outputText: string | null;
}

/** A present side of a turn is one message; an absent one is not. */
export function countMessages(turns: readonly TranscriptTurn[]): number {
  return turns.reduce(
    (count, turn) => count + (turn.inputText === null ? 0 : 1) + (turn.outputText === null ? 0 : 1),
    0,
  );
}

/**
 * Render the transcript the judge reads, oldest first.
 *
 * The store hands turns back newest-first (that is how a window is taken); the
 * judge needs them in the order they happened, or "then they changed their mind"
 * reads backwards.
 */
export function renderTranscript(turns: readonly TranscriptTurn[]): string {
  return [...turns]
    .sort((left, right) => left.sequence - right.sequence)
    .flatMap((turn) => [
      ...(turn.inputText === null ? [] : [`USER: ${turn.inputText}`]),
      ...(turn.outputText === null ? [] : [`ASSISTANT: ${turn.outputText}`]),
    ])
    .join("\n\n");
}

/** A memory the judge proposed, before any of this context's rules apply. */
export interface CandidateMemory {
  readonly kind: string;
  readonly content: string;
  readonly metadata: JsonValue | undefined;
  readonly confidence: number;
  readonly entityKeys: readonly string[];
}

export interface CandidateEntity {
  readonly entityKey: string;
  readonly label: string;
  readonly entityType: string;
  readonly aliases: readonly string[];
}

export interface CandidateRelationship {
  readonly from: string;
  readonly to: string;
  readonly relationshipType: string;
  readonly weight: number | null;
}

export interface JudgeEnvelope {
  readonly memories: readonly CandidateMemory[];
  readonly entities: readonly CandidateEntity[];
  readonly relationships: readonly CandidateRelationship[];
}

export const EMPTY_ENVELOPE: JudgeEnvelope = Object.freeze({
  memories: Object.freeze([]),
  entities: Object.freeze([]),
  relationships: Object.freeze([]),
});

/**
 * Read the judge's answer.
 *
 * Three readings are tried in order — a fenced code block, the widest brace
 * span, then the whole string — because a judge that was told to answer in JSON
 * still sometimes wraps it in prose or in a fence. An answer that parses to
 * something that is not an object is REFUSED rather than treated as empty: the
 * two are different outcomes, and a sweep that silently recorded "0 memories"
 * for a judge returning `"unavailable"` would look healthy while extracting
 * nothing.
 */
export function parseJudgeEnvelope(raw: string): Result<JudgeEnvelope> {
  for (const candidate of readingsOf(raw)) {
    const parsed = tryParse(candidate);
    if (parsed === undefined) continue;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const stated = parsed as Record<string, unknown>;
    return ok({
      memories: readArray(stated["memories"], readCandidateMemory),
      entities: readArray(stated["entities"], readCandidateEntity),
      relationships: readArray(stated["relationships"], readCandidateRelationship),
    });
  }
  return err(extractionEnvelopeInvalid("no JSON object could be read from the judge's answer"));
}

/** Why a candidate was not written. Reported per candidate, never aggregated away. */
export type CandidateRefusal = "below-threshold" | "kind-not-permitted" | "over-session-cap";

export interface AdmittedCandidate {
  readonly candidate: CandidateMemory;
  readonly kind: MemoryKind;
}

export interface CandidateSelection {
  readonly admitted: readonly AdmittedCandidate[];
  readonly refused: readonly { readonly candidate: CandidateMemory; readonly reason: CandidateRefusal }[];
}

/**
 * Choose which of a judge's candidates are written, in confidence order.
 *
 * The session cap is applied AFTER the threshold and the kind filter, so a
 * candidate the policy would never have written does not consume a slot that a
 * good one could have had. That ordering is the source's and it is the one that
 * makes `maxPerSession` mean "at most ten memories", not "at most ten
 * considered".
 */
export function selectCandidates(
  candidates: readonly CandidateMemory[],
  policy: ExtractionPolicy,
): CandidateSelection {
  const admitted: AdmittedCandidate[] = [];
  const refused: { candidate: CandidateMemory; reason: CandidateRefusal }[] = [];

  for (const candidate of byConfidenceDescending(candidates)) {
    if (candidate.confidence < policy.confidenceThreshold) {
      refused.push({ candidate, reason: "below-threshold" });
      continue;
    }
    const kind = candidate.kind.toLowerCase();
    if (!isMemoryKind(kind) || !policy.kinds.includes(kind)) {
      refused.push({ candidate, reason: "kind-not-permitted" });
      continue;
    }
    if (admitted.length >= policy.maxPerSession) {
      refused.push({ candidate, reason: "over-session-cap" });
      continue;
    }
    admitted.push({ candidate, kind });
  }
  return { admitted: Object.freeze(admitted), refused: Object.freeze(refused) };
}

/** Descending confidence, stable within a tie. Never mutates its input. */
export function byConfidenceDescending(
  candidates: readonly CandidateMemory[],
): readonly CandidateMemory[] {
  return [...candidates]
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) =>
      right.candidate.confidence !== left.candidate.confidence
        ? right.candidate.confidence - left.candidate.confidence
        : left.index - right.index,
    )
    .map((entry) => entry.candidate);
}

function readKinds(value: unknown): readonly MemoryKind[] {
  if (!Array.isArray(value)) return [];
  return value.filter((kind): kind is MemoryKind => isMemoryKind(kind) && ATOM_KINDS.includes(kind));
}

function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const numeric = Number(value ?? fallback);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(numeric, minimum), maximum);
}

function clampWhole(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const numeric = Number(value ?? fallback);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.floor(numeric), minimum), maximum);
}

function readingsOf(raw: string): readonly string[] {
  const readings: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]+?)\s*```/iu.exec(raw);
  if (fenced?.[1] !== undefined) readings.push(fenced[1]);
  const braced = /\{[\s\S]*\}/u.exec(raw);
  if (braced?.[0] !== undefined) readings.push(braced[0]);
  readings.push(raw);
  return readings;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function readArray<Value>(value: unknown, read: (row: Record<string, unknown>) => Value | null): readonly Value[] {
  if (!Array.isArray(value)) return [];
  const rows: Value[] = [];
  for (const row of value) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    const parsed = read(row as Record<string, unknown>);
    if (parsed !== null) rows.push(parsed);
  }
  return Object.freeze(rows);
}

function readCandidateMemory(row: Record<string, unknown>): CandidateMemory | null {
  const content = row["content"];
  if (typeof content !== "string") return null;
  const confidence = Number(row["confidence"]);
  return {
    kind: typeof row["kind"] === "string" ? row["kind"] : "fact",
    content,
    metadata: row["metadata"] as JsonValue | undefined,
    // A judge that omitted a confidence has stated nothing, and "nothing" must
    // not clear a threshold. Zero is the only reading that cannot.
    confidence: Number.isFinite(confidence) ? confidence : 0,
    entityKeys: readStrings(row["entities"]),
  };
}

function readCandidateEntity(row: Record<string, unknown>): CandidateEntity | null {
  const entityKey = typeof row["entityKey"] === "string" ? row["entityKey"] : "";
  const label = typeof row["name"] === "string" ? row["name"] : "";
  // Either half names the entity; the source derives the key from whichever is
  // present, so a judge that gave only a display name still produces a node.
  if (entityKey.length === 0 && label.length === 0) return null;
  return {
    entityKey: entityKey.length > 0 ? entityKey : label,
    label: label.length > 0 ? label : entityKey,
    entityType: typeof row["type"] === "string" ? row["type"] : "other",
    aliases: readStrings(row["aliases"]),
  };
}

function readCandidateRelationship(row: Record<string, unknown>): CandidateRelationship | null {
  const from = row["from"];
  const to = row["to"];
  const relationshipType = row["type"];
  if (typeof from !== "string" || typeof to !== "string" || typeof relationshipType !== "string") return null;
  const weight = Number(row["weight"]);
  return { from, to, relationshipType, weight: Number.isFinite(weight) ? weight : null };
}

function readStrings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return Object.freeze(value.filter((entry): entry is string => typeof entry === "string"));
}
