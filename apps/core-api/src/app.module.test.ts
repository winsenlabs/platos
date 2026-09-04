import { describe, expect, it } from "vitest";

import { testPorts } from "@platos/context-identity-access/application/index.js";
import { asIdentifier, organizationScope, type OrganizationId } from "@platos/kernel";

import { CompositionFault, DECLARED_BINDING_COUNT, composeApplication } from "./app.module.js";
import type { SuppliedContextPorts } from "./app.module.js";
import { ADAPTER_BINDINGS, ADAPTER_NAMES, PORT_SATISFACTION, type SuppliedAdapters } from "./composition/adapter-bindings.js";
import { describeAdapterSupply, reportAdapterSupply } from "./composition/registry.js";
import { loadCoreApiConfiguration } from "./config/load.js";
import { createProcessLogger, systemClock, ulidGenerator } from "./runtime/process-ports.js";

function configuration() {
  const outcome = loadCoreApiConfiguration({ PLATOS_ENVIRONMENT: "test" });
  if (!outcome.ok) throw new Error("fixture configuration must be valid");
  return outcome.value;
}

function inputs(adapters?: SuppliedAdapters, ports?: SuppliedContextPorts) {
  const clock = systemClock();
  return {
    configuration: configuration(),
    clock,
    ids: ulidGenerator(clock),
    logger: createProcessLogger({ minimumLevel: "error", write: () => {} }),
    adapters,
    ports,
  };
}

/**
 * The identity-access contract, composed the way an install composes it.
 *
 * `testPorts()` is the context's OWN in-memory bundle, shipped from its
 * `application/` for exactly this: it enforces what the real stores enforce, so
 * a refusal observed here is the refusal the context makes rather than one this
 * file arranged.
 */
function composedIdentityAccess() {
  const app = composeApplication(inputs(undefined, { identityAccess: testPorts() }));
  const identityAccess = app.contexts.identityAccess;
  if (identityAccess === undefined) throw new Error("identity-access should have been composed");
  return identityAccess;
}

const TENANT = organizationScope(asIdentifier<OrganizationId>("org-1"));

/**
 * A stand-in for an adapter that does not exist yet.
 *
 * Every adapter package publishes an interface carrying its own directory name
 * as a literal, so an instance can identify its own slot. That literal is the
 * only thing composition validation reads, which is why a double is enough to
 * exercise the real validation path.
 */
function adapterDouble(name: string): unknown {
  return { adapterName: name };
}

describe("the declared binding table", () => {
  it("declares twelve bindings, matching ADR M0.3 §4's twelve adapters", () => {
    expect(ADAPTER_BINDINGS).toHaveLength(12);
    expect(DECLARED_BINDING_COUNT).toBe(12);
  });

  it("names each adapter exactly once", () => {
    expect(new Set(ADAPTER_NAMES).size).toBe(ADAPTER_NAMES.length);
  });

  it("carries a compile-time satisfaction entry for every declared binding", () => {
    // PORT_SATISFACTION is proven by the compiler; this asserts it is not
    // proving a SUBSET. An adapter dropped from the type would otherwise be
    // silently unproven.
    expect(Object.keys(PORT_SATISFACTION).sort()).toEqual([...ADAPTER_NAMES].sort());
    expect(Object.values(PORT_SATISFACTION).every((value) => value === true)).toBe(true);
  });

  it("assigns the two Notifier adapters to the same owner and port", () => {
    // The pair that makes the mis-wire check load-bearing: they are structurally
    // identical, so only the runtime name distinguishes them.
    const notifiers = ADAPTER_BINDINGS.filter((binding) => binding.port === "Notifier");
    expect(notifiers.map((binding) => binding.adapter)).toEqual(["notifier-email", "notifier-webhook"]);
    expect(new Set(notifiers.map((binding) => binding.owner))).toEqual(new Set(["cost-monitoring"]));
  });
});

describe("adapter supply validation", () => {
  it("reports every binding unsatisfied when nothing is wired — the honest M2.1b state", () => {
    const report = reportAdapterSupply({});
    expect(report.satisfied).toEqual([]);
    expect(report.unsatisfied).toHaveLength(12);
    expect(report.faults).toEqual([]);
    expect(describeAdapterSupply(report)).toBe("0/12 adapter bindings satisfied");
  });

  it("accepts an adapter that identifies its own slot", () => {
    const report = reportAdapterSupply({ outbox: adapterDouble("outbox") } as SuppliedAdapters);
    expect(report.satisfied).toEqual(["outbox"]);
    expect(report.unsatisfied).toHaveLength(11);
    expect(report.faults).toEqual([]);
  });

  it("detects the mis-wire the type system cannot see", () => {
    // `notifier-email` and `notifier-webhook` both implement `Notifier`, so this
    // swap type-checks. Undetected, every cost alert goes down the wrong channel.
    const report = reportAdapterSupply({
      "notifier-email": adapterDouble("notifier-webhook"),
    } as SuppliedAdapters);
    expect(report.faults).toHaveLength(1);
    expect(report.faults[0]).toContain('slot "notifier-email" holds "notifier-webhook"');
    expect(report.satisfied).toEqual([]);
  });

  it("rejects an instance that cannot identify itself", () => {
    const report = reportAdapterSupply({ outbox: {} } as SuppliedAdapters);
    expect(report.faults[0]).toContain("without an adapterName");
  });

  it("rejects an adapter name that is not one of the declared bindings", () => {
    const report = reportAdapterSupply({ "redis-queue": adapterDouble("redis-queue") } as SuppliedAdapters);
    expect(report.faults[0]).toContain("is not one of the 12 declared bindings");
  });
});

