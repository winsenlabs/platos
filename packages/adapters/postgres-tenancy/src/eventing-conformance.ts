// One scenario, written once, so `InMemoryNotificationRuleRepository` and this
// adapter can be asked the SAME questions and their answers compared.
//
// Same instrument as `./conformance.ts`, `./identity-conformance.ts` and the
// tranche-5 scenarios beside them, and the same reason: two independently
// written suites measure two things and agree by coincidence. This module drives
// one sequence of port calls and records what came back; a test runs it twice and
// compares verbatim. A divergence is then a named step with a value on each side.
//
// EVERY IDENTIFIER IS SUPPLIED BY THE CALLER AND EVERY ONE IS A REAL UUID. That
// is not tidiness. `NotificationRule.id` and `NotificationRule.environmentId` are
// `@db.Uuid`, and so are `Project.id` and `Organization.id`, which the ancestry
// filter names — while this context's own `SequenceIdGenerator` mints `id-0001`
// and `testEnvironmentScope()` mints the triple `org-1`/`proj-1`/`env-1`. All
// four satisfy the double and all four are refused by PostgreSQL. The scenario
// uses values BOTH stores accept, so a divergence here is a BEHAVIOUR difference
// rather than a shape difference; the shape refusals have their own named cases
// in `eventing-constraints.integration.test.ts`.
//
// INSTANTS ARE COMPARED LITERALLY, WHICH IS UNUSUAL AND IS THE POINT. The other
// scenarios in this package project dates out, because their stores MINT them.
// This one does not mint anything: `createNotificationRule` and
// `editNotificationRule` stamp `createdAt` and `updatedAt` from the context's own
// `Clock`, and both stores are handed the finished aggregate. So the instants are
// the caller's own literals on both sides, and carrying them is what proves the
// claim that matters most on the erasure path — that scrubbing `createdBy` does
// NOT move `updatedAt`, which the `@updatedAt` column would have done through
// any delegate write.
//
// EVERY REFUSING CALL IS ALONE IN ITS TRANSACTION, and here that is load-bearing
// rather than defensive. The duplicate-name insert below is refused by the
// `@@unique([environmentId, name])` index, and on PostgreSQL a violated
// constraint ABORTS the enclosing transaction — every later statement fails with
// 25P02 until the block ends. A scenario that wrote the refused row and carried
// on in the same unit of work would measure that abort rather than the refusal it
// meant to.
//
// ONE ORDER IS NORMALISED AND IT IS SAID OUT LOUD. `listEnabledRules` has no
// `orderBy` in the legacy source, none here, and no promise of one in the port —
// so the two stores return the same SET in whatever order each finds natural.
// The observation sorts it by `ruleId`, which is a normalisation of something
// neither store claims. `listRules` is NOT normalised: the port promises "newest
// first" and the scenario registers at distinct instants so the promise is total.

import type {
  Destination,
  EnvironmentScope,
  EventingErasureSelector,
  NotificationRule,
  NotificationRuleId,
  NotificationRuleRepository,
  PrincipalId,
  Result,
  RuleFilterInput,
  RuleName,
  TenantScope,
  TransactionScope,
} from "@platos/context-eventing/application/ports/index.js";
import {
  asIdentifier,
  createNotificationRule,
  parseDestination,
  parseRuleFilter,
  parseRuleName,
} from "@platos/context-eventing/application/ports/index.js";
import type { NotResult } from "@platos/context-eventing/application/ports/index.js";
import { runResult } from "@platos/context-eventing/application/ports/index.js";

export type EventingObservation = Record<string, unknown>;

/** Every identifier the scenario needs. All uuids; both stores use the same. */
export interface EventingConformanceIds {
  readonly alphaRuleId: string;
  readonly betaRuleId: string;
  readonly siblingRuleId: string;
  readonly cousinRuleId: string;
  readonly foreignRuleId: string;
  readonly bystanderRuleId: string;
  readonly duplicateRuleId: string;
  readonly missingRuleId: string;
}

export interface EventingConformanceEnvironment {
  readonly repository: NotificationRuleRepository;
  /** The environment under test. */
  readonly scope: EnvironmentScope;
  /** A SECOND environment of the SAME project. */
  readonly sibling: EnvironmentScope;
  /** An environment of a SECOND PROJECT in the SAME organization. */
  readonly cousin: EnvironmentScope;
  /** An environment of a whole SECOND organization. */
  readonly foreign: EnvironmentScope;
  readonly ids: EventingConformanceIds;
  /** Open one transaction. The fake's stand-in, or the adapter's unit of work. */
  run<Value>(work: (transaction: TransactionScope) => Promise<NotResult<Value>>): Promise<Value>;
}

