import { describe, expect, it } from "vitest";

import { testPorts } from "@platos/context-identity-access/application/index.js";
import type { EndUserId } from "@platos/context-identity-access/application/index.js";
import {
  createTenancyFixture,
  seedMember,
  seedTree,
  type TenancyFixture,
} from "@platos/context-tenancy/application/index.js";
import { OrganizationRole, ProjectRole, type UserId } from "@platos/context-tenancy";
import { asIdentifier, organizationScope, type EnvironmentId, type OrganizationId } from "@platos/kernel";

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
 * The tenancy contract, composed the way an install composes it.
 *
 * The fixture is returned alongside so a case can SEED the tree it is about.
 * Like `testPorts()`, these doubles ship inside the context rather than being
 * written here: they are the conformance fixture tenancy publishes for
 * `packages/adapters/postgres-tenancy`, so a denial observed here is tenancy's
 * denial and not one this file arranged, and a second set of fakes living in
 * `apps/` cannot drift from it.
 */
function composedTenancy(fixture: TenancyFixture = createTenancyFixture()) {
  const app = composeApplication(inputs(undefined, { tenancy: fixture.dependencies }));
  const tenancy = app.contexts.tenancy;
  if (tenancy === undefined) throw new Error("tenancy should have been composed");
  return { tenancy, fixture };
}

