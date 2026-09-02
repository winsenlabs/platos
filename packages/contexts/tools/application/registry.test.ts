import { asIdentifier, type EntityId } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import {
  asToolsIdentifier,
  canonicalToolDocument,
  type ExposureId,
  type AgentId,
  type ExternalEntityId,
  type ToolId,
  type ToolName,
} from "../domain/index.js";
import { findTools, listTools, pageTools, setToolEnabled } from "./read-tools.js";
import { registerTools } from "./register-tools.js";
import {
  buildToolsTestContext,
  otherEnvironment,
  testExposure,
  type ToolsTestContext,
} from "./testing/index.js";

const ENTITY = asIdentifier<EntityId>("entity-pk-1");
const EXTERNAL = asToolsIdentifier<ExternalEntityId>("acme-backend");

let context: ToolsTestContext;

beforeEach(() => {
  context = buildToolsTestContext();
  context.tenancy.seedEntity(ENTITY, EXTERNAL);
});

function register(
  tools: readonly { name: string; description?: string; paramSchema?: unknown }[],
  callbackUrl: string | null = "https://acme.test/tools",
) {
  return registerTools(context.dependencies, {
    authorization: context.tenancy.grant(),
    entityId: ENTITY,
    externalEntityId: EXTERNAL,
    tools,
    callbackUrl,
  });
}

describe("registering a declaration", () => {
  it("mints one Tool row per distinct shape and exposes each", async () => {
    const registered = await register([{ name: "files.upload" }, { name: "files.list" }]);
    expect(registered.ok && registered.value.outcome).toEqual({
      registered: 2,
      updated: 0,
      newTools: 2,
      removed: 0,
    });
  });

  it("is IDEMPOTENT: an unchanged declaration mints no new Tool row", async () => {
    await register([{ name: "files.upload", description: "put a file" }]);
    const before = context.digest.inputs.length;
    const again = await register([{ name: "files.upload", description: "put a file" }]);
    expect(again.ok && again.value.outcome.newTools).toBe(0);
    expect(again.ok && again.value.outcome.updated).toBe(1);
    // The digest is still taken — that is how idempotence is DECIDED — but the
    // canonical document is byte-identical, so the lookup finds the row.
    expect(context.digest.inputs.length).toBe(before + 1);
    expect(context.digest.inputs.at(-1)).toBe(context.digest.inputs.at(before - 1));
  });

  it("mints a NEW row when the shape changes, leaving the old version intact", async () => {
    await register([{ name: "files.upload", description: "v1" }]);
    const changed = await register([{ name: "files.upload", description: "v2" }]);
    expect(changed.ok && changed.value.outcome.newTools).toBe(1);
    expect(context.digest.inputs).toContain(
      canonicalToolDocument({ name: "files.upload", description: "v1", paramSchema: {}, category: "files" }),
    );
  });

  it("REPLACES rather than merges, which is what lets the registry shrink", async () => {
    await register([{ name: "a" }, { name: "b" }, { name: "c" }]);
    const shrunk = await register([{ name: "a" }]);
    expect(shrunk.ok && shrunk.value.outcome.removed).toBe(2);
    expect(shrunk.ok && shrunk.value.exposures.map((entry) => entry.toolName)).toEqual(["a"]);

    const listed = await listTools(context.dependencies, {
      authorization: context.tenancy.grant(),
      callableOnly: false,
    });
    expect(listed.ok && listed.value).toHaveLength(1);
  });

  it("refuses a declaration whose external id does not match the entity record", async () => {
    const mismatched = await registerTools(context.dependencies, {
      authorization: context.tenancy.grant(),
      entityId: ENTITY,
      externalEntityId: asToolsIdentifier<ExternalEntityId>("somebody-else"),
      tools: [{ name: "a" }],
      callbackUrl: null,
    });
    expect(!mismatched.ok && mismatched.error.code).toBe("TOOLS_ENTITY_NOT_IN_SCOPE");
  });

  it("refuses a grant tenancy did not mint", async () => {
    const forged = await registerTools(context.dependencies, {
      authorization: { access: "secret:mutate", scope: context.scope },
      entityId: ENTITY,
      externalEntityId: EXTERNAL,
      tools: [{ name: "a" }],
      callbackUrl: null,
    });
    expect(forged.ok).toBe(false);
  });

  it("refuses a metadata grant, which cannot mutate", async () => {
    const readOnly = await registerTools(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      entityId: ENTITY,
      externalEntityId: EXTERNAL,
      tools: [{ name: "a" }],
      callbackUrl: null,
    });
    expect(!readOnly.ok && readOnly.error.code).toBe("TOOLS_SCOPE_MISMATCH");
  });

  it("refuses a grant minted for another environment", async () => {
    const elsewhere = await registerTools(context.dependencies, {
      authorization: context.tenancy.grant("secret:mutate", otherEnvironment()),
      entityId: ENTITY,
      externalEntityId: EXTERNAL,
      tools: [{ name: "a" }],
      callbackUrl: null,
    });
    expect(elsewhere.ok).toBe(false);
  });

  it("writes both tiers in ONE unit of work", async () => {
    await register([{ name: "a" }]);
    expect(context.unitOfWork.transactions).toHaveLength(1);
  });

  it("refuses the whole declaration when any one tool is unnamed", async () => {
    const bad = await register([{ name: "good" }, { name: "" }]);
    expect(!bad.ok && bad.error.code).toBe("TOOLS_DECLARATION_INVALID");
    const listed = await listTools(context.dependencies, {
      authorization: context.tenancy.grant(),
      callableOnly: false,
    });
    expect(listed.ok && listed.value).toEqual([]);
  });
});

