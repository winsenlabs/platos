// The operator gate, on every published method that has one.
//
// `tools` is the first adopted context to publish FOURTEEN operator-authorized
// methods, and the guard behind them used to be the same two hand-written lines
// copied to each. ELEVEN OF THE FOURTEEN COULD HAVE THEIR COPY DELETED WITH THE
// WHOLE SUITE GREEN — `pageTools`, `findTools`, `setToolEnabled`,
// `describeMcpSurface`, `configureMcpSurface`, `listEntityToolPolicies`,
// `setEntityToolPolicy`, `listOrganizationPolicies`, `setOrganizationPolicy`,
// `deleteOrganizationPolicy` and `discoverEntityTools`. Six of the eleven
// MUTATE. Only `registerTools`, `readToolAudit` and `listTools` had a case that
// noticed, which is what a guard copied fourteen times decays into: the copy is
// cheap and the proof is not.
//
// THE GATE ITSELF IS NOW ONE FUNCTION — `application/authorization.ts`'s
// `withOperator`, the only export that hands out a verified grant. This file is
// what proves each use case still goes through it.
//
// IT IS ITS OWN FILE because it is its own claim. Folding it into the
// contracts-barrel suite would have pushed that file past the ADR M0.3 §6
// warning line and buried a security boundary inside a suite about view
// shapes.
//
// THE REFUSAL IS ASSERTED THROUGH THE CONTRACT, NOT THE USE CASE, because the
// binder sits between them: a binder that dropped the caller's authorization
// would leave every use-case-level refusal passing and production open.
//
// EVERY REFUSAL HAS ITS OWN POSITIVE CONTROL. A method that refused everything
// would satisfy a refusal case for the wrong reason, so each is paired with the
// same call under a grant tenancy DID mint, which must not fail FOR THAT
// REASON. It may still fail for its own — a surface not configured, a policy
// row absent — and those are different refusals, named differently.
//
// EVERY CASE IS WRITTEN OUT. A loop over the table would declare the same
// twenty-eight assertions in four lines and the test-case census could not
// count them, which is the canary that has caught three waves on this package
// already. The table is still the single source of the calls; only the `it()`
// declarations are unrolled.

import { asIdentifier, type EntityId, type Result } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import {
  asToolsIdentifier,
  type ExternalEntityId,
  type OrganizationMcpPolicyId,
  type ToolId,
} from "../domain/index.js";
import {
  buildToolsTestContext,
  testExposure,
  testVaultAuthorization,
  type ToolsTestContext,
} from "../application/testing/index.js";
import { toolsContract, type ToolsContract } from "./index.js";

const ENTITY = asIdentifier<EntityId>("entity-pk-1");
const EXTERNAL = asToolsIdentifier<ExternalEntityId>("acme-backend");

/**
 * A hand-written object literal, shaped exactly like a grant and minted by
 * nobody. `InMemoryTenancy` recognises only the grants it issued, which is the
 * identity-not-shape rule the real `tenancy` applies, so this is what a caller
 * forging an authorization across a transport boundary looks like from here.
 */
const FORGED = Object.freeze({ access: "secret:mutate", scope: { kind: "environment" } });

/** The reason a refusal gives, or null when the call was admitted. */
function reasonOf(answered: Result<unknown>): unknown {
  return answered.ok ? null : answered.error.details.reason;
}

let context: ToolsTestContext;
let contract: ToolsContract;
let invocations: ReturnType<typeof buildInvocations>;

/**
 * The three methods that carry no operator grant, each for a stated reason.
 *
 * `listCallableForMcpCaller` is the hosted MCP surface and takes a THIRD
 * PARTY's bearer credential, verified by identity-access and proved in
 * `application/tool-policy.test.ts`. `executeTool` and `resolvePermission` are
 * reached by a runtime already authorized upstream and take a scope rather than
 * a grant. Naming them here is what makes their absence from the table a
 * decision rather than an omission.
 */
