// What the real database refuses, checked BEFORE the statement is sent.
//
// WHY BEFORE. On PostgreSQL a statement that violates a constraint ABORTS the
// enclosing transaction: every later statement fails with 25P02 until the block
// ends. Four of this port's nine methods take the CALLER's `TransactionScope`,
// and `eventing-erasure-target.ts` counts a subject's rules and then scrubs them
// inside the caller's unit of work — a multi-context erasure, so the transaction
// it runs in belongs to `privacy` and carries other contexts' writes. A store
// that let a malformed identifier raise would have reported its own refusal
// correctly and left every other target unable to write anything. `cost-guards.ts`
// and `governance-guards.ts` found the same thing on the same database; the
// answer is the same. Refuse in TypeScript, send nothing, keep the transaction.
//
// EVERY GUARD BELOW IS A CONSTRAINT THAT EXISTS ONLY IN THE MIGRATIONS OR ONLY
// IN THE COLUMN TYPE, AND THAT THE CONTEXT'S OWN IN-MEMORY DOUBLE DOES NOT HOLD.
//
//   `@db.Uuid` on `NotificationRule.id` and `NotificationRule.environmentId`,
//   and on `Project.id` and `Organization.id`, which the ancestry filter in
//   `eventing-rows.ts` names. `application/testing/fixtures.ts` mints
//   `testEnvironmentScope()` as the triple `org-1` / `proj-1` / `env-1` and
//   `SequenceIdGenerator` mints rule ids as `id-0001`. Not one of those four is
//   a uuid; every one is accepted by `InMemoryNotificationRuleRepository`, and
//   EVERY use-case suite in `packages/contexts/eventing` passes with them. This
//   is the same shape tranche 3 found in tenancy's `InvitationTokenIssuer`.
//
//   A NUL BYTE IN ANY TEXT OR JSON VALUE. PostgreSQL cannot store `U+0000` in a
//   `TEXT` column or inside a `jsonb` string — the driver reports
//   `invalid byte sequence` — and NOTHING in this context refuses one.
//   `parseRuleName` bounds a name at 1-120 UTF-16 code units and says outright
//   that "whitespace is NOT trimmed"; `"\u0000"` is one code unit, so it is a
//   LEGAL `RuleName` and a legal rule that the canonical store cannot hold. The
//   same is true of `createdBy`, of a slack/webhook `url` (`nonEmptyString` asks
//   only for length), of an `email` (the domain's own comment records that the
//   rule "really is just contains @") and of a `pagerduty` integration key.
//
//   `timestamp(3)` ON `createdAt` AND `updatedAt`. `createNotificationRule` and
//   `editNotificationRule` stamp both from `Clock.now()`, and a clock that
//   answers `new Date(NaN)` — or a caller that built a rule from a parsed date
//   that did not parse — produces an Invalid Date that the driver refuses with a
//   message naming neither the column nor the port call.
//
//   `NotificationRule_filters_json_root` and `NotificationRule_delivery_json_root`,
//   both `CHECK (jsonb_typeof(...) = 'object')`. `toRuleFilterInput` and
//   `toDestinationInput` return objects today, so these two guards RESTATE a
//   constraint the write half already satisfies — which is exactly why they are
//   here rather than trusted: the CHECK is the authority, the write half is one
//   edit away from an array or a scalar, and the failure mode of that edit is an
//   aborted transaction in somebody else's erasure rather than a refusal.
//
// EVERY REFUSAL HAS ITS OWN CODE. Two guards sharing one code cannot be told
// apart in a log, which is how two defects hid behind one code in `privacy` and
// in `identity-access`. The context's error catalogue publishes ONE code for a
// store failure — `EVENTING_REPOSITORY_UNAVAILABLE` — so the distinction lives
// in `details.reason`, which `eventing-refusal.ts` builds with the code LEADING
// the human detail.

import type {
  Destination,
  NotificationRule,
  RuleFilter,
  TenantScope,
} from "@platos/context-eventing/application/ports/index.js";

import { writeDestination, writeFilter } from "./eventing-rows.js";

/** An identifier bound for a `@db.Uuid` column that is not a uuid. */
export const EVENTING_IDENTIFIER_NOT_UUID = "eventing.write.identifier_not_uuid";

/** A text or JSON value carrying `U+0000`, which no PostgreSQL string can hold. */
export const EVENTING_TEXT_HAS_NUL = "eventing.write.text_has_nul";

/** An instant that is not a finite `Date` a `timestamp(3)` column can hold. */
export const EVENTING_INSTANT_NOT_STORABLE = "eventing.write.instant_not_storable";

/** A `filters` value whose JSON root would not be an object. */
export const EVENTING_FILTERS_NOT_OBJECT = "eventing.write.filters_not_object";

/** A `delivery` value whose JSON root would not be an object. */
export const EVENTING_DELIVERY_NOT_OBJECT = "eventing.write.delivery_not_object";

