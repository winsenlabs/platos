// The database rules NO port method restates, and the rows an OLDER BINARY could
// have written that this one has to survive reading.
//
// EVERYTHING IN THE FIRST HALF IS A PROPERTY OF THE SCHEMA rather than of this
// adapter: the unique index is per ENVIRONMENT and not per name, the foreign key
// CASCADES, `enabled` defaults to true and `updatedAt` has no default at all. Not
// one of them is expressible through the port, so none of them can be checked by
// calling it — and each is a fact some future change could break without a single
// suite in this package noticing.
//
// EVERYTHING IN THE SECOND HALF IS PLANTED, and it has to be. `filters` and
// `delivery` are JSONB behind ONE check each, on their ROOT, and `name` is a
// `TEXT` with no length constraint at all — so a row whose `eventTypes` is
// missing, whose `delivery.type` is outside the union, or whose name is 200
// characters is a row the DATABASE is perfectly happy to hold and this binary
// cannot read. A container only ever reads rows this binary wrote, so the only
// way to reach those branches is to write them out of band, and the only tool
// that can is the ORM's own CLI — which is runtime, and therefore outside the
// sole-writer scanner's scope by construction.

import { afterAll, beforeAll, expect, test } from "vitest";

import type { NotificationRuleId, RuleName } from "@platos/context-eventing/application/ports/index.js";
import { asIdentifier, parseRuleName } from "@platos/context-eventing/application/ports/index.js";

import {
  startEventingHarness,
  type EventingHarness,
  type EventingTenant,
} from "./eventing-harness.js";

let harness: EventingHarness;
let tenant: EventingTenant;

function nameOf(raw: string): RuleName {
  const parsed = parseRuleName(raw);
  if (!parsed.ok) throw new Error(`the fixture's own name must parse: ${raw}`);
  return parsed.value;
}

let sequence = 0;
function freshRuleId(): string {
  sequence += 1;
  return `abababab-0001-4000-8000-${String(sequence).padStart(12, "0")}`;
}

/** Plant one row exactly as written, through the ORM's CLI. */
function plant(options: {
  readonly id: string;
  readonly environmentId: string;
  readonly name: string;
  readonly filters: string;
  readonly delivery: string;
  readonly columns?: string;
  readonly values?: string;
}): void {
  const extraColumns = options.columns ?? `, "enabled", "createdAt", "updatedAt"`;
  const extraValues = options.values ?? `, true, now(), now()`;
  harness.applyRows(
    `INSERT INTO "NotificationRule" ("id", "environmentId", "name", "filters", "delivery", "createdBy"${extraColumns})
     VALUES ('${options.id}'::uuid, '${options.environmentId}'::uuid, '${options.name}', '${options.filters}'::jsonb, '${options.delivery}'::jsonb, 'operator-a'${extraValues});`,
  );
}

/** The `details.reason` a refusal carries, or `OK` when there was none. */
async function reasonOf(work: Promise<{ ok: boolean; error?: unknown }>): Promise<string> {
  const result = (await work) as { ok: boolean; error?: { details?: { reason?: string } } };
  if (result.ok) return "OK";
  return result.error?.details?.reason ?? "no-reason";
}