/** An already-authenticated operator, as identity-access would hand one over. */
function principal(user: string) {
  const id = asIdentifier<UserId>(user);
  return { actorUserId: id, effectiveUserId: id };
}

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
  it("declares FORTY-FOUR bindings across ADR M0.3 §4's TWELVE adapter directories", () => {
    // The two numbers stopped being the same number at WIN-258 tranche 2:
    // ADR M0.3 §15 lets one directory satisfy more than one port, and
    // `postgres-tenancy` satisfies `TenancyRepository`,
    // `IdentityAccessRepository` and — WIN-258 tranche 5, seven stores over —
    // `ToolsRepository`, `AgentsRepository`, `ScaffoldingRepository`,
    // `BudgetRepository`, `ChannelsRepository`, `SkillsRepository`, `secrets`'
    // two and `governance`'s five, because
    // there is one PostgreSQL database behind one client. All twelve are
    // asserted, and the gap between the two counts is asserted too, so a change
    // that collapsed them back into one count fails.
    //
    // 12 directories + 32 extra ports on the one shared directory = 44 bindings.
    // The directory count does NOT move when a third through THIRTEENTH owner is
    // delegated to it, nor when WIN-258 M2.3 gives tenancy's five
    // NON-REPOSITORY ports slots on the directory that already satisfied them.
    // That is the whole property this pair of numbers exists to state.
    //
    // The ninth owner is `providers`, whose ONE port covers all four of its rows.
    // The tenth is `conversations`, whose FOUR ports close the list: they are
    // four lifetimes rather than one composite — a thread is opened, forked,
    // compacted and archived; a turn and its steps settle together and are never
    // edited again; a postman execution outlives the turn it produced; and the
    // erasure half is the only surface in that context that deletes anything.
    // The eleventh is `skills`, whose ONE port covers its three tables: a
    // catalogue entry, a project's adoption of one and an environment's binding
    // of that adoption are one aggregate with one uniqueness key.
    expect(ADAPTER_BINDINGS).toHaveLength(44);
    expect(DECLARED_BINDING_COUNT).toBe(44);
    // The twelfth is `memory`, whose TWO ports — `MemoryRepository` and
    // `KnowledgeGraphRepository` — are both proven through the PROPERTY that
    // carries them, because `KnowledgeGraphRepository.findEntity(subject,
    // agentIds, entityId)` and `TenancyRepository.findEntity(entityId)` are one
    // name with two signatures and no interface can extend both.
    // The thirteenth is `privacy`, whose ONE port covers its two rows and is
    // proven through the ADAPTER rather than a property: `PrivacyRepository` is
    // `OperationRepository` and `TombstoneRepository` composed, and its ten
    // method names collide with nothing the other twelve owners publish.
    // The fourteenth is `jobs`, whose TWO ports over `Job` and `AgentApproval`
    // are proven the same way and for the same kind of reason:
    // `ApprovalsRepository.erase(selector, transaction)` and
    // `ConversationsErasureStore.erase(plan, transaction)` are one name with two
    // signatures. Its OTHER two ports get no row: `IdempotencyStore` is a
    // reserve-once keyspace and `JobHandlerRuntime` is an isolate, and neither
    // writes a canonical row.
    expect(ADAPTER_NAMES).toHaveLength(12);
    const sharedDirectory = ADAPTER_BINDINGS.filter(
      (binding) => binding.adapter === "postgres-tenancy",
    );
    expect(sharedDirectory.map((binding) => binding.port)).toEqual([
      "TenancyRepository",
      "IdentityAccessRepository",
      "ToolsRepository",
      "AgentsRepository",
      "ScaffoldingRepository",
      "BudgetRepository",
      "ChannelsRepository",
      "SafetyLedger",
      "RatingsRepository",
      "CriteriaRepository",
      "EvalsRepository",
      "GoldenSetsRepository",
      "SecretsRepository",
      "EnvironmentVariableRepository",
      "ProvidersRepository",
      "ThreadRepository",
      "TurnRepository",
      "PostmanRepository",
      "ConversationsErasureStore",
      "SkillsRepository",
      "TenancyLocks",
      "OperatorSessionRevoker",
      "EnvironmentAccessKeyRevocationCounter",
      "InvitationTokenIssuer",
      "OperatorDirectory",
      "MemoryRepository",
      "KnowledgeGraphRepository",
      "PrivacyRepository",
      "JobsRepository",
      "ApprovalsRepository",
    ]);
    expect(sharedDirectory.map((binding) => binding.owner)).toEqual([
      "tenancy",
      "identity-access",
      "tools",
      "agents",
      "agents",
      "cost-monitoring",
      "channels",
      "governance",
      "governance",
      "governance",
      "governance",
      "governance",
      "secrets",
      "secrets",
      "providers",
      "conversations",
      "conversations",
      "conversations",
      "conversations",
      "skills",
      "tenancy",
      "tenancy",
      "tenancy",
      "tenancy",
      "tenancy",
      "memory",
      "memory",
      "privacy",
      "jobs",
      "jobs",
    ]);
  });

  it("names each adapter DIRECTORY exactly once, even though one has THIRTY-THREE bindings", () => {
    // `ADAPTER_NAMES` is what an install iterates to CONSTRUCT adapters. A
    // duplicate there would open a second pool over the one database.
    expect(new Set(ADAPTER_NAMES).size).toBe(ADAPTER_NAMES.length);
    expect(new Set(ADAPTER_BINDINGS.map((binding) => binding.adapter)).size).toBe(
      ADAPTER_NAMES.length,
    );
  });

  it("carries a compile-time satisfaction entry for every declared binding", () => {
    // PORT_SATISFACTION is proven by the compiler; this asserts it is not
    // proving a SUBSET. An adapter dropped from the type would otherwise be
    // silently unproven.
    expect(Object.keys(PORT_SATISFACTION).sort()).toEqual(
      ADAPTER_BINDINGS.map((binding) => `${binding.adapter}:${binding.port}`).sort(),
    );
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
    expect(report.unsatisfied).toHaveLength(44);
    expect(report.faults).toEqual([]);
    expect(describeAdapterSupply(report)).toBe("0/44 adapter bindings satisfied");
    // Reported per BINDING, not per directory. A directory-named report would
    // list `postgres-tenancy` once and say 12/12 while TWENTY of the ports it
    // carries were unserved, which is a readiness endpoint that lies about what
    // is serving.
    expect(report.unsatisfied).toContain("postgres-tenancy:TenancyRepository");
    expect(report.unsatisfied).toContain("postgres-tenancy:IdentityAccessRepository");
    expect(report.unsatisfied).toContain("postgres-tenancy:ToolsRepository");
    expect(report.unsatisfied).toContain("postgres-tenancy:AgentsRepository");
    expect(report.unsatisfied).toContain("postgres-tenancy:ScaffoldingRepository");
    expect(report.unsatisfied).toContain("postgres-tenancy:BudgetRepository");
    expect(report.unsatisfied).toContain("postgres-tenancy:ProvidersRepository");
    expect(report.unsatisfied).toContain("postgres-tenancy:ChannelsRepository");
    // WIN-258 M2.3. The five that had no slot until now, and the reason the
    // slots exist: readiness could not previously say the session revoker was
    // unwired, because nothing declared it as a binding to be unsatisfied.
    expect(report.unsatisfied).toContain("postgres-tenancy:TenancyLocks");
    expect(report.unsatisfied).toContain("postgres-tenancy:OperatorSessionRevoker");
    expect(report.unsatisfied).toContain("postgres-tenancy:EnvironmentAccessKeyRevocationCounter");
    expect(report.unsatisfied).toContain("postgres-tenancy:InvitationTokenIssuer");
    expect(report.unsatisfied).toContain("postgres-tenancy:OperatorDirectory");

  });

  it("accepts an adapter that identifies its own slot", () => {
    const report = reportAdapterSupply({ outbox: adapterDouble("outbox") } as SuppliedAdapters);
    expect(report.satisfied).toEqual(["outbox:OutboxWriter"]);
    expect(report.unsatisfied).toHaveLength(43);

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
    expect(report.faults[0]).toContain("is not one of the 12 declared adapters");
  });
});

