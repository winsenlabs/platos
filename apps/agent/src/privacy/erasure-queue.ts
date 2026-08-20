/**
 * Erasure queue — the state that makes an unsettled store resumable.
 *
 * THE DEFECT THIS EXISTS TO FIX
 *
 * A store that did not settle was abandoned. The receipt recorded it honestly
 * — `partial_failure`, with the failing store named — and then nothing ever
 * looked at that row again. `retryCount` was written but never read;
 * `canRetry` was written and never called. The only way to finish an erasure
 * was for a human to notice and POST the retry route by hand.
 *
 * Worse, that human had to supply the subject's external id, because the first
 * pass had already deleted the canonical PlatosEndUser row that resolves it. So
 * an operation whose Redis pass timed out at 03:00 could not be finished by any
 * automated thing at all: the one input required to resume it is the identifier
 * the system deliberately refuses to keep.
 *
 * And if the process died between creating the operation row and persisting the
 * receipt, the row sat at PENDING with `stores: []` forever — indistinguishable
 * from an erasure that was requested and never started.
 *
 * WHAT IS PERSISTED, AND WHY IT IS NOT THE IDENTIFIER
 *
 * The resume plan records the LOCATORS the first pass resolved, captured while
 * Postgres still held them: canonical PlatosEndUser ids, thread ids, scopes.
 * Those are internal surrogate keys. After the sweep they address no row, they
 * appear in no external system, and they cannot be used to reach the person —
 * which is exactly why the tombstone register can afford to hash them and the
 * queue can afford to keep them.
 *
 * The subject's external id is NOT persisted, and neither are object storage
 * keys (`storageKey` ends in the uploader's filename, which is content). So a
 * resume driven from the plan alone addresses less of the subject than the
 * first pass did:
 *
 *   Postgres    ToolCallAudit/SafetyEvent rows matched through the denormalized
 *               `__platosAudit` / `__platosSafety` JSON paths are keyed by the
 *               legacy external id.
 *   Redis       `cost:user:<scope>:<userId>:*` and `rl:day:…` likewise.
 *   ClickHouse  the `user_id` column likewise.
 *   MinIO       addressed only by endUserId — but the attachment rows carrying
 *               the object keys are gone, so nothing is addressable at all.
 *
 * COVERAGE, SO A NARROWER PASS CANNOT CERTIFY A WIDER SUBJECT
 *
 * This is the trap the whole module exists to avoid. A resume that runs with an
 * empty `legacyUserIds` deletes fewer rows AND verifies over a narrower WHERE —
 * so it would find zero survivors and report `passed`, certifying rows it never
 * looked for. That is rounding an unknown up to "gone", from a new direction.
 *
 * So every pass declares its coverage, and `demoteForCoverage` refuses to let a
 * `locators_only` pass mark a legacy-keyed store verified. It downgrades to
 * `unknown`, which keeps the operation open (see `deriveStatus`) and tells the
 * operator precisely what is missing. The queue still makes real progress —
 * deletes are re-issued, data is destroyed — it just cannot sign for it.
 *
 * The consequence is deliberate: an operation with an unsettled legacy-keyed
 * store is finished by an operator supplying the id, not by the queue. Between
 * "the queue can self-heal" and "the receipt never overstates", the second wins.
 *
 * ATTEMPTS AND LEASES
 *
 * Backoff is deterministic rather than jittered. These are rare, operator-
 * visible operations, not a high-fanout retry storm, and a predictable
 * `nextAttemptAt` is one an operator can reason about — and a test can assert.
 *
 * Every destructive pass runs under a lease, including the first one. That is
 * what makes retry idempotent: two concurrent resumes cannot both sweep, and a
 * pass whose process died leaves an expiring lease the queue reclaims rather
 * than a row nobody dares touch.
 *
 * Pure and dependency-free, like the rest of the decision logic here.
 */

import {
  type ErasureReceipt,
  type StoreName,
  type StoreOutcome,
} from "./erasure-receipt";
import type { SubjectKeys, SubjectScope } from "./subject-graph";

/** Attempts before the queue stops re-driving and leaves it for an operator. */
export const DEFAULT_MAX_ATTEMPTS = 8;
/** First retry delay; doubles per attempt. */
export const BASE_BACKOFF_MS = 60_000;
/** Ceiling, so a long-broken store is still retried roughly four times a day. */
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
/**
 * Lease lifetime. Comfortably longer than a sweep (bounded by the ClickHouse
 * mutation poll) and short enough that a crashed pass is reclaimed the same
 * hour rather than pinning the operation until someone notices.
 */
