// The `NotificationRuleRepository` port — the canonical store, seen only as an
// interface.
//
// ADR M0.3 §1 makes this context the SOLE WRITER of `NotificationRule`. This
// port is where that ownership is expressed: every mutation of the table in the
// V1 system passes through one of the methods below, and there is deliberately
// no generic `save(row)` or `query(where)` escape hatch through which another
// context could reach it sideways.
//
// EVERY READ IS SCOPED. There is no `findRule(id)`. There is
// `findRule(scope, id)`, and an implementation MUST return `null` — not a row
// from another environment — when the id exists elsewhere. The legacy service
// achieves this by spreading `environmentScopeWhere(scope)` into every `where`
// and using `findFirst` rather than `findUnique`; making the scope a required
// parameter is the same rule, enforced by the compiler instead of by remembering.
//
// EVERY MUTATION TAKES A `TransactionScope`. The kernel's handle is opaque by
// construction (ADR M0.3 §3: no context passes a vendor transaction handle
// across a port).
//
// Every method returns `Result`. A rejected promise is a defect, not an outcome.

import type { EnvironmentScope, Result, TenantScope, TransactionScope } from "@platos/kernel";

import type { NotificationRule, NotificationRuleId, RuleName } from "../../domain/index.js";

/**
 * What identifies the subject of an erasure inside this context's rows.
 *
 * `scope` is a full `TenantScope`, not an `EnvironmentScope`: an erasure may be
 * addressed at an organization, and `NotificationRule` is environment-keyed
 * underneath one, so an implementation resolves the selector by containment (the
 * kernel's `contains`) rather than by equality.
 *
 * There is one column and it is `createdBy`. See `eventing-erasure-target.ts`
 * for why that makes the method `anonymize` rather than `delete`.
 */
export interface EventingErasureSelector {
  readonly scope: TenantScope;
  /** Matches `NotificationRule.createdBy`; null when the subject cannot be one. */
  readonly principalId: string | null;
}

export interface NotificationRuleRepository {
  insertRule(rule: NotificationRule, transaction: TransactionScope): Promise<Result<NotificationRule>>;

  updateRule(rule: NotificationRule, transaction: TransactionScope): Promise<Result<NotificationRule>>;

  deleteRule(
    scope: EnvironmentScope,
    ruleId: NotificationRuleId,
    transaction: TransactionScope,
  ): Promise<Result<boolean>>;

  findRule(scope: EnvironmentScope, ruleId: NotificationRuleId): Promise<Result<NotificationRule | null>>;

  /** The `@@unique([environmentId, name])` lookup, for pre-flighting a conflict. */
  findRuleByName(scope: EnvironmentScope, name: RuleName): Promise<Result<NotificationRule | null>>;

  /** Newest first, matching the legacy `orderBy: { createdAt: "desc" }`. */
  listRules(scope: EnvironmentScope): Promise<Result<readonly NotificationRule[]>>;

  /**
   * The routing read. Narrowed to enabled rules in the STORE, which is what the
   * legacy `where: { ...scope, enabled: true }` does — a routing pass over a
   * busy environment must not load every disabled rule to discard it in memory.
   * `ruleAdmits` re-checks `enabled` anyway, so the two cannot disagree.
   */
  listEnabledRules(scope: EnvironmentScope): Promise<Result<readonly NotificationRule[]>>;

  countRulesForSubject(selector: EventingErasureSelector): Promise<Result<number>>;

  /** Overwrite `createdBy` on every matching row. Returns the number rewritten. */
  anonymizeRulesForSubject(
    selector: EventingErasureSelector,
    replacement: string,
    transaction: TransactionScope,
  ): Promise<Result<number>>;
}
