// What the REAL database refuses that the context's own double accepts, each
// guard standing beside the constraint it restates.
//
// EVERY CASE HERE IS A VALUE THAT PASSES `InMemoryNotificationRuleRepository`
// AND EVERY USE-CASE SUITE IN `packages/contexts/eventing`. That is the finding
// this file exists to record rather than a hypothetical: `SequenceIdGenerator`
// mints rule ids as `id-0001`, `testEnvironmentScope()` mints the scope triple
// `org-1`/`proj-1`/`env-1`, and all four go into a `@db.Uuid` column or a
// `@db.Uuid` join. It is the same shape tranche 3 found in tenancy's
// `InvitationTokenIssuer`, whose `digest:plt_inv_1` is refused by
// `OrganizationInvitation_tokenHash_check`.
//
// EVERY GUARD IS PROVED TWICE: once that the guard refuses, and once that the
// DATABASE would have refused the same value. A guard with no constraint behind
// it is a rule this adapter invented, and a constraint with no guard in front of
// it is a 25P02 in somebody else's transaction. The second half of each pair
// goes through the client DIRECTLY, outside any unit of work, because that is
// the only way to observe the raw refusal without losing a transaction to it.
//
// AND EVERY GUARD IS PROVED TO KEEP THE TRANSACTION. The case at the end writes
// a refused rule and a good one in the SAME unit of work and reads the good one
// back — which is the property `eventing-guards.ts` is written for and which no
// amount of refusing correctly would give.

import { afterAll, beforeAll, expect, test } from "vitest";