export const LEASE_TTL_MS = 15 * 60 * 1000;

/**
 * How much of the subject a pass could address.
 *
 * `full` — the caller supplied the external id, so every locator the first pass
 * had is available again.
 * `locators_only` — resumed from the persisted plan alone. Legacy-keyed rows
 * are out of reach; see COVERAGE above.
 */
export type ResumeCoverage = "full" | "locators_only";

/**
 * Stores whose subject is partly addressed by the legacy external id.
 *
 * MinIO is absent deliberately: it is keyed only by endUserId. Its own resume
 * problem is the lost object-key map, handled by `objectMapLost`.
 */
export const STORES_KEYED_BY_LEGACY_ID: StoreName[] = ["postgres", "redis", "clickhouse"];

/**
 * Everything a resume needs that the sweep is about to destroy.
 *
 * Versioned because it is a Json column: this codebase has already been bitten
 * by a Json column whose shape drifted from the type that reads it, so the
 * reader coerces at the boundary rather than trusting the write.
 */
export interface ErasureResumePlan {
  version: 1;
  /** Canonical PlatosEndUser ids — the anchor every store is addressed by. */
  platosEndUserIds: string[];
  /** Thread ids: Redis patterns and ClickHouse rows are keyed by them. */
  threadIds: string[];
  /** Scopes, for the scope-keyed Redis counters. */
  scopes: SubjectScope[];
  /**
   * Objects the inventory counted before anything ran.
   *
   * A count, not the keys: `storageKey` ends in the uploader's filename. Enough
   * to know a later pass that discovers nothing has lost the map rather than
   * proved the bucket clean.
   */
  attachmentObjects: number;
}

/** Attempt ceiling, overridable per deployment. */
export function maxAttempts(): number {
  const raw = Number(process.env.PLATOS_ERASURE_MAX_ATTEMPTS);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_MAX_ATTEMPTS;
  return Math.floor(raw);
}

/** Delay before attempt N+1, doubling and capped. */
export function backoffMs(attempts: number): number {
  const exponent = Math.max(0, Math.floor(attempts) - 1);
  // Cap the exponent too: 2 ** 1024 is Infinity, and Infinity * 0 is NaN.
  const scaled = BASE_BACKOFF_MS * 2 ** Math.min(exponent, 32);
  return Math.min(scaled, MAX_BACKOFF_MS);
}

/** True once the queue should stop re-driving and wait for an operator. */
export function isExhausted(attempts: number): boolean {
  return attempts >= maxAttempts();
}

/**
 * When the operation should next be picked up, or null when it should not be.
 *
 * Null is not "abandoned": the row keeps its receipt, its plan and its attempt
 * count, and the retry route still works. It only means the queue stops
 * re-driving something that has failed the same way eight times, because the
 * ninth automated attempt teaches nobody anything.
 */
export function scheduleAfterAttempt(
  receipt: ErasureReceipt,
  now: Date,
): { nextAttemptAt: Date | null; reason: "settled" | "blocked" | "exhausted" | "scheduled" } {
  if (receipt.status === "completed") return { nextAttemptAt: null, reason: "settled" };
  if (receipt.status === "blocked_legal_hold") return { nextAttemptAt: null, reason: "blocked" };
  if (isExhausted(receipt.attempts)) return { nextAttemptAt: null, reason: "exhausted" };
  return {
    nextAttemptAt: new Date(now.getTime() + backoffMs(receipt.attempts)),
    reason: "scheduled",
  };
}

/** Lease expiry for a pass starting now. */
export function leaseUntil(now: Date): Date {
  return new Date(now.getTime() + LEASE_TTL_MS);
}

/** Whether a lease is free to take. */
export function isLeaseFree(leaseExpiresAt: Date | null | undefined, now: Date): boolean {
  return !leaseExpiresAt || leaseExpiresAt.getTime() <= now.getTime();
}

/** Capture the locators, at the one moment they are all still resolvable. */
export function buildResumePlan(args: {
  subject: SubjectKeys;
  threadIds: string[];
  attachmentObjects: number;
}): ErasureResumePlan {
  return {
    version: 1,
    platosEndUserIds: [...args.subject.platosEndUserIds],
    threadIds: [...new Set(args.threadIds.filter(Boolean))].sort(),
    scopes: [...args.subject.scopes],
    attachmentObjects: Math.max(0, Math.trunc(args.attachmentObjects) || 0),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && !!v) : [];
}