describe("composing the application", () => {
  it("composes with nothing wired and reports the gap rather than pretending", () => {
    const app = composeApplication(inputs());
    expect(app.bindings.unsatisfied).toHaveLength(44);

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
    expect(app.bindings.satisfied).toEqual(["outbox:OutboxWriter"]);
    expect(app.bindings.unsatisfied).toHaveLength(43);

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

describe("composing tenancy", () => {
  it("LEAVES THE CONTEXT ABSENT when no port bundle is supplied", () => {
    expect(composeApplication(inputs()).contexts.tenancy).toBeUndefined();
  });

  it("composes the published contract when the bundle is supplied", () => {
    expect(composedTenancy().tenancy.name).toBe("tenancy");
  });

  it("composes BOTH contexts without either displacing the other", () => {
    // The root merges two optional bundles into one frozen object. A spread
    // written the other way round — or an early return — would silently drop
    // whichever context was composed second, and every refusal case below would
    // still pass because it composes tenancy alone.
    const app = composeApplication(
      inputs(undefined, { identityAccess: testPorts(), tenancy: createTenancyFixture().dependencies }),
    );
    expect(Object.keys(app.contexts).sort()).toEqual(["identityAccess", "tenancy"]);
  });

  it("GRANTS AN ACTIVE ORGANIZATION ADMIN, so the wiring cannot be a stub that always denies", async () => {
    // The positive control. Every case after this one asserts a refusal, and a
    // façade wired to a dead repository would satisfy all of them.
    const { tenancy, fixture } = composedTenancy();
    const tree = seedTree(fixture.store);
    seedMember(fixture.store, tree, "ada", { organizationRole: OrganizationRole.ADMIN });
    const decision = await tenancy.authorizeEnvironmentOperator({
      environmentId: tree.environment.id,
      operator: principal("ada"),
      access: "metadata",
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.value.scope.environmentId).toBe(tree.environment.id);
    expect(decision.value.organizationRole).toBe(OrganizationRole.ADMIN);
    // The value the composed contract returns must still be the unforgeable one
    // tenancy minted, not a structural copy that crossed the seam.
    expect(tenancy.verifyAuthorization(decision.value).ok).toBe(true);
    expect(tenancy.verifyAuthorization({ ...decision.value }).ok).toBe(false);
  });

  it("REFUSES AN ENVIRONMENT THAT DOES NOT EXIST", async () => {
    const { tenancy } = composedTenancy();
    const refusal = await tenancy.authorizeEnvironmentOperator({
      environmentId: asIdentifier<EnvironmentId>("no-such-environment"),
      operator: principal("ada"),
      access: "metadata",
    });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.code).toBe("TENANCY_ENVIRONMENT_FORBIDDEN");
    expect(refusal.error.details).toEqual({ gate: "archived-ancestor" });
  });

  it("REFUSES ACROSS TENANTS — an admin of one organization is denied the other's environment", async () => {
    const { tenancy, fixture } = composedTenancy();
    const mine = seedTree(fixture.store, "acme");
    const theirs = seedTree(fixture.store, "globex");
    seedMember(fixture.store, mine, "ada", { organizationRole: OrganizationRole.ADMIN });
    // Ada is an ADMIN — of the WRONG organization. Gate 3 would wave an admin
    // through, so the denial has to come from gate 2 finding no membership in
    // the organization the LEAF resolves to.
    const refusal = await tenancy.authorizeEnvironmentOperator({
      environmentId: theirs.environment.id,
      operator: principal("ada"),
      access: "metadata",
    });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.details).toEqual({ gate: "organization-membership" });
  });

  it("REFUSES UNDER AN ARCHIVED ORGANIZATION, even its own owner", async () => {
    const { tenancy, fixture } = composedTenancy();
    const tree = seedTree(fixture.store);
    seedMember(fixture.store, tree, "ada", { organizationRole: OrganizationRole.OWNER });
    fixture.store.organizations[0] = { ...tree.organization, archivedAt: new Date("2026-02-01T00:00:00.000Z") };
    const refusal = await tenancy.authorizeEnvironmentOperator({
      environmentId: tree.environment.id,
      operator: principal("ada"),
      access: "metadata",
    });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.details).toEqual({ gate: "archived-ancestor" });
  });

  it("REFUSES A DEACTIVATED MEMBER whose row is still on the tree", async () => {
    const { tenancy, fixture } = composedTenancy();
    const tree = seedTree(fixture.store);
    seedMember(fixture.store, tree, "ada", {
      organizationRole: OrganizationRole.OWNER,
      deactivatedAt: new Date("2026-01-15T00:00:00.000Z"),
    });
    const refusal = await tenancy.authorizeEnvironmentOperator({
      environmentId: tree.environment.id,
      operator: principal("ada"),
      access: "metadata",
    });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.details).toEqual({ gate: "organization-membership" });
  });

  it("REFUSES A PROJECT VIEWER a secret mutation while allowing them metadata", async () => {
    // Gate 4, and the pair that proves it is gate 4 rather than an outright
    // denial: the same operator on the same environment is allowed at
    // `metadata` and refused at `secret:mutate`.
    const { tenancy, fixture } = composedTenancy();
    const tree = seedTree(fixture.store);
    seedMember(fixture.store, tree, "vic", {
      organizationRole: OrganizationRole.MEMBER,
      projectRole: ProjectRole.VIEWER,
    });
    const request = { environmentId: tree.environment.id, operator: principal("vic") } as const;
    expect((await tenancy.authorizeEnvironmentOperator({ ...request, access: "metadata" })).ok).toBe(true);
    const refusal = await tenancy.authorizeEnvironmentOperator({ ...request, access: "secret:mutate" });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.details).toEqual({ gate: "secret-mutate-role" });
  });

  it("REFUSES to resolve a scope for an environment that does not exist", async () => {
    const { tenancy } = composedTenancy();
    const refusal = await tenancy.resolveEnvironmentScope(
      asIdentifier<EnvironmentId>("no-such-environment"),
    );
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.code).toBe("TENANCY_NOT_FOUND");
  });

  it("keeps each composition's tenant tree to itself", async () => {
    // Two installs, two bundles, two stores. Asserted by seeding REAL STATE in
    // one and showing the other cannot see it — not by comparing object
    // identity, which two factory calls satisfy trivially and which a
    // module-level store behind them would satisfy too.
    const first = composedTenancy();
    const tree = seedTree(first.fixture.store);
    seedMember(first.fixture.store, tree, "ada", { organizationRole: OrganizationRole.ADMIN });
    const request = {
      environmentId: tree.environment.id,
      operator: principal("ada"),
      access: "metadata",
    } as const;
    expect((await first.tenancy.authorizeEnvironmentOperator(request)).ok).toBe(true);
    expect((await composedTenancy().tenancy.authorizeEnvironmentOperator(request)).ok).toBe(false);
  });
});

