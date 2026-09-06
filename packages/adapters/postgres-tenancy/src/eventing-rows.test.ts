// The mapping and the two `where` shapes, without a database.
//
// WHY THIS SUITE EXISTS BESIDE FOUR CONTAINER SUITES. A container only ever
// reads rows THIS BINARY WROTE, so the refusing branches of `readNotificationRule`
// are unreachable from one except through the rows the rules suite plants as raw
// SQL. Here they are reached directly, which is what lets each of the three carry
// its own named case and its own code — and codes that are only ever seen
// together cannot be told apart.
//
// AND TWO GUARDS ARE REACHABLE ONLY FROM HERE. `guardFiltersJsonRoot` and
// `guardDeliveryJsonRoot` restate `NotificationRule_filters_json_root` and
// `NotificationRule_delivery_json_root`, and nothing the DOMAIN can build reaches
// either: `toRuleFilterInput` and `toDestinationInput` return objects on every
// path. The acceptance says every guard must be falsifiable by a named case, so
// the case calls the guard directly. What stands behind them — that the CHECKs
// exist and refuse — is proved by raw INSERTs in
// `eventing-constraints.integration.test.ts`.

import { describe, expect, test } from "vitest";

import { asIdentifier, environmentScope } from "@platos/context-eventing/application/ports/index.js";

import {
  EVENTING_DELIVERY_NOT_OBJECT,
  EVENTING_FILTERS_NOT_OBJECT,
  EVENTING_IDENTIFIER_NOT_UUID,
  EVENTING_INSTANT_NOT_STORABLE,
  EVENTING_TEXT_HAS_NUL,
  EventingWriteRefused,
  guardDeliveryJsonRoot,
  guardFiltersJsonRoot,
  guardScope,
  guardUuid,
} from "./eventing-guards.js";
import {
  EVENTING_DELIVERY_UNREADABLE,
  EVENTING_FILTERS_UNREADABLE,
  EVENTING_NAME_UNREADABLE,
  readNotificationRule,
  scopedWhere,
  tenantWhere,
  writeDestination,
  writeFilter,
  type NotificationRuleRow,
} from "./eventing-rows.js";
import { UnreadableRowError } from "./mapping.js";

const ORGANIZATION = "aaaaaaaa-0001-4000-8000-000000000001";
const PROJECT = "aaaaaaaa-0002-4000-8000-000000000002";
const ENVIRONMENT = "aaaaaaaa-0003-4000-8000-000000000003";
const RULE = "aaaaaaaa-0004-4000-8000-000000000004";

const SCOPE = environmentScope(
  asIdentifier(ORGANIZATION),
  asIdentifier(PROJECT),
  asIdentifier(ENVIRONMENT),
);

function rowWith(overrides: Partial<NotificationRuleRow> = {}): NotificationRuleRow {
  return {
    id: RULE,
    environmentId: ENVIRONMENT,
    name: "alpha",
    filters: { eventTypes: ["run.completed", "budget.*"], subjectIds: ["run-1"] },
    delivery: { type: "webhook", url: "https://ops.example/hook" },
    enabled: true,
    createdBy: "operator-a",
    createdAt: new Date("2026-06-01T09:00:00.000Z"),
    updatedAt: new Date("2026-06-01T09:05:00.000Z"),
    ...overrides,
  };
}

function codeOf(work: () => unknown): string {
  try {
    work();
    return "NO-REFUSAL";
  } catch (error) {
    if (error instanceof UnreadableRowError || error instanceof EventingWriteRefused) {
      return error.code;
    }
    return `<unexpected:${String(error)}>`;
  }
}