/**
 * Read a plan back out of the Json column.
 *
 * Defensive on purpose. A Json? column can hold a bare string, a null, or an
 * older shape, and the caller here is a destructive path — a plan that parsed
 * into `undefined` fields would resume against an empty subject and, without
 * the emptiness guard in the orchestrator, report a clean sweep of nothing.
 */
export function resumePlanFrom(value: unknown): ErasureResumePlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) return null;
  const scopes = Array.isArray(raw.scopes)
    ? (raw.scopes as unknown[]).filter((s): s is SubjectScope => {
        if (!s || typeof s !== "object") return false;
        const scope = s as Record<string, unknown>;
        return (
          typeof scope.organizationId === "string" &&
          typeof scope.projectId === "string" &&
          typeof scope.environmentId === "string"
        );
      })
    : [];
  const attachments = Number(raw.attachmentObjects);
  return {
    version: 1,
    platosEndUserIds: stringArray(raw.platosEndUserIds),
    threadIds: stringArray(raw.threadIds),
    scopes,
    attachmentObjects: Number.isFinite(attachments) ? Math.max(0, Math.trunc(attachments)) : 0,
  };
}

/**
 * The subject a plan can address on its own.
 *
 * `legacyUserIds` is empty and stays empty — that absence is the whole reason
 * coverage exists, and filling it with anything (the hash, a placeholder) would
 * make the narrowed pass look complete to every executor downstream.
 */
export function subjectFromResumePlan(plan: ErasureResumePlan): SubjectKeys {
  return {
    platosEndUserIds: [...plan.platosEndUserIds],
    legacyUserIds: [],
    scopes: [...plan.scopes],
  };
}

/**
 * Downgrade a verification a narrowed pass was not entitled to make.
 *
 * Only `passed` is touched. A `failed` verification from a narrow pass is still
 * positive evidence that data survived — narrowing can only miss rows, never
 * invent them — and demoting it would discard the more serious finding.
 */
export function demoteForCoverage(outcome: StoreOutcome, coverage: ResumeCoverage): StoreOutcome {
  if (coverage === "full") return outcome;
  if (!STORES_KEYED_BY_LEGACY_ID.includes(outcome.store)) return outcome;
  if (outcome.verificationStatus !== "passed") return outcome;
  return {
    ...outcome,
    verificationStatus: "unknown",
    note: appendNote(
      outcome.note,
      "resumed without the subject id; rows keyed by the legacy id were not addressed",
    ),
  };
}

/**
 * A retry may not soften an earlier verification failure.
 *
 * `failed` is positive evidence that data survived a delete. A later pass that
 * comes back `unknown` — because the store was unreachable, or because it can
 * no longer address what it was asked about — has not refuted that evidence, it
 * has failed to gather any. Letting the weaker result overwrite the stronger
 * one would move the operation from `verification_failed` up to
 * `partial_failure` on the strength of learning nothing.
 *
 * A genuine `passed` DOES clear it: that is a fresh, positive probe proving
 * absence, which is exactly what a retry is for.
 */
export function preserveVerificationFailure(
  previous: StoreOutcome | undefined,
  next: StoreOutcome,
): StoreOutcome {
  if (previous?.verificationStatus !== "failed") return next;
  if (next.verificationStatus === "failed" || next.verificationStatus === "passed") return next;
  return {
    ...next,
    verificationStatus: "failed",
    note: appendNote(next.note, "earlier verification failure not refuted by this pass"),
  };
}

/**
 * True when a later pass has lost the map to the objects an earlier one saw.
 *
 * MinIO discovers object keys from `PlatosMessageAttachment` rows, and Postgres
 * deletes those rows in the same operation. So a retry finds zero rows whether
 * the bucket is clean or whether the keys simply became unknowable — and
 * "verified 0/0 objects absent" is the reassuring reading of the second case.
 *
 * The plan's object count is what tells the two apart.
 */
export function objectMapLost(plan: ErasureResumePlan | null, discoveredNow: number): boolean {
  return !!plan && plan.attachmentObjects > 0 && discoveredNow === 0;
}

/** Join a note fragment onto an existing note without losing either. */
export function appendNote(existing: string | undefined, addition: string): string {
  return existing ? `${existing}; ${addition}` : addition;
}
