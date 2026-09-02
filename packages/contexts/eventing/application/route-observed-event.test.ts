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
    expect(emitted?.attempt).toBe(0);
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

  it("makes a first-attempt request available immediately", async () => {
    context.repository.seed(rule({ id: "rule-1", name: "a", eventTypes: ["*"] }));
    await routeObservedEvent(context.dependencies, observed({ name: "run.completed" }));
    const [queued] = context.queue.all();
    expect(queued?.availableAt.getTime()).toBe(queued?.request.requestedAt.getTime());
  });
});
