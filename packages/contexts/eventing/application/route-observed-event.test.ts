import { asIdentifier, environmentScope, type PrincipalId } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createNotificationRule,
  observedEventFrom,
  parseDestination,
  parseRuleFilter,
  parseRuleName,
  type Destination,
  type NotificationRule,
  type NotificationRuleId,
  type ObservedEvent,
  type RuleFilter,
} from "../domain/index.js";
import { routeObservedEvent } from "./route-observed-event.js";
import {
  buildEventingTestContext,
  testDomainEvent,
  testEnvironmentScope,
  type EventingTestContext,
} from "./testing/index.js";

function filter(eventTypes: string[], subjectIds?: string[]): RuleFilter {
  const parsed = parseRuleFilter({ eventTypes, subjectIds: subjectIds ?? null });
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function destination(raw: unknown): Destination {
  const parsed = parseDestination(raw as never);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function rule(options: {
  id: string;
  name: string;
  eventTypes: string[];
  subjectIds?: string[];
  environmentId?: string;
  enabled?: boolean;
  delivery?: unknown;
}): NotificationRule {
  const name = parseRuleName(options.name);
  if (!name.ok) throw new Error(name.error.code);
  const built = createNotificationRule(
    {
      ruleId: asIdentifier<NotificationRuleId>(options.id),
      scope: testEnvironmentScope(options.environmentId ?? "env-1"),
      name: name.value,
      filter: filter(options.eventTypes, options.subjectIds),
      destination: destination(options.delivery ?? { type: "webhook", url: "https://example.test/h" }),
      createdBy: asIdentifier<PrincipalId>("user-1"),
    },
    new Date("2026-01-01T00:00:00.000Z"),
  );
  return options.enabled === false ? { ...built, enabled: false } : built;
}

function observed(options: Parameters<typeof testDomainEvent>[0]): ObservedEvent {
  const narrowed = observedEventFrom(testDomainEvent(options));
  if (narrowed === null) throw new Error("expected an environment-scoped event");
  return narrowed;
}

// ---------------------------------------------------------------------------
// Fixtures for the drain-boundary REPARSE guard.
//
// A `NotificationRule` in memory already holds parsed halves, so `reparse`
// looks like a redundant round trip — and the 2026-09-03 independent
// verification found it entirely DEAD to this suite: dropping the filter check,
// dropping the destination check, or swapping the two skip reasons all left
// 142/142 green.
//
// It is not redundant, and it is reachable WITHOUT A SINGLE CAST, which is the
// whole point. The two column shapes are `Json` with no database-level shape
// (see domain/notification-rule.ts), an adapter reconstructs the aggregate from
// them, and the aggregate's TYPES do not exclude the values the parsers refuse:
//
//   `RuleFilter.eventPatterns` is `readonly EventPattern[]`, and the empty array
//   is a member of that type — but `parseRuleFilter` refuses an empty
//   `eventTypes`, and `anyPatternMatches` treats it as "match nothing".
//
//   `Destination` includes `{ kind: "webhook"; url: string }`, and the empty
//   string is a member of that type — but `parseDestination` refuses an empty
//   url, because `nonEmptyString("")` is false.
//
// Both are exactly what a row written by an older binary, or by hand, hands back
// through the repository port. The cases below are the last total check before
// such a row's destination is acted on, and each one names the mutation it kills.

function ruleWithHalves(options: {
  id: string;
  name: string;
  filter: RuleFilter;
  destination: Destination;
}): NotificationRule {
  const name = parseRuleName(options.name);
  if (!name.ok) throw new Error(name.error.code);
  return createNotificationRule(
    {
      ruleId: asIdentifier<NotificationRuleId>(options.id),
      scope: testEnvironmentScope("env-1"),
      name: name.value,
      filter: options.filter,
      destination: options.destination,
      createdBy: asIdentifier<PrincipalId>("user-1"),
    },
    new Date("2026-01-01T00:00:00.000Z"),
  );
}

/** Type-legal. `parseRuleFilter` refuses it: `eventTypes` must be NON-EMPTY. */
const UNPARSABLE_FILTER: RuleFilter = { eventPatterns: [], subjectIds: [] };

/** Type-legal. `parseDestination` refuses it: a webhook url must be non-empty. */
const UNPARSABLE_DESTINATION: Destination = { kind: "webhook", url: "" };

const HEALTHY_DESTINATION: Destination = { kind: "webhook", url: "https://example.test/h" };

describe("routeObservedEvent", () => {
  let context: EventingTestContext;

  beforeEach(() => {
    context = buildEventingTestContext();
  });

  it("emits one NotificationRequested per matching rule", async () => {
    context.repository.seed(rule({ id: "rule-1", name: "runs", eventTypes: ["run.*"] }));
    context.repository.seed(rule({ id: "rule-2", name: "all", eventTypes: ["*"] }));

    const report = await routeObservedEvent(context.dependencies, observed({ name: "run.completed" }));

    expect(report.ok).toBe(true);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.requested).toHaveLength(2);
    expect(context.queue.all()).toHaveLength(2);
    expect(report.value.considered).toBe(2);
  });

  it("carries the rule's name and destination BY VALUE onto the request", async () => {
    context.repository.seed(
      rule({
        id: "rule-1",
        name: "runs",
        eventTypes: ["run.*"],
        delivery: { type: "slack", url: "https://hooks.example/x" },
      }),
    );
    const report = await routeObservedEvent(context.dependencies, observed({ name: "run.failed" }));
    if (!report.ok) throw new Error("unreachable");
    const [emitted] = report.value.requested;
    expect(emitted?.ruleName).toBe("runs");
    expect(emitted?.destination).toEqual({ kind: "slack", url: "https://hooks.example/x" });
    expect(emitted?.severity).toBe("alert");
    expect(emitted?.retryCount).toBe(0);
  });

  it("emits nothing for an event no rule wants", async () => {
    context.repository.seed(rule({ id: "rule-1", name: "runs", eventTypes: ["run.*"] }));
    const report = await routeObservedEvent(context.dependencies, observed({ name: "tool.called" }));
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.requested).toHaveLength(0);
    expect(report.value.skipped).toEqual([{ ruleId: "rule-1", reason: "did-not-match" }]);
  });

  it("never considers a rule from another environment", async () => {
    context.repository.seed(
      rule({ id: "rule-elsewhere", name: "all", eventTypes: ["*"], environmentId: "env-2" }),
    );
    const report = await routeObservedEvent(context.dependencies, observed({ name: "run.completed" }));
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.considered).toBe(0);
    expect(context.queue.all()).toHaveLength(0);
  });

  it("never considers a disabled rule", async () => {
    context.repository.seed(rule({ id: "rule-1", name: "all", eventTypes: ["*"], enabled: false }));
    const report = await routeObservedEvent(context.dependencies, observed({ name: "run.completed" }));
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.considered).toBe(0);
    expect(report.value.requested).toHaveLength(0);
  });

  it("honours a subject allowlist", async () => {
    context.repository.seed(
      rule({ id: "rule-1", name: "one-run", eventTypes: ["run.*"], subjectIds: ["run-1"] }),
    );
    const matched = await routeObservedEvent(
      context.dependencies,
      observed({ name: "run.completed", subjectId: "run-1" }),
    );
    if (!matched.ok) throw new Error("unreachable");
    expect(matched.value.requested).toHaveLength(1);

    const missed = await routeObservedEvent(
      context.dependencies,
      observed({ name: "run.completed", subjectId: "run-9" }),
    );
    if (!missed.ok) throw new Error("unreachable");
    expect(missed.value.requested).toHaveLength(0);
  });

  // The legacy per-rule fail-open: one bad row must not stop its siblings.
  it("keeps routing the other rules when the queue rejects ONE match", async () => {
    context.repository.seed(rule({ id: "rule-1", name: "a", eventTypes: ["*"] }));
    context.repository.seed(rule({ id: "rule-2", name: "b", eventTypes: ["*"] }));
    context.queue.failNext("redis down");

    const report = await routeObservedEvent(context.dependencies, observed({ name: "run.completed" }));

    expect(report.ok).toBe(true);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.failures).toHaveLength(1);
    expect(report.value.requested).toHaveLength(1);
    expect(context.queue.all()).toHaveLength(1);
  });

  it("reports an enqueue failure rather than discarding it", async () => {
    context.repository.seed(rule({ id: "rule-1", name: "a", eventTypes: ["*"] }));
    context.queue.failNext();
    const report = await routeObservedEvent(context.dependencies, observed({ name: "run.completed" }));
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.failures).toEqual([{ ruleId: "rule-1", code: "EVENTING_QUEUE_UNAVAILABLE" }]);
  });

  // The one deliberate departure from the legacy fail-open, argued in the use
  // case's header: the caller is a retrying drain and must not be told "fine".
  it("FAILS the pass when the rules could not be read, so the drain retries", async () => {
    context.repository.failNext("connection reset");
    const report = await routeObservedEvent(context.dependencies, observed({ name: "run.completed" }));
    expect(report.ok).toBe(false);
    if (report.ok) throw new Error("unreachable");
    expect(report.error.code).toBe("EVENTING_REPOSITORY_UNAVAILABLE");
  });

  it("stamps every request with the injected clock, not the wall clock", async () => {
    context.repository.seed(rule({ id: "rule-1", name: "a", eventTypes: ["*"] }));
    context.clock.set(new Date("2030-06-01T12:00:00.000Z"));
    const report = await routeObservedEvent(context.dependencies, observed({ name: "run.completed" }));
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.requested[0]?.requestedAt.toISOString()).toBe("2030-06-01T12:00:00.000Z");
  });

  it("makes a first-send request available immediately", async () => {
    context.repository.seed(rule({ id: "rule-1", name: "a", eventTypes: ["*"] }));
    await routeObservedEvent(context.dependencies, observed({ name: "run.completed" }));
    const [queued] = context.queue.all();
    expect(queued?.availableAt.getTime()).toBe(queued?.request.requestedAt.getTime());
  });

  // Kills: deleting the `parseRuleFilter` arm of `reparse`. Without it this rule
  // is still not delivered — an empty pattern list matches nothing — but it is
  // reported as "did-not-match", which says the rule DECLINED the event when in
  // fact the row is unusable. The reason is the assertion, not the absence.
  // Also kills moving `reparse` after `ruleAdmits`, for the same reason.
  it("reports an unparsable stored FILTER as such, not as a non-match", async () => {
    context.repository.seed(
      ruleWithHalves({
        id: "rule-corrupt",
        name: "corrupt-filter",
        filter: UNPARSABLE_FILTER,
        destination: HEALTHY_DESTINATION,
      }),
    );
    context.repository.seed(rule({ id: "rule-healthy", name: "healthy", eventTypes: ["*"] }));

    const report = await routeObservedEvent(context.dependencies, observed({ name: "run.completed" }));

    if (!report.ok) throw new Error("unreachable");
    expect(report.value.skipped).toEqual([
      { ruleId: "rule-corrupt", reason: "filters-unparsable" },
    ]);
    // The legacy per-rule fail-open: one unusable row must not silence its siblings.
    expect(report.value.requested.map((request) => request.ruleId)).toEqual(["rule-healthy"]);
  });

  // Kills: deleting the `parseDestination` arm of `reparse`. Without it this rule
  // MATCHES, and the drain enqueues a NotificationRequested carrying an empty
  // webhook url — a send aimed at a destination that nothing ever validated.
  it("refuses to act on an unparsable stored DESTINATION, and queues nothing for it", async () => {
    context.repository.seed(
      ruleWithHalves({
        id: "rule-corrupt",
        name: "corrupt-destination",
        filter: filter(["*"]),
        destination: UNPARSABLE_DESTINATION,
      }),
    );

    const report = await routeObservedEvent(context.dependencies, observed({ name: "run.completed" }));

    if (!report.ok) throw new Error("unreachable");
    expect(report.value.considered).toBe(1);
    expect(report.value.requested).toHaveLength(0);
    expect(context.queue.all()).toHaveLength(0);
    expect(report.value.skipped).toEqual([
      { ruleId: "rule-corrupt", reason: "destination-unparsable" },
    ]);
  });

  // Kills: swapping the two reasons, and reordering the two checks. A row that is
  // unusable in BOTH halves is reported by the FIRST check that refuses it, and
  // that order is the assertion — an operator reading "destination-unparsable"
  // would go and inspect a delivery column that is in fact fine.
  it("reports the FILTER as the reason when both halves are unusable", async () => {
    context.repository.seed(
      ruleWithHalves({
        id: "rule-corrupt",
        name: "corrupt-both",
        filter: UNPARSABLE_FILTER,
        destination: UNPARSABLE_DESTINATION,
      }),
    );

    const report = await routeObservedEvent(context.dependencies, observed({ name: "run.completed" }));

    if (!report.ok) throw new Error("unreachable");
    expect(report.value.skipped).toEqual([
      { ruleId: "rule-corrupt", reason: "filters-unparsable" },
    ]);
  });
});
