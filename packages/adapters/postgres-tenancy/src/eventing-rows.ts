// `NotificationRule` row -> aggregate mapping, and the two `where` shapes every
// read of this table narrows with.
//
// EVERY JSON COLUMN IS PARSED, NEVER CAST. `filters` and `delivery` are JSONB
// behind ONE constraint each, and both are on the ROOT only:
//
//   NotificationRule_filters_json_root   CHECK (jsonb_typeof("filters")  = 'object')
//   NotificationRule_delivery_json_root  CHECK (jsonb_typeof("delivery") = 'object')
//
// So the database guarantees the column is an object and guarantees nothing
// about a single field inside it. A store that cast `filters` to `RuleFilter`
// would put an arbitrary object into `ruleAdmits`, whose first act is to iterate
// `eventPatterns`; a store that cast `delivery` to `Destination` would hand the
// delivery adapter a `kind` outside the union, and the legacy `isRuleDelivery`
// default arm — "an unrecognised type is a refusal, not a pass-through" — would
// have been silently deleted by the refactor that was meant to preserve it. Both
// go through the context's own parsers, and a row this binary cannot read is an
// `UnreadableRowError` rather than a value outside its own type.
//
// `name` IS PARSED FOR THE SAME REASON AND IT IS THE LESS OBVIOUS ONE. The
// column is a plain `TEXT` with no length constraint at all; `domain/rule-name.ts`
// says so outright — "a column with no length constraint of its own means this
// predicate IS the constraint". The 1-120 bound therefore lives ONLY in the
// domain, and a row written by a binary that did not enforce it is readable as a
// string and unreadable as a `RuleName`.
//
// THE SCOPE IS ECHOED, AND THE ANCESTRY FILTER IS WHAT MAKES THAT TRUTHFUL.
// `NotificationRule` stores ONE tenancy column, `environmentId`; the aggregate
// carries a whole `EnvironmentScope`. Every read that returns a rule is given
// the scope by its caller, so the organization and project halves are echoed
// rather than selected — and that would be a lie if the read had narrowed on
// `environmentId` alone, because a caller holding the right environment id under
// the wrong project would get a rule tagged with an ancestry it does not have.
// `scopedWhere` walks the whole chain, exactly as the legacy
// `environmentScopeWhere` in apps/agent/src/shared/database.provider.ts does, so
// a row that comes back has PROVEN the triple the reader stamps on it.

import type {
  Destination,
  EnvironmentScope,
  NotificationRule,
  NotificationRuleId,
  PrincipalId,
  RuleFilter,
  RuleName,
  TenantScope,
} from "@platos/context-eventing/application/ports/index.js";
import {
  asIdentifier,
  parseDestination,
  parseRuleFilter,
  parseRuleName,
  toDestinationInput,
  toRuleFilterInput,
} from "@platos/context-eventing/application/ports/index.js";

import { UnreadableRowError } from "./mapping.js";

/** A stored `filters` column this binary cannot parse into a `RuleFilter`. */
export const EVENTING_FILTERS_UNREADABLE = "eventing.row.filters_unreadable";

/** A stored `delivery` column this binary cannot parse into a `Destination`. */
export const EVENTING_DELIVERY_UNREADABLE = "eventing.row.delivery_unreadable";

/** A stored `name` outside the 1-120 bound the column itself does not carry. */
export const EVENTING_NAME_UNREADABLE = "eventing.row.name_unreadable";

/**
 * The structural row this module maps. Deliberately NOT the generated type: see
 * the header of `mapping.ts` for why every mapper in this package takes one of
 * these and is checked against the generated shape at its call site instead.
 */
export interface NotificationRuleRow {
  readonly id: string;
  readonly environmentId: string;
  readonly name: string;
  readonly filters: unknown;
  readonly delivery: unknown;
  readonly enabled: boolean;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The columns every full read selects. One place, so no read is wider. */
export const NOTIFICATION_RULE_COLUMNS = {
  id: true,
  environmentId: true,
  name: true,
  filters: true,
  delivery: true,
  enabled: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

function readRuleName(value: string): RuleName {
  const parsed = parseRuleName(value);
  if (!parsed.ok) {
    throw new UnreadableRowError(EVENTING_NAME_UNREADABLE, "NotificationRule.name", value);
  }
  return parsed.value;
}

function describe(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

function readFilter(value: unknown): RuleFilter {
  const parsed = parseRuleFilter(value as never);
  if (!parsed.ok) {
    throw new UnreadableRowError(
      EVENTING_FILTERS_UNREADABLE,
      "NotificationRule.filters",
      describe(value),
    );
  }
  return parsed.value;
}

function readDestination(value: unknown): Destination {
  const parsed = parseDestination(value as never);
  if (!parsed.ok) {
    throw new UnreadableRowError(
      EVENTING_DELIVERY_UNREADABLE,
      "NotificationRule.delivery",
      describe(value),
    );
  }
  return parsed.value;
}

/**
 * One row, seen as the aggregate, under the scope the read PROVED.
 *
 * `scope` is the caller's own triple rather than one selected back out of the
 * tree, and it is honest only because `scopedWhere` below made the row's
 * membership of that triple a condition of it being returned at all.
 */
export function readNotificationRule(
  row: NotificationRuleRow,
  scope: EnvironmentScope,
): NotificationRule {
  return Object.freeze({
    ruleId: asIdentifier<NotificationRuleId>(row.id),
    scope,
    name: readRuleName(row.name),
    filter: readFilter(row.filters),
    destination: readDestination(row.delivery),
    enabled: row.enabled,
    createdBy: asIdentifier<PrincipalId>(row.createdBy),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

/** The `filters` column, as the domain's own write half spells it. */
export function writeFilter(filter: RuleFilter): Record<string, unknown> {
  return { ...toRuleFilterInput(filter) };
}

/** The `delivery` column, as the domain's own write half spells it. */
export function writeDestination(destination: Destination): Record<string, unknown> {
  return { ...toDestinationInput(destination) };
}

/**
 * Restrict a read to ONE environment, proving the whole ancestry.
 *
 * The relation filter is resolved by the database in the SAME statement — it is
 * an `EXISTS` over `Environment` and `Project`, not a second query — which is
 * why `eventing-statements.integration.test.ts` can pin every read at one
 * statement and require the same figure over a fixture an order of magnitude
 * larger.
 */
export function scopedWhere(scope: EnvironmentScope): Record<string, unknown> {
  return {
    environmentId: scope.environmentId,
    environment: {
      projectId: scope.projectId,
      project: { organizationId: scope.organizationId },
    },
  };
}

/**
 * Restrict a read to the environments a TENANT scope reaches.
 *
 * An erasure addresses a subject at an organization, a project or an
 * environment, and this table stores exactly one `environmentId`. The
 * containment is therefore a RELATION filter through `Environment` and
 * `Project`, resolved in one statement — not a widening read of the tree
 * followed by an `IN` list, which is the N+1 this shape is easy to write by
 * accident. It is the same predicate `EventingErasureSelector`'s own comment
 * describes: "an implementation resolves the selector by containment (the
 * kernel's `contains`) rather than by equality".
 */
export function tenantWhere(scope: TenantScope): Record<string, unknown> {
  if (scope.level === "environment") return scopedWhere(scope);
  if (scope.level === "project") {
    return {
      environment: {
        projectId: scope.projectId,
        project: { organizationId: scope.organizationId },
      },
    };
  }
  return { environment: { project: { organizationId: scope.organizationId } } };
}