/** The operator every scenario rule is registered by, and the erasure subject. */
export const CONFORMANCE_OPERATOR = "operator-a";

/** An operator who registered nothing. The zero-row half of the erasure plan. */
export const CONFORMANCE_BYSTANDER = "operator-b";

/** What a scrubbed `createdBy` reads as. `eventing-erasure-target.ts`'s literal. */
export const CONFORMANCE_ERASED = "erased:subject-removed";

/** The one instant every rule is created at, plus an offset per rule. */
const EPOCH = Date.parse("2026-06-01T09:00:00.000Z");

function instant(offsetSeconds: number): Date {
  return new Date(EPOCH + offsetSeconds * 1000);
}

function must<Value>(result: Result<Value>, what: string): Value {
  if (!result.ok) throw new Error(`the scenario's own fixture must parse: ${what}`);
  return result.value;
}

function filterOf(input: RuleFilterInput) {
  return must(parseRuleFilter(input), "filters");
}

function destinationOf(raw: Record<string, unknown>): Destination {
  return must(parseDestination(raw), "delivery");
}

function nameOf(raw: string): RuleName {
  return must(parseRuleName(raw), `name ${raw}`);
}

/**
 * Build one rule at a stated instant.
 *
 * The whole aggregate is minted HERE rather than inside either store, which is
 * what makes the two comparable at all: the port takes a finished
 * `NotificationRule`, so a scenario that let each side build its own would be
 * comparing two fixtures rather than two stores.
 */
function ruleAt(
  ruleId: string,
  scope: EnvironmentScope,
  name: string,
  offsetSeconds: number,
  options: {
    readonly filters?: RuleFilterInput;
    readonly delivery?: Record<string, unknown>;
    readonly createdBy?: string;
  } = {},
): NotificationRule {
  return createNotificationRule(
    {
      ruleId: asIdentifier<NotificationRuleId>(ruleId),
      scope,
      name: nameOf(name),
      filter: filterOf(options.filters ?? { eventTypes: ["run.completed", "budget.*"] }),
      destination: destinationOf(options.delivery ?? { type: "slack", url: "https://hooks.example/x" }),
      createdBy: asIdentifier<PrincipalId>(options.createdBy ?? CONFORMANCE_OPERATOR),
    },
    instant(offsetSeconds),
  );
}