describe("the read models the composition root now reaches", () => {
  it("SHOWS AN OPERATOR ONLY THE PROJECTS THEY CAN SEE, through the composed contract", async () => {
    // `operatorVisibleProjectWhere` was an authorization rule that existed only
    // as a Prisma fragment inside the Remix tree. Reaching the ported rule from
    // here is what shows it is now a decision the composition root can serve.
    const { tenancy, fixture } = composedTenancy();
    const mine = seedTree(fixture.store, "acme");
    const theirs = seedTree(fixture.store, "globex");
    seedMember(fixture.store, mine, "ada", { organizationRole: OrganizationRole.ADMIN });
    seedMember(fixture.store, theirs, "mel", { organizationRole: OrganizationRole.OWNER });

    const visible = await tenancy.listVisibleProjects(asIdentifier<UserId>("ada"));
    expect(visible.ok).toBe(true);
    if (!visible.ok) return;
    expect(visible.value.map((row) => row.project.id)).toEqual([mine.project.id]);
    expect(visible.value[0]?.through).toBe("organization-admin");
  });

  it("REFUSES TO LIST ANOTHER TENANT'S END USERS, through the composed contract", async () => {
    const ports = testPorts();
    for (const [id, organizationId] of [
      ["mine", asIdentifier<OrganizationId>("org-1")],
      ["theirs", asIdentifier<OrganizationId>("org-2")],
    ] as const) {
      ports.repository.state.endUsers.set(asIdentifier<EndUserId>(id), {
        endUserId: asIdentifier<EndUserId>(id),
        organizationId,
        displayName: id,
        disabledAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      });
    }
    const app = composeApplication(inputs(undefined, { identityAccess: ports }));
    const identityAccess = app.contexts.identityAccess;
    if (identityAccess === undefined) throw new Error("identity-access should have been composed");

    const page = await identityAccess.listEndUsers({ scope: TENANT });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.users.map((user) => user.endUserId)).toEqual(["mine"]);
    expect(page.value.total).toBe(1);
  });

  it("KEEPS A BAD PAGE SIZE A REFUSAL at the composition root too", async () => {
    const app = composeApplication(inputs(undefined, { identityAccess: testPorts() }));
    const identityAccess = app.contexts.identityAccess;
    if (identityAccess === undefined) throw new Error("identity-access should have been composed");
    const refusal = await identityAccess.listEndUsers({ scope: TENANT, limit: 101 });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.code).toBe("INVALID_END_USER_FILTER");
  });
});