import type {
  NotificationRule,
  NotificationRuleId,
  PrincipalId,
} from "@platos/context-eventing/application/ports/index.js";
import {
  asIdentifier,
  createNotificationRule,
  environmentScope,
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
let tenant: EventingTenant;

/** The one byte no PostgreSQL text or jsonb value can hold. */
const NUL = String.fromCharCode(0);

let sequence = 0;
function freshRuleId(): string {
  sequence += 1;
  return `ffffffff-0001-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function ruleFor(
  scope: NotificationRule["scope"],
  name: string,
  overrides: Partial<NotificationRule> = {},
): NotificationRule {
  const filter = parseRuleFilter({ eventTypes: ["run.completed"] });
  const destination = parseDestination({ type: "slack", url: "https://hooks.example/x" });
  const parsedName = parseRuleName(name);
  if (!filter.ok || !destination.ok || !parsedName.ok) throw new Error("fixture must parse");
  return {
    ...createNotificationRule(
      {
        ruleId: asIdentifier<NotificationRuleId>(freshRuleId()),
        scope,
        name: parsedName.value,
        filter: filter.value,
        destination: destination.value,
        createdBy: asIdentifier<PrincipalId>("operator-a"),
      },
      new Date("2026-06-01T09:00:00.000Z"),
    ),
    ...overrides,
  };
}

/** The `details.reason` a refusal carries, or the code when it is not one. */
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

test("`@db.Uuid` — the rule id the context's OWN generator mints is refused", async () => {
  // `SequenceIdGenerator.uuid()` answers `id-0001`, `registerNotificationRule`
  // brands it as a `NotificationRuleId`, and the double stores it happily.
  const rule = ruleFor(tenant.scope, "uuid-guard", {
    ruleId: asIdentifier<NotificationRuleId>("id-0001"),
  });
  const reason = await reasonOf(harness.run((t) => harness.repository.insertRule(rule, t)));
  expect(reason).toBe(
    'eventing.write.identifier_not_uuid: rule.ruleId must be a uuid; received "id-0001"',
  );
}, 300_000);

test("`@db.Uuid` — and the database would have refused it too", async () => {
  // The control for the guard above. Without this the guard is a rule this
  // adapter invented rather than one the schema carries.
  const failure = await harness.base.client.notificationRule
    .create({
      data: {
        id: "id-0001",
        environmentId: tenant.environmentId,
        name: "uuid-control",
        filters: { eventTypes: ["run.completed"] },
        delivery: { type: "slack", url: "https://hooks.example/x" },
        enabled: true,
        createdBy: "operator-a",
        createdAt: new Date("2026-06-01T09:00:00.000Z"),
        updatedAt: new Date("2026-06-01T09:00:00.000Z"),
      },
    })
    .then(() => "WROTE")
    .catch((error: unknown) => (error instanceof Error ? error.name : String(error)));
  expect(failure).not.toBe("WROTE");
}, 300_000);

test("`@db.Uuid` — the scope triple the context's OWN fixture mints is refused", async () => {
  // `testEnvironmentScope()` is `org-1` / `proj-1` / `env-1`, and the ancestry
  // filter puts all three into `@db.Uuid` comparisons. The ORGANIZATION is
  // reported first because it is the first the join needs.
  const fake = environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier("env-1"));
  const rule = ruleFor(fake, "scope-guard");
  const reason = await reasonOf(harness.run((t) => harness.repository.insertRule(rule, t)));
  expect(reason).toBe(
    'eventing.write.identifier_not_uuid: scope.organizationId must be a uuid; received "org-1"',
  );
}, 300_000);

test("`@db.Uuid` — a malformed id refuses on the READ path too, which the double does not", async () => {
  // *** A DIVERGENCE FROM THE DOUBLE, PINNED RATHER THAN NORMALISED. ***
  // `InMemoryNotificationRuleRepository.findRule` answers `ok(null)` for any id
  // it does not hold, malformed or not. This store REFUSES, because a SELECT
  // binding `id-0001` to a `uuid` column raises `22P02` inside whatever
  // transaction the caller has open — so answering "not found" would mean
  // sending the statement that poisons it. The conformance scenario therefore
  // uses only well-formed ids, and the difference lives here with its reason.
  const reason = await reasonOf(
    harness.repository.findRule(tenant.scope, asIdentifier<NotificationRuleId>("id-0001")),
  );
  expect(reason).toBe(
    'eventing.write.identifier_not_uuid: ruleId must be a uuid; received "id-0001"',
  );
}, 300_000);

test("a NUL byte in the name is refused, and the driver would have refused it too", async () => {
  // `parseRuleName` bounds a name at 1-120 code units and trims nothing, so
  // `"\\u0000"` is a LEGAL `RuleName` the double stores without complaint.
  const parsed = parseRuleName(`alpha${NUL}beta`);
  expect(parsed.ok).toBe(true);

  const rule = ruleFor(tenant.scope, "nul-placeholder");
  const withNul: NotificationRule = { ...rule, name: parsed.ok ? parsed.value : rule.name };
  const reason = await reasonOf(harness.run((t) => harness.repository.insertRule(withNul, t)));
  expect(reason).toBe(
    "eventing.write.text_has_nul: rule.name carries U+0000, which no PostgreSQL text or jsonb value can hold",
  );

  const failure = await harness.base.client.notificationRule
    .create({
      data: {
        id: freshRuleId(),
        environmentId: tenant.environmentId,
        name: `alpha${NUL}beta`,
        filters: { eventTypes: ["run.completed"] },
        delivery: { type: "slack", url: "https://hooks.example/x" },
        enabled: true,
        createdBy: "operator-a",
        createdAt: new Date("2026-06-01T09:00:00.000Z"),
        updatedAt: new Date("2026-06-01T09:00:00.000Z"),
      },
    })
    .then(() => "WROTE")
    .catch((error: unknown) => (error instanceof Error ? error.name : String(error)));
  expect(failure).not.toBe("WROTE");
}, 300_000);

test("a NUL byte inside the delivery JSON is refused, and it is a DIFFERENT column", async () => {
  // The `delivery` url is a `jsonb` string, and `nonEmptyString` in
  // `domain/destination.ts` asks only for length. The guard walks the union's
  // one string per arm rather than the column, so this refusal names the field.
  const destination = parseDestination({ type: "webhook", url: `https://ops.example/${NUL}` });
  expect(destination.ok).toBe(true);
  const rule = ruleFor(tenant.scope, "nul-delivery");
  const withNul: NotificationRule = {
    ...rule,
    destination: destination.ok ? destination.value : rule.destination,
  };
  const reason = await reasonOf(harness.run((t) => harness.repository.insertRule(withNul, t)));
  expect(reason).toBe(
    "eventing.write.text_has_nul: delivery.url carries U+0000, which no PostgreSQL text or jsonb value can hold",
  );
}, 300_000);