/** Everything the port promises about one rule, and nothing it does not. */
function observeRule(rule: NotificationRule | null): unknown {
  if (rule === null) return null;
  return {
    ruleId: String(rule.ruleId),
    organizationId: String(rule.scope.organizationId),
    projectId: String(rule.scope.projectId),
    environmentId: String(rule.scope.environmentId),
    name: String(rule.name),
    eventPatterns: rule.filter.eventPatterns.map(String),
    subjectIds: rule.filter.subjectIds.map(String),
    destination: rule.destination,
    enabled: rule.enabled,
    createdBy: String(rule.createdBy),
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}

function observe(result: Result<NotificationRule | null>): unknown {
  return result.ok ? observeRule(result.value) : { error: result.error.code };
}

function observeList(result: Result<readonly NotificationRule[]>): unknown {
  return result.ok ? result.value.map((rule) => observeRule(rule)) : { error: result.error.code };
}

/** `listEnabledRules` promises a SET, so its observation is ordered by id. */
function observeUnorderedList(result: Result<readonly NotificationRule[]>): unknown {
  if (!result.ok) return { error: result.error.code };
  return [...result.value]
    .sort((left, right) => (left.ruleId < right.ruleId ? -1 : 1))
    .map((rule) => observeRule(rule));
}

function observeCount(result: Result<number>): unknown {
  return result.ok ? result.value : { error: result.error.code };
}

function observeFlag(result: Result<boolean>): unknown {
  return result.ok ? result.value : { error: result.error.code };
}

function selectorFor(scope: TenantScope, principalId: string | null): EventingErasureSelector {
  return { scope, principalId: principalId === null ? null : asIdentifier<PrincipalId>(principalId) };
}

/** Widen an environment scope to the project and to the organization above it. */
function widened(scope: EnvironmentScope): { project: TenantScope; organization: TenantScope } {
  return {
    project: { level: "project", organizationId: scope.organizationId, projectId: scope.projectId },
    organization: { level: "organization", organizationId: scope.organizationId },
  };
}

export async function runEventingConformance(
  environment: EventingConformanceEnvironment,
): Promise<Record<string, unknown>> {
  const { repository, scope, sibling, cousin, foreign, ids } = environment;
  const observed: Record<string, unknown> = {};
  const record = (step: string, value: unknown): void => {
    observed[step] = value;
  };

  record("emptyBefore", observeList(await repository.listRules(scope)));

  const alpha = ruleAt(ids.alphaRuleId, scope, "alpha", 0);
  const beta = ruleAt(ids.betaRuleId, scope, "beta", 60, {
    filters: { eventTypes: ["run.*"], subjectIds: ["run-77"] },
    delivery: { type: "webhook", url: "https://ops.example/hook" },
  });
  // The SAME name in a SECOND environment of the same project. The unique index
  // is `(environmentId, name)`, so this must succeed — and a store that had
  // narrowed it to `name` alone would fail here rather than in production.
  const siblingAlpha = ruleAt(ids.siblingRuleId, sibling, "alpha", 30, {
    delivery: { type: "email", email: "ops@example.test" },
  });
  // The SAME name again, in a SECOND PROJECT of the SAME organization. It is
  // what makes a PROJECT-level erasure distinguishable from an
  // organization-level one: without it every row the organization reaches is
  // also a row its only project reaches.
  const cousinAlpha = ruleAt(ids.cousinRuleId, cousin, "alpha", 40, {
    delivery: { type: "slack", url: "https://hooks.example/cousin" },
  });
  const foreignAlpha = ruleAt(ids.foreignRuleId, foreign, "alpha", 45, {
    delivery: { type: "pagerduty", integrationKey: "pd-key-1" },
  });
  // A rule ANOTHER operator registered, inside the environment the erasure is
  // about to sweep. Without it the `createdBy` clause of the containment join
  // changes no answer anything asks for, and an erasure that scrubbed every row
  // in the environment would pass every other case here.
  const bystanderRule = ruleAt(ids.bystanderRuleId, sibling, "bystander", 50, {
    createdBy: CONFORMANCE_BYSTANDER,
  });

  record("insertAlpha", observe(await runResult(environment, (t) => repository.insertRule(alpha, t))));
  record("insertBeta", observe(await runResult(environment, (t) => repository.insertRule(beta, t))));
  record(
    "insertSiblingSameName",
    observe(await runResult(environment, (t) => repository.insertRule(siblingAlpha, t))),
  );
  record(
    "insertCousinSameName",
    observe(await runResult(environment, (t) => repository.insertRule(cousinAlpha, t))),
  );
  record(
    "insertForeignSameName",
    observe(await runResult(environment, (t) => repository.insertRule(foreignAlpha, t))),
  );
  record(
    "insertBystanderRule",
    observe(await runResult(environment, (t) => repository.insertRule(bystanderRule, t))),
  );

  // ALONE IN ITS TRANSACTION. The unique index refuses it, and a refused
  // statement leaves the block aborted on PostgreSQL.
  const duplicate = ruleAt(ids.duplicateRuleId, scope, "alpha", 90);
  record(
    "insertDuplicateName",
    observe(await runResult(environment, (t) => repository.insertRule(duplicate, t))),
  );

  record("findAlpha", observe(await repository.findRule(scope, alpha.ruleId)));
  record("findAlphaInSibling", observe(await repository.findRule(sibling, alpha.ruleId)));
  record("findAlphaInForeign", observe(await repository.findRule(foreign, alpha.ruleId)));
  record(
    "findMissing",
    observe(await repository.findRule(scope, asIdentifier<NotificationRuleId>(ids.missingRuleId))),
  );

  record("findByNameAlpha", observe(await repository.findRuleByName(scope, nameOf("alpha"))));
  record("findByNameInSibling", observe(await repository.findRuleByName(sibling, nameOf("alpha"))));
  record("findByNameAbsent", observe(await repository.findRuleByName(scope, nameOf("gamma"))));

  record("listNewestFirst", observeList(await repository.listRules(scope)));
  record("listSibling", observeList(await repository.listRules(sibling)));

  // Disable beta and rename it. `editNotificationRule` stamps a NEW `updatedAt`
  // and leaves `createdAt` where it was; both are compared literally below.
  const editedBeta: NotificationRule = {
    ...beta,
    name: nameOf("beta-renamed"),
    enabled: false,
    updatedAt: instant(120),
  };
  record("updateBeta", observe(await runResult(environment, (t) => repository.updateRule(editedBeta, t))));
  record("findBetaAfterUpdate", observe(await repository.findRule(scope, beta.ruleId)));
  record("listEnabled", observeUnorderedList(await repository.listEnabledRules(scope)));

  // A rename onto a name a SIBLING ROW already holds, in the same environment.
  const collidingBeta: NotificationRule = { ...editedBeta, name: nameOf("alpha") };
  record(
    "updateOntoTakenName",
    observe(await runResult(environment, (t) => repository.updateRule(collidingBeta, t))),
  );

  // THE COUNTS ARE TAKEN AFTER THE DELETES, so the plan a caller would build is
  // the plan for the tree as it then stands rather than for one two writes ago.
  record(
    "deleteInWrongScope",
    observeFlag(await runResult(environment, (t) => repository.deleteRule(sibling, alpha.ruleId, t))),
  );
  record(
    "deleteAlpha",
    observeFlag(await runResult(environment, (t) => repository.deleteRule(scope, alpha.ruleId, t))),
  );
  record(
    "deleteAlphaAgain",
    observeFlag(await runResult(environment, (t) => repository.deleteRule(scope, alpha.ruleId, t))),
  );
  record("findAlphaAfterDelete", observe(await repository.findRule(scope, alpha.ruleId)));

  const { project, organization } = widened(scope);
  record(
    "countAtEnvironment",
    observeCount(await repository.countRulesForSubject(selectorFor(scope, CONFORMANCE_OPERATOR))),
  );
  record(
    "countAtProject",
    observeCount(await repository.countRulesForSubject(selectorFor(project, CONFORMANCE_OPERATOR))),
  );
  record(
    "countAtOrganization",
    observeCount(
      await repository.countRulesForSubject(selectorFor(organization, CONFORMANCE_OPERATOR)),
    ),
  );
  record(
    "countBystander",
    observeCount(
      await repository.countRulesForSubject(selectorFor(organization, CONFORMANCE_BYSTANDER)),
    ),
  );
  record(
    "countVacuousSubject",
    observeCount(await repository.countRulesForSubject(selectorFor(organization, null))),
  );

  // *** THE ERASURE WIDENS IN THREE STEPS, AND EACH ONE PROVES A CLAUSE. ***
  // The containment join in `eventing-erasure.ts` binds the project and the
  // environment as NULL when the level does not name them, so all three levels
  // are one statement — and a statement that had dropped a clause would scrub
  // more than it was asked to. Sweeping narrowest-first is what makes each
  // clause observable on its own: after the environment step the sibling must
  // still be intact, after the project step the cousin must be, and after the
  // organization step the foreign one must be.
  record(
    "anonymizeVacuousSubject",
    observeCount(
      await runResult(environment, (t) =>
        repository.anonymizeRulesForSubject(selectorFor(organization, null), CONFORMANCE_ERASED, t),
      ),
    ),
  );
  record(
    "anonymizeAtEnvironment",
    observeCount(
      await runResult(environment, (t) =>
        repository.anonymizeRulesForSubject(
          selectorFor(scope, CONFORMANCE_OPERATOR),
          CONFORMANCE_ERASED,
          t,
        ),
      ),
    ),
  );
  record("listAfterEnvironmentErasure", observeList(await repository.listRules(scope)));
  record("siblingAfterEnvironmentErasure", observeList(await repository.listRules(sibling)));

  record(
    "anonymizeAtProject",
    observeCount(
      await runResult(environment, (t) =>
        repository.anonymizeRulesForSubject(
          selectorFor(project, CONFORMANCE_OPERATOR),
          CONFORMANCE_ERASED,
          t,
        ),
      ),
    ),
  );
  record("siblingAfterProjectErasure", observeList(await repository.listRules(sibling)));
  record("cousinAfterProjectErasure", observeList(await repository.listRules(cousin)));

  record(
    "anonymizeAtOrganization",
    observeCount(
      await runResult(environment, (t) =>
        repository.anonymizeRulesForSubject(
          selectorFor(organization, CONFORMANCE_OPERATOR),
          CONFORMANCE_ERASED,
          t,
        ),
      ),
    ),
  );
  record("cousinAfterOrganizationErasure", observeList(await repository.listRules(cousin)));
  record("foreignAfterOrganizationErasure", observeList(await repository.listRules(foreign)));
  record(
    "countAfterErasure",
    observeCount(
      await repository.countRulesForSubject(selectorFor(organization, CONFORMANCE_OPERATOR)),
    ),
  );
  // The bystander's rule sat inside every one of the three sweeps and is
  // untouched, which is the `createdBy` clause stated as an observation.
  record(
    "bystanderAfterErasure",
    observeCount(
      await repository.countRulesForSubject(selectorFor(organization, CONFORMANCE_BYSTANDER)),
    ),
  );

  return observed;
}
