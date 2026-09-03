// An in-memory `NotificationRuleRepository`.
//
// It is not a stub. It enforces the two invariants the real table enforces, and
// a use case that violates either fails here exactly as it would against
// Postgres:
//
//   - `@@unique([environmentId, name])`. `insertRule` and `updateRule` refuse a
//     name already held by a DIFFERENT rule in the same environment.
//   - SCOPE ISOLATION. Every read filters on the environment, so a rule from
//     another environment is `null` — absent, not forbidden-but-present.
//
// `failNext` is how a test drives the unavailable paths without a broken double
// per case.

import { err, ok, type EnvironmentScope, type Result, type TransactionScope } from "@platos/kernel";

import {
  repositoryUnavailable,
  ruleNameTaken,
  type NotificationRule,
  type NotificationRuleId,
  type RuleName,
} from "../../domain/index.js";
import type { EventingErasureSelector, NotificationRuleRepository } from "../ports/index.js";

function sameEnvironment(rule: NotificationRule, scope: EnvironmentScope): boolean {
  return (
    rule.scope.organizationId === scope.organizationId &&
    rule.scope.projectId === scope.projectId &&
    rule.scope.environmentId === scope.environmentId
  );
}

/**
 * Containment, for an erasure selector that may name an organization or a
 * project rather than an environment. Mirrors the kernel's `contains` without
 * importing a scope it would have to synthesise.
 */
function withinSelector(rule: NotificationRule, selector: EventingErasureSelector): boolean {
  const { scope } = selector;
  if (rule.scope.organizationId !== scope.organizationId) return false;
  if (scope.level === "organization") return true;
  if (rule.scope.projectId !== scope.projectId) return false;
  if (scope.level === "project") return true;
  return rule.scope.environmentId === scope.environmentId;
}

export class InMemoryNotificationRuleRepository implements NotificationRuleRepository {
  private readonly rules = new Map<NotificationRuleId, NotificationRule>();
  private failure: string | null = null;
  readonly transactions: TransactionScope[] = [];

  /**
   * Every name this double was asked to look up, in order.
   *
   * `assertNameFree` in update-notification-rule.ts short-circuits a re-PUT of
   * the rule's OWN name before it reaches the store, and that shortcut's only
   * observable effect is the read it avoids — remove it and the result is
   * identical, one query later. Without this record the line is an equivalent
   * mutant and cannot be pinned at all.
   */
  readonly nameLookups: RuleName[] = [];

  /**
   * Run just before `findRuleByName` answers, so a test can model a CONCURRENT
   * WRITER that changed the table between a use case's two reads.
   *
   * That interleaving is the whole reason `assertNameFree` compares rule ids
   * rather than trusting the lookup to miss: the row it finds under the new
   * name can be the caller's OWN row, already renamed by someone else. It is
   * unreachable from a double that only ever answers from a settled store, so
   * it is offered here rather than left as an argument in a comment.
   */
  beforeFindRuleByName: (() => void) | null = null;

  /** Make the NEXT call fail with EVENTING_REPOSITORY_UNAVAILABLE. */
  failNext(reason = "injected"): void {
    this.failure = reason;
  }

  private takeFailure(): string | null {
    const reason = this.failure;
    this.failure = null;
    return reason;
  }

  allRules(): readonly NotificationRule[] {
    return [...this.rules.values()];
  }

  /** Seed a row without going through a use case. */
  seed(rule: NotificationRule): void {
    this.rules.set(rule.ruleId, rule);
  }

  private nameClash(rule: NotificationRule): boolean {
    for (const existing of this.rules.values()) {
      if (existing.ruleId === rule.ruleId) continue;
      if (sameEnvironment(existing, rule.scope) && existing.name === rule.name) return true;
    }
    return false;
  }