export class EventingWriteRefused extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "EventingWriteRefused";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The canonical 8-4-4-4-12 form, case-insensitive, with the variant nibble left
 * unchecked.
 *
 * PostgreSQL's own `uuid` input is LOOSER than this — it accepts braces and
 * hyphenless forms — and the looseness is deliberately not copied. A store that
 * admitted `{...}` would write a row whose id is one string on the way in and
 * another on the way out, and every equality this context does on a rule id is a
 * string comparison in TypeScript.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function guardUuid(label: string, value: string): void {
  if (!UUID.test(value)) {
    throw new EventingWriteRefused(
      EVENTING_IDENTIFIER_NOT_UUID,
      `${label} must be a uuid; received ${JSON.stringify(value)}`,
    );
  }
}

/** Every tenancy id a scope names, in the order the ancestry filter uses them. */
export function guardScope(scope: TenantScope): void {
  guardUuid("scope.organizationId", scope.organizationId);
  if (scope.level === "organization") return;
  guardUuid("scope.projectId", scope.projectId);
  if (scope.level === "project") return;
  guardUuid("scope.environmentId", scope.environmentId);
}

function guardNoNul(label: string, value: string): void {
  if (value.includes("\u0000")) {
    throw new EventingWriteRefused(
      EVENTING_TEXT_HAS_NUL,
      `${label} carries U+0000, which no PostgreSQL text or jsonb value can hold`,
    );
  }
}

function guardInstant(label: string, value: Date): void {
  const millis = value.getTime();
  if (!Number.isFinite(millis)) {
    throw new EventingWriteRefused(
      EVENTING_INSTANT_NOT_STORABLE,
      `${label} is not a finite instant a timestamp(3) column can hold`,
    );
  }
}

/**
 * Walk a destination for NUL bytes. Every arm carries exactly one string, and
 * every one of the four is a `TEXT`-shaped value inside the `delivery` JSONB.
 */
function guardDestinationText(destination: Destination): void {
  if (destination.kind === "email") return guardNoNul("delivery.email", destination.email);
  if (destination.kind === "pagerduty") {
    return guardNoNul("delivery.integrationKey", destination.integrationKey);
  }
  guardNoNul("delivery.url", destination.url);
}

/**
 * Walk a filter for NUL bytes. Both halves are string arrays inside `filters`,
 * and a `jsonb` string is exactly as unable to hold `U+0000` as a `TEXT` is.
 */
function guardFilterText(filter: RuleFilter): void {
  for (const pattern of filter.eventPatterns) guardNoNul("filters.eventTypes[]", pattern);
  for (const subjectId of filter.subjectIds) guardNoNul("filters.subjectIds[]", subjectId);
}

function guardJsonObject(code: string, label: string, value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EventingWriteRefused(
      code,
      `${label} must be a JSON object root; ${label}_json_root refuses anything else`,
    );
  }
}

/**
 * `NotificationRule_filters_json_root`, restated in front of the statement.
 *
 * EXPORTED, UNLIKE THE OTHER GUARDS IN THIS FILE, and that is a consequence of
 * the acceptance rather than a convenience. Every guard here has to be
 * FALSIFIABLE by a named case, and this one cannot be reached through the port
 * at all: `toRuleFilterInput` returns an object on every path the domain can
 * build. So the case calls it directly, which is the only honest way to build
 * the input — the same arrangement `skills-guards.ts` reached for when a guard
 * was unreachable through its own port. What stands behind it is proved
 * separately, by a raw INSERT in `eventing-constraints.integration.test.ts`.
 */
export function guardFiltersJsonRoot(value: unknown): void {
  guardJsonObject(EVENTING_FILTERS_NOT_OBJECT, "filters", value);
}

/** `NotificationRule_delivery_json_root`, restated. Exported for the same reason. */
export function guardDeliveryJsonRoot(value: unknown): void {
  guardJsonObject(EVENTING_DELIVERY_NOT_OBJECT, "delivery", value);
}

/**
 * Everything a full row write binds, in one place.
 *
 * Both `insertRule` and `updateRule` take a whole `NotificationRule`, so one
 * guard covers both paths rather than two that drift.
 */
export function guardNotificationRuleWrite(rule: NotificationRule): void {
  guardUuid("rule.ruleId", rule.ruleId);
  guardScope(rule.scope);
  guardNoNul("rule.name", rule.name);
  guardNoNul("rule.createdBy", rule.createdBy);
  guardFilterText(rule.filter);
  guardDestinationText(rule.destination);
  guardInstant("rule.createdAt", rule.createdAt);
  guardInstant("rule.updatedAt", rule.updatedAt);
  guardFiltersJsonRoot(writeFilter(rule.filter));
  guardDeliveryJsonRoot(writeDestination(rule.destination));
}

/**
 * A rule name bound for the `TEXT` column, or for a LOOKUP against it.
 *
 * The read half matters as much as the write half here. `findRuleByName` sends
 * the name as a bind parameter of a SELECT, and a NUL in a bind parameter is
 * refused by the driver before the row is compared — inside whatever transaction
 * the caller has open, which is exactly the 25P02 this file exists to keep out
 * of somebody else's unit of work.
 */
export function guardNotificationRuleName(name: string): void {
  guardNoNul("name", name);
}

/** The replacement an erasure writes into `createdBy`. */
export function guardReplacementPrincipal(replacement: string): void {
  guardNoNul("replacement", replacement);
}