describe("readNotificationRule", () => {
  test("maps every column, and stamps the scope the read PROVED", () => {
    const rule = readNotificationRule(rowWith(), SCOPE);
    expect(rule.ruleId).toBe(RULE);
    expect(rule.scope).toEqual(SCOPE);
    expect(rule.name).toBe("alpha");
    expect([...rule.filter.eventPatterns]).toEqual(["run.completed", "budget.*"]);
    expect([...rule.filter.subjectIds]).toEqual(["run-1"]);
    expect(rule.destination).toEqual({ kind: "webhook", url: "https://ops.example/hook" });
    expect(rule.enabled).toBe(true);
    expect(rule.createdBy).toBe("operator-a");
    expect(rule.createdAt.toISOString()).toBe("2026-06-01T09:00:00.000Z");
    expect(rule.updatedAt.toISOString()).toBe("2026-06-01T09:05:00.000Z");
  });

  test("a `filters` with no `eventTypes` is REFUSED, not cast", () => {
    // `NotificationRule_filters_json_root` checks the ROOT and nothing inside it.
    expect(codeOf(() => readNotificationRule(rowWith({ filters: {} }), SCOPE))).toBe(
      EVENTING_FILTERS_UNREADABLE,
    );
  });

  test("a `delivery` outside the union is REFUSED, not passed through", () => {
    expect(
      codeOf(() =>
        readNotificationRule(rowWith({ delivery: { type: "carrier-pigeon" } }), SCOPE),
      ),
    ).toBe(EVENTING_DELIVERY_UNREADABLE);
  });

  test("a stored `name` past 120 characters is REFUSED — the column bounds nothing", () => {
    expect(codeOf(() => readNotificationRule(rowWith({ name: "x".repeat(121) }), SCOPE))).toBe(
      EVENTING_NAME_UNREADABLE,
    );
    // And 120 exactly is readable, so the bound is the domain's and not a
    // rounding of it.
    expect(readNotificationRule(rowWith({ name: "x".repeat(120) }), SCOPE).name).toHaveLength(120);
  });

  test("the three unreadable-row codes are distinct strings", () => {
    // Two branches sharing one code cannot be told apart in a log, which is how
    // two defects hid behind one code in `privacy` and in `identity-access`.
    expect(
      new Set([EVENTING_FILTERS_UNREADABLE, EVENTING_DELIVERY_UNREADABLE, EVENTING_NAME_UNREADABLE])
        .size,
    ).toBe(3);
  });

  test("the refusal names the COLUMN, so an operator can find the row", () => {
    try {
      readNotificationRule(rowWith({ filters: { eventTypes: [] } }), SCOPE);
      throw new Error("the row must be refused");
    } catch (error) {
      expect(error instanceof UnreadableRowError && error.column).toBe("NotificationRule.filters");
    }
  });
});

describe("the write halves are the DOMAIN's, not a second copy", () => {
  test("`filters` round-trips through the column shape", () => {
    const rule = readNotificationRule(rowWith(), SCOPE);
    expect(writeFilter(rule.filter)).toEqual({
      eventTypes: ["run.completed", "budget.*"],
      subjectIds: ["run-1"],
    });
  });

  test("an EMPTY subject allowlist is written as SQL null, not as an empty array", () => {
    // `toRuleFilterInput` collapses it, and `parseRuleFilter` reads either back
    // as "no subject restriction". Copying the shape here rather than deriving
    // it from the domain would be a second definition of that collapse.
    const rule = readNotificationRule(
      rowWith({ filters: { eventTypes: ["run.completed"] } }),
      SCOPE,
    );
    expect(writeFilter(rule.filter)).toEqual({ eventTypes: ["run.completed"], subjectIds: null });
  });

  test("`delivery` round-trips through the column shape for every arm", () => {
    for (const raw of [
      { type: "slack", url: "https://hooks.example/s" },
      { type: "webhook", url: "https://hooks.example/w" },
      { type: "email", email: "ops@example.test" },
      { type: "pagerduty", integrationKey: "pd-1" },
    ]) {
      const rule = readNotificationRule(rowWith({ delivery: raw }), SCOPE);
      expect(writeDestination(rule.destination)).toEqual(raw);
    }
  });
});