  async insertRule(rule: NotificationRule, transaction: TransactionScope): Promise<Result<NotificationRule>> {
    const reason = this.takeFailure();
    if (reason !== null) return err(repositoryUnavailable(reason));
    this.transactions.push(transaction);
    if (this.nameClash(rule)) return err(ruleNameTaken(rule.name));
    this.rules.set(rule.ruleId, rule);
    return ok(rule);
  }

  async updateRule(rule: NotificationRule, transaction: TransactionScope): Promise<Result<NotificationRule>> {
    const reason = this.takeFailure();
    if (reason !== null) return err(repositoryUnavailable(reason));
    this.transactions.push(transaction);
    if (this.nameClash(rule)) return err(ruleNameTaken(rule.name));
    this.rules.set(rule.ruleId, rule);
    return ok(rule);
  }

  async deleteRule(
    scope: EnvironmentScope,
    ruleId: NotificationRuleId,
    transaction: TransactionScope,
  ): Promise<Result<boolean>> {
    const reason = this.takeFailure();
    if (reason !== null) return err(repositoryUnavailable(reason));
    this.transactions.push(transaction);
    const existing = this.rules.get(ruleId);
    if (existing === undefined || !sameEnvironment(existing, scope)) return ok(false);
    this.rules.delete(ruleId);
    return ok(true);
  }

  async findRule(
    scope: EnvironmentScope,
    ruleId: NotificationRuleId,
  ): Promise<Result<NotificationRule | null>> {
    const reason = this.takeFailure();
    if (reason !== null) return err(repositoryUnavailable(reason));
    const existing = this.rules.get(ruleId);
    if (existing === undefined || !sameEnvironment(existing, scope)) return ok(null);
    return ok(existing);
  }

  async findRuleByName(scope: EnvironmentScope, name: RuleName): Promise<Result<NotificationRule | null>> {
    this.nameLookups.push(name);
    this.beforeFindRuleByName?.();
    const reason = this.takeFailure();
    if (reason !== null) return err(repositoryUnavailable(reason));
    for (const rule of this.rules.values()) {
      if (sameEnvironment(rule, scope) && rule.name === name) return ok(rule);
    }
    return ok(null);
  }

  /** Newest first, matching the legacy `orderBy: { createdAt: "desc" }`. */
  async listRules(scope: EnvironmentScope): Promise<Result<readonly NotificationRule[]>> {
    const reason = this.takeFailure();
    if (reason !== null) return err(repositoryUnavailable(reason));
    const matching = [...this.rules.values()].filter((rule) => sameEnvironment(rule, scope));
    matching.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    return ok(matching);
  }

  async listEnabledRules(scope: EnvironmentScope): Promise<Result<readonly NotificationRule[]>> {
    const reason = this.takeFailure();
    if (reason !== null) return err(repositoryUnavailable(reason));
    return ok([...this.rules.values()].filter((rule) => sameEnvironment(rule, scope) && rule.enabled));
  }

  async countRulesForSubject(selector: EventingErasureSelector): Promise<Result<number>> {
    const reason = this.takeFailure();
    if (reason !== null) return err(repositoryUnavailable(reason));
    if (selector.principalId === null) return ok(0);
    return ok(this.matchingSubject(selector).length);
  }

  async anonymizeRulesForSubject(
    selector: EventingErasureSelector,
    replacement: string,
    transaction: TransactionScope,
  ): Promise<Result<number>> {
    const reason = this.takeFailure();
    if (reason !== null) return err(repositoryUnavailable(reason));
    this.transactions.push(transaction);
    if (selector.principalId === null) return ok(0);
    const matching = this.matchingSubject(selector);
    for (const rule of matching) {
      this.rules.set(rule.ruleId, {
        ...rule,
        createdBy: replacement as NotificationRule["createdBy"],
      });
    }
    return ok(matching.length);
  }

  private matchingSubject(selector: EventingErasureSelector): readonly NotificationRule[] {
    return [...this.rules.values()].filter(
      (rule) => withinSelector(rule, selector) && rule.createdBy === selector.principalId,
    );
  }
}