describe("the session-cookie exchange contract, reached from the composition root", () => {
  function composedIdentityAccessAt() {
    const app = composeApplication(inputs(undefined, { identityAccess: testPorts() }));
    const identityAccess = app.contexts.identityAccess;
    if (identityAccess === undefined) throw new Error("identity-access should have been composed");
    return identityAccess;
  }

  it("CORE DECIDES EVERY ATTRIBUTE, so a BFF has nothing left to choose", () => {
    // The shape that used to live in `apps/webapp/app/services/auth.server.ts`.
    // A front end deciding the security properties of the credential Core issues
    // is the wrong way round; this is the assertion that it no longer does.
    const shape = composedIdentityAccessAt().describeSessionCookie({ secure: true });
    expect(shape.ok).toBe(true);
    if (!shape.ok) return;
    expect(shape.value).toEqual({
      name: "__Host-platos_operator_session",
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: true,
      domain: null,
    });
  });

  it("DROPS THE __Host- PREFIX where there is no TLS, or the browser would drop the cookie", () => {
    const shape = composedIdentityAccessAt().describeSessionCookie({ secure: false });
    expect(shape.ok).toBe(true);
    if (!shape.ok) return;
    expect(shape.value.name).toBe("platos_operator_session");
    expect(shape.value.secure).toBe(false);
  });

  it("REFUSES A DIRECTIVE MODIFIED AFTER IT LEFT CORE", async () => {
    const identityAccess = composedIdentityAccessAt();
    const issued = identityAccess.issueSessionCookie({
      secure: true,
      token: "plt_os_live",
      sessionExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(identityAccess.verifySessionCookie(issued.value).ok).toBe(true);
    expect(
      identityAccess.verifySessionCookie({
        ...issued.value,
        shape: { ...issued.value.shape, secure: false },
      }).ok,
    ).toBe(false);
  });
});
