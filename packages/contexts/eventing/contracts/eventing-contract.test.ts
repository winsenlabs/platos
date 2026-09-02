// The published surface, exercised end to end through `createEventingContract`.
//
// Everything here goes through the contract rather than through a use case, so
// it is the composition — the command translation, the view mapping, the drain
// entry point — that is under test, not the rules those layers delegate to.

import { asIdentifier, organizationScope } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { createEventingContract } from "../application/eventing-contract.js";
import {
  buildEventingTestContext,
  TEST_PRINCIPAL,
  testDomainEvent,
  testEnvironmentScope,
  type EventingTestContext,
} from "../application/testing/index.js";
import type { EventingContract, NotificationRuleId, NotificationRuleView } from "./index.js";

const WEBHOOK = { type: "webhook", url: "https://example.test/hook" } as const;

async function register(
  contract: EventingContract,
  name = "failures",
  eventTypes = ["run.*"],
): Promise<NotificationRuleView> {
  const registered = await contract.registerRule({
    scope: testEnvironmentScope(),
    name,
    filters: { eventTypes },
    delivery: WEBHOOK,
    createdBy: TEST_PRINCIPAL,
  });
  if (!registered.ok) throw new Error(registered.error.code);
  return registered.value;
}

describe("EventingContract", () => {
  let context: EventingTestContext;
  let contract: EventingContract;

  beforeEach(() => {
    context = buildEventingTestContext();
    contract = createEventingContract(context.dependencies);
  });

  it("names itself", () => {
    expect(contract.name).toBe("eventing");
  });

  it("publishes a rule in its COLUMN shape, not as domain value objects", async () => {
    const view = await register(contract);
    expect(view.filters).toEqual({ eventTypes: ["run.*"], subjectIds: null });
    expect(view.delivery).toEqual({ type: "webhook", url: WEBHOOK.url });
    expect(view.enabled).toBe(true);
    expect(view.scope.environmentId).toBe("env-1");
  });

  it("routes a drained event to a matching rule and returns the emitted request", async () => {
    await register(contract);
    const routed = await contract.routeEvent({
      event: testDomainEvent({ name: "run.completed", subjectId: "run-7" }),
    });

    expect(routed.ok).toBe(true);
    if (!routed.ok) throw new Error("unreachable");
    expect(routed.value.requested).toHaveLength(1);
    expect(routed.value.requested[0]?.summary).toBe(
      "[platos] run.completed subject=run-7 (rule: failures)",
    );
    expect(routed.value.failedRuleIds).toHaveLength(0);
  });

  // Not a refusal: an organization-scoped event is valid and simply has no rule
  // that could want it.
  it("treats a non-environment-scoped event as an empty pass, not an error", async () => {
    await register(contract);
    const routed = await contract.routeEvent({
      event: testDomainEvent({ name: "run.completed", scope: organizationScope(asIdentifier("org-1")) as never }),
    });

    expect(routed.ok).toBe(true);
    if (!routed.ok) throw new Error("unreachable");
    expect(routed.value.eventId).toBeNull();
    expect(routed.value.considered).toBe(0);
    expect(routed.value.requested).toHaveLength(0);
  });

  it("reports a partial pass through failedRuleIds without failing", async () => {
    await register(contract, "a", ["*"]);
    context.queue.failNext();
    const routed = await contract.routeEvent({ event: testDomainEvent({ name: "run.completed" }) });
    if (!routed.ok) throw new Error("unreachable");
    expect(routed.value.failedRuleIds).toEqual(["id-0001"]);
  });

  it("fails the pass when the rules could not be read", async () => {
    context.repository.failNext("connection reset");
    const routed = await contract.routeEvent({ event: testDomainEvent({ name: "run.completed" }) });
    expect(routed.ok).toBe(false);
  });

  it("lists, describes and deletes through the scope it was given", async () => {
    const view = await register(contract);

    const listed = await contract.listRules(testEnvironmentScope());
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value).toHaveLength(1);

    const described = await contract.describeRule({ scope: testEnvironmentScope(), ruleId: view.ruleId });
    expect(described.ok).toBe(true);

    const elsewhere = await contract.describeRule({
      scope: testEnvironmentScope("env-2"),
      ruleId: view.ruleId,
    });
    expect(elsewhere.ok).toBe(false);

    const deleted = await contract.deleteRule({ scope: testEnvironmentScope(), ruleId: view.ruleId });
    if (!deleted.ok) throw new Error("unreachable");
    expect(deleted.value).toBe(true);
  });

  it("updates through the contract without re-enabling a disabled rule", async () => {
    const view = await register(contract);
    await contract.updateRule({ scope: testEnvironmentScope(), ruleId: view.ruleId, enabled: false });
    const renamed = await contract.updateRule({
      scope: testEnvironmentScope(),
      ruleId: view.ruleId,
      name: "renamed",
    });
    if (!renamed.ok) throw new Error("unreachable");
    expect(renamed.value.enabled).toBe(false);
    expect(renamed.value.name).toBe("renamed");
  });

  // The synthetic fire deliberately bypasses the matcher: a rule filtered to
  // `run.*` would otherwise never see its own test.
  it("testRule fires a synthetic event PAST the rule's own filter", async () => {
    const view = await register(contract, "failures", ["run.*"]);
    const fired = await contract.testRule({ scope: testEnvironmentScope(), ruleId: view.ruleId });

    expect(fired.ok).toBe(true);
    if (!fired.ok) throw new Error("unreachable");
    expect(fired.value.eventName).toBe("notifications.test_fired");
    expect(fired.value.summary).toBe("[platos] notifications.test_fired (rule: failures)");
    expect(context.queue.all()).toHaveLength(1);
  });

  it("testRule refuses a disabled rule and enqueues nothing", async () => {
    const view = await register(contract);
    await contract.updateRule({ scope: testEnvironmentScope(), ruleId: view.ruleId, enabled: false });
    const fired = await contract.testRule({ scope: testEnvironmentScope(), ruleId: view.ruleId });

    expect(fired.ok).toBe(false);
    if (fired.ok) throw new Error("unreachable");
    expect(fired.error.code).toBe("EVENTING_RULE_DISABLED");
    expect(context.queue.all()).toHaveLength(0);
  });

  it("testRule refuses an unknown rule", async () => {
    const fired = await contract.testRule({
      scope: testEnvironmentScope(),
      ruleId: asIdentifier<NotificationRuleId>("nope"),
    });
    if (fired.ok) throw new Error("unreachable");
    expect(fired.error.code).toBe("EVENTING_RULE_NOT_FOUND");
  });

  it("round-trips an emitted request back through recordDeliveryFailure", async () => {
    await register(contract, "a", ["*"]);
    const routed = await contract.routeEvent({ event: testDomainEvent({ name: "run.completed" }) });
    if (!routed.ok) throw new Error("unreachable");
    const [emitted] = routed.value.requested;
    if (emitted === undefined) throw new Error("unreachable");

    const outcome = await contract.recordDeliveryFailure(emitted);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.value).toMatchObject({ retrying: true, retryCount: 1, delayMs: 2_000 });
    expect(outcome.value.rescheduled?.retryCount).toBe(1);
  });

  it("reports a terminal give-up as a SUCCESS, not an error", async () => {
    await register(contract, "a", ["*"]);
    const routed = await contract.routeEvent({ event: testDomainEvent({ name: "run.completed" }) });
    if (!routed.ok) throw new Error("unreachable");
    const [emitted] = routed.value.requested;
    if (emitted === undefined) throw new Error("unreachable");

    const outcome = await contract.recordDeliveryFailure({ ...emitted, retryCount: 2 });
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.value).toMatchObject({ retrying: false, retryCount: 3, delayMs: null, rescheduled: null });
  });

  // The returning value has been outside the process; the fact that this context
  // minted it is not evidence about what came back.
  it("RE-PARSES a returning request and refuses a tampered destination", async () => {
    await register(contract, "a", ["*"]);
    const routed = await contract.routeEvent({ event: testDomainEvent({ name: "run.completed" }) });
    if (!routed.ok) throw new Error("unreachable");
    const [emitted] = routed.value.requested;
    if (emitted === undefined) throw new Error("unreachable");

    const tampered = await contract.recordDeliveryFailure({
      ...emitted,
      delivery: { type: "sms", url: "https://example.test" } as never,
    });
    expect(tampered.ok).toBe(false);
    if (tampered.ok) throw new Error("unreachable");
    expect(tampered.error.code).toBe("EVENTING_RULE_DESTINATION_INVALID");
  });

  it("hands out an ErasureTarget naming this context", () => {
    expect(contract.erasureTarget().targetName).toBe("eventing");
  });
});