describe("reading the matrix", () => {
  beforeEach(() => {
    context.repository.seedExposure(testExposure(context.scope));
    context.repository.seedExposure(
      testExposure(context.scope, {
        exposureId: asToolsIdentifier<ExposureId>("exposure-2"),
        toolId: asToolsIdentifier<ToolId>("tool-2"),
        toolName: asToolsIdentifier<ToolName>("files.delete"),
        description: "remove a file from the customer's store",
        enabled: false,
      }),
    );
  });

  it("hides an uncallable tool by default and shows it on request", async () => {
    const callable = await listTools(context.dependencies, { authorization: context.tenancy.grant() });
    expect(callable.ok && callable.value).toHaveLength(1);

    const all = await listTools(context.dependencies, {
      authorization: context.tenancy.grant(),
      callableOnly: false,
    });
    expect(all.ok && all.value).toHaveLength(2);
  });

  it("clamps a page to the policy ceiling", async () => {
    const paged = await pageTools(context.dependencies, {
      authorization: context.tenancy.grant(),
      limit: 10_000,
      offset: -3,
    });
    expect(paged.ok && paged.value.total).toBe(2);
    expect(paged.ok && paged.value.items.length).toBeLessThanOrEqual(
      context.dependencies.policy.acl.maximumPageSize,
    );
  });

  it("treats an empty search string as no search", async () => {
    const searched = await pageTools(context.dependencies, {
      authorization: context.tenancy.grant(),
      limit: 10,
      offset: 0,
      search: "   ",
    });
    expect(searched.ok && searched.value.total).toBe(2);
  });
});

describe("switching a tool off", () => {
  beforeEach(() => {
    context.repository.seedExposure(testExposure(context.scope));
  });

  it("takes it out of the callable set", async () => {
    const off = await setToolEnabled(context.dependencies, {
      authorization: context.tenancy.grant(),
      exposureId: "exposure-1",
      enabled: false,
    });
    expect(off.ok && off.value.enabled).toBe(false);

    const listed = await listTools(context.dependencies, { authorization: context.tenancy.grant() });
    expect(listed.ok && listed.value).toEqual([]);
  });

  it("refuses a metadata grant", async () => {
    const refused = await setToolEnabled(context.dependencies, {
      authorization: context.tenancy.grant("metadata"),
      exposureId: "exposure-1",
      enabled: false,
    });
    expect(!refused.ok && refused.error.code).toBe("TOOLS_SCOPE_MISMATCH");
  });

  it("refuses an exposure this environment does not hold", async () => {
    const missing = await setToolEnabled(context.dependencies, {
      authorization: context.tenancy.grant(),
      exposureId: "exposure-nope",
      enabled: false,
    });
    expect(!missing.ok && missing.error.code).toBe("TOOLS_EXPOSURE_NOT_FOUND");
  });
});

describe("find_tools", () => {
  beforeEach(() => {
    context.repository.seedExposure(testExposure(context.scope));
    context.repository.seedExposure(
      testExposure(context.scope, {
        exposureId: asToolsIdentifier<ExposureId>("exposure-2"),
        toolId: asToolsIdentifier<ToolId>("tool-2"),
        toolName: asToolsIdentifier<ToolName>("github.create_issue"),
        description: "open an issue on a repository",
        paramSchema: { properties: { title: {} } },
      }),
    );
  });

  it("ranks the tool a query names first", async () => {
    const found = await findTools(context.dependencies, {
      authorization: context.tenancy.grant(),
      query: "open an issue",
    });
    expect(found.ok && found.value[0]?.toolName).toBe("github.create_issue");
  });

  it("returns nothing rather than padding with unrelated tools", async () => {
    const found = await findTools(context.dependencies, {
      authorization: context.tenancy.grant(),
      query: "quantum chromodynamics",
    });
    expect(found.ok && found.value).toEqual([]);
  });

  it("EXCLUDES a tool the agent may not see, rather than filtering it after ranking", async () => {
    const hidden = await findTools(context.dependencies, {
      authorization: context.tenancy.grant(),
      query: "open an issue",
      agentId: asToolsIdentifier<AgentId>("agent-9"),
    });
    expect(hidden.ok && hidden.value).toEqual([]);
  });

  it("excludes a switched-off tool", async () => {
    await setToolEnabled(context.dependencies, {
      authorization: context.tenancy.grant(),
      exposureId: "exposure-2",
      enabled: false,
    });
    const found = await findTools(context.dependencies, {
      authorization: context.tenancy.grant(),
      query: "open an issue repository",
    });
    expect(found.ok && found.value).toEqual([]);
  });

  it("honours a caller-supplied limit within the policy ceiling", async () => {
    const found = await findTools(context.dependencies, {
      authorization: context.tenancy.grant(),
      query: "file issue upload repository",
      limit: 1,
    });
    expect(found.ok && found.value).toHaveLength(1);
  });

  it("propagates a store failure instead of answering with an empty list", async () => {
    context.repository.failNextRead = "connection reset";
    const found = await findTools(context.dependencies, {
      authorization: context.tenancy.grant(),
      query: "issue",
    });
    expect(!found.ok && found.error.code).toBe("TOOLS_REPOSITORY_UNAVAILABLE");
  });
});