beforeAll(async () => {
  harness = await startEventingHarness();
  tenant = await harness.freshTenant();
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

test("`@@unique([environmentId, name])` is per ENVIRONMENT, not per name", async () => {
  // Both halves in one case, because either alone is misleading. The same name
  // in two environments must be ACCEPTED — a store that narrowed the index to
  // `name` would break every second tenant — and the same name twice in one
  // environment must be REFUSED even when it bypasses the port entirely.
  const id = freshRuleId();
  plant({
    id,
    environmentId: tenant.environmentId,
    name: "shared",
    filters: '{"eventTypes":["run.completed"]}',
    delivery: '{"type":"slack","url":"https://hooks.example/x"}',
  });
  plant({
    id: freshRuleId(),
    environmentId: tenant.siblingEnvironmentId,
    name: "shared",
    filters: '{"eventTypes":["run.completed"]}',
    delivery: '{"type":"slack","url":"https://hooks.example/x"}',
  });

  const here = await harness.repository.findRuleByName(tenant.scope, nameOf("shared"));
  expect(here.ok && here.value?.ruleId).toBe(id);
  const there = await harness.repository.findRuleByName(tenant.sibling, nameOf("shared"));
  expect(there.ok && there.value !== null && there.value.ruleId !== id).toBe(true);

  const duplicate = await harness.base.client
    .$executeRaw`INSERT INTO "NotificationRule" ("id", "environmentId", "name", "filters", "delivery", "enabled", "createdBy", "createdAt", "updatedAt") VALUES (${freshRuleId()}::uuid, ${tenant.environmentId}::uuid, 'shared', '{"eventTypes":["a"]}'::jsonb, '{"type":"slack","url":"https://x"}'::jsonb, true, 'operator-a', now(), now())`
    .then(() => "WROTE")
    .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
  expect(duplicate).not.toBe("WROTE");
  expect(String(duplicate)).toContain("NotificationRule_environmentId_name_key");
}, 300_000);

test("`ON DELETE CASCADE` takes the rules with the environment, and no port says so", async () => {
  // The port has no method that removes an environment's rules in bulk, and
  // `deleteRule` is addressed at one id. This rule is therefore invisible to
  // every port call — and it is the reason `eventing-refusal.ts` does not
  // pre-check the foreign key: the row can be taken by the cascade between any
  // read and any write.
  const doomed = await harness.freshTenant();
  const id = freshRuleId();
  plant({
    id,
    environmentId: doomed.environmentId,
    name: "cascade",
    filters: '{"eventTypes":["run.completed"]}',
    delivery: '{"type":"slack","url":"https://hooks.example/x"}',
  });
  const before = await harness.repository.listRules(doomed.scope);
  expect(before.ok && before.value.length).toBe(1);

  await harness.base.client
    .$executeRaw`DELETE FROM "Environment" WHERE "id" = ${doomed.environmentId}::uuid`;

  const rows = await harness.base.client
    .$queryRaw`SELECT count(*)::int AS total FROM "NotificationRule" WHERE "id" = ${id}::uuid`;
  expect((rows as readonly { total: number }[])[0]?.total).toBe(0);
}, 300_000);

test("`enabled` defaults to true and `updatedAt` has NO default", async () => {
  // Two facts about the DDL that the store never exercises, because it writes
  // both columns explicitly on every path. They matter to anyone writing a
  // migration or a backfill: a row inserted without `enabled` is ROUTED, and a
  // row inserted without `updatedAt` is refused outright — `@updatedAt` is a
  // client-side stamp, not a column default.
  const id = freshRuleId();
  plant({
    id,
    environmentId: tenant.environmentId,
    name: "defaults",
    filters: '{"eventTypes":["run.completed"]}',
    delivery: '{"type":"slack","url":"https://hooks.example/x"}',
    columns: `, "createdAt", "updatedAt"`,
    values: `, now(), now()`,
  });
  const found = await harness.repository.findRule(tenant.scope, asIdentifier<NotificationRuleId>(id));
  expect(found.ok && found.value?.enabled).toBe(true);

  const missingUpdatedAt = await harness.base.client
    .$executeRaw`INSERT INTO "NotificationRule" ("id", "environmentId", "name", "filters", "delivery", "createdBy") VALUES (${freshRuleId()}::uuid, ${tenant.environmentId}::uuid, 'no-updated-at', '{"eventTypes":["a"]}'::jsonb, '{"type":"slack","url":"https://x"}'::jsonb, 'operator-a')`
    .then(() => "WROTE")
    .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
  expect(missingUpdatedAt).not.toBe("WROTE");
}, 300_000);

test("a stored `filters` with no `eventTypes` is REFUSED on read, not cast", async () => {
  // `NotificationRule_filters_json_root` checks the ROOT and nothing inside it,
  // so this row is legal in the database and unreadable here. A store that cast
  // the column would hand `ruleAdmits` an object with no `eventPatterns` and the
  // routing pass would iterate `undefined`.
  const id = freshRuleId();
  plant({
    id,
    environmentId: tenant.environmentId,
    name: "legacy-filters",
    filters: "{}",
    delivery: '{"type":"slack","url":"https://hooks.example/x"}',
  });
  const reason = await reasonOf(
    harness.repository.findRule(tenant.scope, asIdentifier<NotificationRuleId>(id)),
  );
  expect(reason).toContain("eventing.row.filters_unreadable");
  expect(reason).toContain("NotificationRule.filters");
}, 300_000);

test("a stored `delivery` outside the union is REFUSED on read, not passed through", async () => {
  // `domain/destination.ts` says its default arm exists so that "a rule whose
  // destination cannot be parsed is skipped at routing time rather than
  // delivered to an unknown place". A cast here would have deleted that arm.
  const id = freshRuleId();
  plant({
    id,
    environmentId: tenant.environmentId,
    name: "legacy-delivery",
    filters: '{"eventTypes":["run.completed"]}',
    delivery: '{"type":"carrier-pigeon","url":"https://hooks.example/x"}',
  });
  const reason = await reasonOf(
    harness.repository.findRule(tenant.scope, asIdentifier<NotificationRuleId>(id)),
  );
  expect(reason).toContain("eventing.row.delivery_unreadable");
  expect(reason).toContain("NotificationRule.delivery");
}, 300_000);

test("a stored `name` past 120 characters is REFUSED on read — the column bounds nothing", async () => {
  // `domain/rule-name.ts` says it outright: "a column with no length constraint
  // of its own means this predicate IS the constraint". So the bound lives only
  // in TypeScript, and a row written by a binary that did not enforce it is
  // readable as a string and unreadable as a `RuleName`.
  const id = freshRuleId();
  plant({
    id,
    environmentId: tenant.environmentId,
    name: "x".repeat(200),
    filters: '{"eventTypes":["run.completed"]}',
    delivery: '{"type":"slack","url":"https://hooks.example/x"}',
  });
  const reason = await reasonOf(
    harness.repository.findRule(tenant.scope, asIdentifier<NotificationRuleId>(id)),
  );
  expect(reason).toContain("eventing.row.name_unreadable");
  expect(reason).toContain("NotificationRule.name");
}, 300_000);

test("ONE unreadable row refuses the WHOLE listing, and that is reported rather than hidden", async () => {
  // *** A CONTRACT THE REAL DATABASE NARROWS, PINNED AS A NAMED CASE. ***
  // `listRules` returns `Result<readonly NotificationRule[]>` and has no per-row
  // failure channel, so a listing over an environment holding ONE row this
  // binary cannot read has two truthful answers and neither is good: refuse the
  // listing, or silently drop the row. Dropping it would make an operator's rule
  // page quietly incomplete and would tell nobody, so the store refuses — and
  // the environment seeded above now holds four unreadable rows, which is what
  // makes this observable at all.
  const reason = await reasonOf(harness.repository.listRules(tenant.scope));
  expect(reason).toContain("eventing.row.");
  const enabled = await reasonOf(harness.repository.listEnabledRules(tenant.scope));
  expect(enabled).toContain("eventing.row.");
}, 300_000);