describe("the where shapes", () => {
  test("`scopedWhere` narrows on the WHOLE ancestry, not on the leaf column", () => {
    // The property that makes the echoed scope truthful. A store narrowing on
    // `environmentId` alone would answer a caller holding the right environment
    // under the wrong project with a rule tagged with an ancestry it lacks.
    expect(scopedWhere(SCOPE)).toEqual({
      environmentId: ENVIRONMENT,
      environment: { projectId: PROJECT, project: { organizationId: ORGANIZATION } },
    });
  });

  test("`tenantWhere` widens by LEVEL, and each level drops exactly one clause", () => {
    expect(tenantWhere(SCOPE)).toEqual(scopedWhere(SCOPE));
    expect(
      tenantWhere({
        level: "project",
        organizationId: asIdentifier(ORGANIZATION),
        projectId: asIdentifier(PROJECT),
      }),
    ).toEqual({ environment: { projectId: PROJECT, project: { organizationId: ORGANIZATION } } });
    expect(tenantWhere({ level: "organization", organizationId: asIdentifier(ORGANIZATION) })).toEqual({
      environment: { project: { organizationId: ORGANIZATION } },
    });
  });

  test("a PROJECT-level selector still carries its organization", () => {
    // Without the organization clause a project id would be enough to reach a
    // project of ANOTHER organization — project ids are uuids, so a collision is
    // not the risk; a caller passing a project it does not own is.
    const wide = tenantWhere({
      level: "project",
      organizationId: asIdentifier(ORGANIZATION),
      projectId: asIdentifier(PROJECT),
    });
    expect(JSON.stringify(wide)).toContain(ORGANIZATION);
  });
});

describe("the guards no port call can reach", () => {
  test("`guardFiltersJsonRoot` refuses an array, a scalar and a null", () => {
    for (const value of [[], "slack", 1, null]) {
      expect(codeOf(() => guardFiltersJsonRoot(value))).toBe(EVENTING_FILTERS_NOT_OBJECT);
    }
    expect(codeOf(() => guardFiltersJsonRoot({ eventTypes: ["a"] }))).toBe("NO-REFUSAL");
  });

  test("`guardDeliveryJsonRoot` refuses the same, under its OWN code", () => {
    expect(codeOf(() => guardDeliveryJsonRoot([]))).toBe(EVENTING_DELIVERY_NOT_OBJECT);
    expect(EVENTING_DELIVERY_NOT_OBJECT).not.toBe(EVENTING_FILTERS_NOT_OBJECT);
  });
});

describe("the uuid guard", () => {
  test("accepts the canonical form and refuses the shapes PostgreSQL would take", () => {
    // PostgreSQL's own `uuid` input accepts braces and a hyphenless form. This
    // guard does not, deliberately: a row written under one spelling and read
    // back under another would break every string comparison this context makes
    // on a rule id.
    expect(codeOf(() => guardUuid("id", RULE))).toBe("NO-REFUSAL");
    expect(codeOf(() => guardUuid("id", RULE.toUpperCase()))).toBe("NO-REFUSAL");
    expect(codeOf(() => guardUuid("id", `{${RULE}}`))).toBe(EVENTING_IDENTIFIER_NOT_UUID);
    expect(codeOf(() => guardUuid("id", RULE.replaceAll("-", "")))).toBe(
      EVENTING_IDENTIFIER_NOT_UUID,
    );
    expect(codeOf(() => guardUuid("id", "id-0001"))).toBe(EVENTING_IDENTIFIER_NOT_UUID);
  });

  test("`guardScope` checks exactly the ids the level actually names", () => {
    // An organization scope has no project id to check, and checking one that is
    // not there would refuse a legal selector.
    expect(
      codeOf(() => guardScope({ level: "organization", organizationId: asIdentifier(ORGANIZATION) })),
    ).toBe("NO-REFUSAL");
    expect(codeOf(() => guardScope(SCOPE))).toBe("NO-REFUSAL");
    expect(
      codeOf(() => guardScope({ level: "organization", organizationId: asIdentifier("org-1") })),
    ).toBe(EVENTING_IDENTIFIER_NOT_UUID);
    expect(
      codeOf(() =>
        guardScope({
          level: "project",
          organizationId: asIdentifier(ORGANIZATION),
          projectId: asIdentifier("proj-1"),
        }),
      ),
    ).toBe(EVENTING_IDENTIFIER_NOT_UUID);
  });

  test("the five write-refusal codes are five distinct strings", () => {
    expect(
      new Set([
        EVENTING_IDENTIFIER_NOT_UUID,
        EVENTING_TEXT_HAS_NUL,
        EVENTING_INSTANT_NOT_STORABLE,
        EVENTING_FILTERS_NOT_OBJECT,
        EVENTING_DELIVERY_NOT_OBJECT,
      ]).size,
    ).toBe(5);
  });
});
