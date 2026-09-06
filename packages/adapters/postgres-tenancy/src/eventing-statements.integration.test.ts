// Statement counts for the `eventing` store, MEASURED — the N+1 control.
//
// Every pin below is a number this suite observed rather than a number somebody
// expected, and every read is measured TWICE: once over a small environment and
// once over one an order of magnitude larger. What matters is not the figure but
// that the figure DOES NOT MOVE with the number of rows. An N+1 does not announce
// itself in a suite — every value is correct and every test passes — it announces
// itself as a routing pass that took four seconds because the environment had
// forty rules.
//
// *** THE TWO SHAPES THIS CONTEXT COULD EASILY HAVE MADE N+1 ***
// The ancestry filter and the erasure containment both reach through
// `Environment` and `Project` to answer a question about `NotificationRule`,
// which stores neither. Written as "read the environments this scope reaches,
// then query the rules by `IN` list" both would have been two statements — and
// the second would have grown a statement per environment for an organization
// erasure. `scopedWhere` and `tenantWhere` are RELATION filters the database
// resolves in the same statement, and the raw anonymisation is a JOIN rather
// than a loop. The pairs below are what prove it.
//
// THE PROBE FILTER IS ANCHORED, AND THE ANCHOR IS THE POINT. The driver's
// connection probe is exactly `SELECT 1`, and a filter written as a SUBSTRING
// match would discard any statement containing it — which is how tranche 3
// measured an advisory lock at ZERO statements. The pattern below matches the
// whole statement, and the case at the end asserts that not one measured
// statement of this store would have been swallowed by it.

import { afterAll, beforeAll, expect, test } from "vitest";

import type {
  NotificationRule,
  NotificationRuleId,
  PrincipalId,
  TenantScope,
} from "@platos/context-eventing/application/ports/index.js";
import {
  asIdentifier,
  createNotificationRule,
  parseDestination,
  parseRuleFilter,
  parseRuleName,
} from "@platos/context-eventing/application/ports/index.js";

import {
  startEventingHarness,
  type EventingHarness,
  type EventingTenant,
} from "./eventing-harness.js";

let harness: EventingHarness;
/** One rule. */
let small: EventingTenant;
/** Twenty rules. */
let large: EventingTenant;

let smallRule: NotificationRule;
let largeRule: NotificationRule;

const HEAVY = 20;
const OPERATOR = "operator-a";