describe("composing the application", () => {
  it("composes with nothing wired and reports the gap rather than pretending", () => {
    const app = composeApplication(inputs());
    expect(app.bindings.unsatisfied).toHaveLength(12);
    expect(app.contexts).toEqual({});
    expect(app.inFlight.count).toBe(0);
    expect(Object.isFrozen(app)).toBe(true);
  });

  it("REFUSES to compose when an adapter is mis-wired", () => {
    // Fail closed: a mis-wire can only be a programming error, and no amount of
    // waiting fixes it, so it must stop the process rather than degrade it.
    expect(() =>
      composeApplication(inputs({ "redis-cache": adapterDouble("redis-streams") } as SuppliedAdapters)),
    ).toThrow(CompositionFault);
  });

  it("carries the fault detail without leaking configuration values", () => {
    try {
      composeApplication(inputs({ "redis-cache": adapterDouble("redis-streams") } as SuppliedAdapters));
      expect.unreachable("composition should have refused");
    } catch (error) {
      expect(error).toBeInstanceOf(CompositionFault);
      const fault = error as CompositionFault;
      expect(fault.faults).toHaveLength(1);
      expect(fault.message).not.toContain("127.0.0.1");
    }
  });

  it("records a satisfied binding and leaves the rest unsatisfied", () => {
    const app = composeApplication(inputs({ outbox: adapterDouble("outbox") } as SuppliedAdapters));
    expect(app.bindings.satisfied).toEqual(["outbox"]);
    expect(app.bindings.unsatisfied).toHaveLength(11);
  });

  it("does not compose a context from an adapter supply alone", () => {
    // A context is composed from the port bundle an install hands to
    // `ports`, never inferred from an adapter that happens to be present, so
    // supplying an unrelated adapter reaches no context at all.
    const app = composeApplication(inputs({ outbox: adapterDouble("outbox") } as SuppliedAdapters));
    expect(Object.keys(app.contexts)).toEqual([]);
  });
});

describe("composing identity-access", () => {
  it("LEAVES THE CONTEXT ABSENT when no port bundle is supplied", () => {
    // Absent rather than a façade over undefined stores: an install that forgot
    // to wire the identity store must be visible before it serves a request,
    // not at the first authentication.
    expect(composeApplication(inputs()).contexts.identityAccess).toBeUndefined();
  });

  it("composes the published contract when the bundle is supplied", () => {
    expect(composedIdentityAccess().name).toBe("identity-access");
  });

  it("REFUSES A REQUEST CARRYING NO SESSION TOKEN", async () => {
    const refusal = await composedIdentityAccess().authenticateOperator({ presentedToken: null });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.code).toBe("UNAUTHENTICATED");
  });

  it("REFUSES A SESSION TOKEN THAT MATCHES NOTHING IN THE STORE", async () => {
    const refusal = await composedIdentityAccess().authenticateOperator({
      presentedToken: "plt_os_not-a-real-token",
    });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.code).toBe("UNAUTHENTICATED");
  });

  it("REFUSES AN UNKNOWN BEARER CREDENTIAL", async () => {
    const refusal = await composedIdentityAccess().authenticateBearer({
      presentedToken: "plt_mcp_not-a-real-token",
      requestedScope: TENANT,
    });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.code).toBe("UNAUTHENTICATED");
  });

  it("SPENDS A REAL BUDGET, so the wiring cannot be a stub that always allows", async () => {
    // Eleven LOGIN requests against a ten-request window. A façade wired to a
    // dead limiter would allow all eleven; the eleventh must be refused, and the
    // refusal must carry the wait.
    const identityAccess = composedIdentityAccess();
    const request = {
      action: "LOGIN",
      identifier: "operator@example.com",
      scope: TENANT,
      principalId: null,
    } as const;
    for (let spent = 0; spent < 10; spent += 1) {
      expect((await identityAccess.consumeRateLimit(request)).ok).toBe(true);
    }
    const refusal = await identityAccess.consumeRateLimit(request);
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.code).toBe("RATE_LIMITED");
    expect(refusal.error.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("keeps each composition's budget to itself", async () => {
    // Two installs, two bundles, two limiters. Asserted by SPENDING one budget
    // to exhaustion and showing a second composition still allows — not by
    // comparing object identity, which two factory calls satisfy trivially and
    // which a module-level limiter behind them would satisfy too.
    const first = composedIdentityAccess();
    const request = {
      action: "LOGIN",
      identifier: "operator@example.com",
      scope: TENANT,
      principalId: null,
    } as const;
    for (let spent = 0; spent < 10; spent += 1) await first.consumeRateLimit(request);
    expect((await first.consumeRateLimit(request)).ok).toBe(false);
    expect((await composedIdentityAccess().consumeRateLimit(request)).ok).toBe(true);
  });
});
