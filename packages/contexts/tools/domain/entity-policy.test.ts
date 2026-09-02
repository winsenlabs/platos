import { asIdentifier, type EntityId, type EnvironmentId } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  decodeLabels,
  encodeLabels,
  exposedToolNames,
  filterForCaller,
  identityRank,
  IDENTITY_MODES,
  PAT_LABEL_PREFIX,
  permitsCaller,
  synthesizeDenial,
  type EntityToolPolicy,
  type McpCaller,
} from "./entity-policy.js";
import {
  asToolsIdentifier,
  type ActorId,
  type EntityToolPolicyId,
  type ToolId,
  type ToolName,
} from "./identifiers.js";
import { DEFAULT_TOOLS_POLICY } from "./policy.js";

const ACL = DEFAULT_TOOLS_POLICY.acl;
const ENVIRONMENT = asIdentifier<EnvironmentId>("env-1");
const ENTITY = asIdentifier<EntityId>("entity-pk-1");

function policy(overrides: Partial<EntityToolPolicy> = {}): EntityToolPolicy {
  return {
    entityToolPolicyId: asToolsIdentifier<EntityToolPolicyId>("policy-1"),
    environmentId: ENVIRONMENT,
    entityId: ENTITY,
    toolId: asToolsIdentifier<ToolId>("tool-1"),
    toolName: asToolsIdentifier<ToolName>("files.upload"),
    effect: "ALLOW",
    minIdentityMode: "bearer",
    scopeLabels: [],
    allowedPatIds: [],
    addedBy: asToolsIdentifier<ActorId>("operator-1"),
    addedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReviewedAt: null,
    ...overrides,
  };
}

function caller(overrides: Partial<McpCaller> = {}): McpCaller {
  return { identityMode: "bearer", principalId: "mcp:pat:pat-1", scopes: [], ...overrides };
}

describe("identity modes", () => {
  it("are a total order, so raising a minimum can only remove callers", () => {
    expect([...IDENTITY_MODES]).toEqual(["anonymous", "bearer", "oidc"]);
    expect(identityRank("anonymous")).toBeLessThan(identityRank("bearer"));
    expect(identityRank("bearer")).toBeLessThan(identityRank("oidc"));
  });

  it("treat an unrecognised mode as the weakest, never the strongest", () => {
    expect(identityRank("something-new")).toBe(identityRank("anonymous"));
  });
});

describe("the two meanings packed into one label column", () => {
  it("splits scope labels from token ids", () => {
    expect(decodeLabels(["mcp:tools", `${PAT_LABEL_PREFIX}pat-1`, "billing"])).toEqual({
      scopeLabels: ["mcp:tools", "billing"],
      allowedPatIds: ["pat-1"],
    });
  });

  it("round-trips both halves", () => {
    const encoded = encodeLabels(["mcp:tools"], ["pat-1", "pat-2"]);
    expect(decodeLabels(encoded)).toEqual({
      scopeLabels: ["mcp:tools"],
      allowedPatIds: ["pat-1", "pat-2"],
    });
  });

  it("DROPS a scope label that carries the token prefix, rather than escaping it", () => {
    // Round-tripping it would let an operator grant a token by typing a scope
    // label, which is a privilege escalation through a text field.
    const encoded = encodeLabels([`${PAT_LABEL_PREFIX}smuggled`], []);
    expect(decodeLabels(encoded).allowedPatIds).toEqual([]);
    expect(encoded).toEqual([]);
  });

  it("does not duplicate a token that was already encoded", () => {
    expect(encodeLabels([], ["pat-1", "pat-1"])).toEqual([`${PAT_LABEL_PREFIX}pat-1`]);
  });
});

describe("whether a caller may use a tool", () => {
  it("refuses anything that is not an explicit ALLOW", () => {
    expect(permitsCaller(policy({ effect: "DENY" }), caller())).toBe(false);
  });

  it("refuses a caller whose identity ranks below the tool's minimum", () => {
    expect(permitsCaller(policy({ minIdentityMode: "oidc" }), caller())).toBe(false);
    expect(permitsCaller(policy({ minIdentityMode: "oidc" }), caller({ identityMode: "oidc" }))).toBe(
      true,
    );
  });

  it("checks the token list only for bearer callers, who are the ones that have an id", () => {
    const pinned = policy({ allowedPatIds: ["pat-9"] });
    expect(permitsCaller(pinned, caller())).toBe(false);
    expect(permitsCaller(pinned, caller({ principalId: "mcp:pat:pat-9" }))).toBe(true);
    // An OIDC caller is not a token and has no id to be on the list. Applying
    // the check to them would deny the strongly-authenticated caller.
    expect(permitsCaller(pinned, caller({ identityMode: "oidc" }))).toBe(true);
  });

  it("accepts a principal id that is already bare", () => {
    expect(permitsCaller(policy({ allowedPatIds: ["pat-9"] }), caller({ principalId: "pat-9" }))).toBe(
      true,
    );
  });

  it("requires EVERY scope label, not any of them", () => {
    const labelled = policy({ scopeLabels: ["mcp:tools", "billing"] });
    expect(permitsCaller(labelled, caller({ scopes: ["mcp:tools"] }))).toBe(false);
    expect(permitsCaller(labelled, caller({ scopes: ["mcp:tools", "billing"] }))).toBe(true);
  });

  it("lets an unlabelled tool through for a caller holding no scopes", () => {
    expect(permitsCaller(policy(), caller({ scopes: [] }))).toBe(true);
  });

  it("filters a set the same way it judges one", () => {
    const permitted = filterForCaller(
      [policy(), policy({ toolId: asToolsIdentifier<ToolId>("tool-2"), effect: "DENY" })],
      caller(),
    );
    expect(permitted).toHaveLength(1);
  });
});

describe("the synthetic denial", () => {
  const synthesized = synthesizeDenial(
    {
      environmentId: ENVIRONMENT,
      entityId: ENTITY,
      toolId: asToolsIdentifier<ToolId>("tool-7"),
      toolName: asToolsIdentifier<ToolName>("files.delete"),
    },
    ACL,
  );

  it("is not exposed, which is what makes the surface default-deny", () => {
    expect(synthesized.effect).toBe("DENY");
    expect(permitsCaller(synthesized, caller())).toBe(false);
  });

  it("is undated and unattributed, because nothing was written", () => {
    expect(synthesized.addedAt).toBeNull();
    expect(synthesized.addedBy).toBe("");
  });

  it("carries the policy defaults, so an operator sees what switching it on would mean", () => {
    expect(synthesized.minIdentityMode).toBe(ACL.defaultMinimumIdentityMode);
    expect(synthesized.scopeLabels).toEqual([ACL.defaultScopeLabel]);
  });
});

describe("the derived allowlist", () => {
  it("holds the exposed names only, distinct and sorted", () => {
    expect(
      exposedToolNames([
        policy({ toolName: asToolsIdentifier<ToolName>("b") }),
        policy({ toolId: asToolsIdentifier<ToolId>("t2"), toolName: asToolsIdentifier<ToolName>("a") }),
        policy({ toolId: asToolsIdentifier<ToolId>("t3"), toolName: asToolsIdentifier<ToolName>("a") }),
        policy({ toolId: asToolsIdentifier<ToolId>("t4"), toolName: asToolsIdentifier<ToolName>("z"), effect: "DENY" }),
      ]),
    ).toEqual(["a", "b"]);
  });

  it("is empty when nothing is exposed, so a revoked surface offers nothing", () => {
    expect(exposedToolNames([policy({ effect: "DENY" })])).toEqual([]);
  });
});
