// The safety ledger's row, and the vocabulary it is written in.
//
// ADR M0.3 §1 row 14 makes this context the SOLE WRITER of `SafetyEvent`. Two
// producers reach it — the enforcement layer through the kernel
// `SafetyEventSink` (§3, the `auth -> monitoring` inversion) and this context's
// own use case — and BOTH land here, so the ledger has one admission rule rather
// than one per caller.
//
// THE THREE VOCABULARY COLUMNS ARE CLOSED SETS AND AN UNKNOWN VALUE IS REFUSED.
// `detector`, `action` and `severity` are `String` columns in the schema and the
// source writes whatever it is handed. That is what makes the governance
// dashboard's rollups quietly wrong: `summary()` counts by the raw string, so a
// producer that writes `"PII"` or `"blocked"` creates a second bucket that looks
// like a second phenomenon. The three sets below are the vocabulary the running
// system actually emits, and a value outside one is refused with its own code —
// three codes, because a caller that got the detector wrong and a caller that
// got the severity wrong have different bugs.
//
// THE DETAIL IS TRUNCATED, NOT REFUSED, AND THAT ASYMMETRY IS THE POINT. A
// safety signal must never fail a request (the kernel port says so in as many
// words), so an over-long `detail` loses its tail and keeps its row, and the row
// says `detailTruncated` so a reader knows it is looking at a prefix. An unknown
// detector cannot be handled that way: there is no truthful prefix of a wrong
// bucket, and writing it would corrupt every rollup taken afterwards.
//
// `endUserId` IS NEVER WRITTEN, AND THAT IS THE SOURCE'S DECISION KEPT. The
// column is a foreign key to `EndUser.id`; the identifier a producer has in hand
// is the caller's external subject, which is not that uuid. The source records
// the reason in a comment and writes null. Here the subject is carried in
// `principalId` — a field of this domain entity, persisted into the row's
// metadata adapter by the repository — so the erasure target can still find a
// subject's events without the write path forging a foreign key.

import { err, ok, type JsonValue, type Result } from "@platos/kernel";

import {
  safetyActionUnknown,
  safetyDetectorUnknown,
  safetySeverityUnknown,
} from "./errors.js";
import type { AgentId, EndUserId, SafetyEventId, ThreadId, TurnId } from "./identifiers.js";
import type { SafetyPolicy } from "./policy.js";

/**
 * The detectors the running system emits.
 *
 * `rate_limit` and `budget` are here because the enforcement layer was given its
 * own two rather than being aliased onto `exfiltration`, which carried a
 * misleading semantic; `dispatcher_permission_gate` is emitted by the optional
 * four-tier tool-dispatch gate.
 */
export const SAFETY_DETECTORS = [
  "pii",
  "injection",
  "grounded",
  "exfiltration",
  "tool_param",
  "rate_limit",
  "budget",
  "dispatcher_permission_gate",
] as const;

export type SafetyDetector = (typeof SAFETY_DETECTORS)[number];

/** What the detector did about it. */
export const SAFETY_ACTIONS = ["flag", "redact", "block", "warn"] as const;

export type SafetyAction = (typeof SAFETY_ACTIONS)[number];

export const SAFETY_SEVERITIES = ["low", "medium", "high"] as const;

export type SafetySeverity = (typeof SAFETY_SEVERITIES)[number];

export function isSafetyDetector(value: string): value is SafetyDetector {
  return (SAFETY_DETECTORS as readonly string[]).includes(value);
}

export function isSafetyAction(value: string): value is SafetyAction {
  return (SAFETY_ACTIONS as readonly string[]).includes(value);
}

export function isSafetySeverity(value: string): value is SafetySeverity {
  return (SAFETY_SEVERITIES as readonly string[]).includes(value);
}

/** What a producer hands the ledger. Every field is still untrusted. */
export interface SafetyEventDraft {
  readonly detector: string;
  readonly action: string;
  readonly severity: string;
  readonly detail?: string | null;
  readonly metadata?: Readonly<Record<string, JsonValue>> | null;
  readonly agentId?: AgentId | null;
  readonly threadId?: ThreadId | null;
  readonly turnId?: TurnId | null;
  /** The caller's own subject. NOT `SafetyEvent.endUserId`; see the header. */
  readonly principalId?: string | null;
  readonly toolName?: string | null;
  readonly toolCallId?: string | null;
  /** The dotted rule identity, when the event came through the kernel sink. */
  readonly rule?: string | null;
}

/** A draft that passed admission. The shape the repository persists. */
export interface AdmittedSafetyEvent {
  readonly detector: SafetyDetector;
  readonly action: SafetyAction;
  readonly severity: SafetySeverity;
  readonly detail: string | null;
  readonly detailTruncated: boolean;
  readonly metadata: Readonly<Record<string, JsonValue>> | null;
  readonly agentId: AgentId | null;
  readonly threadId: ThreadId | null;
  readonly turnId: TurnId | null;
  readonly principalId: string | null;
  readonly toolName: string | null;
  readonly toolCallId: string | null;
  readonly rule: string | null;
}

/** One stored row. `endUserId` is the column, and it is always null on write. */
export interface SafetyEvent extends AdmittedSafetyEvent {
  readonly safetyEventId: SafetyEventId;
  readonly environmentId: string;
  readonly endUserId: EndUserId | null;
  readonly createdAt: Date;
}

/**
 * Admit a draft into the ledger's vocabulary.
 *
 * The three vocabulary checks run in a fixed order — detector, then action, then
 * severity — so a draft breaking two of them reports the first, deterministically.
 */
export function admitSafetyEvent(draft: SafetyEventDraft, policy: SafetyPolicy): Result<AdmittedSafetyEvent> {
  if (!isSafetyDetector(draft.detector)) return err(safetyDetectorUnknown(draft.detector));
  if (!isSafetyAction(draft.action)) return err(safetyActionUnknown(draft.action));
  if (!isSafetySeverity(draft.severity)) return err(safetySeverityUnknown(draft.severity));

  const detail = truncateDetail(draft.detail ?? null, policy.maxDetailLength);
  return ok({
    detector: draft.detector,
    action: draft.action,
    severity: draft.severity,
    detail: detail.value,
    detailTruncated: detail.truncated,
    metadata: draft.metadata ?? null,
    agentId: draft.agentId ?? null,
    threadId: draft.threadId ?? null,
    turnId: draft.turnId ?? null,
    principalId: draft.principalId ?? null,
    toolName: draft.toolName ?? null,
    toolCallId: draft.toolCallId ?? null,
    rule: draft.rule ?? null,
  });
}

function truncateDetail(
  detail: string | null,
  maximum: number,
): { readonly value: string | null; readonly truncated: boolean } {
  if (detail === null) return { value: null, truncated: false };
  if (detail.length <= maximum) return { value: detail, truncated: false };
  return { value: detail.slice(0, maximum), truncated: true };
}