const CREDENTIAL_AUTHORIZED = ["listCallableForMcpCaller", "executeTool", "resolvePermission"];

beforeEach(() => {
  context = buildToolsTestContext();
  contract = toolsContract(context.dependencies);
  context.tenancy.seedEntity(ENTITY, EXTERNAL);
  context.repository.seedExposure(testExposure(context.scope, { entityId: ENTITY }));

  invocations = buildInvocations(contract);
});

/**
 * Every operator-authorized call, once, with the authorization left open.
 *
 * The keys are INFERRED rather than declared as a `Record<string, …>`, so
 * `invocations.setToolEnabled` is a call and not a possibly-absent one — the
 * table is exhaustive by construction and a typo in a case below does not
 * compile.
 */
function buildInvocations(bound: ToolsContract) {
  return {
    registerTools: (authorization: unknown) =>
      bound.registerTools({
        authorization,
        entityId: ENTITY,
        externalEntityId: EXTERNAL,
        tools: [{ name: "files.upload" }],
        callbackUrl: null,
      }),
    listTools: (authorization: unknown) => bound.listTools({ authorization }),
    pageTools: (authorization: unknown) => bound.pageTools({ authorization, limit: 10, offset: 0 }),
    setToolEnabled: (authorization: unknown) =>
      bound.setToolEnabled({ authorization, exposureId: "exposure-1", enabled: false }),
    findTools: (authorization: unknown) => bound.findTools({ authorization, query: "upload" }),
    discoverEntityTools: (authorization: unknown) =>
      bound.discoverEntityTools({
        authorization,
        entityId: ENTITY,
        externalEntityId: EXTERNAL,
        vaultAuthorization: testVaultAuthorization(),
      }),
    describeMcpSurface: (authorization: unknown) =>
      bound.describeMcpSurface({ authorization, entityId: ENTITY }),
    configureMcpSurface: (authorization: unknown) =>
      bound.configureMcpSurface({ authorization, entityId: ENTITY, enabled: true }),
    listEntityToolPolicies: (authorization: unknown) =>
      bound.listEntityToolPolicies({ authorization, entityId: ENTITY }),
    setEntityToolPolicy: (authorization: unknown) =>
      bound.setEntityToolPolicy({
        authorization,
        entityId: ENTITY,
        toolId: asToolsIdentifier<ToolId>("tool-1"),
        exposed: true,
      }),
    listOrganizationPolicies: (authorization: unknown) =>
      bound.listOrganizationPolicies({ authorization }),
    setOrganizationPolicy: (authorization: unknown) =>
      bound.setOrganizationPolicy({ authorization, pattern: "gdpr.*", state: "block" }),
    deleteOrganizationPolicy: (authorization: unknown) =>
      bound.deleteOrganizationPolicy({
        authorization,
        organizationMcpPolicyId: asToolsIdentifier<OrganizationMcpPolicyId>("policy-1"),
      }),
    readToolAudit: (authorization: unknown) => bound.readToolAudit({ authorization }),
  };
}

async function expectRefused(
  invoke: (authorization: unknown) => Promise<Result<unknown>>,
): Promise<void> {
  const refused = await invoke(FORGED);
  expect(refused.ok).toBe(false);
  expect(!refused.ok && refused.error.code).toBe("TOOLS_REPOSITORY_UNAVAILABLE");
  expect(reasonOf(refused)).toBe("authorization_not_issued");
}

async function expectAdmitted(
  invoke: (authorization: unknown) => Promise<Result<unknown>>,
): Promise<void> {
  expect(reasonOf(await invoke(context.tenancy.grant()))).not.toBe("authorization_not_issued");
}