test("an Invalid Date is refused before it reaches a `timestamp(3)` column", async () => {
  const rule = ruleFor(tenant.scope, "instant-guard", { updatedAt: new Date(Number.NaN) });
  const reason = await reasonOf(harness.run((t) => harness.repository.insertRule(rule, t)));
  expect(reason).toBe(
    "eventing.write.instant_not_storable: rule.updatedAt is not a finite instant a timestamp(3) column can hold",
  );
}, 300_000);

test("`NotificationRule_filters_json_root` refuses a non-object, which no port call can send", async () => {
  // The guard that RESTATES this CHECK cannot be reached through the port —
  // `toRuleFilterInput` always returns an object — so the constraint is proved
  // directly. That is the honest shape: the CHECK is the authority, the guard
  // is one edit's worth of insurance in front of it, and neither is asserted on
  // the strength of the other.
  const failure = await harness.base.client
    .$executeRaw`INSERT INTO "NotificationRule" ("id", "environmentId", "name", "filters", "delivery", "enabled", "createdBy", "createdAt", "updatedAt") VALUES (${freshRuleId()}::uuid, ${tenant.environmentId}::uuid, 'json-root', '[]'::jsonb, '{"type":"slack","url":"https://x"}'::jsonb, true, 'operator-a', now(), now())`
    .then(() => "WROTE")
    .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
  expect(failure).not.toBe("WROTE");
  expect(String(failure)).toContain("NotificationRule_filters_json_root");
}, 300_000);

test("`NotificationRule_delivery_json_root` refuses a non-object, and it is its OWN constraint", async () => {
  const failure = await harness.base.client
    .$executeRaw`INSERT INTO "NotificationRule" ("id", "environmentId", "name", "filters", "delivery", "enabled", "createdBy", "createdAt", "updatedAt") VALUES (${freshRuleId()}::uuid, ${tenant.environmentId}::uuid, 'json-root-2', '{"eventTypes":["a"]}'::jsonb, '"slack"'::jsonb, true, 'operator-a', now(), now())`
    .then(() => "WROTE")
    .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
  expect(failure).not.toBe("WROTE");
  expect(String(failure)).toContain("NotificationRule_delivery_json_root");
}, 300_000);

test("`NotificationRule_environmentId_fkey` is reported under its OWN reason code", async () => {
  // A well-formed uuid that names no environment. It cannot be pre-checked
  // honestly — a read would be stale the instant it returned — so the constraint
  // is the authority and the refusal names it.
  const absent = environmentScope(
    asIdentifier(tenant.organizationId),
    asIdentifier(tenant.projectId),
    asIdentifier("ffffffff-9999-4000-8000-999999999999"),
  );
  const rule = ruleFor(absent, "fk-guard");
  const reason = await reasonOf(harness.run((t) => harness.repository.insertRule(rule, t)));
  expect(reason).toBe(
    "eventing.write.environment_unknown: insertRule names an environment that does not exist",
  );
}, 300_000);

test("a refused write LEAVES THE TRANSACTION USABLE, which is what the guards are for", async () => {
  // The property the whole file exists for. A store that let the uuid reach the
  // database would report this refusal correctly and leave the caller unable to
  // write anything else — and a multi-context erasure is exactly a caller with
  // more to write.
  const good = ruleFor(tenant.scope, "survivor");
  const written = await harness.run(async (transaction) => {
    const refused = await harness.repository.insertRule(
      ruleFor(tenant.scope, "doomed", { ruleId: asIdentifier<NotificationRuleId>("not-a-uuid") }),
      transaction,
    );
    expect(refused.ok).toBe(false);
    return harness.repository.insertRule(good, transaction);
  });
  expect(written.ok).toBe(true);
  const found = await harness.repository.findRule(tenant.scope, good.ruleId);
  expect(found.ok && found.value !== null).toBe(true);
}, 300_000);