let sequence = 0;
function freshRuleId(): string {
  sequence += 1;
  return `cdcdcdcd-0001-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function ruleFor(scope: NotificationRule["scope"], name: string): NotificationRule {
  const filter = parseRuleFilter({ eventTypes: ["run.completed"] });
  const destination = parseDestination({ type: "slack", url: "https://hooks.example/x" });
  const parsedName = parseRuleName(name);
  if (!filter.ok || !destination.ok || !parsedName.ok) throw new Error("fixture must parse");
  return createNotificationRule(
    {
      ruleId: asIdentifier<NotificationRuleId>(freshRuleId()),
      scope,
      name: parsedName.value,
      filter: filter.value,
      destination: destination.value,
      createdBy: asIdentifier<PrincipalId>(OPERATOR),
    },
    new Date("2026-06-01T09:00:00.000Z"),
  );
}

function queries(): readonly string[] {
  return harness
    .statements()
    .filter(
      (statement) =>
        !/^\s*(BEGIN|COMMIT|ROLLBACK|DEALLOCATE)\s*$/iu.test(statement) &&
        !/^\s*SELECT 1\s*$/iu.test(statement),
    );
}

/**
 * Let the client's `query` events arrive.
 *
 * The event is emitted ASYNCHRONOUSLY, after the call has resolved, and a count
 * taken in the same tick can miss the last statement — which is not merely a
 * measurement that reads low: the missed event lands in the NEXT measurement's
 * array, so one pin reads one short and the pin after it reads one long.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

async function measure(work: () => Promise<unknown>): Promise<number> {
  await settle();
  harness.resetStatements();
  await work();
  await settle();
  return queries().length;
}

async function seed(tenant: EventingTenant, name: string): Promise<NotificationRule> {
  const rule = ruleFor(tenant.scope, name);
  const written = await harness.run((transaction) => harness.repository.insertRule(rule, transaction));
  if (!written.ok) throw new Error(`the fixture must register: ${name}`);
  return rule;
}

function organizationOf(tenant: EventingTenant): TenantScope {
  return { level: "organization", organizationId: asIdentifier(tenant.organizationId) };
}

beforeAll(async () => {
  harness = await startEventingHarness();
  small = await harness.freshTenant();
  large = await harness.freshTenant();
  smallRule = await seed(small, "only");
  largeRule = await seed(large, "first");
  for (let index = 1; index < HEAVY; index += 1) {
    await seed(large, `rule-${String(index).padStart(3, "0")}`);
  }
}, 600_000);

afterAll(async () => {
  await harness?.stop();
});

interface Pair {
  small: number;
  large: number;
}

async function measureAll(): Promise<Record<string, Pair>> {
  const both = async (
    work: (tenant: EventingTenant, rule: NotificationRule) => Promise<unknown>,
  ): Promise<Pair> => ({
    small: await measure(() => work(small, smallRule)),
    large: await measure(() => work(large, largeRule)),
  });

  return {
    findRule: await both((tenant, rule) => harness.repository.findRule(tenant.scope, rule.ruleId)),
    findRuleByName: await both((tenant, rule) =>
      harness.repository.findRuleByName(tenant.scope, rule.name),
    ),
    listRules: await both((tenant) => harness.repository.listRules(tenant.scope)),
    listEnabledRules: await both((tenant) => harness.repository.listEnabledRules(tenant.scope)),
    countRulesForSubject: await both((tenant) =>
      harness.repository.countRulesForSubject({
        scope: tenant.scope,
        principalId: OPERATOR,
      }),
    ),
    countRulesAtOrganization: await both((tenant) =>
      harness.repository.countRulesForSubject({
        scope: organizationOf(tenant),
        principalId: OPERATOR,
      }),
    ),
    // A subject with no principal selects nothing, and BOTH erasure methods
    // answer zero without sending a statement. Pinned at ZERO rather than left
    // out: a store that fell through to the query would still answer zero — the
    // column is NOT NULL, so `createdBy: null` matches no row — and would cost a
    // round trip per target on every erasure of an end-user or an entity.
    countVacuousSubject: await both((tenant) =>
      harness.repository.countRulesForSubject({
        scope: organizationOf(tenant),
        principalId: null,
      }),
    ),
    anonymizeVacuousSubject: await both((tenant) =>
      harness.run((transaction) =>
        harness.repository.anonymizeRulesForSubject(
          { scope: organizationOf(tenant), principalId: null },
          "erased:subject-removed",
          transaction,
        ),
      ),
    ),
    insertRule: await both((tenant) =>
      harness.run((transaction) =>
        harness.repository.insertRule(ruleFor(tenant.scope, `measured-${freshRuleId()}`), transaction),
      ),
    ),
    updateRule: await both((tenant, rule) =>
      harness.run((transaction) =>
        harness.repository.updateRule({ ...rule, enabled: rule.enabled }, transaction),
      ),
    ),
    anonymizeAtOrganization: await both((tenant) =>
      harness.run((transaction) =>
        harness.repository.anonymizeRulesForSubject(
          { scope: organizationOf(tenant), principalId: "nobody-at-all" },
          "erased:subject-removed",
          transaction,
        ),
      ),
    ),
    deleteRule: await both((tenant) =>
      harness.run((transaction) =>
        harness.repository.deleteRule(
          tenant.scope,
          asIdentifier<NotificationRuleId>("cdcdcdcd-9999-4000-8000-999999999999"),
          transaction,
        ),
      ),
    ),
  };
}

test("every statement count is pinned and NONE of them moves with the number of rows", async () => {
  const measured = await measureAll();
  expect(measured).toEqual(PINS);
  for (const [method, counts] of Object.entries(measured)) {
    expect({ method, sameAcrossFixtures: counts.small === counts.large }).toEqual({
      method,
      sameAcrossFixtures: true,
    });
  }
}, 600_000);

test("the two ZERO pins are the only ones, and every other method sends a statement", async () => {
  // A zero pin is the one figure this suite can produce by not measuring at all,
  // so it is stood beside the assertion that nothing ELSE is zero. Without this,
  // a harness that stopped recording statements would satisfy every pair above
  // by turning all of them into { small: 0, large: 0 }.
  const measured = await measureAll();
  const zeroes = Object.entries(measured)
    .filter(([, counts]) => counts.small === 0)
    .map(([method]) => method)
    .sort();
  expect(zeroes).toEqual(["anonymizeVacuousSubject", "countVacuousSubject"]);
}, 600_000);

test("the LARGE fixture really is larger, or the pairs above prove nothing", async () => {
  // The control for the control. Two identical fixtures would satisfy every
  // `small === large` assertion above and measure nothing at all.
  const listed = await harness.repository.listRules(large.scope);
  const one = await harness.repository.listRules(small.scope);
  expect(listed.ok && one.ok && listed.value.length >= HEAVY).toBe(true);
  expect(listed.ok && one.ok && listed.value.length > one.value.length * 5).toBe(true);
}, 300_000);

test("the probe filter did not swallow a statement this store sent", async () => {
  // Trap 4, stated as a case. A statement-count suite whose filter discards the
  // thing it measures reports ZERO and passes — which is how tranche 3 measured
  // an advisory lock at zero statements.
  await settle();
  harness.resetStatements();
  await harness.repository.listRules(small.scope);
  await settle();
  const swallowed = harness.statements().filter((statement) => /^\s*SELECT 1\s*$/iu.test(statement));
  const measured = queries();
  expect(measured.length).toBeGreaterThan(0);
  // Every statement this store sends names the table, so none of them is the
  // bare probe — and the filter is anchored, so one that merely CONTAINED
  // `SELECT 1` would still be counted.
  expect(swallowed.every((statement) => statement.trim().toUpperCase() === "SELECT 1")).toBe(true);
  expect(measured.some((statement) => /"NotificationRule"/u.test(statement))).toBe(true);
}, 300_000);

test("the ancestry filter is resolved IN the statement, not by a second read", async () => {
  // The pin above says `findRule` costs one statement. This says WHICH one: the
  // organization and project halves of the scope appear in the same SQL text as
  // the rule id, which is what "resolved by the database in the same statement"
  // means and what a two-read implementation could not produce.
  await settle();
  harness.resetStatements();
  await harness.repository.findRule(small.scope, smallRule.ruleId);
  await settle();
  const sent = queries();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatch(/"Project"/u);
  expect(sent[0]).toMatch(/"Environment"/u);
}, 300_000);

/**
 * The measured counts. EVERY ONE OF THEM WAS OBSERVED FIRST.
 *
 * Filled in from a container run; the suite fails if any of them moves, in
 * either column, so a read that grew a statement is a red build rather than a
 * slow routing pass.
 */
const PINS: Record<string, Pair> = {
  findRule: { small: 1, large: 1 },
  findRuleByName: { small: 1, large: 1 },
  listRules: { small: 1, large: 1 },
  listEnabledRules: { small: 1, large: 1 },
  countRulesForSubject: { small: 1, large: 1 },
  countRulesAtOrganization: { small: 1, large: 1 },
  countVacuousSubject: { small: 0, large: 0 },
  anonymizeVacuousSubject: { small: 0, large: 0 },
  insertRule: { small: 1, large: 1 },
  updateRule: { small: 1, large: 1 },
  anonymizeAtOrganization: { small: 1, large: 1 },
  deleteRule: { small: 1, large: 1 },
};