describe("the operator gate, on every method that has one", () => {
  it("classifies every published method, so a new one cannot arrive unclassified", () => {
    const published = Object.keys(contract).filter((method) => method !== "name");
    expect([...Object.keys(invocations), ...CREDENTIAL_AUTHORIZED].sort()).toEqual(
      published.sort(),
    );
  });

  it("registerTools refuses a grant tenancy did not mint", async () => {
    await expectRefused(invocations.registerTools);
  });

  it("registerTools admits a grant tenancy did mint", async () => {
    await expectAdmitted(invocations.registerTools);
  });

  it("listTools refuses a grant tenancy did not mint", async () => {
    await expectRefused(invocations.listTools);
  });

  it("listTools admits a grant tenancy did mint", async () => {
    await expectAdmitted(invocations.listTools);
  });

  it("pageTools refuses a grant tenancy did not mint", async () => {
    await expectRefused(invocations.pageTools);
  });

  it("pageTools admits a grant tenancy did mint", async () => {
    await expectAdmitted(invocations.pageTools);
  });

  it("setToolEnabled refuses a grant tenancy did not mint", async () => {
    await expectRefused(invocations.setToolEnabled);
  });

  it("setToolEnabled admits a grant tenancy did mint", async () => {
    await expectAdmitted(invocations.setToolEnabled);
  });

  it("findTools refuses a grant tenancy did not mint", async () => {
    await expectRefused(invocations.findTools);
  });

  it("findTools admits a grant tenancy did mint", async () => {
    await expectAdmitted(invocations.findTools);
  });

  it("discoverEntityTools refuses a grant tenancy did not mint", async () => {
    await expectRefused(invocations.discoverEntityTools);
  });

  it("discoverEntityTools admits a grant tenancy did mint", async () => {
    await expectAdmitted(invocations.discoverEntityTools);
  });

  it("describeMcpSurface refuses a grant tenancy did not mint", async () => {
    await expectRefused(invocations.describeMcpSurface);
  });

  it("describeMcpSurface admits a grant tenancy did mint", async () => {
    await expectAdmitted(invocations.describeMcpSurface);
  });

  it("configureMcpSurface refuses a grant tenancy did not mint", async () => {
    await expectRefused(invocations.configureMcpSurface);
  });

  it("configureMcpSurface admits a grant tenancy did mint", async () => {
    await expectAdmitted(invocations.configureMcpSurface);
  });

  it("listEntityToolPolicies refuses a grant tenancy did not mint", async () => {
    await expectRefused(invocations.listEntityToolPolicies);
  });

  it("listEntityToolPolicies admits a grant tenancy did mint", async () => {
    await expectAdmitted(invocations.listEntityToolPolicies);
  });

  it("setEntityToolPolicy refuses a grant tenancy did not mint", async () => {
    await expectRefused(invocations.setEntityToolPolicy);
  });

  it("setEntityToolPolicy admits a grant tenancy did mint", async () => {
    await expectAdmitted(invocations.setEntityToolPolicy);
  });

  it("listOrganizationPolicies refuses a grant tenancy did not mint", async () => {
    await expectRefused(invocations.listOrganizationPolicies);
  });

  it("listOrganizationPolicies admits a grant tenancy did mint", async () => {
    await expectAdmitted(invocations.listOrganizationPolicies);
  });

  it("setOrganizationPolicy refuses a grant tenancy did not mint", async () => {
    await expectRefused(invocations.setOrganizationPolicy);
  });

  it("setOrganizationPolicy admits a grant tenancy did mint", async () => {
    await expectAdmitted(invocations.setOrganizationPolicy);
  });

  it("deleteOrganizationPolicy refuses a grant tenancy did not mint", async () => {
    await expectRefused(invocations.deleteOrganizationPolicy);
  });

  it("deleteOrganizationPolicy admits a grant tenancy did mint", async () => {
    await expectAdmitted(invocations.deleteOrganizationPolicy);
  });

  it("readToolAudit refuses a grant tenancy did not mint", async () => {
    await expectRefused(invocations.readToolAudit);
  });

  it("readToolAudit admits a grant tenancy did mint", async () => {
    await expectAdmitted(invocations.readToolAudit);
  });
});
